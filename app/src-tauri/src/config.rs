//! Persistent configuration: profiles, the 15 keys of each profile and their actions.
//! Stored as JSON in the app's config directory (~/Library/Application Support/com.divtecnologia.divdeck).

use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

pub const KEYS: usize = 15;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MediaKey {
    PlayPause,
    Next,
    Previous,
    VolumeUp,
    VolumeDown,
    Mute,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    #[default]
    None,
    /// Open (or bring to front) an application bundle.
    OpenApp { path: String, name: String },
    /// Open a URL in the default handler (browser, Slack deep link, etc.).
    OpenUrl { url: String },
    /// Keyboard shortcut. `mods` from: cmd, ctrl, alt, shift. `key` is a single
    /// character ("c", "4", "/") or a named key ("F5", "Left", "Return", "Space"...).
    Shortcut { mods: Vec<String>, key: String },
    /// Type a piece of text; `submit` presses Return afterwards (send a chat message, run a command).
    TypeText {
        text: String,
        #[serde(default)]
        submit: bool,
    },
    Media { key: MediaKey },
    /// Run a shell command with /bin/zsh -lc (non-blocking).
    Shell { command: String },
    /// Switch the deck to another profile.
    SwitchProfile { profile: String },
    /// Several actions one after the other (a macro): e.g. open Slack, wait, ⌘K, type a name,
    /// Return, type a message, Return. `exact`: no automatic pause between steps (recorded
    /// macros and game combos keep their own timing through Wait steps).
    Sequence {
        steps: Vec<Action>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        exact: bool,
    },
    /// Pause inside a sequence, in milliseconds (capped at 10 s).
    Wait { ms: u32 },
    /// One key pressed like a person does it (held `hold_ms`), `repeat` times with `gap_ms`
    /// between: what games need (a 0 ms click is often missed). `key` is a key name as in
    /// Shortcut, or "code:<n>" for a raw macOS key code (recorded macros).
    Key {
        key: String,
        #[serde(default = "default_hold")]
        hold_ms: u32,
        #[serde(default = "one")]
        repeat: u32,
        #[serde(default = "default_gap")]
        gap_ms: u32,
    },
    /// Press or release a single key (recorded chords such as shift held while clicking).
    KeyEvent { key: String, down: bool },
    /// Mouse button at the current pointer position: click (`down` absent) or press/release.
    Mouse {
        button: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        down: Option<bool>,
    },
    /// Logitech Easy-Switch: move keyboards/mice to computer channel `host` (1-3).
    /// `devices`: names to switch; empty = every Logitech device that supports it.
    ChangeHost {
        host: u8,
        #[serde(default)]
        devices: Vec<String>,
    },
}

fn default_hold() -> u32 { 40 }
fn default_gap() -> u32 { 60 }
fn one() -> u32 { 1 }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyConfig {
    pub label: String,
    /// LED colour as "rrggbb".
    pub color: String,
    pub action: Action,
    /// Icon shown on a DIV Deck Pro tile: {"kind":"auto"|"brand"|"emoji"|"image"|"none", ...}.
    /// Only the UI reads it (it renders the picture); kept as-is here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<serde_json::Value>,
}

impl Default for KeyConfig {
    fn default() -> Self {
        Self { label: String::new(), color: "1c1f26".into(), action: Action::None, icon: None }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    /// Bundle ids that activate this profile automatically when frontmost.
    #[serde(default)]
    pub apps: Vec<String>,
    pub keys: Vec<KeyConfig>,
}

/// A deck the app has seen at least once. Several can be connected at the same time.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeckConfig {
    pub id: String,
    pub name: String,
    /// "mx" (mechanical keys + LEDs) or "pro" (4" touchscreen)
    pub model: String,
    /// Profile this deck shows when no app-linked profile applies.
    pub profile: String,
    /// Follow the app in focus (app-linked profiles) on this deck.
    #[serde(default = "yes")]
    pub follow_app: bool,
    /// Pro only: screen rotated 180°.
    #[serde(default)]
    pub flipped: bool,
    /// Pro only: the status bar above the keys.
    #[serde(default)]
    pub status: StatusBar,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusBar {
    pub show: bool,
    pub time: bool,
    pub date: bool,
    pub profile: bool,
}
impl Default for StatusBar {
    fn default() -> Self { Self { show: true, time: true, date: true, profile: true } }
}
impl StatusBar {
    pub fn mask(&self) -> u8 {
        (self.show as u8) | (self.time as u8) << 1 | (self.date as u8) << 2 | (self.profile as u8) << 3
    }
}
fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub profiles: Vec<Profile>,
    /// Profile chosen by the user; the deck falls back to it when no app-linked profile matches.
    pub base_profile: String,
    pub auto_switch: bool,
    /// 0..=96 (the firmware caps it).
    pub brightness: u8,
    pub press_color: String,
    /// Built-in presets already merged into this config.
    #[serde(default)]
    pub presets_version: u32,
    /// Every deck seen so far (connected or not).
    #[serde(default)]
    pub decks: Vec<DeckConfig>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            profiles: crate::presets::all(),
            base_profile: "default".into(),
            auto_switch: true,
            brightness: 48,
            press_color: "ffffff".into(),
            presets_version: crate::presets::PRESETS_VERSION,
            decks: vec![],
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Self {
        let mut cfg = fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<Config>(&s).ok())
            .unwrap_or_default();
        cfg.normalize();
        cfg
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(self).unwrap())?;
        fs::rename(tmp, path)
    }

    /// Keep the invariants the rest of the app relies on.
    pub fn normalize(&mut self) {
        if self.profiles.is_empty() {
            *self = Config::default();
        }
        if self.presets_version < crate::presets::PRESETS_VERSION {
            // the first-run "Padrão" from v0.1 was a generic demo: swap it for the new launcher,
            // unless the user renamed or edited its keys
            const V0: [&str; 5] = ["Play", "Anterior", "Próxima", "Vol −", "Vol +"];
            if self.presets_version == 0 {
                if let Some(i) = self.profiles.iter().position(|p| p.id == "default") {
                    let labels: Vec<&str> = self.profiles[i].keys.iter().take(5).map(|k| k.label.as_str()).collect();
                    if labels == V0 && self.profiles[i].keys[5].label == "Terminal" {
                        self.profiles[i] = crate::presets::all().remove(0);
                    }
                }
            }
            // v1 -> v2: built-in profiles the user never edited get the new keys (icons, clearer names)
            if self.presets_version < 2 {
                let old = crate::presets_v1::all();
                let same = |a: &[crate::config::KeyConfig], b: &[crate::config::KeyConfig]| {
                    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.label == y.label && x.action == y.action && x.icon.is_none())
                };
                for new in crate::presets::all() {
                    let Some(o) = old.iter().find(|p| p.id == new.id) else { continue };
                    if let Some(p) = self.profiles.iter_mut().find(|p| p.id == new.id) {
                        if same(&p.keys, &o.keys) {
                            p.keys = new.keys.clone();
                        }
                    }
                }
            }
            // add the built-in profiles the user doesn't have yet (never overwrite edited ones)
            for p in crate::presets::all() {
                if self.profile(&p.id).is_none() {
                    self.profiles.push(p);
                }
            }
            self.presets_version = crate::presets::PRESETS_VERSION;
        }
        // built-in profiles keep the apps they ship with: those can't be unlinked or moved
        for preset in crate::presets::all() {
            if self.profile(&preset.id).is_none() {
                continue;
            }
            for p in &mut self.profiles {
                if p.id == preset.id {
                    for a in preset.apps.iter().rev() {
                        if !p.apps.iter().any(|x| x.eq_ignore_ascii_case(a)) {
                            p.apps.insert(0, a.clone());
                        }
                    }
                } else {
                    p.apps.retain(|x| !preset.apps.iter().any(|a| a.eq_ignore_ascii_case(x)));
                }
            }
        }
        for p in &mut self.profiles {
            p.keys.resize(KEYS, KeyConfig::default());
        }
        if self.profile(&self.base_profile).is_none() {
            self.base_profile = self.profiles[0].id.clone();
        }
        self.brightness = self.brightness.min(96);
        let base = self.base_profile.clone();
        let ids: Vec<String> = self.profiles.iter().map(|p| p.id.clone()).collect();
        for d in &mut self.decks {
            if !ids.contains(&d.profile) {
                d.profile = base.clone();
            }
        }
    }

    pub fn deck(&self, id: &str) -> Option<&DeckConfig> {
        self.decks.iter().find(|d| d.id == id)
    }
    pub fn deck_mut(&mut self, id: &str) -> Option<&mut DeckConfig> {
        self.decks.iter_mut().find(|d| d.id == id)
    }

    pub fn profile(&self, id: &str) -> Option<&Profile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    /// Profile linked to the frontmost app. Entries match the bundle id or, for apps without a
    /// stable one (games), the app name, case-insensitively.
    pub fn profile_for_app(&self, bundle_id: &str, name: &str) -> Option<&Profile> {
        self.profiles.iter().find(|p| {
            p.apps.iter().any(|a| a == bundle_id || (!name.is_empty() && a.eq_ignore_ascii_case(name)))
        })
    }
}
