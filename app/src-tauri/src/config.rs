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
    /// Type a piece of text.
    TypeText { text: String },
    Media { key: MediaKey },
    /// Run a shell command with /bin/zsh -lc (non-blocking).
    Shell { command: String },
    /// Switch the deck to another profile.
    SwitchProfile { profile: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyConfig {
    pub label: String,
    /// LED colour as "rrggbb".
    pub color: String,
    pub action: Action,
}

impl Default for KeyConfig {
    fn default() -> Self {
        Self { label: String::new(), color: "1c1f26".into(), action: Action::None }
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
