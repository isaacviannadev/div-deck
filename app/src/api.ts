import presets from "./presets.json";

// Bridge to the Rust side. Outside Tauri (plain `npm run dev` in a browser) a mock is used,
// so the UI can be developed and previewed without the deck or the native shell.

export type MediaKey = "playPause" | "next" | "previous" | "volumeUp" | "volumeDown" | "mute";

export type Action =
  | { type: "none" }
  | { type: "openApp"; path: string; name: string }
  | { type: "openUrl"; url: string }
  | { type: "shortcut"; mods: string[]; key: string }
  | { type: "typeText"; text: string }
  | { type: "media"; key: MediaKey }
  | { type: "shell"; command: string }
  | { type: "switchProfile"; profile: string };

export type ActionType = Action["type"];

export interface KeyConfig {
  label: string;
  color: string; // rrggbb
  action: Action;
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
}

export interface DeckStatus {
  connected: boolean;
  port: string | null;
  firmware: string | null;
}

export interface AppInfo {
  name: string;
  path: string;
  bundleId: string | null;
  icon: string | null;
}

export interface AppStateDto {
  config: Config;
  activeProfile: string;
  status: DeckStatus;
  frontApp: string | null;
  accessibility: boolean;
}

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
  setProfile: (id: string) => call<void>("set_profile", { id }),
  testAction: (action: Action) => call<void>("test_action", { action }),
  previewLed: (key: number, color: string) => call<void>("preview_led", { key, color }),
  previewBrightness: (value: number) => call<void>("preview_brightness", { value }),
  saveToDevice: () => call<void>("save_to_device"),
  listApps: () => call<AppInfo[]>("list_apps"),
  appIcon: (icns: string) => call<string | null>("app_icon", { icns }),
  accessibilityStatus: () => call<boolean>("accessibility_status"),
  openAccessibilitySettings: () => call<void>("open_accessibility_settings"),

  onStatus: (cb: (s: DeckStatus) => void) => on("deck://status", cb),
  onKey: (cb: (e: { key: number; down: boolean }) => void) => on("deck://key", cb),
  onProfile: (cb: (id: string) => void) => on("deck://profile", cb),
  onFrontApp: (cb: (bundleId: string | null) => void) => on("deck://front-app", cb),

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
            activeProfile: config.baseProfile,
            status: { connected: true, port: "/dev/cu.usbserial-0001", firmware: "1.0.0" },
            frontApp: "com.apple.Safari",
            accessibility: true,
          } satisfies AppStateDto;
        case "save_config":
          config = structuredClone(args!.config as Config);
          return;
        case "set_profile":
          emit("deck://profile", args!.id);
          return;
        case "test_action": {
          const k = config.profiles[0].keys.findIndex((x) => JSON.stringify(x.action) === JSON.stringify(args!.action));
          if (k >= 0) {
            emit("deck://key", { key: k, down: true });
            setTimeout(() => emit("deck://key", { key: k, down: false }), 180);
          }
          return;
        }
        case "list_apps":
          return apps;
        case "app_icon":
          return null;
        case "accessibility_status":
          return true;
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
