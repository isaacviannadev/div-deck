//! USB serial link to the deck. A background thread finds the ESP32, handshakes with
//! `HELLO`, keeps it in host mode with `PING` every 2 s, forwards key events and writes
//! queued commands. Unplug/replug is handled by falling back to scanning.

use serde::Serialize;
use serialport::{SerialPort, SerialPortType};
use std::{
    io::{ErrorKind, Write},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckStatus {
    pub connected: bool,
    pub port: Option<String>,
    pub firmware: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct KeyEvent {
    pub key: u8,
    pub down: bool,
}

#[derive(Default)]
pub struct Deck {
    tx: Mutex<Option<mpsc::Sender<String>>>,
    pub status: Mutex<DeckStatus>,
}

impl Deck {
    /// Queue a protocol line (without newline). Dropped silently when no deck is connected.
    pub fn send(&self, line: impl Into<String>) {
        if let Some(tx) = self.tx.lock().unwrap().as_ref() {
            let _ = tx.send(line.into());
        }
    }
}

/// USB-UART bridges used on ESP32 boards: Silabs CP210x, WCH CH34x, FTDI, Espressif native USB.
const KNOWN_VIDS: [u16; 4] = [0x10C4, 0x1A86, 0x0403, 0x303A];

fn candidates() -> Vec<String> {
    let Ok(ports) = serialport::available_ports() else { return vec![] };
    let mut found: Vec<(u8, String)> = ports
        .into_iter()
        .filter_map(|p| {
            let name = p.port_name;
            // macOS lists every device twice (tty.* and cu.*); cu.* is the one that doesn't block on DCD.
            if cfg!(target_os = "macos") && !name.starts_with("/dev/cu.") {
                return None;
            }
            let usb_like = name.contains("usbserial") || name.contains("SLAB") || name.contains("wchusb") || name.contains("usbmodem");
            let rank = match &p.port_type {
                SerialPortType::UsbPort(u) if KNOWN_VIDS.contains(&u.vid) => 0,
                SerialPortType::UsbPort(_) => 1,
                _ if usb_like => 1,
                _ => return None,
            };
            Some((rank, name))
        })
        .collect();
    found.sort();
    found.into_iter().map(|(_, n)| n).collect()
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

/// Open a port and wait for the deck's HELLO. Returns the port and the firmware version.
fn probe(name: &str) -> Option<(Box<dyn SerialPort>, String, LineReader)> {
    let mut port = serialport::new(name, 115_200).timeout(Duration::from_millis(50)).open().ok()?;
    // Release the DevKit's auto-reset lines (DTR/RTS). This may reboot the ESP32 once,
    // so allow time for its boot + LED self-test before giving up.
    let _ = port.write_data_terminal_ready(false);
    let _ = port.write_request_to_send(false);
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
                let fw = rest.split_whitespace().next().unwrap_or("?").to_string();
                return Some((port, fw, reader));
            }
        }
    }
    None
}

fn set_status(app: &AppHandle, deck: &Deck, status: DeckStatus) {
    *deck.status.lock().unwrap() = status.clone();
    let _ = app.emit("deck://status", status);
}

pub fn spawn(app: AppHandle, deck: Arc<Deck>) {
    thread::Builder::new()
        .name("divdeck-serial".into())
        .spawn(move || loop {
            for name in candidates() {
                let Some((mut port, firmware, mut reader)) = probe(&name) else { continue };
                session(&app, &deck, &name, port.as_mut(), firmware, &mut reader);
            }
            thread::sleep(Duration::from_millis(1500));
        })
        .expect("spawn serial thread");
}

fn session(app: &AppHandle, deck: &Deck, name: &str, port: &mut dyn SerialPort, firmware: String, reader: &mut LineReader) {
    let (tx, rx) = mpsc::channel::<String>();
    *deck.tx.lock().unwrap() = Some(tx);
    set_status(app, deck, DeckStatus { connected: true, port: Some(name.into()), firmware: Some(firmware) });
    crate::push_leds(app);

    let mut last_ping = Instant::now();
    'session: loop {
        while let Ok(line) = rx.try_recv() {
            if port.write_all(format!("{line}\n").as_bytes()).is_err() {
                break 'session;
            }
        }
        if last_ping.elapsed() >= Duration::from_secs(2) {
            if port.write_all(b"PING\n").is_err() {
                break;
            }
            last_ping = Instant::now();
        }
        match reader.poll(port) {
            Ok(lines) => {
                for line in lines {
                    let mut it = line.split_whitespace();
                    let (Some(kind), Some(k)) = (it.next(), it.next().and_then(|k| k.parse::<u8>().ok())) else { continue };
                    match kind {
                        "D" => crate::on_key(app, k, true),
                        "U" => crate::on_key(app, k, false),
                        _ => {}
                    }
                }
            }
            Err(_) => break, // unplugged
        }
    }
    *deck.tx.lock().unwrap() = None;
    set_status(app, deck, DeckStatus::default());
}
