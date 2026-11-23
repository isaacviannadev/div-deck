//! USB serial links to the decks. A scanner thread probes every USB serial port that isn't
//! already in use, handshakes with `HELLO`, and starts one session thread per deck. Each session
//! keeps its deck in host mode with `PING` every 2 s, forwards key events and writes queued
//! commands. Any number of decks (DIV Deck MX and DIV Deck Pro) can be connected at once;
//! unplug/replug is handled by the scanner picking the port up again.
//!
//! HELLO reply from the firmware:
//!   HELLO DIVDECK <version> KEYS=15 [LEDS=15] [MODEL=MX|PRO] [ID=<chip id>]
//! Firmware from before v0.2 sends no MODEL/ID: it is treated as an MX and identified by its port.

use serde::Serialize;
use serialport::{SerialPort, SerialPortType};
use std::{
    collections::HashMap,
    io::{ErrorKind, Write},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    pub id: String,
    /// "mx" or "pro"
    pub model: String,
    pub port: String,
    pub firmware: String,
}

struct Link {
    tx: mpsc::Sender<String>,
    info: LinkInfo,
}

#[derive(Default)]
pub struct Decks {
    links: Mutex<HashMap<String, Link>>,
}

impl Decks {
    /// Queue a protocol line (without newline) for one deck. Dropped when it isn't connected.
    pub fn send(&self, id: &str, line: impl Into<String>) {
        if let Some(l) = self.links.lock().unwrap().get(id) {
            let _ = l.tx.send(line.into());
        }
    }
    pub fn broadcast(&self, line: &str) {
        for l in self.links.lock().unwrap().values() {
            let _ = l.tx.send(line.to_string());
        }
    }
    pub fn connected(&self) -> Vec<LinkInfo> {
        let mut v: Vec<LinkInfo> = self.links.lock().unwrap().values().map(|l| l.info.clone()).collect();
        v.sort_by(|a, b| a.port.cmp(&b.port));
        v
    }
    pub fn info(&self, id: &str) -> Option<LinkInfo> {
        self.links.lock().unwrap().get(id).map(|l| l.info.clone())
    }
    fn busy_ports(&self) -> Vec<String> {
        self.links.lock().unwrap().values().map(|l| l.info.port.clone()).collect()
    }
}

/// USB-UART bridges used on ESP32 boards: Silabs CP210x, WCH CH34x, FTDI, Espressif native USB (S3).
const KNOWN_VIDS: [u16; 4] = [0x10C4, 0x1A86, 0x0403, 0x303A];

/// Espressif's own USB (ESP32-S3/C3 native USB-Serial-JTAG): toggling DTR/RTS there resets the chip.
const ESPRESSIF_VID: u16 = 0x303A;

/// Ports worth probing, with "is native Espressif USB".
fn candidates() -> Vec<(String, bool)> {
    let Ok(ports) = serialport::available_ports() else { return vec![] };
    let mut found: Vec<(u8, String, bool)> = ports
        .into_iter()
        .filter_map(|p| {
            let name = p.port_name;
            // macOS lists every device twice (tty.* and cu.*); cu.* is the one that doesn't block on DCD.
            if cfg!(target_os = "macos") && !name.starts_with("/dev/cu.") {
                return None;
            }
            let usb_like = name.contains("usbserial") || name.contains("SLAB") || name.contains("wchusb") || name.contains("usbmodem");
            let native = matches!(&p.port_type, SerialPortType::UsbPort(u) if u.vid == ESPRESSIF_VID);
            let rank = match &p.port_type {
                SerialPortType::UsbPort(u) if KNOWN_VIDS.contains(&u.vid) => 0,
                SerialPortType::UsbPort(_) => 1,
                _ if usb_like => 1,
                _ => return None,
            };
            Some((rank, name, native))
        })
        .collect();
    found.sort();
    found.into_iter().map(|(_, n, native)| (n, native)).collect()
}

#[derive(Default)]
struct LineReader {
    buf: Vec<u8>,
}

impl LineReader {
    fn poll(&mut self, port: &mut dyn SerialPort) -> std::io::Result<Vec<String>> {
        let mut chunk = [0u8; 256];
        match port.read(&mut chunk) {
            Ok(0) => {}
            Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock => {}
            Err(e) => return Err(e),
        }
        let mut lines = vec![];
        while let Some(i) = self.buf.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = self.buf.drain(..=i).collect();
            let line = String::from_utf8_lossy(&raw).trim().to_string();
            if !line.is_empty() {
                lines.push(line);
            }
        }
        if self.buf.len() > 1024 {
            self.buf.clear(); // garbage (e.g. ROM boot messages at another baud rate)
        }
        Ok(lines)
    }
}

/// "HELLO DIVDECK 1.2.0 KEYS=15 MODEL=PRO ID=a1b2c3" -> LinkInfo
fn parse_hello(rest: &str, port: &str) -> LinkInfo {
    let mut it = rest.split_whitespace();
    let firmware = it.next().unwrap_or("?").to_string();
    let mut model = "mx".to_string();
    let mut id = String::new();
    for kv in it {
        if let Some(v) = kv.strip_prefix("MODEL=") {
            model = v.to_ascii_lowercase();
        } else if let Some(v) = kv.strip_prefix("ID=") {
            id = v.to_ascii_lowercase();
        }
    }
    if id.is_empty() {
        // old firmware: the USB-serial port name is stable per board (CP210x serial number)
        id = format!("port-{}", port.rsplit('/').next().unwrap_or(port).replace(['.', ' '], "-"));
    } else {
        id = format!("{model}-{id}");
    }
    LinkInfo { id, model, port: port.to_string(), firmware }
}

/// Open a port and wait for the deck's HELLO.
fn probe(name: &str, native: bool) -> Option<(Box<dyn SerialPort>, LinkInfo, LineReader)> {
    let mut port = serialport::new(name, 115_200).timeout(Duration::from_millis(50)).open().ok()?;
    if !native {
        // Release the DevKit's auto-reset lines (DTR/RTS). This may reboot the ESP32 once,
        // so allow time for its boot + LED self-test before giving up.
        // Never on the S3's native USB: there these lines reset the chip and it drops off the bus.
        let _ = port.write_data_terminal_ready(false);
        let _ = port.write_request_to_send(false);
    }
    let mut reader = LineReader::default();
    let deadline = Instant::now() + Duration::from_millis(3500);
    let mut last_hello = Instant::now() - Duration::from_secs(1);
    while Instant::now() < deadline {
        if last_hello.elapsed() > Duration::from_millis(600) {
            port.write_all(b"HELLO\n").ok()?;
            last_hello = Instant::now();
        }
        for line in reader.poll(port.as_mut()).ok()? {
            if let Some(rest) = line.strip_prefix("HELLO DIVDECK") {
                return Some((port, parse_hello(rest, name), reader));
            }
        }
    }
    None
}

pub fn spawn(app: AppHandle, decks: Arc<Decks>) {
    thread::Builder::new()
        .name("divdeck-scan".into())
        .spawn(move || loop {
            let busy = decks.busy_ports();
            for (name, native) in candidates().into_iter().filter(|(n, _)| !busy.contains(n)) {
                let Some((port, info, reader)) = probe(&name, native) else { continue };
                if decks.links.lock().unwrap().contains_key(&info.id) {
                    continue; // same deck seen on two ports (shouldn't happen)
                }
                let (app, decks) = (app.clone(), decks.clone());
                let _ = thread::Builder::new()
                    .name(format!("divdeck-{}", info.id))
                    .spawn(move || session(&app, &decks, port, info, reader));
            }
            thread::sleep(Duration::from_millis(1500));
        })
        .expect("spawn serial thread");
}

fn session(app: &AppHandle, decks: &Decks, mut port: Box<dyn SerialPort>, info: LinkInfo, mut reader: LineReader) {
    let (tx, rx) = mpsc::channel::<String>();
    let id = info.id.clone();
    decks.links.lock().unwrap().insert(id.clone(), Link { tx, info: info.clone() });
    crate::on_deck_connected(app, &info);

    let mut last_ping = Instant::now();
    'session: loop {
        let mut wrote = false;
        while let Ok(line) = rx.try_recv() {
            if port.write_all(format!("{line}\n").as_bytes()).is_err() {
                break 'session;
            }
            wrote = true;
        }
        if wrote {
            let _ = port.flush();
        }
        if last_ping.elapsed() >= Duration::from_secs(2) {
            if port.write_all(b"PING\n").is_err() {
                break;
            }
            last_ping = Instant::now();
        }
        match reader.poll(port.as_mut()) {
            Ok(lines) => {
                for line in lines {
                    if let Some(hash) = line.strip_prefix("NEED ") {
                        crate::on_icon_needed(app, &id, hash.trim());
                        continue;
                    }
                    let mut it = line.split_whitespace();
                    let (Some(kind), Some(k)) = (it.next(), it.next().and_then(|k| k.parse::<u8>().ok())) else { continue };
                    match kind {
                        "D" => crate::on_key(app, &id, k, true),
                        "U" => crate::on_key(app, &id, k, false),
                        _ => {}
                    }
                }
            }
            Err(_) => break, // unplugged
        }
    }
    decks.links.lock().unwrap().remove(&id);
    crate::on_deck_disconnected(app, &id);
}

#[cfg(test)]
mod tests {
    use super::parse_hello;
    #[test]
    fn hello_old_and_new() {
        let a = parse_hello(" 1.0.0 KEYS=15 LEDS=15", "/dev/cu.usbserial-0001");
        assert_eq!((a.model.as_str(), a.id.as_str(), a.firmware.as_str()), ("mx", "port-cu-usbserial-0001", "1.0.0"));
        let b = parse_hello(" 0.2.0 KEYS=15 MODEL=PRO ID=A1B2C3", "/dev/cu.usbmodem101");
        assert_eq!((b.model.as_str(), b.id.as_str()), ("pro", "pro-a1b2c3"));
    }
}
