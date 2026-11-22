mod actions;
mod apps;
mod config;
mod presets;
mod serial;

use config::{Action, Config};
use serde::Serialize;
use serial::{Deck, DeckStatus, KeyEvent};
use std::{
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
    /// Profile currently shown on the deck (may be an app-linked one).
    active: Mutex<String>,
    front_app: Mutex<Option<String>>,
    config_path: PathBuf,
    icon_cache: PathBuf,
    deck: Arc<Deck>,
    actions: Mutex<mpsc::Sender<actions::Job>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateDto {
    config: Config,
    active_profile: String,
    status: DeckStatus,
    front_app: Option<String>,
    accessibility: bool,
}

// ------------------------------------------------------------------ deck glue

/// Called by the serial thread for every key event.
pub(crate) fn on_key(app: &AppHandle, key: u8, down: bool) {
    let _ = app.emit("deck://key", KeyEvent { key, down });
    if !down {
        return;
    }
    let st = app.state::<AppState>();
    let action = {
        let cfg = st.config.lock().unwrap();
        let active = st.active.lock().unwrap();
        cfg.profile(&active).and_then(|p| p.keys.get(key as usize)).map(|k| k.action.clone())
    };
    match action {
        Some(Action::SwitchProfile { profile }) => set_active(app, &profile, true),
        Some(Action::None) | None => {}
        Some(a) => {
            let _ = st.actions.lock().unwrap().send(actions::Job::Run(a));
        }
    }
}

/// Send brightness, press colour and the active profile's key colours to the deck.
pub(crate) fn push_leds(app: &AppHandle) {
    let st = app.state::<AppState>();
    let cfg = st.config.lock().unwrap();
    let active = st.active.lock().unwrap();
    st.deck.send(format!("B {}", cfg.brightness));
    st.deck.send(format!("P {}", cfg.press_color));
    if let Some(p) = cfg.profile(&active) {
        for (k, key) in p.keys.iter().enumerate() {
            st.deck.send(format!("L {k} {}", key.color));
        }
    }
}

fn set_active(app: &AppHandle, id: &str, manual: bool) {
    let st = app.state::<AppState>();
    {
        let mut cfg = st.config.lock().unwrap();
        if cfg.profile(id).is_none() {
            return;
        }
        if manual && cfg.base_profile != id {
            cfg.base_profile = id.to_string();
            let _ = cfg.save(&st.config_path);
        }
        *st.active.lock().unwrap() = id.to_string();
    }
    push_leds(app);
    let _ = app.emit("deck://profile", id.to_string());
}

/// Watch the frontmost app and switch to its linked profile (or back to the base profile).
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
            let front_name = front_full.as_ref().map(|f| f.1.clone()).unwrap_or_default();
            let front = front_full.map(|f| if f.0.is_empty() { f.1 } else { f.0 });
            if front == last || front.as_deref() == Some(OWN_BUNDLE_ID) {
                continue; // configuring the deck shouldn't make it switch away
            }
            last = front.clone();
            let st = app.state::<AppState>();
            *st.front_app.lock().unwrap() = front.clone();
            let _ = app.emit("deck://front-app", front.clone());
            let target = {
                let cfg = st.config.lock().unwrap();
                if !cfg.auto_switch {
                    continue;
                }
                front
                    .as_deref()
                    .and_then(|b| cfg.profile_for_app(b, &front_name))
                    .map(|p| p.id.clone())
                    .unwrap_or_else(|| cfg.base_profile.clone())
            };
            if *st.active.lock().unwrap() != target {
                set_active(&app, &target, false);
            }
        }
    });
}

// ------------------------------------------------------------------ commands

#[tauri::command]
fn get_state(st: tauri::State<AppState>) -> StateDto {
    StateDto {
        config: st.config.lock().unwrap().clone(),
        active_profile: st.active.lock().unwrap().clone(),
        status: st.deck.status.lock().unwrap().clone(),
        front_app: st.front_app.lock().unwrap().clone(),
        accessibility: actions::accessibility_trusted(),
    }
}

#[tauri::command]
fn save_config(app: AppHandle, st: tauri::State<AppState>, mut config: Config) -> Result<(), String> {
    config.normalize();
    config.save(&st.config_path).map_err(|e| e.to_string())?;
    {
        let mut active = st.active.lock().unwrap();
        if config.profile(&active).is_none() {
            *active = config.base_profile.clone();
        }
        *st.config.lock().unwrap() = config;
    }
    push_leds(&app);
    Ok(())
}

#[tauri::command]
fn set_profile(app: AppHandle, id: String) {
    set_active(&app, &id, true);
}

#[tauri::command]
fn test_action(st: tauri::State<AppState>, action: Action) {
    let _ = st.actions.lock().unwrap().send(actions::Job::Run(action));
}

/// Live LED preview while editing (not persisted).
#[tauri::command]
fn preview_led(st: tauri::State<AppState>, key: u8, color: String) {
    if key < 15 && color.len() == 6 && color.chars().all(|c| c.is_ascii_hexdigit()) {
        st.deck.send(format!("L {key} {color}"));
    }
}

#[tauri::command]
fn preview_brightness(st: tauri::State<AppState>, value: u8) {
    st.deck.send(format!("B {}", value.min(96)));
}

/// Persist the current colours in the deck's flash (used in standalone mode).
#[tauri::command]
fn save_to_device(st: tauri::State<AppState>) {
    st.deck.send("S");
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
            let deck = Arc::new(Deck::default());
            app.manage(AppState {
                active: Mutex::new(config.base_profile.clone()),
                config: Mutex::new(config),
                front_app: Mutex::new(None),
                config_path,
                icon_cache,
                deck: deck.clone(),
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

            serial::spawn(app.handle().clone(), deck);
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
