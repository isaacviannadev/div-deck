mod actions;
mod apps;
mod config;
mod presets;
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
            cfg.decks.push(DeckConfig { id: link.id.clone(), name, model: link.model.clone(), profile, follow_app: true, flipped: false });
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
    emit_decks(app);
}

pub(crate) fn on_deck_disconnected(app: &AppHandle, id: &str) {
    app.state::<AppState>().active.lock().unwrap().remove(id);
    emit_decks(app);
}

/// Called by a deck's session thread for every key (or touch tile) event.
pub(crate) fn on_key(app: &AppHandle, deck: &str, key: u8, down: bool) {
    let _ = app.emit("deck://key", KeyEvent { deck, key, down });
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
                Action::Sequence { steps } => steps.iter().rev().find_map(|s| match s {
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
        // a macro shows the glyph of its first real step
        Action::Sequence { steps } => steps
            .iter()
            .find(|s| !matches!(s, Action::Wait { .. } | Action::None))
            .map(|s| pro_glyph(s, cfg))
            .unwrap_or_else(|| "txt >>".into()),
    }
}

/// Send brightness, press colour and the active profile's keys to one deck.
/// MX: LED colours. Pro: tile colours, labels and glyphs, then a redraw.
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
    if let Some(p) = active.as_deref().and_then(|a| cfg.profile(a)) {
        for (k, key) in p.keys.iter().enumerate() {
            st.decks.send(id, format!("L {k} {}", key.color));
            if pro {
                let label = if key.label.is_empty() && key.action != Action::None { String::new() } else { ascii(&key.label) };
                st.decks.send(id, format!("T {k} {}", label.trim()));
                st.decks.send(id, format!("G {k} {}", pro_glyph(&key.action, &cfg)));
            }
        }
        if pro {
            st.decks.send(id, format!("N {}", ascii(&p.name)));
            st.decks.send(id, "R");
        }
    }
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
fn open_accessibility_settings() {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn();
}

// ------------------------------------------------------------------ app

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
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            let config_path = app.path().app_config_dir()?.join("config.json");
            let icon_cache = app.path().app_cache_dir()?.join("icons");
            let config = Config::load(&config_path);
            let decks = Arc::new(Decks::default());
            app.manage(AppState {
                active: Mutex::new(HashMap::new()),
                config: Mutex::new(config),
                front_app: Mutex::new(None),
                config_path,
                icon_cache,
                decks: decks.clone(),
                actions: Mutex::new(actions::spawn_worker()),
            });

            let show = MenuItem::with_id(app, "show", "Abrir DIV Deck", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("divdeck").menu(&menu).tooltip("DIV Deck").on_menu_event(
                |app, e| match e.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                },
            );
            if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png")) {
                tray = tray.icon(icon).icon_as_template(true);
            }
            tray.build(app)?;

            serial::spawn(app.handle().clone(), decks);
            spawn_front_app_watcher(app.handle().clone());
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
            open_accessibility_settings,
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
