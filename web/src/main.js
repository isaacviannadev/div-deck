import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ScrollCraft } from 'scroll-craft';
import { svg, drawIcon, hasIcon } from './icons.js';
import presets from './presets.json';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = matchMedia('(pointer: fine)').matches;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };

// ============================================================== page icons
document.querySelectorAll('[data-icon]').forEach((el) => {
  el.insertAdjacentHTML('afterbegin', svg(el.dataset.icon, +(el.dataset.size || 18), el.dataset.color || 'currentColor'));
});

// ============================================================== key legends per profile
// the site shows what each key does in each profile; the real caps are translucent PLA lit by the LED
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
    else text = k.label.slice(0, 4);
    if (icon && !hasIcon(icon)) { text = k.label.slice(0, 3); icon = null; }
    return { icon, text, label: k.label };
  });
}
const STORY_PROFILES = ['default', 'vscode', 'figma', 'discord'];
const PROFILE_NAMES = { default: 'Padrão', vscode: 'VS Code', figma: 'Figma', discord: 'Discord' };

// ============================================================== model selector (DIV Deck MX / DIV Deck Touch; the id stays "pro")
const MODELS = ['mx', 'pro'];
const params = new URLSearchParams(location.search);
let model = params.get('modelo') === 'pro' || location.hash === '#pro' ? 'pro'
  : params.get('modelo') === 'mx' ? 'mx'
  : (() => { try { return localStorage.getItem('divdeck-model'); } catch { return null; } })();
if (!MODELS.includes(model)) model = 'mx';
const modelListeners = [];
function setModel(m, scroll = false) {
  if (!MODELS.includes(m)) return;
  model = m;
  document.documentElement.dataset.model = m;
  document.querySelectorAll('[data-set-model]').forEach((b) => {
    const on = b.dataset.setModel === m;
    b.classList.toggle('on', on);
    if (b.getAttribute('role') === 'tab') b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  try { localStorage.setItem('divdeck-model', m); } catch {}
  const u = new URL(location.href); u.searchParams.set('modelo', m); if (u.hash === '#pro') u.hash = ''; history.replaceState(null, '', u);
  modelListeners.forEach((f) => f(m));
  if (scroll) scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
}
document.querySelectorAll('[data-set-model]').forEach((b) => b.addEventListener('click', (e) => {
  e.preventDefault();
  setModel(b.dataset.setModel, b.hasAttribute('data-scroll-top'));
}));
setModel(model);

// ============================================================== 3D deck
const MM = 0.01;                    // model units are mm → scene units
const T = THREE.MathUtils.degToRad(30);
const TZ = 50.68;                   // deck → desk offset from the OpenSCAD model
const KEY0 = [11.525, 20.525], PITCH = 19.05;
const CAP_Z = 7.2;                  // keycap bottom above the switch plate

const stage = document.querySelector('#stage');
const canvas = document.querySelector('#deck3d');
let three = null;

try {
  if (!canvas || !stage) throw new Error('no canvas');
  three = initThree();
} catch (e) {
  document.documentElement.classList.add('no-webgl');
  console.warn('[divdeck] 3D disabled:', e);
}

function initThree() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.28;

  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
  camera.position.set(0, 0, 3.2);

  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(1.5, 2.5, 2.2); scene.add(key);
  const rimC = new THREE.DirectionalLight(0x38d6ff, 1.4); rimC.position.set(-2.5, 0.6, -1.5); scene.add(rimC);
  const rimV = new THREE.DirectionalLight(0x7c5cff, 1.1); rimV.position.set(2.5, 0.2, -2); scene.add(rimV);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.45, 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // pivot: scroll + mouse rotation. root: OpenSCAD desk frame (z up, mm) → three (y up, m)
  const pivot = new THREE.Group(); scene.add(pivot);
  const root = new THREE.Group(); root.rotation.x = -Math.PI / 2; root.scale.setScalar(MM); pivot.add(root);
  const deck = new THREE.Group(); deck.position.z = TZ; deck.rotation.x = -T; root.add(deck);

  const layers = { tray: new THREE.Group(), pcb: new THREE.Group(), plate: new THREE.Group(), cover: new THREE.Group(), caps: new THREE.Group() };
  Object.values(layers).forEach((g) => deck.add(g));

  const mat = {
    tray: new THREE.MeshPhysicalMaterial({ color: 0x1a1b1f, roughness: 0.6, clearcoat: 0.15, clearcoatRoughness: 0.6 }),
    lid: new THREE.MeshPhysicalMaterial({ color: 0x24262b, roughness: 0.55 }),
    cover: new THREE.MeshPhysicalMaterial({ color: 0x0d0e10, roughness: 0.38, clearcoat: 0.5, clearcoatRoughness: 0.35 }),
    // frosted translucent PLA: the LED below shines through the whole cap
    cap: new THREE.MeshPhysicalMaterial({ color: 0xe6ebf2, roughness: 0.5, transmission: 0.72, thickness: 5, ior: 1.46, attenuationColor: new THREE.Color(0xdfe7f2), attenuationDistance: 14, clearcoat: 0.25, clearcoatRoughness: 0.4 }),
    sw: new THREE.MeshPhysicalMaterial({ color: 0x30343d, roughness: 0.3, metalness: 0.05 }),
    stem: new THREE.MeshPhysicalMaterial({ color: 0x2f6df6, roughness: 0.35 }),
    pcb: new THREE.MeshPhysicalMaterial({ color: 0x0f1012, roughness: 0.32, clearcoat: 0.6 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xd9a944, roughness: 0.3, metalness: 1 }),
    silver: new THREE.MeshStandardMaterial({ color: 0xbfc3c8, roughness: 0.28, metalness: 1 }),
    devkit: new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.45 }),
  };

  // ---- PCB, LEDs and the ESP32 DevKit are simple solids; the case parts come from the real STLs
  const PCB_W = 99.25, PCB_D = 72.15;
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(PCB_W, PCB_D, 1.6), mat.pcb);
  pcb.position.set(PCB_W / 2, PCB_D / 2, -5.8); layers.pcb.add(pcb);
  // key 0 = top-left as seen from the front; the model's x axis runs right-to-left from there
  const keyPos = (k) => { const r = Math.floor(k / 5), c = 4 - (k % 5); return [KEY0[0] + c * PITCH, KEY0[1] + r * PITCH]; };

  const leds = [], glows = [], ledColor = [], ledTarget = [];
  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
  })();
  for (let k = 0; k < 15; k++) {
    const [x, y] = keyPos(k);
    ledColor.push(new THREE.Color(0x38d6ff)); ledTarget.push(new THREE.Color(0x38d6ff));
    const led = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.8, 0.9), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x38d6ff, emissiveIntensity: 3 }));
    led.position.set(x, y - 5.1, -4.8); layers.pcb.add(led); leds.push(led);
    // hot-swap socket outline under each switch
    const sock = new THREE.Mesh(new THREE.BoxGeometry(11, 5, 1.8), mat.devkit);
    sock.position.set(x - 1, y + 2.5, -7.5); layers.pcb.add(sock);
    // light leaking around the keycap, sitting on the faceplate
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), new THREE.MeshBasicMaterial({ map: glowTex, color: 0x38d6ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.set(x, y - 1, 1.7); layers.cover.add(glow); glows.push(glow);
  }
  // light columns from each LED up through the exploded layers (only visible in the light phase)
  const beamTex = (() => {
    const c = document.createElement('canvas'); c.width = 4; c.height = 128;
    const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 0, 128);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.35, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = gr; g.fillRect(0, 0, 4, 128); return new THREE.CanvasTexture(c);
  })();
  const beams = [];
  for (let k = 0; k < 15; k++) {
    const [x, y] = keyPos(k);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 1.6, 64, 24, 1, true),
      new THREE.MeshBasicMaterial({ map: beamTex, color: 0x38d6ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.rotation.x = Math.PI / 2; beam.position.set(x, y - 2.5, -4.4 + 32);
    layers.pcb.add(beam); beams.push(beam);
  }

  // DevKit (desk frame, upside down in its corral, header pins up)
  const devkit = new THREE.Group(); root.add(devkit);
  const board = new THREE.Mesh(new THREE.BoxGeometry(51.5, 28.3, 1.6), mat.devkit); devkit.add(board);
  const can = new THREE.Mesh(new THREE.BoxGeometry(18, 25.5, 3.2), mat.silver); can.position.set(14, 0, -2.4); devkit.add(can);
  for (const sy of [-1, 1]) {
    const hdr = new THREE.Mesh(new THREE.BoxGeometry(38, 2.5, 2.5), mat.devkit); hdr.position.set(-4, sy * 12.2, 2.05); devkit.add(hdr);
    for (let i = 0; i < 15; i++) { const pin = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.64, 6), mat.gold); pin.position.set(-21.8 + i * 2.54, sy * 12.2, 5); devkit.add(pin); }
  }
  devkit.position.set(26, 8.2, 7.7);

  // ---- DIV Deck Touch: 4" touchscreen panel on its desk foot (case parts from the real STLs)
  const P_T = 15.5, P_W = 124, P_H = 72, VA = [85.22, 56.88];
  const proRoot = new THREE.Group(); proRoot.rotation.x = -Math.PI / 2; proRoot.scale.setScalar(0.0001); pivot.add(proRoot);
  const proRig = new THREE.Group(); proRig.rotation.z = Math.PI; proRoot.add(proRig);   // front of the panel towards +y like the MX
  const panel = new THREE.Group(); proRig.add(panel);
  panel.rotation.x = THREE.MathUtils.degToRad(65);
  panel.position.set(0, (P_H / 2) * Math.cos(THREE.MathUtils.degToRad(65)), 5 + (P_H / 2) * Math.sin(THREE.MathUtils.degToRad(65)));
  const pro = { back: new THREE.Group(), board: new THREE.Group(), pcb: new THREE.Group(), glass: new THREE.Group(), bezel: new THREE.Group(), pen: new THREE.Group(), foot: new THREE.Group() };
  ['back', 'board', 'pcb', 'glass', 'bezel', 'pen'].forEach((k) => panel.add(pro[k]));
  proRig.add(pro.foot);
  const pmat = {
    white: new THREE.MeshPhysicalMaterial({ color: 0xe8e9ec, roughness: 0.58, clearcoat: 0.08 }),
    black: new THREE.MeshPhysicalMaterial({ color: 0x0b0b0d, roughness: 0.32, clearcoat: 0.5, clearcoatRoughness: 0.3 }),
    pcb: new THREE.MeshPhysicalMaterial({ color: 0x8f1218, roughness: 0.42, clearcoat: 0.4 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x050506, roughness: 0.06, clearcoat: 1, metalness: 0.1 }),
    pen: new THREE.MeshPhysicalMaterial({ color: 0x2a2c31, roughness: 0.4 }),
  };
  const PCB_X0 = -58.03;
  { const m = new THREE.Mesh(new THREE.BoxGeometry(108.04, 61.74, 1.6), pmat.pcb); m.position.set(PCB_X0 + 54.02, 0, 8.65 + 0.8); pro.pcb.add(m);
    // header strip at the PCB end
    const h = new THREE.Mesh(new THREE.BoxGeometry(2.5, 35.6, 2.5), mat.devkit); h.position.set(PCB_X0 + 1.6, 0, 7.4); pro.pcb.add(h); }
  { const g = new THREE.Mesh(new THREE.BoxGeometry(94.57, 60.88, 4.0), pmat.glass); g.position.set(0, 0, 10.25 + 2.0); pro.glass.add(g); }
  // the picture: a canvas the page redraws (tiles, icons, labels) — what the app sends to the real deck
  const scr = document.createElement('canvas'); scr.width = 960; scr.height = 640;
  const sg = scr.getContext('2d');
  const scrTex = new THREE.CanvasTexture(scr); scrTex.colorSpace = THREE.SRGBColorSpace; scrTex.anisotropy = 8;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(VA[0], VA[1]), new THREE.MeshBasicMaterial({ map: scrTex, toneMapped: false }));
  screen.position.z = 14.27; pro.glass.add(screen);
  { const b = new THREE.Mesh(new THREE.BoxGeometry(23.5, 18, 1.0), mat.devkit); b.position.set(46.85, 0, -11.4); pro.board.add(b);
    const usb = new THREE.Mesh(new THREE.BoxGeometry(7.4, 8.9, 3.2), mat.silver); usb.position.set(56.2, 0, -9.3); pro.board.add(usb);
    const chip = new THREE.Mesh(new THREE.BoxGeometry(7, 7, 0.9), mat.sw); chip.position.set(46, 0, -10.5); pro.board.add(chip); }
  { const body = new THREE.Mesh(new THREE.CylinderGeometry(2.75, 2.75, 80, 24), pmat.pen); body.rotation.z = Math.PI / 2; body.position.x = -6;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(2.75, 12, 24), pmat.pen); tip.rotation.z = -Math.PI / 2; tip.position.x = 40;
    pro.pen.add(body, tip); pro.pen.position.set(-4, 34.4, 5); }
  const proPick = [screen];
  let proCtr = null;
  new GLTFLoader().load('assets/divdeck-pro.glb', (gltf) => {
    const get = (n) => { const m = gltf.scene.getObjectByName(n); m.geometry = toCreasedNormals(m.geometry, THREE.MathUtils.degToRad(35)); return m; };
    const back = get('back'); back.material = pmat.white; pro.back.add(back);
    const bezel = get('bezel'); bezel.material = pmat.black; pro.bezel.add(bezel);
    bezel.geometry.computeBoundingBox();
    const bb = bezel.geometry.boundingBox;
    faceTouch = new THREE.Mesh(new THREE.PlaneGeometry(bb.max.x - bb.min.x, bb.max.y - bb.min.y),
      new THREE.MeshStandardMaterial({ map: faceTex.pro[0], transparent: true, roughness: 0.5, alphaTest: 0.5 }));
    faceTouch.position.set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, bb.max.z + 0.05);
    faceTouch.visible = faceState.pro !== 0;
    pro.bezel.add(faceTouch);
    const foot = get('foot'); foot.material = pmat.white; pro.foot.add(foot);
    proRoot.scale.setScalar(MM); proRoot.position.set(0, 0, 0); proRoot.updateMatrixWorld(true);
    const saved = [pivot.position.clone(), pivot.rotation.clone()];
    pivot.position.set(0, 0, 0); pivot.rotation.set(0, 0, 0); scene.updateMatrixWorld(true);
    proCtr = new THREE.Box3().setFromObject(proRoot, true).getCenter(new THREE.Vector3()).negate();
    pivot.position.copy(saved[0]); pivot.rotation.copy(saved[1]);
  });

  // tiles on the Pro screen (same grid as the firmware: 5 x 3, 8 px margin and gap at 480 x 320)
  const proColor = [], proTarget = [], proFlip = new Array(15).fill(0);
  for (let k = 0; k < 15; k++) { proColor.push(new THREE.Color(0x38d6ff)); proTarget.push(new THREE.Color(0x38d6ff)); }
  let proLegends = [];
  const TW = (960 - 32 - 64) / 5, TH = (640 - 32 - 32) / 3;
  const tileXY = (k) => [16 + (k % 5) * (TW + 16), 16 + Math.floor(k / 5) * (TH + 16)];
  function drawScreen(wave, t, lp, hover, flash) {
    sg.fillStyle = '#000'; sg.fillRect(0, 0, 960, 640);
    for (let k = 0; k < 15; k++) {
      const [x, y] = tileXY(k);
      const c = proColor[k].clone();
      let ring = 0;
      if (wave > 0) {
        const d = Math.hypot((k % 5) - 2, Math.floor(k / 5) - 1);
        hsl.setHSL((((d * 0.24 + (k % 5) * 0.05 - t * 0.3 + lp * 0.8) % 1) + 1) % 1, 0.78, 0.52);
        c.lerp(hsl, wave);
        ring = Math.max(0, Math.sin(d * 1.6 - t * 4.2)) ** 3;
      }
      const press = Math.max(flash[k], hover === k ? 0.6 : 0, Math.sin(proFlip[k] * Math.PI));
      const inset = press * 7;
      const f = 0.72 + press * 0.22 + ring * 0.08 - wave * 0.06;
      sg.fillStyle = `rgb(${Math.min(255, c.r * 255 * f)},${Math.min(255, c.g * 255 * f)},${Math.min(255, c.b * 255 * f)})`;
      sg.beginPath(); sg.roundRect(x + inset, y + inset, TW - 2 * inset, TH - 2 * inset, 28); sg.fill();
      const gr = sg.createLinearGradient(0, y, 0, y + TH);
      gr.addColorStop(0, 'rgba(255,255,255,.16)'); gr.addColorStop(0.55, 'rgba(255,255,255,0)');
      sg.fillStyle = gr; sg.fill();
      const l = proLegends[k]; if (!l) continue;
      const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      const ink = lum * f > 0.68 ? '#111' : '#fff';
      if (l.icon) drawIcon(sg, l.icon, x + TW / 2, y + TH / 2 - 14, 64, ink);
      else if (l.text) {
        sg.fillStyle = ink; sg.textAlign = 'center'; sg.textBaseline = 'middle';
        sg.font = `700 ${l.text.length > 3 ? 30 : 40}px -apple-system, "SF Pro Display", Inter, system-ui, sans-serif`;
        sg.fillText(l.text, x + TW / 2, y + TH / 2 - 14);
      }
      if (l.label) {
        sg.fillStyle = ink; sg.globalAlpha = 0.9; sg.textAlign = 'center'; sg.textBaseline = 'alphabetic';
        sg.font = `600 22px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif`;
        sg.fillText(l.label.length > 11 ? l.label.slice(0, 10) + '…' : l.label, x + TW / 2, y + TH - 18);
        sg.globalAlpha = 1;
      }
    }
    scrTex.needsUpdate = true;
  }

  // ---- a profile changes what each key does (icon / label on top) and its LED colour
  const legendCanvas = [], legendTex = [];
  function applyProfile(profileId) {
    const p = presets.profiles.find((x) => x.id === profileId);
    p.keys.forEach((k, i) => { ledTarget[i].set('#' + k.color); proTarget[i].set('#' + k.color); });
    proLegends = legendsFor(profileId);
    proFlip.fill(1);
    legendsFor(profileId).forEach((l, k) => {
      const c = legendCanvas[k]; if (!c) return;
      const g = c.getContext('2d');
      g.clearRect(0, 0, 256, 256);
      g.shadowColor = 'rgba(255,255,255,.35)'; g.shadowBlur = 6;
      const ink = '#16181d';
      if (l.icon) drawIcon(g, l.icon, 128, l.text ? 112 : 120, 118, ink);
      else if (l.text) {
        g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'middle';
        const fs = l.text.length > 3 ? 54 : l.text.length > 2 ? 70 : 92;
        g.font = `600 ${fs}px -apple-system, "SF Pro Display", Inter, system-ui, sans-serif`;
        g.fillText(l.text, 128, 110);
      }
      if (l.label) {
        g.fillStyle = 'rgba(22,24,29,.78)'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.font = `600 30px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif`;
        g.fillText(l.label.length > 10 ? l.label.slice(0, 9) + '…' : l.label, 128, 214);
      }
      legendTex[k].needsUpdate = true;
      flip[k] = 1;
    });
  }
  const flip = new Array(15).fill(0); // little press when the legend changes

  let mxCtr = new THREE.Vector3();
  // swappable faces (MX) and screen covers (Touch): pictures of the real printed parts
  const texLoader = new THREE.TextureLoader();
  const loadTex = (u) => { const t = texLoader.load(u); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
  const FACES = {
    mx: ['basica', 'codigo', 'topografica', 'futurista', 'gamer'],
    pro: [null, 'touch-code-grafite', 'touch-code-creme', 'touch-sup-grafite', 'touch-sup-creme'],
  };
  const FACE_NAMES = {
    mx: ['Básica', 'Código', 'Topográfica', 'Futurista', 'Gamer'],
    pro: ['Lisa', 'Code · grafite', 'Code · creme', 'Superfície · grafite', 'Superfície · creme'],
  };
  const faceTex = {
    mx: FACES.mx.map((n, i) => i ? loadTex(`assets/faces/mx-${n}.png`) : null),
    pro: FACES.pro.map((n) => n ? loadTex(`assets/faces/${n}.png`) : null),
  };
  let faceMx = null, faceTouch = null, podInlay = null;
  const pod = new THREE.Group(); layers.cover.add(pod);
  const oled = document.createElement('canvas'); oled.width = 256; oled.height = 128;
  const oledTex = new THREE.CanvasTexture(oled); oledTex.colorSpace = THREE.SRGBColorSpace;
  let oledKey = '';
  function drawOled(profileName) {
    const d = new Date();
    const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const key = hm + profileName; if (key === oledKey) return; oledKey = key;
    const g = oled.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#e8f4ff'; g.textBaseline = 'middle';
    g.font = '700 54px ui-monospace, Menlo, monospace'; g.textAlign = 'center'; g.fillText(hm, 128, 50);
    g.font = '500 20px ui-monospace, Menlo, monospace';
    g.textAlign = 'left'; g.fillText('> ' + profileName, 14, 106);
    g.textAlign = 'right'; g.fillText(d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }), 242, 106);
    oledTex.needsUpdate = true;
  }
  const faceState = { mx: 0, pro: 0, lift: 0 };
  const caps = [], capMats = [];
  const pick = []; // meshes for raycasting
  const state = { mix: model === 'pro' ? 1 : 0, p: 0, explode: 0, mx: 0, my: 0, tmx: 0, tmy: 0, hover: -1, profile: '', wave: 0, flash: new Array(15).fill(0) };

  new GLTFLoader().load('assets/divdeck.glb', (gltf) => {
    const get = (n) => { const m = gltf.scene.getObjectByName(n); m.geometry = toCreasedNormals(m.geometry, THREE.MathUtils.degToRad(35)); return m; };
    const tray = get('tray'); tray.material = mat.tray; layers.tray.add(tray);
    const lid = get('lid'); lid.material = mat.lid; layers.plate.add(lid);
    const cover = get('cover'); cover.material = mat.cover; layers.cover.add(cover);
    // the removable face: a picture of each printed face laid on the plate (keycap holes are transparent)
    cover.geometry.computeBoundingBox();
    const cb = cover.geometry.boundingBox;
    faceMx = new THREE.Mesh(new THREE.PlaneGeometry(cb.max.x - cb.min.x, cb.max.y - cb.min.y),
      new THREE.MeshStandardMaterial({ map: faceTex.mx[faceState.mx], transparent: true, roughness: 0.55, alphaTest: 0.5 }));
    faceMx.position.set((cb.min.x + cb.max.x) / 2, (cb.min.y + cb.max.y) / 2, cb.max.z + 0.05);
    faceMx.rotation.z = Math.PI;   // the renders are drawn from the front of the deck
    faceMx.visible = faceState.mx !== 0;
    layers.cover.add(faceMx);
    // the OLED pod clips on behind the keys
    for (const n of ['pod_shell', 'pod_base', 'pod_glass']) {
      const m = gltf.scene.getObjectByName(n); if (!m) continue;
      m.geometry = toCreasedNormals(m.geometry, THREE.MathUtils.degToRad(35));
      m.material = n === 'pod_glass' ? new THREE.MeshBasicMaterial({ color: 0x07080a }) : n === 'pod_base' ? mat.lid : mat.cover;
      pod.add(m);
      if (n === 'pod_glass') {
        // the OLED: time, date and the profile, as the firmware draws them
        m.geometry.computeBoundingBox(); const g = m.geometry.boundingBox;
        const scr = new THREE.Mesh(new THREE.PlaneGeometry((g.max.x - g.min.x) * 0.86, (g.max.y - g.min.y) * 0.8), new THREE.MeshBasicMaterial({ map: oledTex, transparent: true, toneMapped: false }));
        scr.position.set((g.min.x + g.max.x) / 2, (g.min.y + g.max.y) / 2, g.max.z + 0.05); scr.rotation.z = Math.PI; scr.renderOrder = 3; pod.add(scr);
      }
    }
    { const t = texLoader.load('assets/pod_inlay.png'); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
      const a = { x0: 22.70, x1: 76.28, y0: -16.09, y1: 7.73, z: 13.6 };
      const m = new THREE.Mesh(new THREE.PlaneGeometry(a.x1 - a.x0, a.y1 - a.y0), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, toneMapped: false }));
      m.position.set((a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2, a.z + 0.03); m.renderOrder = 2; m.visible = faceState.mx === 1; podInlay = m; pod.add(m); }
    const swGeo = get('switch').geometry, stemGeo = get('stem').geometry;
    const capGeos = [get('keycap1').geometry, get('keycap2').geometry, get('keycap3').geometry]; // Pro caps, sculpted per row
    for (let k = 0; k < 15; k++) {
      const [x, y] = keyPos(k);
      const sw = new THREE.Mesh(swGeo, mat.sw); sw.position.set(x, y, 0); layers.plate.add(sw);
      const cap = new THREE.Group(); cap.position.set(x, y, CAP_Z); layers.caps.add(cap);
      const body = new THREE.Mesh(capGeos[Math.floor(k / 5)], mat.cap.clone()); capMats[k] = body.material; body.userData.key = k; cap.add(body); pick.push(body);
      // the MX stem travels with the keycap (geometry is in switch coordinates, plate top = 0)
      const stem = new THREE.Mesh(stemGeo, mat.stem); stem.position.z = -CAP_Z; cap.add(stem);
      // legend printed on top of the cap (canvas texture redrawn per profile)
      const c = document.createElement('canvas'); c.width = c.height = 256; legendCanvas.push(c);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; legendTex.push(tex);
      const capTop = [8.54, 7.6, 8.2][Math.floor(k / 5)];
      const legend = new THREE.Mesh(new THREE.PlaneGeometry(11, 11), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
      legend.position.z = capTop + 0.32; legend.rotation.z = Math.PI; legend.renderOrder = 2; cap.add(legend);
      caps.push(cap);
    }
    // centre the model on the pivot
    // measure with the pivot at rest (the render loop may already have rotated it)
    const saved = [pivot.position.clone(), pivot.rotation.clone()];
    pivot.position.set(0, 0, 0); pivot.rotation.set(0, 0, 0);
    scene.updateMatrixWorld(true);
    const ctr = new THREE.Box3().setFromObject(root, true).getCenter(new THREE.Vector3());
    root.position.sub(ctr); mxCtr = root.position.clone();
    pivot.position.copy(saved[0]); pivot.rotation.copy(saved[1]);
    applyProfile(state.profile || 'default');
    document.documentElement.classList.add('deck-ready');
  });

  function setProfile(id) {
    if (state.profile === id) return;
    state.profile = id;
    applyProfile(id);
    const lbl = document.querySelector('#story-profile');
    if (lbl) lbl.textContent = PROFILE_NAMES[id];
    drawOled(PROFILE_NAMES[id]);
  }

  // ---- mouse: tilt toward the cursor, hover/press keys
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
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
    for (let k = 0; k < 15; k++) {
      const d = Math.hypot(Math.floor(k / 5) - r0, (k % 5) - c0);
      setTimeout(() => { state.flash[k] = 1; }, d * 70);
    }
  }

  // ---- scroll timeline
  const story = document.querySelector('#story');
  const captions = [...document.querySelectorAll('[data-at]')];
  function readScroll() {
    const r = story.getBoundingClientRect();
    state.p = clamp(-r.top / (r.height - innerHeight));
  }
  // keyframes: [p, yaw, pitch, distance, offset x, offset y]  (offsets keep the model clear of the captions)
  // chapters: hero ..0.09 · keys 0.12-0.24 · inside 0.27-0.41 · light 0.44-0.57 · faces 0.6-0.74 · profiles 0.77..
  const KF = [
    [0.0, -0.6, 0.5, 5.8, 0, -0.98], [0.08, -0.6, 0.5, 5.8, 0, -0.98],
    [0.15, -0.15, 1.0, 3.6, 0.42, -0.02], [0.23, -0.15, 1.0, 3.6, 0.42, -0.02],
    [0.32, 0.55, 0.48, 4.6, -0.5, 0.06], [0.4, 0.6, 0.45, 4.6, -0.5, 0.06],
    [0.47, 0.15, 0.34, 4.6, 0.42, -0.06], [0.55, 0.3, 0.38, 4.6, 0.42, -0.06],
    [0.62, -0.08, 1.12, 3.8, -0.42, 0.0], [0.73, 0.06, 1.08, 3.8, -0.42, 0.0],
    [0.8, -0.45, 0.62, 3.9, -0.42, -0.02], [1.0, -0.4, 0.62, 3.9, -0.42, -0.02],
  ];
  function camAt(p) {
    let i = 0; while (i < KF.length - 2 && p > KF[i + 1][0]) i++;
    const a = KF[i], b = KF[i + 1];
    const t = smooth(a[0], b[0], p);
    return a.slice(1).map((v, j) => lerp(v, b[j + 1], t));
  }

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false); composer.setSize(w, h); bloom.setSize(w, h);
    camera.aspect = w / h;
    camera.fov = w < 700 ? 40 : 28;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize); resize();

  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(stage);

  let proFrame = 0;
  const floatSel = document.querySelector('.model-float');
  const faceLabel = document.querySelector('#story-face');
  const clock = new THREE.Timer();
  const hsl = new THREE.Color();
  function frame() {
    requestAnimationFrame(frame);
    if (!visible) return;
    clock.update(); const t = clock.getElapsed();
    readScroll();
    const p = reduceMotion ? 0 : state.p;

    // model switch: the current deck spins away, the other one spins in
    state.mix = lerp(state.mix, model === 'pro' ? 1 : 0, reduceMotion ? 1 : 0.07);
    const m = state.mix;
    const sMx = 1 - smooth(0.0, 0.55, m), sPro = smooth(0.45, 1.0, m);
    root.visible = sMx > 0.001; root.scale.setScalar(MM * Math.max(sMx, 0.0001)); root.position.copy(mxCtr).multiplyScalar(sMx);
    proRoot.visible = !!proCtr && sPro > 0.001;
    if (proCtr) { proRoot.scale.setScalar(MM * Math.max(sPro, 0.0001)); proRoot.position.copy(proCtr).multiplyScalar(sPro); }
    const isPro = m > 0.5;

    // explode 0.30 → 0.52, hold, reassemble 0.70 → 0.84 (MX: the light phase happens exploded, with the beams)
    // Pro: opens only for "Por dentro" and is whole again before the colour phase
    const exMx = smooth(0.25, 0.37, p) * (1 - smooth(0.55, 0.6, p));
    const exPro = smooth(0.26, 0.32, p) * (1 - smooth(0.39, 0.44, p));
    const ex = isPro ? exPro : exMx;
    state.explode = ex;
    // Pro: the layers lift off the back along the panel's normal, the foot drops, the pen slides out
    const exp = exPro;
    // faces chapter: the face / cover lifts off, changes, and clicks back in
    const inFaces = p > 0.6 && p < 0.745;
    const fi = inFaces ? clamp(Math.floor(((p - 0.6) / 0.145) * FACES[isPro ? 'pro' : 'mx'].length), 0, FACES[isPro ? 'pro' : 'mx'].length - 1) : 0;
    const want = isPro ? 'pro' : 'mx';
    if (faceState[want] !== fi || faceState.lift > 0.001) {
      if (faceState[want] !== fi) {
        faceState.lift = Math.min(1, faceState.lift + (reduceMotion ? 1 : 0.12));
        if (faceState.lift >= 1) {
          faceState[want] = fi;
          if (want === 'mx' && faceMx) { faceMx.material.map = faceTex.mx[fi]; faceMx.material.needsUpdate = true; faceMx.visible = fi !== 0; if (podInlay) podInlay.visible = fi === 1; }
          if (want === 'pro' && faceTouch) { faceTouch.material.map = faceTex.pro[fi]; faceTouch.material.needsUpdate = true; faceTouch.visible = fi !== 0; }
        }
      } else faceState.lift = Math.max(0, faceState.lift - 0.08);
    }
    const lift = Math.sin(faceState.lift * Math.PI / 2);
    if (faceLabel) { const t = FACE_NAMES[want][faceState[want]]; if (faceLabel.textContent !== t) faceLabel.textContent = t; }
    pro.board.position.z = exp * 10; pro.pcb.position.z = exp * 22; pro.glass.position.z = exp * 34; pro.bezel.position.z = exp * 50 + (isPro ? lift * 22 : 0);
    pro.pen.position.x = -4 + exp * 95;
    pro.foot.position.z = -exp * 26; pro.foot.position.y = exp * 18;
    layers.caps.position.z = ex * 62;
    layers.cover.position.z = ex * 42 + (isPro ? 0 : lift * 16);
    layers.plate.position.z = ex * 25;
    layers.pcb.position.z = ex * 9;
    devkit.position.z = 7.7 - ex * 6;

    // profile shown on the keys
    setProfile(p < 0.77 ? 'default' : STORY_PROFILES[clamp(Math.floor((p - 0.77) / 0.055) + 1, 0, 3)]);

    // mouse follow
    state.mx = lerp(state.mx, state.tmx, 0.06); state.my = lerp(state.my, state.tmy, 0.06);
    let [yaw, pitch, dist, ox, oy] = camAt(p);
    // the Touch stands up: look at its face from the front in the covers chapter
    pitch -= m * 0.78 * smooth(0.58, 0.62, p) * (1 - smooth(0.74, 0.78, p));
    dist *= 1 + m * 0.12 + exPro * m * 0.18;   // the Pro is wider: step back a little, more when it opens
    ox *= 1 + exPro * m * 0.25;
    oy -= m * 0.14 * (1 - smooth(0.08, 0.18, p));   // the Pro stands taller: keep it under the hero text
    if (stage.clientWidth < 900) { ox = 0; oy = p < 0.1 ? -1.75 : 0.22; dist *= p < 0.1 ? 1.6 : 1.45; }
    const idle = reduceMotion ? 0 : Math.sin(t * 0.5) * 0.04;
    const spin = Math.sin(Math.PI * m) * 0.9 * (model === 'pro' ? 1 : -1);
    pivot.rotation.set(pitch + state.my * 0.12, Math.PI + yaw + state.mx * 0.28 + idle + spin, 0, 'XYZ');
    pivot.position.set(ox, oy + Math.sin(t * 0.8) * 0.012, 0);
    camera.position.set(0, 0, dist);

    // hover (only when assembled)
    state.hover = -1;
    if (ex < 0.05 && finePointer && Math.abs(m - Math.round(m)) < 0.02) {
      ray.setFromCamera(ndc, camera);
      if (!isPro && pick.length) {
        const hit = ray.intersectObjects(pick, false)[0];
        if (hit) state.hover = hit.object.userData.key;
      } else if (isPro && proCtr) {
        const hit = ray.intersectObjects(proPick, false)[0];
        if (hit && hit.uv) {
          const px = hit.uv.x * 960, py = (1 - hit.uv.y) * 640;
          for (let k = 0; k < 15; k++) { const [x, y] = tileXY(k); if (px >= x && px <= x + TW && py >= y && py <= y + TH) state.hover = k; }
        }
      }
    }
    canvas.style.cursor = state.hover >= 0 ? 'pointer' : '';

    // LEDs: profile colours + breathing, rainbow wave while exploded, hover/press flashes
    const wave = smooth(0.43, 0.48, p) * (1 - smooth(0.55, 0.59, p));
    // the Pro's screen is already bright: much less bloom than the MX's LEDs
    bloom.strength = lerp(0.55 + wave * 0.85, 0.16 + wave * 0.14, m);
    bloom.threshold = lerp(0.92 - wave * 0.25, 0.95 - wave * 0.05, m);
    scene.environmentIntensity = 0.28 * (1 - wave * 0.7);
    key.intensity = 1.5 * (1 - wave * 0.75);
    // light phase pattern: a colour ripple from the centre key with travelling bright rings
    const lp = (p - 0.47) / 0.1;
    for (let k = 0; k < 15; k++) {
      const c = ledColor[k];
      c.lerp(ledTarget[k], 0.08);
      const col = c.clone();
      let ring = 0;
      if (wave > 0) {
        const d = Math.hypot((k % 5) - 2, Math.floor(k / 5) - 1);
        hsl.setHSL((((d * 0.24 + (k % 5) * 0.05 - t * 0.3 + lp * 0.8) % 1) + 1) % 1, 0.95, 0.55);
        col.lerp(hsl, wave);
        ring = Math.max(0, Math.sin(d * 1.6 - t * 4.2)) ** 3;
      }
      state.flash[k] = Math.max(0, state.flash[k] - 0.03);
      const hov = k === state.hover ? 1 : 0;
      const breathe = 0.75 + 0.25 * Math.sin(t * 1.6 + k * 0.35);
      const I = breathe + hov * 0.8 + state.flash[k] * 1.6 + wave * (0.5 + ring * 1.4);
      leds[k].material.emissive.copy(col); leds[k].material.emissiveIntensity = 2 + I * 2;
      glows[k].material.color.copy(col).multiplyScalar(0.55 * I * (1 - exMx * 0.85));
      beams[k].material.color.copy(col); beams[k].material.opacity = wave * (0.18 + ring * 0.5) * exMx;
      flip[k] = Math.max(0, flip[k] - 0.05);
      if (capMats[k]) { capMats[k].emissive.copy(col); capMats[k].emissiveIntensity = (0.26 + 0.12 * I) * (1 - exMx * 0.6) + wave * (0.12 + ring * 0.3) + state.flash[k] * 0.25 + hov * 0.12; }
      if (caps[k]) caps[k].position.z = lerp(caps[k].position.z, CAP_Z - (hov ? 2.2 : 0) - state.flash[k] * 1.2 - Math.sin(flip[k] * Math.PI) * 1.4, 0.25);
    }

    // Pro screen: tile colours follow the profile, rainbow wave in the light phase
    if (isPro || m > 0.3) {
      for (let k = 0; k < 15; k++) { proColor[k].lerp(proTarget[k], 0.08); proFlip[k] = Math.max(0, proFlip[k] - 0.05); }
      if (proFrame++ % 2 === 0) drawScreen(wave, t, lp, state.hover, state.flash);
    }

    if ((proFrame & 63) === 0) drawOled(PROFILE_NAMES[state.profile] || 'Padrão');
    // captions
    captions.forEach((el) => {
      const [a, b] = el.dataset.at.split(',').map(Number);
      const o = smooth(a, a + 0.03, p) * (1 - smooth(b - 0.03, b, p));
      el.style.opacity = o.toFixed(3);
      el.style.transform = `translateY(${((1 - o) * (p < a + 0.03 ? 24 : -24)).toFixed(1)}px)`;
      el.style.pointerEvents = o > 0.5 ? 'auto' : 'none';
    });
    document.documentElement.style.setProperty('--story', p.toFixed(4));
    floatSel?.classList.toggle('live', p > 0.13);

    composer.render();
  }
  frame();
  return { state };
}

// ============================================================== page motion (scroll-craft + pointer effects)
const sc = new ScrollCraft();
if (!reduceMotion) {
  sc.reveal('.reveal', { direction: 'up', distance: '28px', duration: 800, ease: 'quartOut' });
  document.querySelectorAll('.stagger').forEach((group) => {
    [...group.children].forEach((el, i) => sc.reveal(el, { delay: i * 90, distance: '32px', duration: 850, ease: 'quartOut' }));
  });
}
sc.counter('[data-count]', { duration: 1800, ease: 'quartOut', formatter: (n) => n.toLocaleString('pt-BR') })
  .progress('.steps .step', { start: 0.85, end: 0.45 });

if (finePointer && !reduceMotion) {
  // spotlight that follows the cursor on cards
  document.querySelectorAll('.spot').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  });
  // 3D tilt
  document.querySelectorAll('.tilt').forEach((el) => {
    const max = +(el.dataset.tilt || 6);
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `perspective(1200px) rotateY(${x * max}deg) rotateX(${-y * max}deg)`;
    });
    el.addEventListener('pointerleave', () => { el.style.transform = ''; });
  });
  // magnetic buttons and pills
  document.querySelectorAll('.magnetic').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
      el.style.transform = `translate(${x * 0.18}px, ${y * 0.25}px)`;
    });
    el.addEventListener('pointerleave', () => { el.style.transform = ''; });
  });
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
      document.getElementById('hero-meta').textContent = `Versão ${v} · ${(mine.size / 1048576).toFixed(1)} MB · grátis`;
    }
  })
  .catch(() => {});

// Packaging photos: preserve a normal image link when the browser lacks dialogs.
const packDialog = document.querySelector('#pack-view');
if (typeof packDialog?.showModal === 'function') {
  const photo = packDialog.querySelector('img');
  const title = packDialog.querySelector('#pack-view-title');
  for (const link of document.querySelectorAll('[data-pack-image]')) {
    link.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      title.textContent = link.dataset.packImage;
      photo.src = link.href;
      packDialog.showModal();
    });
  }
  packDialog.addEventListener('click', (event) => { if (event.target === packDialog) packDialog.close(); });
}
