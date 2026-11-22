import { useEffect, useState, type ReactNode } from "react";
import type { Action, ActionType, AppInfo, MediaKey, Profile } from "./api";
import { appIconUrl, installedApps, isWindows } from "./api";

// ------------------------------------------------------------------ icons (24px, stroke)

const P: Record<string, ReactNode> = {
  play: <path d="M7 5.5v13l11-6.5z" />,
  next: <><path d="M5 6l9 6-9 6z" /><path d="M18 6v12" /></>,
  prev: <><path d="M19 6l-9 6 9 6z" /><path d="M6 6v12" /></>,
  volDown: <><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" /><path d="M16 12h4" /></>,
  volUp: <><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" /><path d="M16 12h4M18 10v4" /></>,
  mute: <><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" /><path d="M16 10l4 4M20 10l-4 4" /></>,
  app: <><rect x="4" y="4" width="7" height="7" rx="2" /><rect x="13" y="4" width="7" height="7" rx="2" /><rect x="4" y="13" width="7" height="7" rx="2" /><rect x="13" y="13" width="7" height="7" rx="2" /></>,
  command: <path d="M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9zm0 0h6m-6 0v6m6-6V6.5A2.5 2.5 0 1 1 17.5 9H15zm0 0v6m0 0h-6m6 0v2.5a2.5 2.5 0 1 0 2.5-2.5H15zm-6 0v2.5A2.5 2.5 0 1 1 6.5 15H9z" />,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  type: <><path d="M5 7V5h14v2M12 5v14M9 19h6" /></>,
  terminal: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M7 10l3 2-3 2M12.5 14.5H17" /></>,
  layers: <><path d="M12 4l8.5 4.5L12 13 3.5 8.5z" /><path d="M3.5 12.5L12 17l8.5-4.5" /></>,
  dot: <circle cx="12" cy="12" r="1.6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  bolt: <path d="M13 3L5 14h6l-1 7 8-11h-6z" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />,
  usb: <><path d="M12 3v14M9 6l3-3 3 3" /><circle cx="12" cy="19" r="2" /><path d="M12 13l-4-2.5V8M12 11l4-2V7" /></>,
  sun: <><circle cx="12" cy="12" r="3.5" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" /></>,
  save: <><path d="M5 4h11l3 3v13H5z" /><path d="M8 4v5h7V4M8 20v-6h8v6" /></>,
  warn: <><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17v.5" /></>,
  record: <circle cx="12" cy="12" r="5" />,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  redo: <><path d="M15 14l5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  pin: <><path d="M9 4h6l-1 6 3 3H7l3-3z" /><path d="M12 13v7" /></>,
};
export type IconName = keyof typeof P;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {P[name]}
    </svg>
  );
}

// ------------------------------------------------------------------ actions

export const ACTION_TYPES: { type: ActionType; label: string; icon: IconName }[] = [
  { type: "openApp", label: "Abrir app", icon: "app" },
  { type: "shortcut", label: "Atalho", icon: "command" },
  { type: "media", label: "Mídia", icon: "play" },
  { type: "openUrl", label: "Link", icon: "link" },
  { type: "typeText", label: "Texto", icon: "type" },
  { type: "shell", label: "Comando", icon: "terminal" },
  { type: "switchProfile", label: "Perfil", icon: "layers" },
  { type: "none", label: "Nenhuma", icon: "dot" },
];

export const MEDIA: { key: MediaKey; label: string; icon: IconName }[] = [
  { key: "playPause", label: "Play / Pausa", icon: "play" },
  { key: "previous", label: "Anterior", icon: "prev" },
  { key: "next", label: "Próxima", icon: "next" },
  { key: "volumeDown", label: "Volume −", icon: "volDown" },
  { key: "volumeUp", label: "Volume +", icon: "volUp" },
  { key: "mute", label: "Mudo", icon: "mute" },
];

export function defaultAction(type: ActionType, profiles: Profile[]): Action {
  switch (type) {
    case "none": return { type };
    case "openApp": return { type, path: "", name: "" };
    case "openUrl": return { type, url: "https://" };
    case "shortcut": return { type, mods: ["cmd"], key: "" };
    case "typeText": return { type, text: "" };
    case "media": return { type, key: "playPause" };
    case "shell": return { type, command: "" };
    case "switchProfile": return { type, profile: profiles[0]?.id ?? "" };
  }
}

const MOD_ORDER = ["ctrl", "alt", "shift", "cmd"];
const MOD_GLYPH: Record<string, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
const KEY_GLYPH: Record<string, string> = {
  Return: "↩", Space: "Espaço", Tab: "⇥", Escape: "esc", Backspace: "⌫", Delete: "⌦",
  Left: "←", Right: "→", Up: "↑", Down: "↓", Home: "↖", End: "↘", PageUp: "⇞", PageDown: "⇟",
};
export const MODS = (isWindows ? ["ctrl", "alt", "shift"] : MOD_ORDER).map((m) => ({ id: m, glyph: isWindows ? WIN_MOD[m] : MOD_GLYPH[m] }));

const WIN_MOD: Record<string, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Ctrl" };
export function formatShortcut(mods: string[], key: string) {
  if (isWindows) {
    const m = [...new Set(MOD_ORDER.filter((x) => mods.includes(x)).map((x) => WIN_MOD[x]))];
    const k = key.length === 1 ? key.toUpperCase() : key === "Space" ? "Espaço" : key;
    return [...m, k].join("+");
  }
  const m = MOD_ORDER.filter((x) => mods.includes(x)).map((x) => MOD_GLYPH[x]).join("");
  const k = KEY_GLYPH[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return m + k;
}

/** KeyboardEvent → the key name the Rust side understands. */
export function keyFromEvent(e: KeyboardEvent): string | null {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^F\d{1,2}$/.test(c)) return c;
  const named: Record<string, string> = {
    ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Space: "Space", Enter: "Return",
    NumpadEnter: "Return", Tab: "Tab", Escape: "Escape", Backspace: "Backspace", Delete: "Delete",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  };
  if (named[c]) return named[c];
  if (["Meta", "Control", "Alt", "Shift", "CapsLock"].includes(e.key)) return null;
  return e.key.length === 1 ? e.key.toLowerCase() : null;
}

export function actionIcon(a: Action): IconName {
  if (a.type === "media") return MEDIA.find((m) => m.key === a.key)?.icon ?? "play";
  return ACTION_TYPES.find((t) => t.type === a.type)?.icon ?? "dot";
}

export function actionSummary(a: Action, profiles: Profile[]): string {
  switch (a.type) {
    case "none": return "Sem ação";
    case "openApp": return a.name ? `Abre ${a.name}` : "Escolha um app";
    case "openUrl": return a.url.replace(/^https?:\/\//, "");
    case "shortcut": return a.key ? formatShortcut(a.mods, a.key) : "Grave um atalho";
    case "typeText": return a.text ? `“${a.text.slice(0, 24)}${a.text.length > 24 ? "…" : ""}”` : "Texto vazio";
    case "media": return MEDIA.find((m) => m.key === a.key)?.label ?? "";
    case "shell": return a.command || "Comando vazio";
    case "switchProfile": return `→ ${profiles.find((p) => p.id === a.profile)?.name ?? "?"}`;
  }
}

// ------------------------------------------------------------------ app icons

export function useApps() {
  const [apps, setApps] = useState<AppInfo[]>([]);
  useEffect(() => { installedApps().then(setApps); }, []);
  return apps;
}

export function AppIcon({ app, path, bundleId, size = 28 }: { app?: AppInfo | null; path?: string; bundleId?: string; size?: number }) {
  const apps = useApps();
  const info = app ?? apps.find((a) => (path && a.path === path) || (bundleId && a.bundleId === bundleId)) ?? null;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    appIconUrl(info?.icon).then((u) => alive && setSrc(u));
    return () => { alive = false; };
  }, [info?.icon]);
  const name = info?.name ?? path?.split("/").pop()?.replace(/\.app$/, "") ?? bundleId?.split(".").pop() ?? "?";
  if (src) return <img className="app-icon" src={src} width={size} height={size} alt="" />;
  return (
    <span className="app-icon mono" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function appName(apps: AppInfo[], bundleId: string | null | undefined) {
  if (!bundleId) return null;
  return apps.find((a) => a.bundleId === bundleId)?.name ?? bundleId.split(".").pop() ?? bundleId;
}

// ------------------------------------------------------------------ small controls

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <button type="button" role="switch" aria-checked={checked} className={checked ? "on" : ""} onClick={() => onChange(!checked)}>
        <i />
      </button>
    </label>
  );
}
