import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { svg, drawIcon, hasIcon } from './icons.js';
import presets from './presets.json';

// "Placa de impressão": the page is a slicer workspace. The hero prints the deck layer by layer
// on a build plate (clipping plane + layer slider); then the keys light up and change with the
// app, like filament swaps.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = matchMedia('(pointer: fine)').matches;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeOut = (t) => 1 - Math.pow(1 - clamp(t), 3);
const fmt1 = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// ============================================================== page icons
document.querySelectorAll('[data-icon]').forEach((el) => {
  el.insertAdjacentHTML('afterbegin', svg(el.dataset.icon, +(el.dataset.size || 18), el.dataset.color || 'currentColor'));
});

// ============================================================== key legends per profile
const MOD = { ctrl: '⌃', alt: '⌥', shift: '⇧', cmd: '⌘' };
const KEYG = { Return: '↩', Space: '␣', Tab: '⇥', Escape: 'esc', Backspace: '⌫', Delete: '⌦', Left: '←', Right: '→', Up: '↑', Down: '↓' };
const shortcutText = (a) => ['ctrl', 'alt', 'shift', 'cmd'].filter((m) => a.mods.includes(m)).map((m) => MOD[m]).join('') + (KEYG[a.key] ?? (a.key.length === 1 ? a.key.toUpperCase() : a.key));
const mediaIcon = { playPause: 'play', next: 'next', previous: 'prev', volumeUp: 'volup', volumeDown: 'voldown', mute: 'mute' };
const appIcon = { 'Visual Studio Code': 'vscode', Cursor: 'cursor', Figma: 'figma', ChatGPT: 'chatgpt', Claude: 'claude', Discord: 'discord', Steam: 'steam' };

function legendsFor(profileId) {
  const p = presets.profiles.find((x) => x.id === profileId);
  return p.keys.map((k) => {
    const a = k.action;
    let icon = null, text = null;
    if (a.type === 'media') icon = mediaIcon[a.key];
    else if (a.type === 'openApp') icon = appIcon[a.name];
    else if (a.type === 'openUrl') icon = k.label.startsWith('Dota') ? 'dota2' : 'steam';
    else if (a.type === 'shortcut') { icon = k.label === 'Print' ? 'camera' : null; text = icon ? null : shortcutText(a); }
    else if (a.type === 'none') text = '';
    else text = k.label.slice(0, 4);
    if (icon && !hasIcon(icon)) { text = k.label.slice(0, 3); icon = null; }
    return { icon, text, label: k.label, color: k.color, none: a.type === 'none' };
  });
}
const PROFILE_NAMES = Object.fromEntries(presets.profiles.map((p) => [p.id, p.name]));
const STORY_PROFILES = ['default', 'vscode', 'figma', 'discord'];

// ============================================================== model selector (DIV Deck MX / DIV Deck Pro)
const MODELS = ['mx', 'pro'];
const MODEL_NAME = { mx: 'DIV Deck MX', pro: 'DIV Deck Pro' };
const params = new URLSearchParams(location.search);
let model = params.get('modelo') === 'pro' || location.hash === '#pro' ? 'pro'
  : params.get('modelo') === 'mx' ? 'mx'
  : (() => { try { return localStorage.getItem('divdeck-model'); } catch { return null; } })();
if (!MODELS.includes(model)) model = 'mx';
const modelListeners = [];
function setModel(m) {
  if (!MODELS.includes(m)) return;
  model = m;
  document.documentElement.dataset.model = m;
  document.querySelectorAll('[data-set-model]').forEach((b) => {
    const on = b.dataset.setModel === m;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.model-name').forEach((el) => { el.textContent = MODEL_NAME[m]; });
  try { localStorage.setItem('divdeck-model', m); } catch {}
  const u = new URL(location.href); u.searchParams.set('modelo', m); if (u.hash === '#pro') u.hash = ''; history.replaceState(null, '', u);
  modelListeners.forEach((f) => f(m));
}
document.querySelectorAll('[data-set-model]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); setModel(b.dataset.setModel); }));
setModel(model);

// ============================================================== 3D: the build plate
const MM = 0.01;
const T = THREE.MathUtils.degToRad(30);
const TZ = 50.68;
const KEY0 = [11.525, 20.525], PITCH = 19.05;
const CAP_Z = 7.2;
const LAYER = 0.2;                 // layer height shown in the readout (mm)

const stage = document.querySelector('#stage');
const canvas = document.querySelector('#deck3d');
const ui = {
  n: document.querySelector('#layer-n'), t: document.querySelector('#layer-t'), mm: document.querySelector('#layer-mm'),
  rail: document.querySelector('#rail'), fill: document.querySelector('#rail-fill'), thumb: document.querySelector('#rail-thumb'),
  pct: document.querySelector('#job-pct'), profile: document.querySelector('#story-profile'),
};
let three = null;
try {
  if (!canvas || !stage) throw new Error('no canvas');
  three = initThree();
} catch (e) {
  document.documentElement.classList.add('no-webgl');
  console.warn('[divdeck] 3D disabled:', e);
}

function plateTexture() {
  // textured PEI: bronze speckle, a darker rim band, the DIV mark printed at the front edge
  const c = document.createElement('canvas'); c.width = 1024; c.height = 820;
  const g = c.getContext('2d');
  g.fillStyle = '#a97f45'; g.fillRect(0, 0, 1024, 820);
  for (let i = 0; i < 26000; i++) {
    const v = Math.random();
    g.fillStyle = v < 0.5 ? `rgba(70,44,14,${0.08 + Math.random() * 0.12})` : `rgba(255,226,170,${0.06 + Math.random() * 0.12})`;
    g.fillRect(Math.random() * 1024, Math.random() * 820, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  g.strokeStyle = 'rgba(61,42,18,.55)'; g.lineWidth = 10; g.strokeRect(5, 5, 1014, 810);
  g.strokeStyle = 'rgba(61,42,18,.18)'; g.lineWidth = 1.5;
  for (let x = 64; x < 1024; x += 64) { g.beginPath(); g.moveTo(x, 18); g.lineTo(x, 30); g.moveTo(x, 790); g.lineTo(x, 802); g.stroke(); }
  g.fillStyle = 'rgba(61,42,18,.55)'; g.font = '600 26px Archivo, sans-serif'; g.textAlign = 'left';
  g.fillText('DIV DECK · TEXTURED PEI', 34, 784);
  g.textAlign = 'right'; g.fillText('0,2 mm · 220 °C', 990, 784);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  t.wrapS = THREE.RepeatWrapping; t.repeat.x = -1;   // the plate is seen from the back of the scene
  return t;
}

function initThree() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.localClippingEnabled = true;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.75;
  const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 50);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb79c74, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.8); key.position.set(1.8, 3.2, 2.4); scene.add(key);
  const fill = new THREE.DirectionalLight(0xdfe9ff, 0.6); fill.position.set(-2.5, 1.2, 1.5); scene.add(fill);

  const pivot = new THREE.Group(); scene.add(pivot);
  const root = new THREE.Group(); root.rotation.x = -Math.PI / 2; root.scale.setScalar(MM); pivot.add(root);
  const deck = new THREE.Group(); deck.position.z = TZ; deck.rotation.x = -T; root.add(deck);
  const layers = { tray: new THREE.Group(), pcb: new THREE.Group(), plate: new THREE.Group(), cover: new THREE.Group(), caps: new THREE.Group() };
  Object.values(layers).forEach((g) => deck.add(g));

  // clipping: everything above the current layer is not printed yet (root frame: desk, z up, mm)
  const clipMx = new THREE.Plane(), clipPro = new THREE.Plane();
  const localClip = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  const C = (m, pro = false) => { m.clippingPlanes = [pro ? clipPro : clipMx]; return m; };

  const mat = {
    tray: C(new THREE.MeshPhysicalMaterial({ color: 0x2b2e33, roughness: 0.62, side: THREE.DoubleSide })),
    lid: C(new THREE.MeshPhysicalMaterial({ color: 0x3a3d43, roughness: 0.55, side: THREE.DoubleSide })),
    cover: C(new THREE.MeshPhysicalMaterial({ color: 0x1c1f24, roughness: 0.5, side: THREE.DoubleSide })),
    pod: C(new THREE.MeshPhysicalMaterial({ color: 0x1c1f24, roughness: 0.5, side: THREE.DoubleSide })),
    podBase: C(new THREE.MeshPhysicalMaterial({ color: 0x2b2e33, roughness: 0.6, side: THREE.DoubleSide })),
    oled: C(new THREE.MeshBasicMaterial({ color: 0x050607, toneMapped: false })),
    cap: C(new THREE.MeshPhysicalMaterial({ color: 0xf1f3f6, roughness: 0.48, transmission: 0.55, thickness: 5, ior: 1.46, attenuationColor: new THREE.Color(0xe9eef5), attenuationDistance: 16, clearcoat: 0.2, clearcoatRoughness: 0.4, side: THREE.DoubleSide })),
    sw: C(new THREE.MeshPhysicalMaterial({ color: 0x30343d, roughness: 0.3 })),
    stem: C(new THREE.MeshPhysicalMaterial({ color: 0x2f6df6, roughness: 0.35 })),
    pcb: C(new THREE.MeshPhysicalMaterial({ color: 0x0f1012, roughness: 0.32, clearcoat: 0.6 })),
    gold: C(new THREE.MeshStandardMaterial({ color: 0xd9a944, roughness: 0.3, metalness: 1 })),
    silver: C(new THREE.MeshStandardMaterial({ color: 0xbfc3c8, roughness: 0.28, metalness: 1 })),
    devkit: C(new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.45 })),
  };

  // ---- build plates (one under each model)
  const plateMat = new THREE.MeshStandardMaterial({ map: plateTexture(), roughness: 0.8, metalness: 0.25 });
  const plateEdge = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.5, metalness: 0.4 });
  const makePlate = (w, d, cx, cy) => {
    const g = new THREE.Group();
    const top = new THREE.Mesh(new THREE.PlaneGeometry(w, d), plateMat); top.position.set(cx, cy, 0.02); g.add(top);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w + 4, d + 4, 4), plateEdge); slab.position.set(cx, cy, -2.05); g.add(slab);
    return g;
  };
  root.add(makePlate(200, 160, 49.6, 26));

  // layer highlight: a thin orange band at the current layer, as the slicer draws it
  const bandMat = new THREE.MeshBasicMaterial({ color: 0xff6b1a, transparent: true, opacity: 0.0, depthWrite: false, side: THREE.DoubleSide });
  const band = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bandMat); root.add(band);
  const bandLine = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 0), new THREE.Vector3(-0.5, 0.5, 0)]),
    new THREE.LineBasicMaterial({ color: 0xff6b1a, transparent: true, opacity: 0 }));
  root.add(bandLine);

  // ---- PCB, LEDs and the ESP32 DevKit are simple solids; the case parts come from the real STLs
  const PCB_W = 99.25, PCB_D = 72.15;
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(PCB_W, PCB_D, 1.6), mat.pcb);
  pcb.position.set(PCB_W / 2, PCB_D / 2, -5.8); layers.pcb.add(pcb);
  const keyPos = (k) => { const r = Math.floor(k / 5), c = 4 - (k % 5); return [KEY0[0] + c * PITCH, KEY0[1] + r * PITCH]; };
  const leds = [], ledColor = [], ledTarget = [];
  for (let k = 0; k < 15; k++) {
    const [x, y] = keyPos(k);
    ledColor.push(new THREE.Color(0x38d6ff)); ledTarget.push(new THREE.Color(0x38d6ff));
    const led = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.8, 0.9), C(new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x38d6ff, emissiveIntensity: 3 })));
    led.position.set(x, y - 5.1, -4.8); layers.pcb.add(led); leds.push(led);
  }
  const devkit = new THREE.Group(); root.add(devkit);
  const board = new THREE.Mesh(new THREE.BoxGeometry(51.5, 28.3, 1.6), mat.devkit); devkit.add(board);
  const can = new THREE.Mesh(new THREE.BoxGeometry(18, 25.5, 3.2), mat.silver); can.position.set(14, 0, -2.4); devkit.add(can);
  devkit.position.set(26, 8.2, 7.7);

  // ---- DIV Deck Pro
  const P_H = 72, VA = [85.22, 56.88];
  const proRoot = new THREE.Group(); proRoot.rotation.x = -Math.PI / 2; proRoot.scale.setScalar(0.0001); pivot.add(proRoot);
  const proRig = new THREE.Group(); proRig.rotation.z = Math.PI; proRoot.add(proRig);
  const panel = new THREE.Group(); proRig.add(panel);
  panel.rotation.x = THREE.MathUtils.degToRad(65);
  panel.position.set(0, (P_H / 2) * Math.cos(THREE.MathUtils.degToRad(65)), 5 + (P_H / 2) * Math.sin(THREE.MathUtils.degToRad(65)));
  const pro = { back: new THREE.Group(), glass: new THREE.Group(), bezel: new THREE.Group(), foot: new THREE.Group() };
  ['back', 'glass', 'bezel'].forEach((k) => panel.add(pro[k]));
  proRig.add(pro.foot);
  proRoot.add(makePlate(200, 150, 0, 0));
  const pmat = {
    white: C(new THREE.MeshPhysicalMaterial({ color: 0xeceef1, roughness: 0.58, side: THREE.DoubleSide }), true),
    black: C(new THREE.MeshPhysicalMaterial({ color: 0x16181c, roughness: 0.4, side: THREE.DoubleSide }), true),
    glass: C(new THREE.MeshPhysicalMaterial({ color: 0x050506, roughness: 0.06, clearcoat: 1 }), true),
  };
  { const g = new THREE.Mesh(new THREE.BoxGeometry(94.57, 60.88, 4.0), pmat.glass); g.position.set(0, 0, 10.25 + 2.0); pro.glass.add(g); }
  const scr = document.createElement('canvas'); scr.width = 960; scr.height = 640;
  const sg = scr.getContext('2d');
  const scrTex = new THREE.CanvasTexture(scr); scrTex.colorSpace = THREE.SRGBColorSpace; scrTex.anisotropy = 8;
  const screenMat = C(new THREE.MeshBasicMaterial({ map: scrTex, toneMapped: false }), true);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(VA[0], VA[1]), screenMat);
  screen.position.z = 14.27; pro.glass.add(screen);
  let proCtr = null, proTop = 90;

  const measure = (obj) => {
    const saved = [pivot.position.clone(), pivot.rotation.clone()];
    pivot.position.set(0, 0, 0); pivot.rotation.set(0, 0, 0); scene.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(obj, true);
    const lo = obj.worldToLocal(b.min.clone()), hi = obj.worldToLocal(b.max.clone());
    const ctr = b.getCenter(new THREE.Vector3());
    pivot.position.copy(saved[0]); pivot.rotation.copy(saved[1]);
    return { ctr, top: Math.max(lo.z, hi.z) };
  };

  new GLTFLoader().load('assets/divdeck-pro.glb', (gltf) => {
    const get = (n) => { const m = gltf.scene.getObjectByName(n); m.geometry = toCreasedNormals(m.geometry, THREE.MathUtils.degToRad(35)); return m; };
    const back = get('back'); back.material = pmat.white; pro.back.add(back);
    const bezel = get('bezel'); bezel.material = pmat.black; pro.bezel.add(bezel);
    const foot = get('foot'); foot.material = pmat.white; pro.foot.add(foot);
    proRoot.scale.setScalar(MM); proRoot.position.set(0, 0, 0);
    const m = measure(proRoot); proCtr = m.ctr.negate(); proTop = m.top;
    if (model === 'pro') startPrint();
  });

  // tiles on the Pro screen
  const proColor = [], proTarget = [], proFlip = new Array(15).fill(0);
  for (let k = 0; k < 15; k++) { proColor.push(new THREE.Color(0x38d6ff)); proTarget.push(new THREE.Color(0x38d6ff)); }
  let proLegends = [];
  const TW = (960 - 32 - 64) / 5, TH = (640 - 32 - 32) / 3;
  const tileXY = (k) => [16 + (k % 5) * (TW + 16), 16 + Math.floor(k / 5) * (TH + 16)];
  function drawScreen(on, hover, flash) {
    sg.fillStyle = '#000'; sg.fillRect(0, 0, 960, 640);
    for (let k = 0; k < 15; k++) {
      const [x, y] = tileXY(k);
      const c = proColor[k].clone().multiplyScalar(on);
      const press = Math.max(flash[k], hover === k ? 0.6 : 0, Math.sin(proFlip[k] * Math.PI));
      const inset = press * 7, f = 0.76 + press * 0.2;
      sg.fillStyle = `rgb(${Math.min(255, c.r * 255 * f)},${Math.min(255, c.g * 255 * f)},${Math.min(255, c.b * 255 * f)})`;
      sg.beginPath(); sg.roundRect(x + inset, y + inset, TW - 2 * inset, TH - 2 * inset, 28); sg.fill();
      const l = proLegends[k]; if (!l || on < 0.5) continue;
      const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      const ink = lum * f > 0.68 ? '#111' : '#fff';
      if (l.icon) drawIcon(sg, l.icon, x + TW / 2, y + TH / 2 - 14, 64, ink);
      else if (l.text) {
        sg.fillStyle = ink; sg.textAlign = 'center'; sg.textBaseline = 'middle';
        sg.font = `700 ${l.text.length > 3 ? 30 : 40}px -apple-system, system-ui, sans-serif`;
        sg.fillText(l.text, x + TW / 2, y + TH / 2 - 14);
      }
      if (l.label) {
        sg.fillStyle = ink; sg.globalAlpha = 0.9; sg.textAlign = 'center'; sg.textBaseline = 'alphabetic';
        sg.font = `600 22px -apple-system, system-ui, sans-serif`;
        sg.fillText(l.label.length > 11 ? l.label.slice(0, 10) + '…' : l.label, x + TW / 2, y + TH - 18);
        sg.globalAlpha = 1;
      }
    }
    scrTex.needsUpdate = true;
  }

  // ---- profiles on the keys
  const legendCanvas = [], legendTex = [], flip = new Array(15).fill(0);
  function applyProfile(profileId) {
    const p = presets.profiles.find((x) => x.id === profileId);
    p.keys.forEach((k, i) => { ledTarget[i].set('#' + k.color); proTarget[i].set('#' + k.color); });
    proLegends = legendsFor(profileId);
    proFlip.fill(1);
    proLegends.forEach((l, k) => {
      const c = legendCanvas[k]; if (!c) return;
      const g = c.getContext('2d');
      g.clearRect(0, 0, 256, 256);
      const ink = '#16181d';
      if (l.icon) drawIcon(g, l.icon, 128, 112, 118, ink);
      else if (l.text) {
        g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'middle';
        const fs = l.text.length > 3 ? 54 : l.text.length > 2 ? 70 : 92;
        g.font = `650 ${fs}px Archivo, -apple-system, system-ui, sans-serif`;
        g.fillText(l.text, 128, 110);
      }
      if (l.label) {
        g.fillStyle = 'rgba(22,24,29,.78)'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.font = `600 30px Archivo, -apple-system, system-ui, sans-serif`;
        g.fillText(l.label.length > 10 ? l.label.slice(0, 9) + '…' : l.label, 128, 214);
      }
      legendTex[k].needsUpdate = true;
      flip[k] = 1;
    });
  }

  let mxCtr = new THREE.Vector3(), mxTop = 80;
  const caps = [], capMats = [], pick = [];
  const state = { mix: model === 'pro' ? 1 : 0, p: 0, mx: 0, my: 0, tmx: 0, tmy: 0, hover: -1, profile: '', manualProfile: null, manualH: null, flash: new Array(15).fill(0), printT0: -1 };
  const clock = new THREE.Timer();

  const texLoader = new THREE.TextureLoader();
  const artPlane = (url, a) => {
    const t = texLoader.load(url); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(a.x1 - a.x0, a.y1 - a.y0), C(new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, toneMapped: false })));
    m.position.set((a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2, a.z + 0.03); m.renderOrder = 2; return m;
  };

  new GLTFLoader().load('assets/divdeck.glb', (gltf) => {
    const get = (n) => { const m = gltf.scene.getObjectByName(n); if (!m) return null; m.geometry = toCreasedNormals(m.geometry, THREE.MathUtils.degToRad(35)); return m; };
    const tray = get('tray'); tray.material = mat.tray; layers.tray.add(tray);
    const lid = get('lid'); lid.material = mat.lid; layers.plate.add(lid);
    const cover = get('cover'); cover.material = mat.cover; layers.cover.add(cover);
    // the code face and the OLED pod (printed in two colours: the green art is a texture here)
    layers.cover.add(artPlane('assets/face_inlay.png', { x0: 1.77, x1: 97.54, y0: 2.53, y1: 71.39, z: 1.6 }));
    const podShell = get('pod_shell'), podBase = get('pod_base'), podGlass = get('pod_glass');
    if (podShell) { podShell.material = mat.pod; layers.cover.add(podShell); layers.cover.add(artPlane('assets/pod_inlay.png', { x0: 22.70, x1: 76.28, y0: -16.09, y1: 7.73, z: 13.6 })); }
    if (podBase) { podBase.material = mat.podBase; layers.cover.add(podBase); }
    if (podGlass) { podGlass.material = mat.oled; layers.cover.add(podGlass); }
    const swGeo = get('switch').geometry, stemGeo = get('stem').geometry;
    const capGeos = [get('keycap1').geometry, get('keycap2').geometry, get('keycap3').geometry];
    for (let k = 0; k < 15; k++) {
      const [x, y] = keyPos(k);
      const sw = new THREE.Mesh(swGeo, mat.sw); sw.position.set(x, y, 0); layers.plate.add(sw);
      const cap = new THREE.Group(); cap.position.set(x, y, CAP_Z); layers.caps.add(cap);
      const body = new THREE.Mesh(capGeos[Math.floor(k / 5)], C(mat.cap.clone())); capMats[k] = body.material; body.userData.key = k; cap.add(body); pick.push(body);
      const stem = new THREE.Mesh(stemGeo, mat.stem); stem.position.z = -CAP_Z; cap.add(stem);
      const c = document.createElement('canvas'); c.width = c.height = 256; legendCanvas.push(c);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; legendTex.push(tex);
      const capTop = [8.54, 7.6, 8.2][Math.floor(k / 5)];
      const legend = new THREE.Mesh(new THREE.PlaneGeometry(11, 11), C(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false })));
      legend.position.z = capTop + 0.32; legend.rotation.z = Math.PI; legend.renderOrder = 2; cap.add(legend);
      caps.push(cap);
    }
    const m = measure(root); root.position.sub(m.ctr); mxCtr = root.position.clone(); mxTop = m.top;
    applyProfile(state.profile || 'default');
    document.documentElement.classList.add('deck-ready');
    if (model === 'mx') startPrint();
  });

  // ---- printing: plays once when a model appears; the slider scrubs it any time
  const PRINT_S = 3.2;
  function startPrint() { state.printT0 = reduceMotion ? -99 : clock.getElapsed(); state.manualH = null; }
  modelListeners.push(() => startPrint());

  function setProfile(id) {
    if (state.profile === id) return;
    state.profile = id;
    applyProfile(id);
    if (ui.profile) ui.profile.textContent = PROFILE_NAMES[id];
    document.querySelectorAll('.spool').forEach((b) => b.classList.toggle('on', b.dataset.profile === id));
  }
  document.querySelectorAll('.spool').forEach((b) => b.addEventListener('click', () => {
    state.manualProfile = { id: b.dataset.profile, at: state.p };
    if (state.manualH !== null) state.manualH = null;
  }));

  // ---- the layer slider (drag, click or arrow keys)
  let curTop = mxTop, curH = 0;
  const vertical = () => innerWidth > 720;
  function railTo(e) {
    const r = ui.rail.getBoundingClientRect();
    const f = vertical() ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    state.manualH = clamp(f) * curTop; state.manualAt = scrollY;
  }
  ui.rail?.addEventListener('pointerdown', (e) => { ui.rail.setPointerCapture(e.pointerId); railTo(e); });
  ui.rail?.addEventListener('pointermove', (e) => { if (ui.rail.hasPointerCapture(e.pointerId)) railTo(e); });
  ui.rail?.addEventListener('keydown', (e) => {
    const step = (e.shiftKey ? 50 : 10) * LAYER;
    const h = state.manualH ?? curH;
    if (['ArrowUp', 'ArrowRight'].includes(e.key)) { state.manualH = clamp(h + step, 0, curTop); e.preventDefault(); }
    if (['ArrowDown', 'ArrowLeft'].includes(e.key)) { state.manualH = clamp(h - step, 0, curTop); e.preventDefault(); }
    if (e.key === 'End') { state.manualH = curTop; e.preventDefault(); }
    if (e.key === 'Home') { state.manualH = 0; e.preventDefault(); }
    state.manualAt = scrollY;
  });

  // ---- pointer: tilt toward the cursor, hover/press keys
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(9, 9);
  if (finePointer && !reduceMotion) {
    addEventListener('pointermove', (e) => {
      state.tmx = (e.clientX / innerWidth) * 2 - 1;
      state.tmy = (e.clientY / innerHeight) * 2 - 1;
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    }, { passive: true });
    canvas.addEventListener('pointerdown', () => { if (state.hover >= 0) ripple(state.hover); });
    canvas.addEventListener('pointerleave', () => { ndc.set(9, 9); });
  }
  function ripple(k0) {
    const r0 = Math.floor(k0 / 5), c0 = k0 % 5;
    for (let k = 0; k < 15; k++) setTimeout(() => { state.flash[k] = 1; }, Math.hypot(Math.floor(k / 5) - r0, (k % 5) - c0) * 70);
  }

  const story = document.querySelector('#story');
  const readScroll = () => { const r = story.getBoundingClientRect(); state.p = clamp(-r.top / Math.max(1, r.height - innerHeight)); };

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.fov = w < 720 ? 38 : 26; camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize); resize();
  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(stage);

  let proFrame = 0, lastLayer = -1;
  function frame() {
    requestAnimationFrame(frame);
    if (!visible) return;
    clock.update(); const t = clock.getElapsed();
    readScroll();
    const p = reduceMotion ? 0 : state.p;

    // model switch
    state.mix = lerp(state.mix, model === 'pro' ? 1 : 0, reduceMotion ? 1 : 0.08);
    const m = state.mix, isPro = m > 0.5;
    const sMx = 1 - smooth(0.0, 0.5, m), sPro = smooth(0.5, 1.0, m);
    root.visible = sMx > 0.001; root.scale.setScalar(MM * Math.max(sMx, 0.0001)); root.position.copy(mxCtr).multiplyScalar(sMx);
    proRoot.visible = !!proCtr && sPro > 0.001;
    if (proCtr) { proRoot.scale.setScalar(MM * Math.max(sPro, 0.0001)); proRoot.position.copy(proCtr).multiplyScalar(sPro); }

    // print height: intro animation, overridden by the slider until the page scrolls on
    curTop = isPro ? proTop : mxTop;
    if (state.manualH !== null && Math.abs(scrollY - state.manualAt) > 120) state.manualH = null;
    const intro = state.printT0 < -1 ? 1 : state.printT0 < 0 ? 0 : easeOut((t - state.printT0) / PRINT_S);
    const h = state.manualH !== null ? state.manualH : intro * curTop;
    curH = h;
    const done = h >= curTop - 0.01;
    localClip.constant = done ? 1e6 : h;
    pivot.updateMatrixWorld(true);
    clipMx.copy(localClip).applyMatrix4(root.matrixWorld);
    clipPro.copy(localClip).applyMatrix4(proRoot.matrixWorld);
    // the orange layer band follows the cut
    const host = isPro ? proRoot : root;
    if (band.parent !== host) { host.add(band); host.add(bandLine); }
    const showBand = done ? 0 : 1;
    const bw = isPro ? 140 : 122, bd = isPro ? 70 : 96, bx = isPro ? 0 : 49.6, by = isPro ? 6 : 24;
    band.scale.set(bw, bd, 1); band.position.set(bx, by, h); bandLine.scale.copy(band.scale); bandLine.position.copy(band.position);
    bandMat.opacity = lerp(bandMat.opacity, 0.1 * showBand, 0.2); bandLine.material.opacity = lerp(bandLine.material.opacity, 0.9 * showBand, 0.2);
    const layer = Math.round(h / LAYER), total = Math.round(curTop / LAYER);
    if (layer !== lastLayer || ui.t.textContent !== String(total)) {
      lastLayer = layer;
      ui.n.textContent = layer; ui.t.textContent = total; ui.mm.textContent = fmt1(h);
      const f = clamp(h / curTop);
      ui.pct.textContent = `${Math.round(f * 100)}%`;
      ui.rail.setAttribute('aria-valuenow', layer); ui.rail.setAttribute('aria-valuemax', total);
      if (vertical()) { ui.fill.style.cssText = `height:${f * 100}%`; ui.thumb.style.cssText = `top:${(1 - f) * 100}%`; }
      else { ui.fill.style.cssText = `width:${f * 100}%`; ui.thumb.style.cssText = `left:${f * 100}%`; }
    }
    // lights come on once the last layer is down
    const on = done ? smooth(0, 0.6, (state.manualH !== null ? 1 : (t - state.printT0 - PRINT_S))) : 0;
    const lit = reduceMotion ? 1 : on;

    // profile: scroll walks through the four, a spool click picks one until the next step
    const auto = STORY_PROFILES[clamp(Math.floor(p * 4.2), 0, 3)];
    if (state.manualProfile && STORY_PROFILES[clamp(Math.floor(state.manualProfile.at * 4.2), 0, 3)] !== auto) state.manualProfile = null;
    setProfile(state.manualProfile ? state.manualProfile.id : auto);

    // camera: three-quarter view on the plate, a slow orbit with the scroll
    state.mx = lerp(state.mx, state.tmx, 0.05); state.my = lerp(state.my, state.tmy, 0.05);
    const narrow = stage.clientWidth < 900;
    const yaw = -0.62 + p * 0.9 + state.mx * 0.18 + (reduceMotion ? 0 : Math.sin(t * 0.35) * 0.03);
    const pitch = 0.62 + state.my * 0.06 - (isPro ? 0.12 : 0);
    pivot.rotation.set(pitch, Math.PI + yaw, 0, 'XYZ');
    pivot.position.set(narrow ? 0 : 0.42, narrow ? -0.5 : -0.1, 0);
    camera.position.set(0, 0, (narrow ? 6.6 : 4.4) * (isPro ? 1.12 : 1));

    // hover
    state.hover = -1;
    if (done && finePointer && Math.abs(m - Math.round(m)) < 0.02) {
      ray.setFromCamera(ndc, camera);
      if (!isPro && pick.length) { const hit = ray.intersectObjects(pick, false)[0]; if (hit) state.hover = hit.object.userData.key; }
      else if (isPro && proCtr) {
        const hit = ray.intersectObjects([screen], false)[0];
        if (hit && hit.uv) { const px = hit.uv.x * 960, py = (1 - hit.uv.y) * 640; for (let k = 0; k < 15; k++) { const [x, y] = tileXY(k); if (px >= x && px <= x + TW && py >= y && py <= y + TH) state.hover = k; } }
      }
    }
    canvas.style.cursor = state.hover >= 0 ? 'pointer' : '';

    for (let k = 0; k < 15; k++) {
      const c = ledColor[k]; c.lerp(ledTarget[k], 0.08);
      state.flash[k] = Math.max(0, state.flash[k] - 0.03);
      const hov = k === state.hover ? 1 : 0;
      const breathe = 0.8 + 0.2 * Math.sin(t * 1.6 + k * 0.35);
      const I = (breathe + hov * 0.8 + state.flash[k] * 1.6) * lit;
      leds[k].material.emissive.copy(c); leds[k].material.emissiveIntensity = 0.3 + I * 3;
      flip[k] = Math.max(0, flip[k] - 0.05);
      if (capMats[k]) { capMats[k].emissive.copy(c); capMats[k].emissiveIntensity = 0.55 * I + state.flash[k] * 0.25 * lit + hov * 0.1; }
      if (caps[k]) caps[k].position.z = lerp(caps[k].position.z, CAP_Z - (hov ? 2.2 : 0) - state.flash[k] * 1.2 - Math.sin(flip[k] * Math.PI) * 1.4, 0.25);
    }
    if (isPro || m > 0.3) {
      for (let k = 0; k < 15; k++) { proColor[k].lerp(proTarget[k], 0.08); proFlip[k] = Math.max(0, proFlip[k] - 0.05); }
      if (proFrame++ % 2 === 0) drawScreen(lit, state.hover, state.flash);
    }
    renderer.render(scene, camera);
  }
  frame();
  return { state };
}

// ============================================================== Pré-visualizar: every ready-made profile
{
  const list = document.querySelector('#plist'), keys = document.querySelector('#pkeys'), cap = document.querySelector('#pcap');
  const ICON_FOR = { default: null, vscode: 'vscode', cursor: 'cursor', figma: 'figma', discord: 'discord', steam: 'steam', dota2: 'dota2', chatgpt: 'chatgpt', claude: 'claude' };
  const NOTE = {
    default: 'Para qualquer app: mídia, volume, captura de tela e atalhos de janelas.',
    vscode: 'Paleta de comandos, terminal, busca e git, no VS Code.',
    cursor: 'Chat, Composer, aceitar sugestão e terminal, no Cursor.',
    figma: 'Ferramentas, componentes e alinhamento, no Figma.',
    discord: 'Mudo, ensurdecer e navegação entre servidores, no Discord.',
    steam: 'Biblioteca, loja, amigos e capturas, na Steam.',
    dota2: 'Atalhos de jogo e de câmera, no Dota 2.',
    chatgpt: 'Prompts prontos: explicar, revisar, testes, resumo.',
    claude: 'Prompts prontos: explicar, revisar, testes, commit, resumo.',
  };
  let cur = null;
  const lum = (hex) => { const n = parseInt(hex, 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
  function show(id) {
    if (cur === id) return; cur = id;
    list.querySelectorAll('button').forEach((b) => { const on = b.dataset.id === id; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    const L = legendsFor(id);
    keys.innerHTML = L.map((l) => {
      const light = lum(l.color) > 0.62;
      const ink = light ? '#1b1f24' : '#fff';
      const g = l.icon ? svg(l.icon, 26, ink) : (l.text ?? '');
      return `<div class="k ${light ? 'lite' : ''} swap" style="--c:#${l.none ? '2b2e33' : l.color}"><span class="g">${g}</span><span class="l">${l.label || ''}</span></div>`;
    }).join('');
    requestAnimationFrame(() => requestAnimationFrame(() => keys.querySelectorAll('.k').forEach((k, i) => setTimeout(() => k.classList.remove('swap'), reduceMotion ? 0 : i * 18))));
    cap.textContent = NOTE[id] || '';
  }
  if (list && keys) {
    list.innerHTML = presets.profiles.map((p) => {
      const ic = ICON_FOR[p.id];
      const used = p.keys.filter((k) => k.action.type !== 'none').length;
      return `<button role="tab" data-id="${p.id}"><span class="ic">${ic && hasIcon(ic) ? svg(ic, 16) : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>'}</span><span>${p.name}<small>${used} teclas</small></span></button>`;
    }).join('');
    list.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.id); });
    show('vscode');
  }
}

// ============================================================== Objetos: MX / Pro
document.querySelectorAll('.tree .grp').forEach((b) => b.addEventListener('click', () => {
  const id = b.dataset.obj;
  document.querySelectorAll('.tree .grp').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.odetail').forEach((d) => d.classList.toggle('ohide', d.dataset.for !== id));
}));
modelListeners.push((m) => document.querySelector(`.tree .grp[data-obj="${m}"]`)?.click());
document.querySelector(`.tree .grp[data-obj="${model}"]`)?.click();

// ============================================================== tabs follow the section in view
{
  const tabs = [...document.querySelectorAll('.tabs a')];
  const secs = tabs.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return;
    tabs.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id));
  }), { rootMargin: '-45% 0px -50% 0px' });
  secs.forEach((s) => io.observe(s));
}

// ============================================================== downloads from the latest release
const isWin = /Windows/i.test(navigator.userAgent);
const isMac = /Mac/i.test(navigator.userAgent) && !/iPhone|iPad/i.test(navigator.userAgent);
document.getElementById(isWin ? 'dl-win' : 'dl-mac')?.classList.add('rec');
fetch('https://api.github.com/repos/isaacviannadev/div-deck/releases/latest')
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then((rel) => {
    const find = (re) => rel.assets.find((a) => re.test(a.name));
    const mac = find(/universal\.dmg$/i) || find(/\.dmg$/i);
    const win = find(/setup\.exe$/i) || find(/\.msi$/i);
    const v = rel.tag_name.replace(/^v/, '');
    if (mac) document.getElementById('dl-mac').href = mac.browser_download_url;
    if (win) document.getElementById('dl-win').href = win.browser_download_url;
    document.getElementById('version').textContent = `Versão ${v} · ${new Date(rel.published_at).toLocaleDateString('pt-BR')}`;
    const mine = isWin ? win : isMac ? mac : null;
    if (mine) {
      document.querySelectorAll('.hero-dl').forEach((a) => {
        a.href = mine.browser_download_url;
        a.querySelector('span').textContent = isWin ? 'Baixar para Windows' : 'Baixar para Mac';
      });
      document.getElementById('hero-meta').textContent = `Versão ${v} · ${(mine.size / 1048576).toFixed(1)} MB · grátis · ${isWin ? 'Windows 10/11' : 'macOS 12+'}`;
    }
  })
  .catch(() => {});
