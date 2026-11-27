//! Executes key actions. Keyboard/media events go through enigo on a dedicated thread so a
//! slow action never blocks the serial reader.

use crate::config::{Action, MediaKey};
use enigo::{Button, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use std::{cell::RefCell, process::Command, sync::{mpsc, OnceLock}, thread, time::Duration};

pub enum Job {
    Run(Action),
}

/// Needed to reach the main thread: on recent macOS the keyboard-layout lookups that enigo does
/// (TSMGetInputSourceProperty) abort the app when called from any other thread.
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

thread_local! {
    static ENIGO: RefCell<Option<Enigo>> = const { RefCell::new(None) };
}

pub fn spawn_worker(app: tauri::AppHandle) -> mpsc::Sender<Job> {
    let _ = APP.set(app);
    let (tx, rx) = mpsc::channel::<Job>();
    thread::Builder::new()
        .name("divdeck-actions".into())
        .spawn(move || {
            for job in rx {
                let Job::Run(action) = job;
                if let Err(e) = run_at(&action, 0) {
                    eprintln!("[divdeck] action failed: {e}");
                }
            }
        })
        .expect("spawn action worker");
    tx
}

fn with_enigo<F>(f: F) -> Result<(), String>
where
    F: FnOnce(&mut Enigo) -> Result<(), String>,
{
    ENIGO.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            let settings = Settings { open_prompt_to_get_permissions: true, ..Settings::default() };
            *slot = Some(Enigo::new(&settings).map_err(|e| e.to_string())?);
        }
        f(slot.as_mut().unwrap())
    })
}

/// Run a keyboard/media operation. macOS: on the main thread (waits for it), elsewhere: right here.
fn kb<F>(f: F) -> Result<(), String>
where
    F: FnOnce(&mut Enigo) -> Result<(), String> + Send + 'static,
{
    #[cfg(target_os = "macos")]
    {
        let app = APP.get().ok_or("app not ready")?;
        let (tx, rx) = mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(with_enigo(f));
        })
        .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "keyboard timed out".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        with_enigo(f)
    }
}

/// Gap between the steps of a sequence, so apps keep up with synthetic input.
const STEP_GAP: Duration = Duration::from_millis(60);

fn run_at(action: &Action, depth: u8) -> Result<(), String> {
    match action {
        Action::None | Action::SwitchProfile { .. } => Ok(()), // profile switch is handled by the caller
        Action::OpenApp { path, name } => open_app(path, name),
        Action::OpenUrl { url } => open_url(url),
        Action::Shell { command } => shell(command),
        Action::Wait { ms } => {
            thread::sleep(Duration::from_millis((*ms).min(10_000) as u64));
            Ok(())
        }
        Action::Sequence { steps, exact } => {
            if depth > 2 {
                return Err("sequence nested too deep".into());
            }
            for (i, step) in steps.iter().enumerate() {
                if i > 0 && !*exact && !matches!(step, Action::Wait { .. }) {
                    thread::sleep(STEP_GAP);
                }
                run_at(step, depth + 1)?;
            }
            Ok(())
        }
        Action::Key { key, hold_ms, repeat, gap_ms } => {
            let k = parse_key(key).or_else(|| parse_mod(key)).ok_or_else(|| format!("unknown key '{key}'"))?;
            let n = (*repeat).clamp(1, 50);
            for i in 0..n {
                if i > 0 {
                    thread::sleep(Duration::from_millis((*gap_ms).min(5_000) as u64));
                }
                kb(move |e| e.key(k, Direction::Press).map_err(|e| e.to_string()))?;
                thread::sleep(Duration::from_millis((*hold_ms).clamp(1, 2_000) as u64));
                kb(move |e| e.key(k, Direction::Release).map_err(|e| e.to_string()))?;
            }
            Ok(())
        }
        Action::KeyEvent { key, down } => {
            let k = parse_key(key).or_else(|| parse_mod(key)).ok_or_else(|| format!("unknown key '{key}'"))?;
            let d = if *down { Direction::Press } else { Direction::Release };
            kb(move |e| e.key(k, d).map_err(|e| e.to_string()))
        }
        Action::Mouse { button, down } => {
            let b = match button.as_str() {
                "right" => Button::Right,
                "middle" => Button::Middle,
                _ => Button::Left,
            };
            let d = match down {
                None => Direction::Click,
                Some(true) => Direction::Press,
                Some(false) => Direction::Release,
            };
            kb(move |e| e.button(b, d).map_err(|e| e.to_string()))
        }
        Action::ChangeHost { targets, host, devices } => {
            crate::logi::change_host(Action::host_plan(targets, *host, devices)).map(|_| ())
        }
        Action::TypeText { text, submit } => {
            if !text.is_empty() {
                let t = text.clone();
                kb(move |e| e.text(&t).map_err(|e| e.to_string()))?;
            }
            if *submit {
                thread::sleep(Duration::from_millis(40));
                kb(|e| e.key(Key::Return, Direction::Click).map_err(|e| e.to_string()))?;
            }
            Ok(())
        }
        Action::Media { key } => {
            let k = match key {
                MediaKey::PlayPause => Key::MediaPlayPause,
                MediaKey::Next => Key::MediaNextTrack,
                MediaKey::Previous => Key::MediaPrevTrack,
                MediaKey::VolumeUp => Key::VolumeUp,
                MediaKey::VolumeDown => Key::VolumeDown,
                MediaKey::Mute => Key::VolumeMute,
            };
            kb(move |e| e.key(k, Direction::Click).map_err(|e| e.to_string()))
        }
        Action::Shortcut { mods, key } => {
            let main = parse_key(key).ok_or_else(|| format!("unknown key '{key}'"))?;
            let mods: Vec<Key> = mods.iter().filter_map(|m| parse_mod(m)).collect();
            kb(move |e| {
                for m in &mods {
                    e.key(*m, Direction::Press).map_err(|e| e.to_string())?;
                }
                let res = e.key(main, Direction::Click).map_err(|e| e.to_string());
                for m in mods.iter().rev() {
                    let _ = e.key(*m, Direction::Release);
                }
                res
            })
        }
    }
}

fn spawn(cmd: &str, args: &[&str]) -> Result<(), String> {
    let mut c = Command::new(cmd);
    c.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing
    }
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn open_app(path: &str, _name: &str) -> Result<(), String> {
    spawn("open", &["-a", path])
}
#[cfg(not(windows))]
fn open_url(url: &str) -> Result<(), String> {
    spawn("open", &[url])
}
#[cfg(not(windows))]
fn shell(command: &str) -> Result<(), String> {
    spawn("/bin/zsh", &["-lc", command])
}

#[cfg(windows)]
fn open_app(path: &str, name: &str) -> Result<(), String> {
    // path is a Start-menu .lnk or an .exe; built-in presets only carry the app name,
    // so look that up among the Start-menu shortcuts.
    if std::path::Path::new(path).exists() {
        return spawn("explorer.exe", &[path]);
    }
    let want = name.to_lowercase();
    let apps = crate::apps::list();
    let hit = apps.iter().find(|a| a.name.to_lowercase() == want)
        .or_else(|| apps.iter().find(|a| a.name.to_lowercase().contains(&want)));
    match hit {
        Some(a) => spawn("explorer.exe", &[&a.path]),
        None => Err(format!("app '{name}' not found in the Start menu")),
    }
}
#[cfg(windows)]
fn open_url(url: &str) -> Result<(), String> {
    spawn("rundll32.exe", &["url.dll,FileProtocolHandler", url])
}
#[cfg(windows)]
fn shell(command: &str) -> Result<(), String> {
    spawn("cmd.exe", &["/C", command])
}

fn parse_mod(m: &str) -> Option<Key> {
    Some(match m {
        // profiles are written with macOS modifiers; on Windows ⌘ maps to Ctrl
        "cmd" if cfg!(windows) => Key::Control,
        "cmd" => Key::Meta,
        "ctrl" | "Control" => Key::Control,
        "alt" | "Alt" => Key::Alt,
        "shift" | "Shift" => Key::Shift,
        "Meta" => Key::Meta,
        _ => return None,
    })
}

pub(crate) fn parse_key(k: &str) -> Option<Key> {
    if let Some(code) = k.strip_prefix("code:") {
        return code.parse::<u32>().ok().map(Key::Other); // raw key code (recorded on this OS)
    }
    let mut chars = k.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return Some(Key::Unicode(c.to_ascii_lowercase()));
    }
    Some(match k {
        "Return" | "Enter" => Key::Return,
        "Space" => Key::Space,
        "Tab" => Key::Tab,
        "Escape" => Key::Escape,
        "Backspace" => Key::Backspace,
        "Delete" => Key::Delete,
        "Left" => Key::LeftArrow,
        "Right" => Key::RightArrow,
        "Up" => Key::UpArrow,
        "Down" => Key::DownArrow,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        f if f.starts_with('F') => match f[1..].parse::<u8>().ok()? {
            1 => Key::F1,
            2 => Key::F2,
            3 => Key::F3,
            4 => Key::F4,
            5 => Key::F5,
            6 => Key::F6,
            7 => Key::F7,
            8 => Key::F8,
            9 => Key::F9,
            10 => Key::F10,
            11 => Key::F11,
            12 => Key::F12,
            13 => Key::F13,
            14 => Key::F14,
            15 => Key::F15,
            16 => Key::F16,
            17 => Key::F17,
            18 => Key::F18,
            19 => Key::F19,
            20 => Key::F20,
            _ => return None,
        },
        _ => return None,
    })
}

/// Accessibility permission is required to send keystrokes on macOS.
#[cfg(target_os = "macos")]
pub fn accessibility_trusted() -> bool {
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    unsafe { AXIsProcessTrusted() }
}

#[cfg(not(target_os = "macos"))]
pub fn accessibility_trusted() -> bool {
    true
}

/// Ask macOS for the Accessibility permission (system prompt + entry in Settings).
/// `reset` first clears a stale entry: after an update signed differently, the switch can show "on"
/// for the old build while the new one isn't actually trusted.
#[cfg(target_os = "macos")]
pub fn request_accessibility(reset: bool) -> bool {
    use std::ffi::c_void;
    if reset {
        let _ = Command::new("/usr/bin/tccutil").args(["reset", "Accessibility", "com.divtecnologia.divdeck"]).status();
    }
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        static kAXTrustedCheckOptionPrompt: *const c_void;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFBooleanTrue: *const c_void;
        static kCFTypeDictionaryKeyCallBacks: u8;
        static kCFTypeDictionaryValueCallBacks: u8;
        fn CFDictionaryCreate(alloc: *const c_void, keys: *const *const c_void, values: *const *const c_void, n: isize,
                              kcb: *const c_void, vcb: *const c_void) -> *const c_void;
        fn CFRelease(cf: *const c_void);
    }
    unsafe {
        let keys = [kAXTrustedCheckOptionPrompt];
        let values = [kCFBooleanTrue];
        let dict = CFDictionaryCreate(
            std::ptr::null(), keys.as_ptr(), values.as_ptr(), 1,
            &raw const kCFTypeDictionaryKeyCallBacks as *const c_void, &raw const kCFTypeDictionaryValueCallBacks as *const c_void,
        );
        let ok = AXIsProcessTrustedWithOptions(dict);
        if !dict.is_null() {
            CFRelease(dict);
        }
        ok
    }
}

#[cfg(not(target_os = "macos"))]
pub fn request_accessibility(_reset: bool) -> bool {
    true
}
