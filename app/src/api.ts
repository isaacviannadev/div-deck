import presets from "./presets.json";

// Bridge to the Rust side. Outside Tauri (plain `npm run dev` in a browser) a mock is used,
// so the UI can be developed and previewed without the deck or the native shell.

export type MediaKey = "playPause" | "next" | "previous" | "volumeUp" | "volumeDown" | "mute";

export type Action =
  | { type: "none" }
  | { type: "openApp"; path: string; name: string }
  | { type: "openUrl"; url: string }
  | { type: "shortcut"; mods: string[]; key: string }
  | { type: "typeText"; text: string; submit?: boolean }
  | { type: "media"; key: MediaKey }
  | { type: "shell"; command: string }
  | { type: "switchProfile"; profile: string }
  | { type: "sequence"; steps: Action[]; exact?: boolean }
  | { type: "wait"; ms: number }
  | { type: "key"; key: string; holdMs: number; repeat: number; gapMs: number }
  | { type: "keyEvent"; key: string; down: boolean }
  | { type: "mouse"; button: "left" | "right" | "middle"; down?: boolean }
  | { type: "changeHost"; host: number; devices: string[] };

export interface LogiDevice { name: string; hosts: number; current: number }
export type MacroState = { state: "idle" | "armed" | "recording"; steps?: Action[]; error?: string };

export type ActionType = Action["type"];

/** Picture on a DIV Deck Pro tile. Absent = "auto" (the app's own icon for "open app", else the action's symbol). */
export type KeyIcon =
  | { kind: "auto" }
  | { kind: "none" }
  | { kind: "brand"; slug: string; title: string; hex: string }
  | { kind: "emoji"; char: string }
  | { kind: "image"; data: string }; // PNG data URL, 128 x 128

export interface KeyConfig {
  label: string;
  color: string; // rrggbb
  action: Action;
  icon?: KeyIcon;
}

export interface Profile {
  id: string;
  name: string;
  apps: string[]; // bundle ids
  keys: KeyConfig[];
}

export interface Config {
  profiles: Profile[];
  baseProfile: string;
  autoSwitch: boolean;
  brightness: number;
  pressColor: string;
  decks?: DeckSettings[];
}

export type DeckModel = "mx" | "pro";

/** Saved settings of a deck (the backend registers every deck the first time it connects). */
export interface DeckSettings {
  id: string;
  name: string;
  model: DeckModel;
  /** Profile shown when no app-linked profile applies. */
  profile: string;
  followApp: boolean;
  /** Pro: screen rotated 180°. */
  flipped: boolean;
  /** Pro: status bar above the keys. */
  status: StatusBar;
}

export interface StatusBar { show: boolean; time: boolean; date: boolean; profile: boolean; }

export interface DeckInfo extends DeckSettings {
  connected: boolean;
  port: string | null;
  firmware: string | null;
  /** Profile on the deck right now. */
  active: string;
}

export interface AppInfo {
  name: string;
  path: string;
  bundleId: string | null;
  icon: string | null;
}

export interface AppStateDto {
  config: Config;
  decks: DeckInfo[];
  frontApp: string | null;
  accessibility: boolean;
}

export const modelName = (m: DeckModel) => (m === "pro" ? "DIV Deck Pro" : "DIV Deck");

export const KEYS = 15;
export const COLS = 5;

export const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Unlisten = () => void;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  return mock.invoke(cmd, args) as Promise<T>;
}

function on<T>(event: string, cb: (payload: T) => void): Promise<Unlisten> {
  if (isTauri) {
    return import("@tauri-apps/api/event").then(({ listen }) => listen<T>(event, (e) => cb(e.payload)));
  }
  return Promise.resolve(mock.listen(event, cb as (p: unknown) => void));
}

export const api = {
  getState: () => call<AppStateDto>("get_state"),
  saveConfig: (config: Config) => call<void>("save_config", { config }),
  requestAccessibility: (reset: boolean) => call<boolean>("request_accessibility", { reset }),
  updateDeck: (deck: DeckSettings) => call<void>("update_deck", { deck }),
  iconsMissing: (hashes: string[]) => call<string[]>("icons_missing", { hashes }),
  putIcon: (hash: string, data: string) => call<void>("put_icon", { hash, data }),
  setIconMap: (map: Record<string, (string | null)[]>) => call<void>("set_icon_map", { map }),
  forgetDeck: (id: string) => call<void>("forget_deck", { id }),
  setProfile: (deck: string | null, id: string) => call<void>("set_profile", { deck, id }),
  testAction: (action: Action) => call<void>("test_action", { action }),
  previewLed: (deck: string, key: number, color: string) => call<void>("preview_led", { deck, key, color }),
  previewBrightness: (value: number) => call<void>("preview_brightness", { value }),
  saveToDevice: (deck: string) => call<void>("save_to_device", { deck }),
  listApps: () => call<AppInfo[]>("list_apps"),
  appIcon: (icns: string) => call<string | null>("app_icon", { icns }),
  accessibilityStatus: () => call<boolean>("accessibility_status"),
  openAccessibilitySettings: () => call<void>("open_accessibility_settings"),
  logiDevices: () => call<LogiDevice[]>("logi_devices"),
  macroArm: () => call<void>("macro_arm"),
  macroStart: () => call<void>("macro_start"),
  macroStop: () => call<void>("macro_stop"),
  macroCancel: () => call<void>("macro_cancel"),
  inputAccess: (request: boolean) => call<boolean>("input_access", { request }),
  openInputSettings: () => call<void>("open_input_settings"),
  onMacro: (cb: (m: MacroState) => void) => on("macro://state", cb),

  onDecks: (cb: (d: DeckInfo[]) => void) => on("deck://decks", cb),
  onKey: (cb: (e: { deck: string; key: number; down: boolean }) => void) => on("deck://key", cb),
  onFrontApp: (cb: (bundleId: string | null) => void) => on("deck://front-app", cb),
  onMenu: (cb: (id: string) => void) => on("menu://action", cb),
  onImport: (cb: (r: { ok: boolean; profiles?: Profile[]; error?: string }) => void) => on("menu://import", cb),
  onExported: (cb: (r: { ok: boolean; count?: number; name?: string; error?: string }) => void) => on("menu://exported", cb),

  async autostart(enable?: boolean): Promise<boolean> {
    if (!isTauri) return mock.autostart(enable);
    const m = await import("@tauri-apps/plugin-autostart");
    if (enable === true) await m.enable();
    if (enable === false) await m.disable();
    return m.isEnabled();
  },
};

// ------------------------------------------------------------------ icon cache

const iconCache = new Map<string, Promise<string | null>>();
export function appIconUrl(icns: string | null | undefined): Promise<string | null> {
  if (!icns) return Promise.resolve(null);
  let p = iconCache.get(icns);
  if (!p) {
    p = api.appIcon(icns).catch(() => null);
    iconCache.set(icns, p);
  }
  return p;
}

let appsPromise: Promise<AppInfo[]> | null = null;
export function installedApps(): Promise<AppInfo[]> {
  appsPromise ??= api.listApps().catch(() => []);
  return appsPromise;
}

// ------------------------------------------------------------------ built-in profiles

/** Apps that ship linked to a built-in profile. They can't be unlinked or moved elsewhere. */
const PRESET_APPS: Record<string, string[]> = Object.fromEntries(
  (presets as unknown as Config).profiles.map((p) => [p.id, p.apps]),
);
export const lockedApps = (profileId: string): string[] => PRESET_APPS[profileId] ?? [];
export const presetOwner = (app: string): string | undefined =>
  Object.keys(PRESET_APPS).find((id) => PRESET_APPS[id].some((a) => a.toLowerCase() === app.toLowerCase()));

// ------------------------------------------------------------------ mock (browser preview)

const mock = (() => {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emit = (ev: string, p: unknown) => listeners.get(ev)?.forEach((cb) => cb(p));
  let config: Config = structuredClone(presets) as Config;
  let auto = false;
  let decks: DeckInfo[] = [
    { id: "port-cu-usbserial-0001", name: "DIV Deck", model: "mx", profile: config.baseProfile, followApp: true, flipped: false, status: { show: true, time: true, date: true, profile: true },
      connected: true, port: "/dev/cu.usbserial-0001", firmware: "1.0.0", active: config.baseProfile },
    { id: "pro-30edab12cd34", name: "DIV Deck Pro", model: "pro", profile: config.baseProfile, followApp: false, flipped: false, status: { show: true, time: true, date: true, profile: true },
      connected: true, port: "/dev/cu.usbmodem101", firmware: "0.2.0", active: config.baseProfile },
  ];
  const pushDecks = () => emit("deck://decks", structuredClone(decks));
  const ids: Record<string, string> = {
    "Visual Studio Code": "com.microsoft.VSCode", Cursor: "com.todesktop.230313mzl4w4u92", Figma: "com.figma.Desktop",
    Discord: "com.hnc.Discord", Steam: "com.valvesoftware.steam", ChatGPT: "com.openai.chat", Claude: "com.anthropic.claudefordesktop",
  };
  const apps: AppInfo[] = ["Arc", "ChatGPT", "Claude", "Cursor", "Discord", "Figma", "Finder", "Notes", "Safari", "Steam", "Terminal", "Visual Studio Code"]
    .map((name) => ({ name, path: `/Applications/${name}.app`, bundleId: ids[name] ?? `com.example.${name}`, icon: null }));

  return {
    listen(ev: string, cb: (p: unknown) => void): Unlisten {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(cb);
      return () => listeners.get(ev)!.delete(cb);
    },
    async invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
      switch (cmd) {
        case "get_state":
          return {
            config: structuredClone(config),
            decks: structuredClone(decks),
            frontApp: "com.apple.Safari",
            accessibility: true,
          } satisfies AppStateDto;
        case "save_config":
          config = structuredClone(args!.config as Config);
          return;
        case "set_profile":
          decks = decks.map((d) => (d.id === args!.deck ? { ...d, profile: args!.id as string, active: args!.id as string } : d));
          pushDecks();
          return;
        case "update_deck": {
          const u = args!.deck as DeckSettings;
          decks = decks.map((d) => (d.id === u.id ? { ...d, ...u } : d));
          pushDecks();
          return;
        }
        case "request_accessibility":
          return true;
        case "icons_missing":
          return [];
        case "put_icon":
        case "set_icon_map":
          return;
        case "forget_deck":
          decks = decks.filter((d) => d.id !== args!.id || d.connected);
          pushDecks();
          return;
        case "test_action": {
          const k = config.profiles[0].keys.findIndex((x) => JSON.stringify(x.action) === JSON.stringify(args!.action));
          if (k >= 0) {
            emit("deck://key", { deck: decks[0].id, key: k, down: true });
            setTimeout(() => emit("deck://key", { deck: decks[0].id, key: k, down: false }), 180);
          }
          return;
        }
        case "list_apps":
          return apps;
        case "app_icon":
          return null;
        case "accessibility_status":
        case "input_access":
          return true;
        case "logi_devices":
          return [{ name: "MX Mechanical", hosts: 3, current: 1 }, { name: "MX Master 4 for Mac", hosts: 3, current: 1 }] satisfies LogiDevice[];
        case "macro_arm":
          emit("macro://state", { state: "armed" });
          return;
        case "macro_start":
          emit("macro://state", { state: "recording" });
          return;
        case "macro_stop":
          emit("macro://state", { state: "idle", steps: [
            { type: "key", key: "code:12", holdMs: 42, repeat: 1, gapMs: 60 }, { type: "wait", ms: 80 },
            { type: "key", key: "code:13", holdMs: 38, repeat: 1, gapMs: 60 }, { type: "wait", ms: 85 },
            { type: "key", key: "code:14", holdMs: 40, repeat: 3, gapMs: 78 }, { type: "wait", ms: 90 },
            { type: "key", key: "code:15", holdMs: 41, repeat: 1, gapMs: 60 },
          ] });
          return;
        case "macro_cancel":
          emit("macro://state", { state: "idle" });
          return;
        default:
          return null;
      }
    },
    async autostart(enable?: boolean) {
      if (enable !== undefined) auto = enable;
      return auto;
    },
  };
})();

// ------------------------------------------------------------------ updates (GitHub releases)

export interface UpdateInfo { version: string; notes?: string; install: (onProgress: (pct: number) => void) => Promise<void> }

/** Looks for a newer signed release. Resolves null in the browser preview or when up to date. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const u = await check().catch(() => null);
  if (!u) return null;
  return {
    version: u.version,
    notes: u.body ?? undefined,
    install: async (onProgress) => {
      let total = 0, done = 0;
      await u.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") { done += e.data.chunkLength; if (total) onProgress(Math.min(99, Math.round((done / total) * 100))); }
        else if (e.event === "Finished") onProgress(100);
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}
