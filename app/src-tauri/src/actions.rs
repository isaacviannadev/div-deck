//! Executes key actions. Keyboard/media events go through enigo on a dedicated thread so a
//! slow action never blocks the serial reader.

use crate::config::{Action, MediaKey};
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::{process::Command, sync::mpsc, thread, time::Duration};

pub enum Job {
    Run(Action),
}

pub fn spawn_worker() -> mpsc::Sender<Job> {
    let (tx, rx) = mpsc::channel::<Job>();
    thread::Builder::new()
        .name("divdeck-actions".into())
        .spawn(move || {
            let mut enigo: Option<Enigo> = None;
            for job in rx {
                let Job::Run(action) = job;
                if let Err(e) = run(&action, &mut enigo) {
                    eprintln!("[divdeck] action failed: {e}");
                }
            }
        })
        .expect("spawn action worker");
    tx
}

fn enigo(slot: &mut Option<Enigo>) -> Result<&mut Enigo, String> {
    if slot.is_none() {
        let settings = Settings { open_prompt_to_get_permissions: true, ..Settings::default() };
        *slot = Some(Enigo::new(&settings).map_err(|e| e.to_string())?);
    }
    Ok(slot.as_mut().unwrap())
}

/// Gap between the steps of a sequence, so apps keep up with synthetic input.
const STEP_GAP: Duration = Duration::from_millis(60);

fn run(action: &Action, slot: &mut Option<Enigo>) -> Result<(), String> {
    run_at(action, slot, 0)
}

fn run_at(action: &Action, slot: &mut Option<Enigo>, depth: u8) -> Result<(), String> {
    match action {
        Action::None | Action::SwitchProfile { .. } => Ok(()), // profile switch is handled by the caller
        Action::OpenApp { path, name } => open_app(path, name),
        Action::OpenUrl { url } => open_url(url),
        Action::Shell { command } => shell(command),
        Action::Wait { ms } => {
            thread::sleep(Duration::from_millis((*ms).min(10_000) as u64));
            Ok(())
        }
        Action::Sequence { steps } => {
            if depth > 2 {
                return Err("sequence nested too deep".into());
            }
            for (i, step) in steps.iter().enumerate() {
                if i > 0 && !matches!(step, Action::Wait { .. }) {
                    thread::sleep(STEP_GAP);
                }
                run_at(step, slot, depth + 1)?;
            }
            Ok(())
        }
        Action::TypeText { text, submit } => {
            let e = enigo(slot)?;
            if !text.is_empty() {
                e.text(text).map_err(|e| e.to_string())?;
            }
            if *submit {
                thread::sleep(Duration::from_millis(40));
                e.key(Key::Return, Direction::Click).map_err(|e| e.to_string())?;
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
            enigo(slot)?.key(k, Direction::Click).map_err(|e| e.to_string())
        }
        Action::Shortcut { mods, key } => {
            let main = parse_key(key).ok_or_else(|| format!("unknown key '{key}'"))?;
            let mods: Vec<Key> = mods.iter().filter_map(|m| parse_mod(m)).collect();
            let e = enigo(slot)?;
            for m in &mods {
                e.key(*m, Direction::Press).map_err(|e| e.to_string())?;
            }
            let res = e.key(main, Direction::Click).map_err(|e| e.to_string());
            for m in mods.iter().rev() {
                let _ = e.key(*m, Direction::Release);
            }
            res
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
        "ctrl" => Key::Control,
        "alt" => Key::Alt,
        "shift" => Key::Shift,
        _ => return None,
    })
}

fn parse_key(k: &str) -> Option<Key> {
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
