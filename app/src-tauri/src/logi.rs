//! Logitech Easy-Switch from a deck key: the same HID++ 2.0 request Logi Options+ sends
//! (feature 0x1814 CHANGE_HOST, setCurrentHost) to every keyboard/mouse that supports it.
//!
//! Bluetooth devices expose a vendor collection (usage page 0xFF43); Unifying/Bolt receivers
//! use page 0xFF00 with the paired devices at indices 1..6. On macOS a keyboard can only be
//! opened with the "Input Monitoring" permission.

use hidapi::{DeviceInfo, HidApi, HidDevice};
use serde::Serialize;
use std::{collections::HashMap, ffi::CString, sync::Mutex, time::Duration};

const LOGITECH: u16 = 0x046D;
const F_NAME: u16 = 0x0005;
const F_CHANGE_HOST: u16 = 0x1814;
const SW_ID: u8 = 0x0A;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogiDevice {
    pub name: String,
    /// Number of Easy-Switch channels and the active one (1-based).
    pub hosts: u8,
    pub current: u8,
}

struct Target {
    path: CString,
    dev: u8,
    feat: u8,
    name: String,
}

/// Names are slow to read over Bluetooth (16 chars per round trip): cached per path + index.
static NAMES: Mutex<Option<HashMap<(CString, u8), String>>> = Mutex::new(None);

fn hidpp_collection(i: &DeviceInfo) -> bool {
    i.vendor_id() == LOGITECH && ((i.usage_page() == 0xFF43 && i.usage() == 0x0202) || (i.usage_page() == 0xFF00 && i.usage() == 0x0002))
}

fn req(d: &HidDevice, dev: u8, feat: u8, fun: u8, args: &[u8]) -> Option<[u8; 16]> {
    let mut b = [0u8; 20];
    b[0] = 0x11;
    b[1] = dev;
    b[2] = feat;
    b[3] = (fun << 4) | SW_ID;
    b[4..4 + args.len()].copy_from_slice(args);
    d.write(&b).ok()?;
    let mut r = [0u8; 64];
    for _ in 0..16 {
        let n = d.read_timeout(&mut r, 250).ok()?;
        if n == 0 {
            return None;
        }
        if r[0] == 0x11 && r[1] == dev && r[2] == 0xFF && r[3] == feat {
            return None; // HID++ error (no such feature / device slot empty)
        }
        if (r[0] == 0x11 || r[0] == 0x10) && r[1] == dev && r[2] == feat && r[3] == b[3] {
            let mut out = [0u8; 16];
            out.copy_from_slice(&r[4..20]);
            return Some(out);
        }
    }
    None
}

fn feature(d: &HidDevice, dev: u8, id: u16) -> Option<u8> {
    req(d, dev, 0, 0, &[(id >> 8) as u8, id as u8]).map(|r| r[0]).filter(|&ix| ix != 0)
}

fn read_name(d: &HidDevice, dev: u8) -> Option<String> {
    let ix = feature(d, dev, F_NAME)?;
    let len = req(d, dev, ix, 0, &[])?[0] as usize;
    let mut name = String::new();
    while name.len() < len {
        let chunk = req(d, dev, ix, 1, &[name.len() as u8])?;
        let take = (len - name.len()).min(16);
        let part: String = chunk[..take].iter().take_while(|&&c| c != 0).map(|&c| c as char).collect();
        if part.is_empty() {
            break;
        }
        name.push_str(&part);
    }
    Some(name)
}

fn api() -> Result<HidApi, String> {
    HidApi::new().map_err(|e| format!("HID: {e}"))
}

/// Every device that answers CHANGE_HOST, with its name. `want_names`: also read names (slow).
fn scan(api: &HidApi, want_names: bool) -> (Vec<(Target, HidDevice)>, Vec<String>) {
    let mut found = vec![];
    let mut errors = vec![];
    let mut names = NAMES.lock().unwrap();
    let cache = names.get_or_insert_with(HashMap::new);
    for info in api.device_list().filter(|i| hidpp_collection(i)) {
        let d = match info.open_device(api) {
            Ok(d) => d,
            Err(_) => {
                errors.push(info.product_string().unwrap_or("Logitech").to_string());
                continue;
            }
        };
        let slots: Vec<u8> = if info.usage_page() == 0xFF43 { vec![0xFF] } else { (1..=6).collect() };
        let mut hits = vec![];
        for dev in slots {
            let Some(feat) = feature(&d, dev, F_CHANGE_HOST) else { continue };
            let key = (info.path().to_owned(), dev);
            let name = match cache.get(&key) {
                Some(n) => n.clone(),
                None if want_names => {
                    let n = read_name(&d, dev).unwrap_or_else(|| info.product_string().unwrap_or("Logitech").to_string());
                    cache.insert(key, n.clone());
                    n
                }
                None => info.product_string().unwrap_or("Logitech").to_string(),
            };
            hits.push(Target { path: info.path().to_owned(), dev, feat, name });
        }
        // one open handle per collection: reopen for each extra receiver slot
        let mut it = hits.into_iter();
        if let Some(first) = it.next() {
            found.push((first, d));
            for t in it {
                if let Ok(d2) = api.open_path(&t.path) {
                    found.push((t, d2));
                }
            }
        }
    }
    (found, errors)
}

/// The app's list for the action editor.
pub fn list() -> Result<Vec<LogiDevice>, String> {
    let api = api()?;
    let (found, errors) = scan(&api, true);
    let mut out = vec![];
    for (t, d) in &found {
        let info = req(d, t.dev, t.feat, 0, &[]);
        let (hosts, current) = info.map(|r| (r[0], r[1] + 1)).unwrap_or((3, 0));
        out.push(LogiDevice { name: t.name.clone(), hosts, current });
    }
    if out.is_empty() && !errors.is_empty() {
        return Err(format!("sem permissão para abrir: {} (Monitorização de entrada)", errors.join(", ")));
    }
    Ok(out)
}

/// Move the devices to channel `host` (1-based). Returns how many were switched.
pub fn change_host(host: u8, only: &[String]) -> Result<usize, String> {
    if !(1..=3).contains(&host) {
        return Err("canal inválido".into());
    }
    let api = api()?;
    let (found, errors) = scan(&api, !only.is_empty());
    let mut n = 0;
    for (t, d) in &found {
        if !only.is_empty() && !only.iter().any(|o| o == &t.name) {
            continue;
        }
        // setCurrentHost: the device leaves at once, so there is no reply to wait for
        let mut b = [0u8; 20];
        b[0] = 0x11;
        b[1] = t.dev;
        b[2] = t.feat;
        b[3] = (1 << 4) | SW_ID;
        b[4] = host - 1;
        if d.write(&b).is_ok() {
            n += 1;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if n == 0 {
        return Err(if errors.is_empty() {
            "nenhum teclado/rato Logitech com Easy-Switch encontrado".into()
        } else {
            format!("sem permissão para abrir: {} (Monitorização de entrada)", errors.join(", "))
        });
    }
    Ok(n)
}
