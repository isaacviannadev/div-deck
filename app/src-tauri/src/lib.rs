mod actions;
mod apps;
mod config;
mod logi;
mod recorder;
mod presets;
mod presets_v1;
mod serial;

use config::{Action, Config, DeckConfig, MediaKey};
use serde::Serialize;
use serial::{Decks, LinkInfo};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WindowEvent,
};

const OWN_BUNDLE_ID: &str = "com.divtecnologia.divdeck";

struct AppState {
    config: Mutex<Config>,
    /// Profile currently shown on each connected deck (may be an app-linked one), by deck id.
    active: Mutex<HashMap<String, String>>,
    front_app: Mutex<Option<(String, String)>>,
    config_path: PathBuf,
    icon_cache: PathBuf,
    decks: Arc<Decks>,
    actions: Mutex<mpsc::Sender<actions::Job>>,
    /// Pro tile icons: profile id -> 15 icon hashes (rendered by the UI, cached as files).
    icon_map: Mutex<HashMap<String, Vec<Option<String>>>>,
    /// Folder with rendered icons (56x56 BGRA, named by hash) + index.json.
    tile_icons: PathBuf,
}

/// A known deck as the UI sees it: its saved settings plus the live link, if any.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckDto {
    #[serde(flatten)]
    deck: DeckConfig,
    connected: bool,
    port: Option<String>,
    firmware: Option<String>,
    /// Profile on screen right now.
    active: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateDto {
    config: Config,
    decks: Vec<DeckDto>,
    front_app: Option<String>,
    accessibility: bool,
}

#[derive(Clone, Serialize)]
struct KeyEvent<'a> {
    deck: &'a str,
    key: u8,
    down: bool,
}

// ------------------------------------------------------------------ deck glue

fn deck_list(app: &AppHandle) -> Vec<DeckDto> {
    let st = app.state::<AppState>();
    let cfg = st.config.lock().unwrap();
    let active = st.active.lock().unwrap();
    let mut v: Vec<DeckDto> = cfg
        .decks
        .iter()
        .map(|d| {
            let link = st.decks.info(&d.id);
            DeckDto {
                connected: link.is_some(),
                port: link.as_ref().map(|l| l.port.clone()),
                firmware: link.map(|l| l.firmware),
                active: active.get(&d.id).cloned().unwrap_or_else(|| d.profile.clone()),
                deck: d.clone(),
            }
        })
        .collect();
    v.sort_by_key(|d| !d.connected); // connected first, then in the order they were first seen
    v
}

fn emit_decks(app: &AppHandle) {
    let _ = app.emit("deck://decks", deck_list(app));
}

/// Profile a deck should show right now: the one linked to the app in focus (if it follows the
/// focus), otherwise its own base profile.
fn wanted_profile(cfg: &Config, deck: &DeckConfig, front: &Option<(String, String)>) -> String {
    if cfg.auto_switch && deck.follow_app {
        if let Some((bundle, name)) = front {
            let key = if bundle.is_empty() { name } else { bundle };
            if let Some(p) = cfg.profile_for_app(key, name) {
                return p.id.clone();
            }
        }
    }
    deck.profile.clone()
}

/// Called by the serial scanner when a deck answers HELLO.
pub(crate) fn on_deck_connected(app: &AppHandle, link: &LinkInfo) {
    let st = app.state::<AppState>();
    {
        let mut cfg = st.config.lock().unwrap();
        if cfg.deck(&link.id).is_none() {
            let base = if link.model == "pro" { "DIV Deck Pro" } else { "DIV Deck" };
            let same = cfg.decks.iter().filter(|d| d.name.starts_with(base)).count();
            let name = if same == 0 { base.to_string() } else { format!("{base} {}", same + 1) };
            let profile = cfg.base_profile.clone();
            cfg.decks.push(DeckConfig { id: link.id.clone(), name, model: link.model.clone(), profile, follow_app: true, flipped: false, status: Default::default() });
            let _ = cfg.save(&st.config_path);
        } else if let Some(d) = cfg.deck_mut(&link.id) {
            if d.model != link.model {
                d.model = link.model.clone();
                let _ = cfg.save(&st.config_path);
            }
        }
        let front = st.front_app.lock().unwrap().clone();
        let deck = cfg.deck(&link.id).unwrap().clone();
        st.active.lock().unwrap().insert(link.id.clone(), wanted_profile(&cfg, &deck, &front));
    }
    push_deck(app, &link.id);
    prefetch_faces(app, &link.id);
    emit_decks(app);
}

/// Offer every profile's tile faces to a Pro in the background ("IP"): it answers WANT for the ones
/// it doesn't have yet, and those are sent after anything the screen needs right now. After that,
/// switching profiles never waits for a transfer.
pub(crate) fn prefetch_faces(app: &AppHandle, id: &str) {
    let st = app.state::<AppState>();
    if st.decks.info(id).map(|l| l.model != "pro").unwrap_or(true) {
        return;
    }
    let mut seen = std::collections::HashSet::new();
    let map = st.icon_map.lock().unwrap().clone();
    for hashes in map.values() {
        for h in hashes.iter().flatten() {
            if seen.insert(h.clone()) && st.tile_icons.join(h).exists() {
                st.decks.send(id, format!("IP {h}"));
            }
        }
    }
}

pub(crate) fn on_deck_disconnected(app: &AppHandle, id: &str) {
    app.state::<AppState>().active.lock().unwrap().remove(id);
    emit_decks(app);
}

/// Called by a deck's session thread for every key (or touch tile) event.
pub(crate) fn on_key(app: &AppHandle, deck: &str, key: u8, down: bool) {
    let _ = app.emit("deck://key", KeyEvent { deck, key, down });
    // macro recorder: a deck key starts it, the next one stops it (the key's action doesn't run)
    match recorder::state() {
        recorder::State::Idle => {}
        _ if !down => return,
        recorder::State::Armed => {
            match recorder::start() {
                Ok(()) => emit_macro(app, "recording", None, None),
                Err(e) => {
                    recorder::cancel();
                    emit_macro(app, "idle", None, Some(e));
                }
            }
            return;
        }
        recorder::State::Recording => {
            let steps = recorder::finish();
            emit_macro(app, "idle", steps, None);
            return;
        }
    }
    if !down {
        return;
    }
    let st = app.state::<AppState>();
    let action = {
        let cfg = st.config.lock().unwrap();
        let active = st.active.lock().unwrap();
        active.get(deck).and_then(|id| cfg.profile(id)).and_then(|p| p.keys.get(key as usize)).map(|k| k.action.clone())
    };
    match action {
        Some(Action::SwitchProfile { profile }) => set_active(app, deck, &profile, true),
        Some(Action::None) | None => {}
        Some(a) => {
            // a "switch profile" step inside a sequence takes effect on this deck too
            let switch = match &a {
                Action::Sequence { steps, .. } => steps.iter().rev().find_map(|s| match s {
                    Action::SwitchProfile { profile } => Some(profile.clone()),
                    _ => None,
                }),
                _ => None,
            };
            let _ = st.actions.lock().unwrap().send(actions::Job::Run(a));
            if let Some(p) = switch {
                set_active(app, deck, &p, true);
            }
        }
    }
}

/// Small diagnostic log: ~/Library/Logs/DIV Deck/divdeck.log (macOS), %APPDATA%\\DIV Deck\\divdeck.log.
pub(crate) fn log(msg: impl AsRef<str>) {
    use std::io::Write as _;
    let dir = if cfg!(windows) {
        std::env::var_os("APPDATA").map(|d| std::path::PathBuf::from(d).join("DIV Deck"))
    } else {
        std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Library/Logs/DIV Deck"))
    };
    let Some(dir) = dir else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("divdeck.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 512 * 1024) {
        let _ = std::fs::rename(&path, dir.join("divdeck.old.log"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"), msg.as_ref());
    }
}

/// "code:12" (recorded macOS key code) -> "Q"; plain names as they are.
pub(crate) fn key_label(key: &str) -> String {
    const MAC: [(u16, &str); 50] = [
        (0, "A"), (1, "S"), (2, "D"), (3, "F"), (4, "H"), (5, "G"), (6, "Z"), (7, "X"), (8, "C"), (9, "V"), (11, "B"),
        (12, "Q"), (13, "W"), (14, "E"), (15, "R"), (16, "Y"), (17, "T"), (18, "1"), (19, "2"), (20, "3"), (21, "4"),
        (22, "6"), (23, "5"), (25, "9"), (26, "7"), (28, "8"), (29, "0"), (31, "O"), (32, "U"), (34, "I"), (35, "P"),
        (36, "Enter"), (37, "L"), (38, "J"), (40, "K"), (45, "N"), (46, "M"), (48, "Tab"), (49, "Space"), (51, "Del"),
        (53, "Esc"), (122, "F1"), (120, "F2"), (99, "F3"), (118, "F4"), (96, "F5"), (123, "Left"), (124, "Right"),
        (125, "Down"), (126, "Up"),
    ];
    match key.strip_prefix("code:").and_then(|c| c.parse::<u16>().ok()) {
        Some(c) => MAC.iter().find(|(k, _)| *k == c).map(|(_, n)| n.to_string()).unwrap_or_else(|| format!("#{c}")),
        None if key.chars().count() == 1 => key.to_uppercase(),
        None => key.to_string(),
    }
}

/// Plain ASCII for the Pro's built-in fonts ("Próxima" -> "Proxima", "Vol −" -> "Vol -").
fn ascii(s: &str) -> String {
    s.chars()
        .filter_map(|c| {
            Some(match c {
                'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
                'Á' | 'À' | 'Â' | 'Ã' | 'Ä' => 'A',
                'é' | 'è' | 'ê' | 'ë' => 'e',
                'É' | 'È' | 'Ê' | 'Ë' => 'E',
                'í' | 'ì' | 'î' | 'ï' => 'i',
                'Í' | 'Ì' | 'Î' | 'Ï' => 'I',
                'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
                'Ó' | 'Ò' | 'Ô' | 'Õ' | 'Ö' => 'O',
                'ú' | 'ù' | 'û' | 'ü' => 'u',
                'Ú' | 'Ù' | 'Û' | 'Ü' => 'U',
                'ç' => 'c',
                'Ç' => 'C',
                'ñ' => 'n',
                '−' | '–' | '—' => '-',
                '·' | '•' => '.',
                c if c.is_ascii() && !c.is_ascii_control() => c,
                _ => return None,
            })
        })
        .collect()
}

/// Big glyph drawn on a Pro tile: "<kind> <text>". kind = txt | play | next | prev | volup | voldown | mute | none
fn pro_glyph(a: &Action, cfg: &Config) -> String {
    let mono = |name: &str| {
        let words: Vec<&str> = name.split_whitespace().filter(|w| w.chars().next().is_some_and(|c| c.is_alphanumeric())).collect();
        let m: String = if words.len() >= 2 {
            words.iter().take(2).filter_map(|w| w.chars().next()).collect()
        } else {
            name.chars().filter(|c| c.is_alphanumeric()).take(2).collect()
        };
        let mut c = m.chars();
        match c.next() {
            Some(f) => f.to_uppercase().chain(c).collect::<String>(),
            None => "?".into(),
        }
    };
    match a {
        Action::None => "none".into(),
        Action::OpenApp { name, .. } => format!("txt {}", ascii(&mono(name))),
        Action::OpenUrl { .. } => "txt www".into(),
        Action::Shortcut { mods, key } => {
            let mut parts: Vec<String> = ["ctrl", "alt", "shift", "cmd"]
                .iter()
                .filter(|m| mods.iter().any(|x| x == *m))
                .map(|m| match *m {
                    "cmd" => if cfg!(windows) { "Ctrl" } else { "Cmd" },
                    "ctrl" => "Ctrl",
                    "alt" => if cfg!(windows) { "Alt" } else { "Opt" },
                    _ => "Shift",
                }.to_string())
                .collect();
            parts.push(if key.chars().count() == 1 { key.to_uppercase() } else { key.clone() });
            format!("txt {}", ascii(&parts.join("+")))
        }
        Action::TypeText { .. } => "txt Aa".into(),
        Action::Media { key } => match key {
            MediaKey::PlayPause => "play",
            MediaKey::Next => "next",
            MediaKey::Previous => "prev",
            MediaKey::VolumeUp => "volup",
            MediaKey::VolumeDown => "voldown",
            MediaKey::Mute => "mute",
        }
        .into(),
        Action::Shell { .. } => "txt >_".into(),
        Action::SwitchProfile { profile } => {
            format!("txt {}", ascii(&mono(&cfg.profile(profile).map(|p| p.name.clone()).unwrap_or_default())))
        }
        Action::Wait { .. } => "none".into(),
        Action::Key { key, .. } | Action::KeyEvent { key, .. } => format!("txt {}", ascii(&key_label(key))),
        Action::Mouse { .. } => "txt Clk".into(),
        Action::ChangeHost { targets, host, .. } => {
            let h = targets.first().map(|t| t.host).unwrap_or(*host);
            format!("txt PC{h}")
        }
        // a macro shows the glyph of its first real step
        Action::Sequence { steps, .. } => steps
            .iter()
            .find(|s| !matches!(s, Action::Wait { .. } | Action::None))
            .map(|s| pro_glyph(s, cfg))
            .unwrap_or_else(|| "txt >>".into()),
    }
}

/// Send brightness, press colour and the active profile's keys to one deck.
/// MX: LED colours. Pro: tile colours, labels and glyphs, then a redraw.
/// Local wall-clock time as seconds since 1970 (what the Pro shows in its status bar).
pub(crate) fn local_now() -> i64 {
    chrono::Local::now().naive_local().and_utc().timestamp()
}

pub(crate) fn push_deck(app: &AppHandle, id: &str) {
    let st = app.state::<AppState>();
    let Some(link) = st.decks.info(id) else { return };
    let cfg = st.config.lock().unwrap();
    let active = st.active.lock().unwrap().get(id).cloned();
    let pro = link.model == "pro";
    st.decks.send(id, format!("B {}", cfg.brightness));
    st.decks.send(id, format!("P {}", cfg.press_color));
    if pro {
        let flipped = cfg.deck(id).is_some_and(|d| d.flipped);
        st.decks.send(id, format!("O {}", if flipped { 3 } else { 1 }));
    }
    // Pro status bar / MX OLED pod (MX firmware 1.2+; older firmware just answers ERR)
    let sb = cfg.deck(id).map(|d| d.status.clone()).unwrap_or_default();
    st.decks.send(id, format!("H {}", sb.mask()));
    st.decks.send(id, format!("C {}", local_now()));
    if let Some(p) = active.as_deref().and_then(|a| cfg.profile(a)) {
        for (k, key) in p.keys.iter().enumerate() {
            st.decks.send(id, format!("L {k} {}", key.color));
            if pro {
                let label = if key.label.is_empty() && key.action != Action::None { String::new() } else { ascii(&key.label) };
                st.decks.send(id, format!("T {k} {}", label.trim()));
                st.decks.send(id, format!("G {k} {}", pro_glyph(&key.action, &cfg)));
                let hash = st.icon_map.lock().unwrap().get(&p.id).and_then(|v| v.get(k).cloned().flatten());
                let hash = hash.filter(|h| st.tile_icons.join(h).exists());
                st.decks.send(id, format!("IH {k} {}", hash.as_deref().unwrap_or("-")));
            }
        }
        st.decks.send(id, format!("N {}", ascii(&p.name)));
        if pro {
            st.decks.send(id, "R");
        }
    }
}

/// The lines that send one tile face to a Pro (base64 chunks, then the end marker).
pub(crate) fn face_lines(app: &AppHandle, hash: &str) -> Option<Vec<String>> {
    use base64::Engine;
    let st = app.state::<AppState>();
    if !hash.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let bytes = std::fs::read(st.tile_icons.join(hash)).ok()?;
    let mut out: Vec<String> = bytes
        .chunks(384)
        .map(|c| format!("IB {hash} {}", base64::engine::general_purpose::STANDARD.encode(c)))
        .collect();
    out.push(format!("IE {hash}"));
    Some(out)
}

fn push_all(app: &AppHandle) {
    let ids: Vec<String> = app.state::<AppState>().decks.connected().into_iter().map(|l| l.id).collect();
    for id in ids {
        push_deck(app, &id);
    }
}

/// Show `profile` on `deck`. `manual` = chosen by the user (or a "switch profile" key): it becomes
/// that deck's base profile.
fn set_active(app: &AppHandle, deck: &str, profile: &str, manual: bool) {
    let st = app.state::<AppState>();
    {
        let mut cfg = st.config.lock().unwrap();
        if cfg.profile(profile).is_none() {
            return;
        }
        if manual {
            let mut changed = cfg.base_profile != profile;
            cfg.base_profile = profile.to_string();
            if let Some(d) = cfg.deck_mut(deck) {
                changed |= d.profile != profile;
                d.profile = profile.to_string();
            }
            if changed {
                let _ = cfg.save(&st.config_path);
            }
        }
        if st.decks.info(deck).is_some() {
            st.active.lock().unwrap().insert(deck.to_string(), profile.to_string());
        }
    }
    push_deck(app, deck);
    emit_decks(app);
}

/// Watch the frontmost app and switch every deck that follows the focus to its linked profile
/// (or back to that deck's base profile).
fn spawn_front_app_watcher(app: AppHandle) {
    thread::spawn(move || {
        let mut last: Option<String> = None;
        loop {
            thread::sleep(Duration::from_millis(400));
            let (tx, rx) = mpsc::channel();
            if app.run_on_main_thread(move || { let _ = tx.send(apps::frontmost_app()); }).is_err() {
                continue;
            }
            let Ok(front_full) = rx.recv_timeout(Duration::from_secs(1)) else { continue };
            let front = front_full.as_ref().map(|f| if f.0.is_empty() { f.1.clone() } else { f.0.clone() });
            if front == last || front.as_deref() == Some(OWN_BUNDLE_ID) {
                continue; // configuring the deck shouldn't make it switch away
            }
            last = front.clone();
            let st = app.state::<AppState>();
            *st.front_app.lock().unwrap() = front_full.clone();
            let _ = app.emit("deck://front-app", front.clone());
            let changes: Vec<(String, String)> = {
                let cfg = st.config.lock().unwrap();
                let active = st.active.lock().unwrap();
                active
                    .iter()
                    .filter_map(|(id, cur)| {
                        let deck = cfg.deck(id)?;
                        let want = wanted_profile(&cfg, deck, &front_full);
                        (want != *cur).then(|| (id.clone(), want))
                    })
                    .collect()
            };
            for (id, p) in changes {
                set_active(&app, &id, &p, false);
            }
        }
    });
}

// ------------------------------------------------------------------ commands

#[tauri::command]
fn get_state(app: AppHandle, st: tauri::State<AppState>) -> StateDto {
    // one lock at a time: a guard kept alive across deck_list() (which locks the config again)
    // would deadlock the main thread and the window would never open
    let config = st.config.lock().unwrap().clone();
    let front_app = st.front_app.lock().unwrap().as_ref().map(|f| if f.0.is_empty() { f.1.clone() } else { f.0.clone() });
    let decks = deck_list(&app);
    StateDto { config, decks, front_app, accessibility: actions::accessibility_trusted() }
}

/// Saves profiles and settings. The deck list is owned by the backend (decks are registered when
/// they connect), so whatever the UI sends for `decks` is ignored here: see `update_deck`.
#[tauri::command]
fn save_config(app: AppHandle, st: tauri::State<AppState>, mut config: Config) -> Result<(), String> {
    {
        let mut cur = st.config.lock().unwrap();
        config.decks = cur.decks.clone();
        config.normalize();
        config.save(&st.config_path).map_err(|e| e.to_string())?;
        let mut active = st.active.lock().unwrap();
        for (id, p) in active.iter_mut() {
            if config.profile(p).is_none() {
                *p = config.deck(id).map(|d| d.profile.clone()).unwrap_or_else(|| config.base_profile.clone());
            }
        }
        *cur = config;
    }
    push_all(&app);
    emit_decks(&app);
    Ok(())
}

/// Rename a deck, toggle "follow the app in focus" or flip a Pro's screen.
#[tauri::command]
fn update_deck(app: AppHandle, st: tauri::State<AppState>, deck: DeckConfig) -> Result<(), String> {
    let refollow;
    {
        let mut cfg = st.config.lock().unwrap();
        let Some(d) = cfg.deck_mut(&deck.id) else { return Err("deck desconhecido".into()) };
        refollow = d.follow_app != deck.follow_app;
        d.name = deck.name.trim().chars().take(32).collect();
        if d.name.is_empty() {
            d.name = if d.model == "pro" { "DIV Deck Pro".into() } else { "DIV Deck".into() };
        }
        d.follow_app = deck.follow_app;
        d.flipped = deck.flipped;
        d.status = deck.status.clone();
        cfg.save(&st.config_path).map_err(|e| e.to_string())?;
    }
    if refollow {
        let want = {
            let cfg = st.config.lock().unwrap();
            let front = st.front_app.lock().unwrap().clone();
            wanted_profile(&cfg, cfg.deck(&deck.id).unwrap(), &front)
        };
        set_active(&app, &deck.id, &want, false);
    } else {
        push_deck(&app, &deck.id);
        emit_decks(&app);
    }
    Ok(())
}

/// Remove a deck that isn't connected from the list.
#[tauri::command]
fn forget_deck(app: AppHandle, st: tauri::State<AppState>, id: String) -> Result<(), String> {
    if st.decks.info(&id).is_some() {
        return Err("desligue o deck antes de o remover".into());
    }
    {
        let mut cfg = st.config.lock().unwrap();
        cfg.decks.retain(|d| d.id != id);
        cfg.save(&st.config_path).map_err(|e| e.to_string())?;
    }
    emit_decks(&app);
    Ok(())
}

#[tauri::command]
fn set_profile(app: AppHandle, st: tauri::State<AppState>, deck: Option<String>, id: String) {
    match deck {
        Some(d) => set_active(&app, &d, &id, true),
        None => {
            let mut cfg = st.config.lock().unwrap();
            if cfg.profile(&id).is_some() && cfg.base_profile != id {
                cfg.base_profile = id;
                let _ = cfg.save(&st.config_path);
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MacroEvent {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    steps: Option<Vec<Action>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn emit_macro(app: &AppHandle, state: &'static str, steps: Option<Vec<Action>>, error: Option<String>) {
    let _ = app.emit("macro://state", MacroEvent { state, steps, error });
}

/// Arm the recorder: the next deck key (or macro_start) begins recording.
#[tauri::command]
fn macro_arm(app: AppHandle) -> Result<(), String> {
    recorder::arm()?;
    emit_macro(&app, "armed", None, None);
    Ok(())
}

#[tauri::command]
fn macro_start(app: AppHandle) -> Result<(), String> {
    if let Err(e) = recorder::start() {
        recorder::cancel();
        emit_macro(&app, "idle", None, Some(e.clone()));
        return Err(e);
    }
    emit_macro(&app, "recording", None, None);
    Ok(())
}

#[tauri::command]
fn macro_stop(app: AppHandle) {
    let steps = recorder::finish();
    emit_macro(&app, "idle", steps, None);
}

#[tauri::command]
fn macro_cancel(app: AppHandle) {
    recorder::cancel();
    emit_macro(&app, "idle", None, None);
}

/// "Input Monitoring" (macOS): needed to record macros and to reach Logitech keyboards.
#[tauri::command]
fn input_access(request: bool) -> bool {
    recorder::has_access(request)
}

#[tauri::command]
fn open_input_settings() {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
        .spawn();
}

#[tauri::command]
async fn logi_devices() -> Result<Vec<logi::LogiDevice>, String> {
    tauri::async_runtime::spawn_blocking(logi::list).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn test_action(st: tauri::State<AppState>, action: Action) {
    let _ = st.actions.lock().unwrap().send(actions::Job::Run(action));
}

/// Live LED / tile colour preview while editing (not persisted).
#[tauri::command]
fn preview_led(st: tauri::State<AppState>, deck: String, key: u8, color: String) {
    if key < 15 && color.len() == 6 && color.chars().all(|c| c.is_ascii_hexdigit()) {
        st.decks.send(&deck, format!("L {key} {color}"));
        if st.decks.info(&deck).is_some_and(|l| l.model == "pro") {
            st.decks.send(&deck, "R");
        }
    }
}

#[tauri::command]
fn preview_brightness(st: tauri::State<AppState>, value: u8) {
    st.decks.broadcast(&format!("B {}", value.min(96)));
}

/// Persist the current colours (and Pro labels) in the deck's flash (used in standalone mode).
#[tauri::command]
fn save_to_device(st: tauri::State<AppState>, deck: String) {
    st.decks.send(&deck, "S");
}

/// Which of these icon hashes aren't rendered and cached yet.
#[tauri::command]
fn icons_missing(st: tauri::State<AppState>, hashes: Vec<String>) -> Vec<String> {
    hashes.into_iter().filter(|h| h.chars().all(|c| c.is_ascii_alphanumeric()) && !st.tile_icons.join(h).exists()).collect()
}

/// Store one rendered tile face (86 x 96 RGB565 big-endian, base64).
#[tauri::command]
fn put_icon(st: tauri::State<AppState>, hash: String, data: String) -> Result<(), String> {
    use base64::Engine;
    if !hash.chars().all(|c| c.is_ascii_alphanumeric()) || hash.len() > 11 {
        return Err("hash inválido".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    if bytes.len() != 86 * 90 * 2 {
        return Err("tamanho inválido".into());
    }
    std::fs::create_dir_all(&st.tile_icons).map_err(|e| e.to_string())?;
    std::fs::write(st.tile_icons.join(&hash), bytes).map_err(|e| e.to_string())
}

/// Which icon each key of each profile shows on a Pro. Pushes the change to the connected decks.
#[tauri::command]
fn set_icon_map(app: AppHandle, st: tauri::State<AppState>, map: HashMap<String, Vec<Option<String>>>) {
    let changed = {
        let mut cur = st.icon_map.lock().unwrap();
        let changed = *cur != map;
        *cur = map;
        changed
    };
    if changed {
        if let Ok(json) = serde_json::to_string(&*st.icon_map.lock().unwrap()) {
            let _ = std::fs::write(st.tile_icons.join("index.json"), json);
        }
        push_all(&app);
        for l in st.decks.connected() {
            prefetch_faces(&app, &l.id);
        }
    }
}

#[tauri::command]
async fn list_apps() -> Vec<apps::AppInfo> {
    apps::list()
}

#[tauri::command]
async fn app_icon(st: tauri::State<'_, AppState>, icns: String) -> Result<Option<String>, ()> {
    Ok(apps::icon_data_url(&icns, &st.icon_cache))
}

#[tauri::command]
fn accessibility_status() -> bool {
    actions::accessibility_trusted()
}

#[tauri::command]
fn request_accessibility(reset: bool) -> bool {
    actions::request_accessibility(reset)
}

#[tauri::command]
fn open_accessibility_settings() {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn();
}

// ------------------------------------------------------------------ app

// ------------------------------------------------------------------ app menu (macOS menu bar)

const SITE_URL: &str = "https://isaacviannadev.github.io/div-deck/";
const ISSUES_URL: &str = "https://github.com/isaacviannadev/div-deck/issues/new";
const MANUAL_URL: &str = "https://claude.ai/artifact/D82b8R3qZEZSwgJaUffmws";

#[cfg(target_os = "macos")]
fn build_app_menu(app: &tauri::App) -> tauri::Result<Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, PredefinedMenuItem, Submenu};
    let h = app.handle();
    let item = |id: &str, text: &str, acc: Option<&str>| MenuItem::with_id(h, id, text, true, acc);
    let sep = || PredefinedMenuItem::separator(h);
    let about = AboutMetadata {
        name: Some("DIV Deck".into()),
        version: Some(app.package_info().version.to_string()),
        copyright: Some("DIV Tecnologia".into()),
        website: Some(SITE_URL.into()),
        ..Default::default()
    };
    let app_menu = Submenu::with_items(h, "DIV Deck", true, &[
        &PredefinedMenuItem::about(h, Some("Sobre o DIV Deck"), Some(about))?,
        &item("check_update", "Verificar atualizações…", None)?,
        &sep()?,
        &PredefinedMenuItem::services(h, None)?,
        &sep()?,
        &PredefinedMenuItem::hide(h, Some("Ocultar DIV Deck"))?,
        &PredefinedMenuItem::hide_others(h, Some("Ocultar outros"))?,
        &PredefinedMenuItem::show_all(h, Some("Mostrar tudo"))?,
        &sep()?,
        &item("quit", "Sair do DIV Deck", Some("CmdOrCtrl+Q"))?,
    ])?;
    let file = Submenu::with_items(h, "Arquivo", true, &[
        &item("new_profile", "Novo perfil", Some("CmdOrCtrl+N"))?,
        &item("duplicate_profile", "Duplicar perfil", Some("CmdOrCtrl+D"))?,
        &item("delete_profile", "Apagar perfil…", None)?,
        &sep()?,
        &item("save", "Salvar", Some("CmdOrCtrl+S"))?,
        &item("discard", "Descartar alterações…", None)?,
        &sep()?,
        &item("import", "Importar perfis…", Some("CmdOrCtrl+O"))?,
        &item("export", "Exportar perfis…", Some("CmdOrCtrl+Shift+E"))?,
        &sep()?,
        &item("open_config", "Mostrar pasta de configuração", None)?,
        &sep()?,
        &PredefinedMenuItem::close_window(h, Some("Fechar janela"))?,
    ])?;
    let edit = Submenu::with_items(h, "Editar", true, &[
        &PredefinedMenuItem::undo(h, Some("Desfazer"))?,
        &PredefinedMenuItem::redo(h, Some("Refazer"))?,
        &sep()?,
        &PredefinedMenuItem::cut(h, Some("Cortar"))?,
        &PredefinedMenuItem::copy(h, Some("Copiar"))?,
        &PredefinedMenuItem::paste(h, Some("Colar"))?,
        &PredefinedMenuItem::select_all(h, Some("Selecionar tudo"))?,
    ])?;
    let deck = Submenu::with_items(h, "Deck", true, &[
        &item("save_device", "Gravar teclas no deck", Some("CmdOrCtrl+Shift+S"))?,
        &item("test_key", "Testar tecla selecionada", Some("CmdOrCtrl+T"))?,
        &item("clear_key", "Limpar tecla selecionada…", None)?,
    ])?;
    let window = Submenu::with_items(h, "Janela", true, &[
        &PredefinedMenuItem::minimize(h, Some("Minimizar"))?,
        &PredefinedMenuItem::maximize(h, Some("Zoom"))?,
    ])?;
    let help = Submenu::with_items(h, "Ajuda", true, &[
        &item("help_manual", "Manual do DIV Deck Pro", None)?,
        &item("help_site", "Site do DIV Deck", None)?,
        &sep()?,
        &item("help_issue", "Reportar um problema…", None)?,
    ])?;
    Menu::with_items(h, &[&app_menu, &file, &edit, &deck, &window, &help])
}

/// Menu clicks: some are done here, the rest go to the window (which owns unsaved edits).
fn on_app_menu(app: &AppHandle, id: &str) {
    use tauri_plugin_opener::OpenerExt;
    match id {
        "quit" => app.exit(0),
        "help_manual" => { let _ = app.opener().open_url(MANUAL_URL, None::<&str>); }
        "help_site" => { let _ = app.opener().open_url(SITE_URL, None::<&str>); }
        "help_issue" => { let _ = app.opener().open_url(ISSUES_URL, None::<&str>); }
        "open_config" => {
            let st = app.state::<AppState>();
            if let Some(dir) = st.config_path.parent() {
                let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
            }
        }
        "export" => export_profiles(app),
        "import" => import_profiles(app),
        "show" => show_main(app),
        _ => {
            show_main(app);
            let _ = app.emit("menu://action", id.to_string());
        }
    }
}

/// File format for exported profiles.
#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfilesFile {
    format: String,
    version: u32,
    app_version: String,
    profiles: Vec<config::Profile>,
}

fn export_profiles(app: &AppHandle) {
    use tauri_plugin_dialog::DialogExt;
    let app = app.clone();
    let profiles = app.state::<AppState>().config.lock().unwrap().profiles.clone();
    let file = ProfilesFile { format: "divdeck-profiles".into(), version: 1, app_version: app.package_info().version.to_string(), profiles };
    app.dialog().file().set_title("Exportar perfis").set_file_name("DIV Deck - perfis.divdeck.json")
        .add_filter("Perfis do DIV Deck", &["json"])
        .save_file(move |path| {
            let Some(path) = path.and_then(|p| p.into_path().ok()) else { return };
            let res = serde_json::to_string_pretty(&file).map_err(|e| e.to_string()).and_then(|s| std::fs::write(&path, s).map_err(|e| e.to_string()));
            let n = file.profiles.len();
            let _ = app.emit("menu://exported", match res {
                Ok(()) => serde_json::json!({ "ok": true, "count": n, "name": path.file_name().map(|f| f.to_string_lossy().to_string()) }),
                Err(e) => serde_json::json!({ "ok": false, "error": e }),
            });
        });
}

fn import_profiles(app: &AppHandle) {
    use tauri_plugin_dialog::DialogExt;
    let app = app.clone();
    app.dialog().file().set_title("Importar perfis").add_filter("Perfis do DIV Deck", &["json"]).pick_file(move |path| {
        let Some(path) = path.and_then(|p| p.into_path().ok()) else { return };
        let parsed = std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|s| {
            serde_json::from_str::<ProfilesFile>(&s).map_err(|_| "o ficheiro não é um export de perfis do DIV Deck".to_string())
        });
        show_main(&app);
        let _ = app.emit("menu://import", match parsed {
            Ok(f) if f.format == "divdeck-profiles" => serde_json::json!({ "ok": true, "profiles": f.profiles }),
            Ok(_) => serde_json::json!({ "ok": false, "error": "formato desconhecido" }),
            Err(e) => serde_json::json!({ "ok": false, "error": e }),
        });
    });
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(|app, e| on_app_menu(app, e.id.as_ref()))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            let config_path = app.path().app_config_dir()?.join("config.json");
            let icon_cache = app.path().app_cache_dir()?.join("icons");
            let tile_icons = config_path.parent().map(|p| p.join("tile-icons")).unwrap_or_else(|| PathBuf::from("tile-icons"));
            let _ = std::fs::create_dir_all(&tile_icons);
            let icon_map: HashMap<String, Vec<Option<String>>> = std::fs::read_to_string(tile_icons.join("index.json"))
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            let config = Config::load(&config_path);
            let decks = Arc::new(Decks::default());
            app.manage(AppState {
                active: Mutex::new(HashMap::new()),
                config: Mutex::new(config),
                front_app: Mutex::new(None),
                config_path,
                icon_cache,
                decks: decks.clone(),
                actions: Mutex::new(actions::spawn_worker(app.handle().clone())),
                icon_map: Mutex::new(icon_map),
                tile_icons,
            });

            #[cfg(target_os = "macos")]
            {
                let m = build_app_menu(app)?;
                app.handle().set_menu(m)?;
            }
            // tray menu: same ids as the app menu, handled by on_app_menu
            let show = MenuItem::with_id(app, "show", "Abrir DIV Deck", true, None::<&str>)?;
            let upd = MenuItem::with_id(app, "check_update", "Verificar atualizações…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let sep = tauri::menu::PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show, &upd, &sep, &quit])?;
            let mut tray = TrayIconBuilder::with_id("divdeck").menu(&menu).tooltip("DIV Deck");
            if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png")) {
                tray = tray.icon(icon).icon_as_template(true);
            }
            tray.build(app)?;

            serial::spawn(app.handle().clone(), decks.clone());
            spawn_front_app_watcher(app.handle().clone());
            // keep the Pro status-bar / MX OLED clock right (the decks count on their own in between)
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(300));
                for l in decks.connected() {
                    decks.send(&l.id, format!("C {}", local_now()));
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the deck running in the menu bar.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            save_config,
            icons_missing,
            put_icon,
            set_icon_map,
            update_deck,
            forget_deck,
            set_profile,
            test_action,
            preview_led,
            preview_brightness,
            save_to_device,
            list_apps,
            app_icon,
            accessibility_status,
            request_accessibility,
            open_accessibility_settings,
            macro_arm,
            macro_start,
            macro_stop,
            macro_cancel,
            input_access,
            open_input_settings,
            logi_devices,
        ])
        .build(tauri::generate_context!())
        .expect("error while building DIV Deck");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            show_main(app);
        }
        let _ = (app, &event);
    });
}
