// Icons used on the page and on the 3D keycaps.
// Brand marks come from Simple Icons (CC0, simpleicons.org). VS Code, ChatGPT and Windows are
// not in Simple Icons, so those use neutral glyphs instead of the vendors' logos.
import brand from './brand-paths.json';

const stroke = {
  vscode: 'M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15',
  chatgpt: 'M4.5 5.5h15v10.5H10l-5.5 4.5V5.5zM9 11h.01M12 11h.01M15 11h.01',
  camera: 'M4 8.5h3.2L9 6h6l1.8 2.5H20V18H4zM12 15.6a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6z',
  mute: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4zM16 10l4 4M20 10l-4 4',
  voldown: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4zM16 12h4.5',
  volup: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4zM16 12h4.5M18.25 9.75v4.5',
  windows: '',
};
const fill = {
  play: 'M7.5 5.2v13.6L18.6 12z',
  next: 'M5 5.5l9 6.5-9 6.5zM16.5 5.5h2.5v13h-2.5z',
  prev: 'M19 5.5l-9 6.5 9 6.5zM5 5.5h2.5v13H5z',
  windows: 'M3 5.6 10.4 4.6v6.9H3zM11.4 4.5 21 3.1v8.4h-9.6zM3 12.5h7.4v6.9L3 18.4zM11.4 12.5H21v8.4l-9.6-1.4z',
  ...brand,
};

export function svg(name, size = 18, color = 'currentColor') {
  if (fill[name]) return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${color}" aria-hidden="true"><path d="${fill[name]}"/></svg>`;
  if (stroke[name]) return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${stroke[name]}"/></svg>`;
  return '';
}

/** Draw an icon centred at (cx, cy) with the given size on a 2D canvas. */
export function drawIcon(ctx, name, cx, cy, size, color) {
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 24, size / 24);
  if (fill[name]) {
    ctx.fillStyle = color;
    ctx.fill(new Path2D(fill[name]));
  } else if (stroke[name]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(new Path2D(stroke[name]));
  }
  ctx.restore();
}

export const hasIcon = (n) => !!(fill[n] || stroke[n]);
