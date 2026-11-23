// Pictures for DIV Deck Pro tiles: app icons, brand logos (Simple Icons), emoji or the user's own image.
// The app renders each one to 56 x 56 BGRA (what the firmware draws with alpha), names it by a hash of
// what it shows, and hands it to the backend, which streams it to the deck the first time it is needed.

import { api, appIconUrl, type AppInfo, type Config, type KeyConfig, type KeyIcon } from "./api";

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

/** 56 x 56 BGRA, base64 — the exact bytes the firmware stores and draws. */
async function renderBGRA(k: KeyConfig, apps: AppInfo[]): Promise<string | null> {
  const c = document.createElement("canvas"); c.width = c.height = ICON_PX;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  if (!(await drawKeyIcon(g, k, ICON_PX, apps))) return null;
  const px = g.getImageData(0, 0, ICON_PX, ICON_PX).data;
  const out = new Uint8Array(px.length);
  for (let i = 0; i < px.length; i += 4) { out[i] = px[i + 2]; out[i + 1] = px[i + 1]; out[i + 2] = px[i]; out[i + 3] = px[i + 3]; }
  let bin = ""; for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Make sure every key of every profile has its picture cached, then tell the backend which goes where. */
export async function syncTileIcons(config: Config, apps: AppInfo[]): Promise<void> {
  const map: Record<string, (string | null)[]> = {};
  const todo = new Map<string, KeyConfig>();
  for (const p of config.profiles) {
    map[p.id] = p.keys.map((k) => {
      const d = iconDescriptor(k);
      if (!d) return null;
      const h = hash(d);
      todo.set(h, k);
      return h;
    });
  }
  const missing = new Set(await api.iconsMissing([...todo.keys()]));
  for (const h of missing) {
    try {
      const data = await renderBGRA(todo.get(h)!, apps);
      if (data) await api.putIcon(h, data);
    } catch { /* an icon that can't be drawn just stays a glyph */ }
  }
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
