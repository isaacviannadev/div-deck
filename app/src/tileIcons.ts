// Pictures for DIV Deck Pro tiles: app icons, brand logos (Simple Icons), emoji or the user's own image.
// The app renders each tile face, names it by a hash of what it shows, and hands it to the backend,
// which streams it to the deck the first time it is needed.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, appIconUrl, type AppInfo, type Config, type KeyConfig, type KeyIcon, type Profile } from "./api";
import { Icon, MEDIA, actionIcon, actionSummary, formatShortcut, type IconName } from "./ui";

export const ICON_PX = 56;

type Brand = { title: string; slug: string; hex: string; path: string };
let brandsP: Promise<Brand[]> | null = null;
/** All Simple Icons brands (loaded on first use; a few MB). */
export function brands(): Promise<Brand[]> {
  brandsP ??= import("simple-icons").then((m) =>
    Object.values(m as unknown as Record<string, Brand>)
      .filter((b) => b && typeof b === "object" && "slug" in b && "path" in b)
      .map((b) => ({ title: b.title, slug: b.slug, hex: b.hex, path: b.path })),
  );
  return brandsP;
}
export async function brandPath(slug: string): Promise<string | null> {
  return (await brands()).find((b) => b.slug === slug)?.path ?? null;
}

/** What a key's tile shows, as a stable string (null = no picture: the deck draws the action's symbol). */
export function iconDescriptor(k: KeyConfig): string | null {
  const ic: KeyIcon = k.icon ?? { kind: "auto" };
  switch (ic.kind) {
    case "none": return null;
    case "auto": return k.action.type === "openApp" && k.action.path ? `app:${k.action.path}` : null;
    case "brand": return `brand:${ic.slug}:${ic.hex}`;
    case "emoji": return `emoji:${ic.char}`;
    case "image": return `img:${hash(ic.data)}`;
  }
}

/** 10-character alphanumeric hash (two FNV-1a 32-bit runs). */
export function hash(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return ((a >>> 0).toString(36) + (b >>> 0).toString(36)).padEnd(10, "0").slice(0, 10);
}

const loadImg = (src: string) =>
  new Promise<HTMLImageElement>((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });

function squircle(g: CanvasRenderingContext2D, x: number, y: number, s: number, r: number) {
  g.beginPath(); g.roundRect(x, y, s, s, r);
}

/** Draws the picture for a descriptor on a canvas of any size (also used for previews). */
export async function drawIcon(g: CanvasRenderingContext2D, desc: string, size: number, apps: AppInfo[]): Promise<boolean> {
  g.clearRect(0, 0, size, size);
  const [kind, ...rest] = desc.split(":");
  const val = rest.join(":");
  if (kind === "app") {
    const info = apps.find((a) => a.path === val);
    const url = await appIconUrl(info?.icon);
    if (!url) return false;
    g.drawImage(await loadImg(url), 0, 0, size, size);
    return true;
  }
  if (kind === "brand") {
    const [slug, hex] = val.split(":");
    const path = await brandPath(slug);
    if (!path) return false;
    const pad = size * 0.06, s = size - 2 * pad;
    squircle(g, pad, pad, s, s * 0.24);
    g.fillStyle = `#${hex}`; g.fill();
    const lum = parseInt(hex.slice(0, 2), 16) * 0.299 + parseInt(hex.slice(2, 4), 16) * 0.587 + parseInt(hex.slice(4, 6), 16) * 0.114;
    g.save();
    const inner = s * 0.62;
    g.translate(pad + (s - inner) / 2, pad + (s - inner) / 2);
    g.scale(inner / 24, inner / 24);
    g.fillStyle = lum > 186 ? "#000" : "#fff";
    g.fill(new Path2D(path));
    g.restore();
    return true;
  }
  if (kind === "emoji") {
    g.textAlign = "center"; g.textBaseline = "middle";
    g.font = `${Math.round(size * 0.8)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    g.fillText(val, size / 2, size / 2 + size * 0.05);
    return true;
  }
  if (kind === "img") return false; // needs the data URL: see drawKeyIcon
  return false;
}

/** Draws a key's picture (handles user images, which aren't in the descriptor). */
export async function drawKeyIcon(g: CanvasRenderingContext2D, k: KeyConfig, size: number, apps: AppInfo[]): Promise<boolean> {
  if (k.icon?.kind === "image") {
    g.clearRect(0, 0, size, size);
    g.save(); squircle(g, 0, 0, size, size * 0.22); g.clip();
    g.drawImage(await loadImg(k.icon.data), 0, 0, size, size);
    g.restore();
    return true;
  }
  const d = iconDescriptor(k);
  return d ? drawIcon(g, d, size, apps) : false;
}

// ------------------------------------------------------------------ whole tile faces
// The Pro draws whatever we send: the full tile (background, picture, label), anti-aliased, as
// 86 x 96 RGB565 big-endian. Same look as the tiles in the app, much nicer than the deck's own fonts.

export const FACE_W = 86, FACE_H = 96;
const FACE_VERSION = "f2";

const SANS = '-apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif';
const SANS_D = '-apple-system, "SF Pro Display", "Segoe UI", system-ui, sans-serif';

function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mix = (c: [number, number, number], t: [number, number, number], f: number) =>
  `rgb(${c.map((v, i) => Math.round(v + (t[i] - v) * f)).join(",")})`;
const lumOf = ([r, g, b]: [number, number, number]) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

/** The text under the picture (what the app's tile shows). */
function faceLabel(k: KeyConfig, profiles: Profile[]): string {
  if (k.label.trim()) return k.label.trim();
  const a = k.action;
  if (a.type === "openApp") return a.name;
  if (a.type === "media") return MEDIA.find((m) => m.key === a.key)?.label ?? "";
  if (a.type === "shortcut") return "";
  return actionSummary(a, profiles);
}

/** Stroke icon from the app's icon set as an image (white). */
async function strokeIcon(name: IconName, size: number, color: string): Promise<HTMLImageElement> {
  const svg = renderToStaticMarkup(createElement(Icon, { name, size }))
    .replace(/currentColor/g, color)
    .replace('stroke-width="1.7"', 'stroke-width="2"')
    .replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  return loadImg(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

function fitText(g: CanvasRenderingContext2D, text: string, maxW: number, sizes: number[], weight: number, family: string): string {
  for (const s of sizes) {
    g.font = `${weight} ${s}px ${family}`;
    if (g.measureText(text).width <= maxW) return text;
  }
  let t = text;
  while (t.length > 1 && g.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t.trimEnd() + "…";
}

/** Draws one tile face (also usable for previews). Returns false for an empty key. */
export async function drawFace(g: CanvasRenderingContext2D, k: KeyConfig, profiles: Profile[], apps: AppInfo[]): Promise<boolean> {
  const W = FACE_W, H = FACE_H, R = 15;
  const a = k.action;
  g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
  if (a.type === "none" && !k.label.trim() && (!k.icon || k.icon.kind === "auto" || k.icon.kind === "none")) return false;
  const base = rgbOf(k.color);
  // body: the tile colour, a touch lighter at the top, deeper at the bottom
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, mix(base, [255, 255, 255], 0.10));
  grad.addColorStop(0.55, mix(base, [0, 0, 0], 0.18));
  grad.addColorStop(1, mix(base, [0, 0, 0], 0.34));
  g.beginPath(); g.roundRect(0.5, 0.5, W - 1, H - 1, R); g.fillStyle = grad; g.fill();
  // glass highlight on the upper half + hairline at the top edge
  const hi = g.createLinearGradient(0, 0, 0, H * 0.55);
  hi.addColorStop(0, "rgba(255,255,255,.20)"); hi.addColorStop(1, "rgba(255,255,255,0)");
  g.beginPath(); g.roundRect(0.5, 0.5, W - 1, H * 0.55, [R, R, 6, 6]); g.fillStyle = hi; g.fill();
  g.beginPath(); g.roundRect(1, 1, W - 2, H - 2, R - 0.5); g.strokeStyle = "rgba(255,255,255,.16)"; g.lineWidth = 1; g.stroke();

  const light = lumOf(base) > 0.72;
  const fg = light ? "#111" : "#fff";
  const label = faceLabel(k, profiles);
  const cy = label ? 39 : H / 2;

  // picture: app icon / brand / emoji / own image, else the action's symbol
  const PIC = label ? 44 : 52;
  const c = document.createElement("canvas"); c.width = c.height = PIC * 2;
  const pg = c.getContext("2d")!;
  let drawn = false;
  try { drawn = await drawKeyIcon(pg, k, PIC * 2, apps); } catch { drawn = false; }
  if (drawn) {
    g.save();
    g.shadowColor = "rgba(0,0,0,.35)"; g.shadowBlur = 6; g.shadowOffsetY = 2;
    g.drawImage(c, (W - PIC) / 2, cy - PIC / 2, PIC, PIC);
    g.restore();
  } else if (a.type === "shortcut" && a.key) {
    const t = formatShortcut(a.mods, a.key);
    g.fillStyle = fg; g.textAlign = "center"; g.textBaseline = "middle";
    const txt = fitText(g, t, W - 14, [24, 21, 18, 15, 13], 700, SANS_D);
    g.fillText(txt, W / 2, cy + 1);
  } else if (a.type === "openApp" && a.name) {
    const words = a.name.split(/\s+/).filter(Boolean);
    const mono = (words.length >= 2 ? words[0][0] + words[1][0] : a.name.slice(0, 2));
    g.fillStyle = fg; g.textAlign = "center"; g.textBaseline = "middle";
    g.font = `700 24px ${SANS_D}`;
    g.fillText(mono.charAt(0).toUpperCase() + mono.slice(1), W / 2, cy + 1);
  } else {
    const s = label ? 30 : 38;
    const img = await strokeIcon(actionIcon(a), s, fg);
    g.drawImage(img, (W - s) / 2, cy - s / 2, s, s);
  }

  if (label) {
    g.fillStyle = light ? "rgba(0,0,0,.82)" : "rgba(255,255,255,.96)";
    g.textAlign = "center"; g.textBaseline = "alphabetic";
    if (!light) { g.shadowColor = "rgba(0,0,0,.35)"; g.shadowBlur = 2; g.shadowOffsetY = 1; }
    const t = fitText(g, label, W - 10, [11, 10.5, 10], 500, SANS);
    g.fillText(t, W / 2, H - 11);
    g.shadowColor = "transparent";
  }
  return true;
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** 86 x 96 RGB565 big-endian with ordered dithering (smooth gradients on the 16-bit panel), base64. */
async function renderFace(k: KeyConfig, profiles: Profile[], apps: AppInfo[]): Promise<string | null> {
  const c = document.createElement("canvas"); c.width = FACE_W; c.height = FACE_H;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  if (!(await drawFace(g, k, profiles, apps))) return null;
  const px = g.getImageData(0, 0, FACE_W, FACE_H).data;
  const out = new Uint8Array(FACE_W * FACE_H * 2);
  for (let y = 0, o = 0; y < FACE_H; y++) {
    for (let x = 0; x < FACE_W; x++, o += 2) {
      const i = (y * FACE_W + x) * 4;
      const d = BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.5;
      const r = Math.max(0, Math.min(31, Math.round(px[i] / 8.226 + d)));
      const gg = Math.max(0, Math.min(63, Math.round(px[i + 1] / 4.048 + d)));
      const b = Math.max(0, Math.min(31, Math.round(px[i + 2] / 8.226 + d)));
      const v = (r << 11) | (gg << 5) | b;
      out[o] = v >> 8; out[o + 1] = v & 255;
    }
  }
  let bin = ""; for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(bin);
}

function faceKey(k: KeyConfig, profiles: Profile[]): string {
  const icon = k.icon?.kind === "image" ? { kind: "image", h: hash(k.icon.data) } : k.icon ?? null;
  return JSON.stringify([FACE_VERSION, k.color, faceLabel(k, profiles), k.action.type, k.action, icon]);
}

/** Make sure every key of every profile has its face rendered and cached, then tell the backend which goes where. */
export async function syncTileIcons(config: Config, apps: AppInfo[]): Promise<void> {
  const map: Record<string, (string | null)[]> = {};
  const todo = new Map<string, KeyConfig>();
  for (const p of config.profiles) {
    map[p.id] = p.keys.map((k) => {
      if (k.action.type === "none" && !k.label.trim() && (!k.icon || k.icon.kind === "auto" || k.icon.kind === "none")) return null;
      const h = hash(faceKey(k, config.profiles));
      todo.set(h, k);
      return h;
    });
  }
  const missing = new Set(await api.iconsMissing([...todo.keys()]));
  const failed = new Set<string>();
  for (const h of missing) {
    try {
      const data = await renderFace(todo.get(h)!, config.profiles, apps);
      if (data) await api.putIcon(h, data); else failed.add(h);
    } catch { failed.add(h); /* the deck draws this one itself */ }
  }
  for (const id in map) map[id] = map[id].map((h) => (h && failed.has(h) ? null : h));
  await api.setIconMap(map);
}

/** Resize a picked image file to a 128 x 128 PNG (cover crop). */
export async function imageFileToIcon(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    g.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 128, 128);
    return c.toDataURL("image/png");
  } finally { URL.revokeObjectURL(url); }
}

export const EMOJI = (
  "😀 😎 🤓 🥳 🤖 👾 👋 👍 👏 🙌 🙏 💪 🧠 👀 ❤️ 🔥 ✨ ⭐ ⚡ 💡 🚀 🎯 ✅ ❌ ⚠️ 🔔 🔕 📌 📎 🔒 🔓 🔑 " +
  "💬 📣 📧 📨 📞 📅 🗓️ ⏰ ⏱️ ⌛ 📝 📄 📁 📂 🗂️ 📊 📈 📉 🧾 💼 🏠 🏢 ☕ 🍕 🍔 🍺 🎂 " +
  "🎵 🎶 🎧 🎤 🎬 🎮 🕹️ 📷 📸 🎥 📺 🖥️ 💻 ⌨️ 🖱️ 📱 🔋 🔌 💾 🗑️ 🔍 🛠️ ⚙️ 🧪 🐛 🧩 " +
  "☀️ 🌙 🌧️ ❄️ 🌈 🌍 🌱 🌸 🐶 🐱 🦊 🐼 🦄 🐙 🐝 🏃 🚗 ✈️ 🛒 💰 💳 🎁 🏆 🥇 🎉 ▶️ ⏸️ ⏹️ ⏭️ ⏮️ 🔁 🔊 🔇"
).split(" ");
