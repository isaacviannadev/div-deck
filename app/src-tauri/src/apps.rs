//! Installed applications (for the "open app" action and per-app profiles) and their icons.

use base64::Engine;
use serde::Serialize;
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub path: String,
    pub bundle_id: Option<String>,
    /// Path of the .icns file, if the bundle has one (newer apps may only ship Assets.car).
    pub icon: Option<String>,
}

#[cfg(not(windows))]
fn read_app(path: &Path) -> Option<AppInfo> {
    let name = path.file_stem()?.to_string_lossy().to_string();
    let plist = plist::Value::from_file(path.join("Contents/Info.plist")).ok();
    let dict = plist.as_ref().and_then(|v| v.as_dictionary());
    let get = |k: &str| dict.and_then(|d| d.get(k)).and_then(|v| v.as_string()).map(str::to_string);
    let icon = get("CFBundleIconFile").and_then(|f| {
        let f = if f.ends_with(".icns") { f } else { format!("{f}.icns") };
        let p = path.join("Contents/Resources").join(f);
        p.exists().then(|| p.to_string_lossy().to_string())
    });
    Some(AppInfo { name, path: path.to_string_lossy().to_string(), bundle_id: get("CFBundleIdentifier"), icon })
}

#[cfg(not(windows))]
fn scan(dir: &Path, depth: u8, out: &mut Vec<AppInfo>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().is_some_and(|x| x == "app") {
            if let Some(a) = read_app(&p) {
                out.push(a);
            }
        } else if depth > 0 && p.is_dir() {
            scan(&p, depth - 1, out); // e.g. /Applications/Utilities, vendor folders
        }
    }
}

#[cfg(not(windows))]
pub fn list() -> Vec<AppInfo> {
    let mut roots: Vec<PathBuf> = vec!["/Applications".into(), "/System/Applications".into()];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    let mut out = vec![];
    for r in &roots {
        scan(r, 1, &mut out);
    }
    if let Some(f) = read_app(Path::new("/System/Library/CoreServices/Finder.app")) {
        out.push(f);
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    out.dedup_by(|a, b| a.path == b.path);
    out
}

/// Windows: Start-menu shortcuts. `bundle_id` holds the target exe name (e.g. "Code"),
/// which is what the frontmost-app watcher reports, so profiles can link to it.
#[cfg(windows)]
pub fn list() -> Vec<AppInfo> {
    fn scan_lnk(dir: &Path, depth: u8, out: &mut Vec<AppInfo>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("lnk")) {
                let name = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
                let lower = name.to_lowercase();
                if lower.contains("uninstall") || lower.contains("desinstal") {
                    continue;
                }
                let target = lnk::ShellLink::open(&p, lnk::encoding::WINDOWS_1252)
                    .ok()
                    .and_then(|l| l.link_target());
                let exe = target
                    .as_deref()
                    .map(Path::new)
                    .filter(|t| t.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")))
                    .and_then(|t| t.file_stem())
                    .map(|s| s.to_string_lossy().to_string());
                out.push(AppInfo { name, path: p.to_string_lossy().to_string(), bundle_id: exe, icon: None });
            } else if depth > 0 && p.is_dir() {
                scan_lnk(&p, depth - 1, out);
            }
        }
    }
    let mut out = vec![];
    for var in ["ProgramData", "APPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            scan_lnk(&PathBuf::from(base).join("Microsoft/Windows/Start Menu/Programs"), 2, &mut out);
        }
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    out.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
    out
}

/// Convert an .icns to a 64 px PNG (cached) and return it as a data URL.
pub fn icon_data_url(icns: &str, cache_dir: &Path) -> Option<String> {
    let mut h = DefaultHasher::new();
    icns.hash(&mut h);
    let png = cache_dir.join(format!("{:016x}.png", h.finish()));
    if !png.exists() {
        fs::create_dir_all(cache_dir).ok()?;
        let ok = Command::new("/usr/bin/sips")
            .args(["-s", "format", "png", "-Z", "64", icns, "--out"])
            .arg(&png)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            return None;
        }
    }
    let bytes = fs::read(png).ok()?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// (bundle id, name) of the frontmost application. Must run on the main thread.
#[cfg(target_os = "macos")]
pub fn frontmost_app() -> Option<(String, String)> {
    use objc2_app_kit::NSWorkspace;
    let ws = NSWorkspace::sharedWorkspace();
    let app = ws.frontmostApplication()?;
    let bid = app.bundleIdentifier().map(|s| s.to_string()).unwrap_or_default();
    let name = app.localizedName().map(|s| s.to_string()).unwrap_or_default();
    Some((bid, name))
}

/// Windows: exe name (without .exe) of the foreground window's process, used as both id and name.
#[cfg(windows)]
pub fn frontmost_app() -> Option<(String, String)> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION},
        UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
    };
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        if ok == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let stem = Path::new(&path).file_stem()?.to_string_lossy().to_string();
        Some((stem.clone(), stem))
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn frontmost_app() -> Option<(String, String)> {
    None
}
