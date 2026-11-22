import { useCallback, useEffect, useRef, useState } from "react";
import { api, isTauri, isWindows, type AppStateDto, type Config, type DeckStatus, type KeyConfig, type Profile } from "./api";
import { AppPicker, Deck, KeyEditor } from "./components";
import { AppIcon, Icon, Toggle, appName, useApps } from "./ui";
import "./App.css";
import logoSvg from "./divdeck-logo.svg?raw";

const uid = () => Math.random().toString(36).slice(2, 9);

document.documentElement.classList.add(isTauri ? "native" : "web", isWindows ? "win" : "mac");

export default function App() {
  const [state, setState] = useState<AppStateDto | null>(null);
  useEffect(() => { api.getState().then(setState); }, []);
  if (!state) return <div className="boot" data-tauri-drag-region />;
  return <Main initial={state} />;
}

function Main({ initial }: { initial: AppStateDto }) {
  const apps = useApps();
  const [config, setConfig] = useState<Config>(initial.config);
  const [active, setActive] = useState(initial.activeProfile);
  const [status, setStatus] = useState<DeckStatus>(initial.status);
  const [frontApp, setFrontApp] = useState(initial.frontApp);
  const [axOk, setAxOk] = useState(initial.accessibility);
  const [selected, setSelected] = useState(0);
  const [pressed, setPressed] = useState<Set<number>>(new Set());
  const [linking, setLinking] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  // ---- backend events
  useEffect(() => {
    const subs = [
      api.onStatus(setStatus),
      api.onProfile(setActive),
      api.onFrontApp(setFrontApp),
      api.onKey(({ key, down }) => {
        setPressed((p) => { const n = new Set(p); if (down) n.add(key); else n.delete(key); return n; });
        if (down) setSelected(key);
      }),
    ];
    api.autostart().then(setAutostart);
    const ax = setInterval(() => api.accessibilityStatus().then(setAxOk), 3000);
    return () => { subs.forEach((s) => s.then((u) => u())); clearInterval(ax); };
  }, []);

  // ---- autosave (debounced)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => api.saveConfig(config), 350);
    return () => clearTimeout(t);
  }, [config]);

  const profile = config.profiles.find((p) => p.id === active) ?? config.profiles[0];
  const updateProfile = useCallback((fn: (p: Profile) => Profile) => {
    setConfig((c) => ({ ...c, profiles: c.profiles.map((p) => (p.id === profile.id ? fn(p) : p)) }));
  }, [profile.id]);
  const updateKey = (k: KeyConfig) => updateProfile((p) => ({ ...p, keys: p.keys.map((x, i) => (i === selected ? k : x)) }));

  const selectProfile = (id: string) => { setActive(id); setConfig((c) => ({ ...c, baseProfile: id })); api.setProfile(id); };
  const addProfile = () => {
    const p: Profile = { id: uid(), name: `Perfil ${config.profiles.length + 1}`, apps: [], keys: Array.from({ length: 15 }, () => ({ label: "", color: "1c1f26", action: { type: "none" } })) };
    setConfig((c) => ({ ...c, profiles: [...c.profiles, p] }));
    setTimeout(() => selectProfile(p.id), 400); // after autosave so the backend knows it
  };
  const duplicateProfile = () => {
    const p: Profile = { ...structuredClone(profile), id: uid(), name: `${profile.name} (cópia)`, apps: [] };
    setConfig((c) => ({ ...c, profiles: [...c.profiles, p] }));
    setTimeout(() => selectProfile(p.id), 400);
  };
  const deleteProfile = () => {
    if (config.profiles.length < 2) return;
    const rest = config.profiles.filter((p) => p.id !== profile.id);
    setConfig((c) => ({ ...c, profiles: rest, baseProfile: rest[0].id }));
    setTimeout(() => selectProfile(rest[0].id), 400);
  };
  const linkApp = (bundleId: string | null) => {
    if (!bundleId) return;
    // an app belongs to one profile only
    setConfig((c) => ({
      ...c,
      profiles: c.profiles.map((p) => p.id === profile.id
        ? { ...p, apps: p.apps.includes(bundleId) ? p.apps : [...p.apps, bundleId] }
        : { ...p, apps: p.apps.filter((a) => a !== bundleId) }),
    }));
  };

  const say = (msg: string) => { setFlash(msg); setTimeout(() => setFlash(null), 2200); };
  const frontName = appName(apps, frontApp);
  const frontLinkedHere = frontApp ? profile.apps.includes(frontApp) : false;

  const profileColor = (p: Profile) => `#${p.keys.find((k) => k.action.type !== "none")?.color ?? "8e8e93"}`;

  return (
    <div className="shell">
      {/* ------------------------------------------------ sidebar */}
      <aside className="side">
        <div className="side-top" data-tauri-drag-region />
        <div className="brand" data-tauri-drag-region dangerouslySetInnerHTML={{ __html: logoSvg }} />

        <div className="side-section">Dispositivo</div>
        <div className={`device ${status.connected ? "ok" : ""}`}>
          <span className="device-icon"><Icon name="usb" size={15} /></span>
          <div className="device-text">
            <strong>DIV Deck</strong>
            <small>{status.connected ? `Conectado · fw ${status.firmware}` : "Procurando…"}</small>
          </div>
          <span className="device-dot" />
        </div>

        <div className="side-section">
          <span>Perfis</span>
          <button className="side-add" onClick={addProfile} title="Novo perfil"><Icon name="plus" size={14} /></button>
        </div>
        <nav className="profiles">
          {config.profiles.map((p) => (
            <button key={p.id} className={`profile ${p.id === profile.id ? "on" : ""}`} onClick={() => selectProfile(p.id)}>
              {p.apps[0]
                ? <AppIcon bundleId={p.apps[0]} size={18} />
                : <span className="profile-glyph" style={{ background: profileColor(p) }}><Icon name="app" size={11} /></span>}
              <span className="profile-name">{p.name}</span>
              {p.id === active && status.connected && <span className="live" title="No deck agora" />}
            </button>
          ))}
        </nav>

        <div className="side-foot">
          <div className="slider">
            <Icon name="sun" size={14} />
            <input type="range" min={0} max={96} value={config.brightness}
              onChange={(e) => { const v = +e.target.value; setConfig((c) => ({ ...c, brightness: v })); api.previewBrightness(v); }} />
            <b>{Math.round((config.brightness / 96) * 100)}%</b>
          </div>
          <Toggle label="Trocar pelo app em foco" checked={config.autoSwitch} onChange={(v) => setConfig((c) => ({ ...c, autoSwitch: v }))} />
          <Toggle label="Abrir ao iniciar sessão" checked={autostart} onChange={(v) => api.autostart(v).then(setAutostart)} />
          <button className="btn wide" disabled={!status.connected} onClick={() => { api.saveToDevice(); say("Cores gravadas no deck"); }}>
            Gravar cores no deck
          </button>
        </div>
      </aside>

      {/* ------------------------------------------------ main */}
      <main className="main">
        <header className="toolbar" data-tauri-drag-region>
          <div className="title-block" data-tauri-drag-region>
            <input className="profile-title" value={profile.name} onChange={(e) => updateProfile((p) => ({ ...p, name: e.target.value }))} />
            <p className="profile-sub" data-tauri-drag-region>
              {profile.apps.length
                ? "Ativa sozinho quando um destes apps está em foco"
                : profile.id === config.baseProfile ? "Perfil base · aparece quando nenhum app vinculado está em foco" : "Vincule um app para ativar sozinho"}
            </p>
          </div>
          <div className="tool-actions">
            <button className="tool-btn" onClick={duplicateProfile} title="Duplicar perfil"><Icon name="layers" size={16} /></button>
            <button className="tool-btn" onClick={deleteProfile} disabled={config.profiles.length < 2} title="Apagar perfil"><Icon name="trash" size={16} /></button>
          </div>
        </header>

        <div className="links">
          {profile.apps.map((b) => (
            <span key={b} className="app-chip">
              <AppIcon bundleId={b} size={16} /> {appName(apps, b)}
              <button onClick={() => updateProfile((p) => ({ ...p, apps: p.apps.filter((x) => x !== b) }))} aria-label="Remover"><Icon name="x" size={11} /></button>
            </span>
          ))}
          <span className="pick-wrap">
            <button className="app-chip add" onClick={() => setLinking(true)}><Icon name="plus" size={12} /> Vincular app</button>
            {linking && <AppPicker exclude={profile.apps} onClose={() => setLinking(false)} onPick={(a) => { linkApp(a.bundleId); setLinking(false); }} />}
          </span>
          {frontApp && !frontLinkedHere && (
            <button className="app-chip suggest" onClick={() => linkApp(frontApp)} title="Último app em foco antes do DIV Deck">
              <AppIcon bundleId={frontApp} size={16} /> Vincular {frontName}
            </button>
          )}
        </div>

        {!axOk && (
          <div className="banner">
            <Icon name="warn" size={16} />
            <span>Atalhos, mídia e texto precisam da permissão de <b>Acessibilidade</b>.</span>
            <button className="btn small" onClick={() => api.openAccessibilitySettings()}>Abrir Ajustes…</button>
          </div>
        )}

        <div className="stage" data-tauri-drag-region>
          <Deck profile={profile} profiles={config.profiles} selected={selected} pressed={pressed} pressColor={config.pressColor} onSelect={setSelected} />
          <p className="deck-hint">Clique numa tecla para editar — ou aperte-a no deck</p>
        </div>
        {flash && <div className="toast">{flash}</div>}
      </main>

      {/* ------------------------------------------------ inspector */}
      <aside className="panel">
        <div className="panel-top" data-tauri-drag-region />
        <KeyEditor key={`${profile.id}-${selected}`} index={selected} value={profile.keys[selected]} profiles={config.profiles}
          pressColor={config.pressColor}
          onChange={updateKey}
          onPreviewColor={(c) => api.previewLed(selected, c)}
          onTest={() => api.testAction(profile.keys[selected].action)} />
      </aside>
    </div>
  );
}
