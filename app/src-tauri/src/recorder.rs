//! Macro recorder: captures what the user types/clicks (with timing) and turns it into the steps of
//! a Sequence. Flow: the editor arms the recorder; the first press of any deck key starts it,
//! the next one stops it (the deck is a serial device, so its own presses never pollute the
//! recording). On macOS this needs the "Input Monitoring" permission (listen-only event tap).

use crate::config::Action;
use serde::Serialize;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Idle,
    Armed,
    Recording,
}

/// One captured input: a key (macOS key code) or a mouse button, pressed or released.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum Input {
    Key(u16),
    Mouse(u8), // 0 left, 1 right, 2 middle
}

#[derive(Clone, Copy, Debug)]
pub struct Ev {
    pub t: u32, // ms since the start
    pub input: Input,
    pub down: bool,
}

static STATE: Mutex<State> = Mutex::new(State::Idle);

pub fn state() -> State {
    *STATE.lock().unwrap()
}
fn set_state(s: State) {
    *STATE.lock().unwrap() = s;
}

pub fn arm() -> Result<(), String> {
    if !imp::listen_access(true) {
        return Err("permissão".into());
    }
    imp::stop(); // a previous recording that was never finished
    set_state(State::Armed);
    Ok(())
}

pub fn start() -> Result<(), String> {
    imp::start()?;
    set_state(State::Recording);
    Ok(())
}

/// Stop and return the steps (None when nothing was recording).
pub fn finish() -> Option<Vec<Action>> {
    let was = state();
    set_state(State::Idle);
    let evs = imp::stop();
    (was == State::Recording).then(|| to_steps(&evs))
}

pub fn cancel() {
    set_state(State::Idle);
    imp::stop();
}

pub fn has_access(request: bool) -> bool {
    imp::listen_access(request)
}

/// Modifier key codes become named keys, so playback sets the modifier flags properly.
fn key_name(code: u16) -> String {
    match code {
        54 | 55 => "Meta".into(),
        56 | 60 => "Shift".into(),
        58 | 61 => "Alt".into(),
        59 | 62 => "Control".into(),
        c => format!("code:{c}"),
    }
}

fn mouse_name(b: u8) -> String {
    ["left", "right", "middle"].get(b as usize).unwrap_or(&"left").to_string()
}

fn tap_step(input: Input, hold: u32) -> Action {
    match input {
        Input::Key(c) => Action::Key { key: key_name(c), hold_ms: hold.clamp(10, 2000), repeat: 1, gap_ms: 0 },
        Input::Mouse(b) => Action::Mouse { button: mouse_name(b), down: None },
    }
}

fn raw_step(e: &Ev) -> Action {
    match e.input {
        Input::Key(c) => Action::KeyEvent { key: key_name(c), down: e.down },
        Input::Mouse(b) => Action::Mouse { button: mouse_name(b), down: Some(e.down) },
    }
}

/// Recorded events -> editable steps: a press immediately followed by its release becomes one
/// "Key" (with the real hold time), overlapping ones stay as press/release; real pauses become
/// Wait steps, and a key tapped several times at an even pace collapses into "key x N".
pub fn to_steps(evs: &[Ev]) -> Vec<Action> {
    // drop releases whose press happened before the recording (e.g. the key used to start)
    let mut held: Vec<Input> = vec![];
    let mut clean: Vec<Ev> = vec![];
    for e in evs {
        if e.down {
            held.push(e.input);
            clean.push(*e);
        } else if let Some(p) = held.iter().position(|h| *h == e.input) {
            held.remove(p);
            clean.push(*e);
        }
    }
    // still held at the end: a mouse press is the click on "Parar" in the app (drop it),
    // a key gets released
    let end = clean.last().map(|e| e.t).unwrap_or(0);
    for h in held {
        match h {
            Input::Mouse(_) => {
                if let Some(p) = clean.iter().rposition(|e| e.input == h && e.down) {
                    clean.remove(p);
                }
            }
            Input::Key(_) => clean.push(Ev { t: end + 1, input: h, down: false }),
        }
    }

    // (step, start, end) on the timeline
    let mut timed: Vec<(Action, u32, u32)> = vec![];
    let mut i = 0;
    while i < clean.len() {
        let e = clean[i];
        if e.down && i + 1 < clean.len() && !clean[i + 1].down && clean[i + 1].input == e.input {
            timed.push((tap_step(e.input, clean[i + 1].t - e.t), e.t, clean[i + 1].t));
            i += 2;
        } else {
            timed.push((raw_step(&e), e.t, e.t));
            i += 1;
        }
    }

    let mut steps: Vec<Action> = vec![];
    let mut last_end: Option<u32> = None;
    for (a, start, end) in timed {
        if let Some(prev) = last_end {
            let gap = start.saturating_sub(prev);
            // merge "same key again at the same pace" into a repeat
            if let (Some(Action::Key { key, hold_ms: _, repeat, gap_ms }), Action::Key { key: k2, .. }) = (steps.last_mut(), &a) {
                let even = *repeat == 1 || (gap as i64 - *gap_ms as i64).unsigned_abs() as u32 <= (*gap_ms / 3).max(30);
                if key == k2 && gap <= 600 && even {
                    *gap_ms = if *repeat == 1 { gap } else { (*gap_ms * (*repeat - 1) + gap) / *repeat };
                    *repeat += 1;
                    last_end = Some(end);
                    continue;
                }
            }
            if gap >= 5 {
                steps.push(Action::Wait { ms: gap.min(10_000) });
            }
        }
        steps.push(a);
        last_end = Some(end);
    }
    // a single tap keeps gap 0; give repeats without a measured gap a sane default
    for s in steps.iter_mut() {
        if let Action::Key { repeat, gap_ms, .. } = s {
            if *repeat == 1 {
                *gap_ms = 60;
            }
        }
    }
    steps
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{Ev, Input};
    use core_foundation::runloop::{kCFRunLoopCommonModes, kCFRunLoopDefaultMode, CFRunLoop};
    use core_graphics::event::{
        CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType, CallbackResult,
        EventField,
    };
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc, Mutex,
        },
        thread,
        time::{Duration, Instant},
    };

    struct Active {
        stop: Arc<AtomicBool>,
        events: Arc<Mutex<Vec<Ev>>>,
        thread: thread::JoinHandle<()>,
    }
    static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightListenEventAccess() -> bool;
        fn CGRequestListenEventAccess() -> bool;
    }

    pub fn listen_access(request: bool) -> bool {
        unsafe {
            if CGPreflightListenEventAccess() {
                return true;
            }
            request && CGRequestListenEventAccess()
        }
    }

    fn modifier_down(code: u16, flags: CGEventFlags) -> Option<bool> {
        let bit = match code {
            54 | 55 => CGEventFlags::CGEventFlagCommand,
            56 | 60 => CGEventFlags::CGEventFlagShift,
            58 | 61 => CGEventFlags::CGEventFlagAlternate,
            59 | 62 => CGEventFlags::CGEventFlagControl,
            _ => return None, // caps lock, fn: not recorded
        };
        Some(flags.contains(bit))
    }

    pub fn start() -> Result<(), String> {
        stop();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let events: Arc<Mutex<Vec<Ev>>> = Default::default();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let (sf, ev) = (stop_flag.clone(), events.clone());
        let thread = thread::Builder::new()
            .name("divdeck-recorder".into())
            .spawn(move || {
                let t0 = Instant::now();
                let sink = ev.clone();
                let tap = CGEventTap::new(
                    CGEventTapLocation::Session,
                    CGEventTapPlacement::HeadInsertEventTap,
                    CGEventTapOptions::ListenOnly,
                    vec![
                        CGEventType::KeyDown,
                        CGEventType::KeyUp,
                        CGEventType::FlagsChanged,
                        CGEventType::LeftMouseDown,
                        CGEventType::LeftMouseUp,
                        CGEventType::RightMouseDown,
                        CGEventType::RightMouseUp,
                        CGEventType::OtherMouseDown,
                        CGEventType::OtherMouseUp,
                    ],
                    move |_proxy, etype, event| {
                        let t = t0.elapsed().as_millis() as u32;
                        let code = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as u16;
                        let rec = match etype {
                            CGEventType::KeyDown => {
                                if event.get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT) != 0 {
                                    None // key held down: macOS repeats, the recording keeps one press
                                } else {
                                    Some((Input::Key(code), true))
                                }
                            }
                            CGEventType::KeyUp => Some((Input::Key(code), false)),
                            CGEventType::FlagsChanged => modifier_down(code, event.get_flags()).map(|d| (Input::Key(code), d)),
                            CGEventType::LeftMouseDown => Some((Input::Mouse(0), true)),
                            CGEventType::LeftMouseUp => Some((Input::Mouse(0), false)),
                            CGEventType::RightMouseDown => Some((Input::Mouse(1), true)),
                            CGEventType::RightMouseUp => Some((Input::Mouse(1), false)),
                            CGEventType::OtherMouseDown => Some((Input::Mouse(2), true)),
                            CGEventType::OtherMouseUp => Some((Input::Mouse(2), false)),
                            _ => None,
                        };
                        if let Some((input, down)) = rec {
                            if let Ok(mut v) = sink.lock() {
                                if v.len() < 5000 {
                                    v.push(Ev { t, input, down });
                                }
                            }
                        }
                        CallbackResult::Keep
                    },
                );
                let Ok(tap) = tap else {
                    let _ = ready_tx.send(Err("permissão".into()));
                    return;
                };
                let Ok(source) = tap.mach_port().create_runloop_source(0) else {
                    let _ = ready_tx.send(Err("event tap".into()));
                    return;
                };
                let rl = CFRunLoop::get_current();
                rl.add_source(&source, unsafe { kCFRunLoopCommonModes });
                tap.enable();
                let _ = ready_tx.send(Ok(()));
                while !sf.load(Ordering::Relaxed) {
                    CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, Duration::from_millis(100), false);
                }
                rl.remove_source(&source, unsafe { kCFRunLoopCommonModes });
                drop(tap);
            })
            .map_err(|e| e.to_string())?;
        ready_rx.recv_timeout(Duration::from_secs(3)).map_err(|_| "event tap".to_string())??;
        *ACTIVE.lock().unwrap() = Some(Active { stop: stop_flag, events, thread });
        Ok(())
    }

    pub fn stop() -> Vec<Ev> {
        let Some(a) = ACTIVE.lock().unwrap().take() else { return vec![] };
        a.stop.store(true, Ordering::Relaxed);
        let _ = a.thread.join();
        let v = a.events.lock().map(|v| v.clone()).unwrap_or_default();
        v
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::Ev;
    pub fn listen_access(_request: bool) -> bool {
        true
    }
    pub fn start() -> Result<(), String> {
        Err("a gravação de macros ainda só existe no macOS".into())
    }
    pub fn stop() -> Vec<Ev> {
        vec![]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn k(t: u32, c: u16, down: bool) -> Ev {
        Ev { t, input: Input::Key(c), down }
    }
    #[test]
    fn invoker_combo() {
        // q w e r, then e e e r (codes: q=12 w=13 e=14 r=15)
        let evs = vec![
            k(0, 12, true), k(40, 12, false), k(120, 13, true), k(160, 13, false), k(240, 14, true), k(280, 14, false),
            k(360, 15, true), k(400, 15, false), k(600, 14, true), k(640, 14, false), k(720, 14, true), k(760, 14, false),
            k(840, 14, true), k(880, 14, false), k(960, 15, true), k(1000, 15, false),
        ];
        let s = to_steps(&evs);
        let keys: Vec<(String, u32)> = s.iter().filter_map(|a| match a {
            Action::Key { key, repeat, .. } => Some((key.clone(), *repeat)),
            _ => None,
        }).collect();
        assert_eq!(keys, vec![("code:12".into(), 1), ("code:13".into(), 1), ("code:14".into(), 1), ("code:15".into(), 1), ("code:14".into(), 3), ("code:15".into(), 1)]);
    }
    #[test]
    fn chord_stays_raw() {
        let evs = vec![k(0, 56, true), k(50, 0, true), k(90, 0, false), k(120, 56, false)];
        let s = to_steps(&evs);
        assert!(matches!(&s[0], Action::KeyEvent { key, down: true } if key == "Shift"));
        assert!(s.iter().any(|a| matches!(a, Action::Key { key, .. } if key == "code:0")));
    }
}
