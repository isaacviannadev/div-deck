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
    return { icon, text, color: '#' + k.color };
  });
}
const STORY_PROFILES = ['default', 'vscode', 'figma', 'discord'];
const PROFILE_NAMES = { default: 'Padrão', vscode: 'VS Code', figma: 'Figma', discord: 'Discord' };

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
    cap: new THREE.MeshPhysicalMaterial({ color: 0xc9cace, roughness: 0.68 }),
    sw: new THREE.MeshPhysicalMaterial({ color: 0x30343d, roughness: 0.3, metalness: 0.05 }),
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
  // DevKit (desk frame, upside down in its corral, header pins up)
  const devkit = new THREE.Group(); root.add(devkit);
  const board = new THREE.Mesh(new THREE.BoxGeometry(51.5, 28.3, 1.6), mat.devkit); devkit.add(board);
  const can = new THREE.Mesh(new THREE.BoxGeometry(18, 25.5, 3.2), mat.silver); can.position.set(14, 0, -2.4); devkit.add(can);
  for (const sy of [-1, 1]) {
    const hdr = new THREE.Mesh(new THREE.BoxGeometry(38, 2.5, 2.5), mat.devkit); hdr.position.set(-4, sy * 12.2, 2.05); devkit.add(hdr);
    for (let i = 0; i < 15; i++) { const pin = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.64, 6), mat.gold); pin.position.set(-21.8 + i * 2.54, sy * 12.2, 5); devkit.add(pin); }
  }
  devkit.position.set(26, 8.2, 7.7);

  // ---- keycap legends (canvas textures, redrawn per profile)
  const legendCanvas = [], legendTex = [];
  function drawLegends(profileId) {
    const L = legendsFor(profileId);
    L.forEach((l, k) => {
      const c = legendCanvas[k], g = c.getContext('2d');
      g.clearRect(0, 0, 256, 256);
      if (l.icon) drawIcon(g, l.icon, 128, 128, 132, '#2a2b30');
      else if (l.text) {
        g.fillStyle = '#2a2b30';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        const fs = l.text.length > 3 ? 56 : l.text.length > 2 ? 72 : 96;
        g.font = `600 ${fs}px -apple-system, "SF Pro Display", Inter, system-ui, sans-serif`;
        g.fillText(l.text, 128, 134);
      }
      legendTex[k].needsUpdate = true;
      ledTarget[k].set(l.color);
    });
  }

  const caps = [];
  const pick = []; // meshes for raycasting
  const state = { p: 0, explode: 0, mx: 0, my: 0, tmx: 0, tmy: 0, hover: -1, profile: '', wave: 0, flash: new Array(15).fill(0) };

  new GLTFLoader().load('assets/divdeck.glb', (gltf) => {
    const get = (n) => { const m = gltf.scene.getObjectByName(n); m.geometry = toCreasedNormals(m.geometry, THREE.MathUtils.degToRad(35)); return m; };
    const tray = get('tray'); tray.material = mat.tray; layers.tray.add(tray);
    const lid = get('lid'); lid.material = mat.lid; layers.plate.add(lid);
    const cover = get('cover'); cover.material = mat.cover; layers.cover.add(cover);
    const swGeo = get('switch').geometry, capGeo = get('keycap').geometry;
    for (let k = 0; k < 15; k++) {
      const [x, y] = keyPos(k);
      const sw = new THREE.Mesh(swGeo, mat.sw); sw.position.set(x, y, 0); layers.plate.add(sw);
      const cap = new THREE.Group(); cap.position.set(x, y, CAP_Z); layers.caps.add(cap);
      const body = new THREE.Mesh(capGeo, mat.cap); body.userData.key = k; cap.add(body); pick.push(body);
      const c = document.createElement('canvas'); c.width = c.height = 256; legendCanvas.push(c);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; legendTex.push(tex);
      // the deck is viewed from the front (+y in the desk frame), so the legend plane is turned to read upright
      const legend = new THREE.Mesh(new THREE.PlaneGeometry(11.5, 11.5), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
      legend.position.z = 6.03; legend.rotation.z = Math.PI; cap.add(legend);
      caps.push(cap);
    }
    // centre the model on the pivot
    // measure with the pivot at rest (the render loop may already have rotated it)
    const saved = [pivot.position.clone(), pivot.rotation.clone()];
    pivot.position.set(0, 0, 0); pivot.rotation.set(0, 0, 0);
    scene.updateMatrixWorld(true);
    const ctr = new THREE.Box3().setFromObject(root, true).getCenter(new THREE.Vector3());
    root.position.sub(ctr);
    pivot.position.copy(saved[0]); pivot.rotation.copy(saved[1]);
    drawLegends(state.profile || 'default');
    document.documentElement.classList.add('deck-ready');
  });

  function setProfile(id) {
    if (state.profile === id) return;
    state.profile = id;
    if (legendCanvas.length) drawLegends(id);
    const lbl = document.querySelector('#story-profile');
    if (lbl) lbl.textContent = PROFILE_NAMES[id];
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
  const KF = [
    [0.0, -0.6, 0.5, 5.8, 0, -0.8], [0.1, -0.6, 0.5, 5.8, 0, -0.8],
    [0.2, -0.15, 1.0, 3.6, 0.42, -0.02], [0.3, -0.15, 1.0, 3.6, 0.42, -0.02],
    [0.42, 0.55, 0.48, 4.6, -0.5, 0.06], [0.5, 0.6, 0.45, 4.6, -0.5, 0.06],
    [0.58, 0.2, 0.62, 4.4, 0.45, 0.04], [0.68, 0.25, 0.62, 4.4, 0.45, 0.04],
    [0.78, -0.45, 0.62, 3.9, -0.42, -0.02], [1.0, -0.4, 0.62, 3.9, -0.42, -0.02],
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

  const clock = new THREE.Timer();
  const hsl = new THREE.Color();
  function frame() {
    requestAnimationFrame(frame);
    if (!visible) return;
    clock.update(); const t = clock.getElapsed();
    readScroll();
    const p = reduceMotion ? 0 : state.p;

    // explode 0.30 → 0.52, hold, reassemble 0.70 → 0.84
    const ex = smooth(0.3, 0.52, p) * (1 - smooth(0.7, 0.84, p));
    state.explode = ex;
    layers.caps.position.z = ex * 62;
    layers.cover.position.z = ex * 42;
    layers.plate.position.z = ex * 25;
    layers.pcb.position.z = ex * 9;
    devkit.position.z = 7.7 - ex * 6;

    // profile shown on the keys
    setProfile(p < 0.72 ? 'default' : STORY_PROFILES[clamp(Math.floor((p - 0.72) / 0.07) + 1, 0, 3)]);

    // mouse follow
    state.mx = lerp(state.mx, state.tmx, 0.06); state.my = lerp(state.my, state.tmy, 0.06);
    let [yaw, pitch, dist, ox, oy] = camAt(p);
    if (stage.clientWidth < 900) { ox = 0; oy = p < 0.1 ? -0.75 : 0.22; dist *= 1.45; }
    const idle = reduceMotion ? 0 : Math.sin(t * 0.5) * 0.04;
    pivot.rotation.set(pitch + state.my * 0.12, Math.PI + yaw + state.mx * 0.28 + idle, 0, 'XYZ');
    pivot.position.set(ox, oy + Math.sin(t * 0.8) * 0.012, 0);
    camera.position.set(0, 0, dist);

    // hover (only when assembled)
    state.hover = -1;
    if (pick.length && ex < 0.05 && finePointer) {
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(pick, false)[0];
      if (hit) state.hover = hit.object.userData.key;
    }
    canvas.style.cursor = state.hover >= 0 ? 'pointer' : '';

    // LEDs: profile colours + breathing, rainbow wave while exploded, hover/press flashes
    const wave = smooth(0.48, 0.56, p) * (1 - smooth(0.66, 0.72, p));
    for (let k = 0; k < 15; k++) {
      const c = ledColor[k];
      c.lerp(ledTarget[k], 0.08);
      const col = c.clone();
      if (wave > 0) { hsl.setHSL(((k % 5) * 0.12 + Math.floor(k / 5) * 0.05 - t * 0.25) % 1 + 1, 0.85, 0.55); col.lerp(hsl, wave); }
      state.flash[k] = Math.max(0, state.flash[k] - 0.03);
      const hov = k === state.hover ? 1 : 0;
      const breathe = 0.75 + 0.25 * Math.sin(t * 1.6 + k * 0.35);
      const I = breathe + hov * 0.8 + state.flash[k] * 1.6;
      leds[k].material.emissive.copy(col); leds[k].material.emissiveIntensity = 2 + I * 2;
      glows[k].material.color.copy(col).multiplyScalar(0.55 * I * (1 - ex * 0.85));
      if (caps[k]) caps[k].position.z = lerp(caps[k].position.z, CAP_Z - (hov ? 2.2 : 0) - state.flash[k] * 1.2, 0.25);
    }

    // captions
    captions.forEach((el) => {
      const [a, b] = el.dataset.at.split(',').map(Number);
      const o = smooth(a, a + 0.03, p) * (1 - smooth(b - 0.03, b, p));
      el.style.opacity = o.toFixed(3);
      el.style.transform = `translateY(${((1 - o) * (p < a + 0.03 ? 24 : -24)).toFixed(1)}px)`;
      el.style.pointerEvents = o > 0.5 ? 'auto' : 'none';
    });
    document.documentElement.style.setProperty('--story', p.toFixed(4));

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
