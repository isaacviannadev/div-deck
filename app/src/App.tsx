import { useCallback, useEffect, useRef, useState } from "react";
import { api, checkForUpdate, isTauri, isWindows, lockedApps, presetOwner, type UpdateInfo, type AppStateDto, type Config, type DeckInfo, type KeyConfig, type Profile, modelName } from "./api";
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
  /** Last config written to disk / the deck. Profile edits stay local until "Salvar". */
  const [saved, setSaved] = useState<Config>(initial.config);
  const [decks, setDecks] = useState<DeckInfo[]>(initial.decks);
  /** Deck being configured (LED previews, "Gravar no deck", profile choice go to it). */
  const [deckId, setDeckId] = useState<string | null>(initial.decks[0]?.id ?? null);
  const deck = decks.find((d) => d.id === deckId) ?? decks[0] ?? null;
  /** Profile open in the editor. Follows what the selected deck shows. */
  const [active, setActive] = useState(initial.decks[0]?.active ?? initial.config.baseProfile);
  const deckRef = useRef(deck); deckRef.current = deck;
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
      api.onDecks((list) => {
        setDecks((old) => {
          const cur = deckRef.current;
          const now = list.find((d) => d.id === cur?.id) ?? list[0];
          const before = old.find((d) => d.id === now?.id);
          // the deck on screen switched profile (focus change or a key): follow it in the editor
          if (now && (!before || before.active !== now.active || !cur || cur.id !== now.id)) setActive(now.active);
          return list;
        });
        if (!deckRef.current && list[0]) setDeckId(list[0].id);
      }),
      api.onFrontApp(setFrontApp),
      api.onKey(({ deck: d, key, down }) => {
        if (d !== deckRef.current?.id) {
          if (!down) return;
          setDeckId(d); // pressing a key on another deck selects that deck
          setPressed(new Set());
        }
        setPressed((p) => { const n = new Set(p); if (down) n.add(key); else n.delete(key); return n; });
        if (down) setSelected(key);
      }),
    ];
    api.autostart().then(setAutostart);
    const ax = setInterval(() => api.accessibilityStatus().then(setAxOk), 3000);
    return () => { subs.forEach((s) => s.then((u) => u())); clearInterval(ax); };
  }, []);

  // ---- updates: check at launch and every 6 h
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState<number | null>(null);
  useEffect(() => {
    const run = () => checkForUpdate().then((u) => u && setUpdate(u));
    run();
    const t = setInterval(run, 6 * 3600_000);
    return () => clearInterval(t);
  }, []);
  const installUpdate = async () => {
    if (!update) return;
    if (dirtyRef.current) await keys.current.save();
    setUpdating(0);
    try { await update.install(setUpdating); }
    catch { setUpdating(null); say("Não foi possível atualizar. Tente de novo mais tarde."); }
  };

  const say = (msg: string) => { setFlash(msg); setTimeout(() => setFlash(null), 2200); };

  // ---- profile edits: undo / redo history (profiles only; settings save right away)
  const cfgRef = useRef(config); cfgRef.current = config;
  const savedRef = useRef(saved); savedRef.current = saved;
  const [hist, setHist] = useState<{ past: Profile[][]; future: Profile[][] }>({ past: [], future: [] });
  const lastEdit = useRef<{ tag: string; at: number }>({ tag: "", at: 0 });

  const edit = useCallback((fn: (ps: Profile[]) => Profile[], tag = "") => {
    const before = cfgRef.current.profiles;
    const after = fn(before);
    if (after === before || JSON.stringify(after) === JSON.stringify(before)) return;
    const now = Date.now();
    // typing in a field coalesces into one undo step
    const merge = tag !== "" && tag === lastEdit.current.tag && now - lastEdit.current.at < 1200;
    lastEdit.current = { tag, at: now };
    setHist((h) => ({ past: merge ? h.past : [...h.past.slice(-99), before], future: [] }));
    setConfig((c) => ({ ...c, profiles: after }));
  }, []);

  const restore = (ps: Profile[]) => {
    lastEdit.current = { tag: "", at: 0 };
    setConfig((c) => ({ ...c, profiles: ps }));
    if (!ps.some((p) => p.id === active)) setActive(ps[0].id);
  };
  const undo = () => {
    if (!hist.past.length) return;
    const prev = hist.past[hist.past.length - 1];
    setHist({ past: hist.past.slice(0, -1), future: [config.profiles, ...hist.future] });
    restore(prev);
  };
  const redo = () => {
    if (!hist.future.length) return;
    const [next, ...rest] = hist.future;
    setHist({ past: [...hist.past, config.profiles], future: rest });
    restore(next);
  };

  const dirty = JSON.stringify(config.profiles) !== JSON.stringify(saved.profiles);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const save = async () => {
    if (!dirty) return;
    const next = { ...savedRef.current, profiles: config.profiles, baseProfile: config.profiles.some((p) => p.id === config.baseProfile) ? config.baseProfile : config.profiles[0].id };
    await api.saveConfig(next);
    setSaved(next);
    lastEdit.current = { tag: "", at: 0 };
    if (next.profiles.some((p) => p.id === active)) api.setProfile(deckRef.current?.id ?? null, active);
    say("Alterações salvas");
  };
  const discard = () => edit(() => saved.profiles);

  // ---- settings (brightness, auto switch) are saved on their own, without pending profile edits
  useEffect(() => {
    const s = savedRef.current;
    if (config.brightness === s.brightness && config.autoSwitch === s.autoSwitch) return;
    const t = setTimeout(() => {
      const next = { ...savedRef.current, brightness: config.brightness, autoSwitch: config.autoSwitch };
      api.saveConfig(next).then(() => setSaved(next));
    }, 350);
    return () => clearTimeout(t);
  }, [config.brightness, config.autoSwitch]);

  // ---- keyboard: ⌘S save, ⌘Z undo, ⇧⌘Z / Ctrl+Y redo
  const keys = useRef({ save, undo, redo }); keys.current = { save, undo, redo };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "s") { e.preventDefault(); keys.current.save(); }
      else if (k === "z" && !e.shiftKey) { e.preventDefault(); keys.current.undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); keys.current.redo(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const profile = config.profiles.find((p) => p.id === active) ?? config.profiles[0];
  const locked = lockedApps(profile.id);
  const updateProfile = useCallback((fn: (p: Profile) => Profile, tag = "") => {
    edit((ps) => ps.map((p) => (p.id === profile.id ? fn(p) : p)), tag);
  }, [profile.id, edit]);
  const updateKey = (k: KeyConfig) => updateProfile((p) => ({ ...p, keys: p.keys.map((x, i) => (i === selected ? k : x)) }), `key-${profile.id}-${selected}`);

  /** Switching profiles is navigation, not an edit: it never marks the config as unsaved. */
  const selectProfile = (id: string) => {
    setActive(id);
    setConfig((c) => ({ ...c, baseProfile: id }));
    if (savedRef.current.profiles.some((p) => p.id === id)) {
      setSaved((s) => ({ ...s, baseProfile: id }));
      api.setProfile(deckRef.current?.id ?? null, id);
    }
  };
  const selectDeck = (d: DeckInfo) => {
    setDeckId(d.id);
    setPressed(new Set());
    setActive(d.active);
  };
  const changeDeck = (patch: Partial<DeckInfo>) => {
    if (!deck) return;
    const next = { ...deck, ...patch };
    setDecks((ds) => ds.map((d) => (d.id === deck.id ? next : d)));
    api.updateDeck({ id: next.id, name: next.name, model: next.model, profile: next.profile, followApp: next.followApp, flipped: next.flipped });
  };
  const [deckName, setDeckName] = useState(deck?.name ?? "");
  useEffect(() => setDeckName(deck?.name ?? ""), [deck?.id, deck?.name]);
  const addProfile = () => {
    const p: Profile = { id: uid(), name: `Perfil ${config.profiles.length + 1}`, apps: [], keys: Array.from({ length: 15 }, () => ({ label: "", color: "1c1f26", action: { type: "none" } })) };
    edit((ps) => [...ps, p]);
    selectProfile(p.id);
  };
  const duplicateProfile = () => {
    const p: Profile = { ...structuredClone(profile), id: uid(), name: `${profile.name} (cópia)`, apps: [] };
    edit((ps) => [...ps, p]);
    selectProfile(p.id);
  };
  const deleteProfile = () => {
    if (config.profiles.length < 2) return;
    const rest = config.profiles.filter((p) => p.id !== profile.id);
    edit(() => rest);
    selectProfile(rest[0].id);
  };
  const linkApp = (bundleId: string | null) => {
    if (!bundleId) return;
    const owner = presetOwner(bundleId);
    if (owner && owner !== profile.id) {
      say(`${appName(apps, bundleId)} é fixo do perfil ${config.profiles.find((p) => p.id === owner)?.name ?? owner}`);
      return;
    }
    // an app belongs to one profile only
    edit((ps) => ps.map((p) => p.id === profile.id
      ? { ...p, apps: p.apps.includes(bundleId) ? p.apps : [...p.apps, bundleId] }
      : { ...p, apps: p.apps.filter((a) => a !== bundleId) }));
  };
  const unlinkApp = (bundleId: string) => {
    if (locked.includes(bundleId)) return;
    updateProfile((p) => ({ ...p, apps: p.apps.filter((x) => x !== bundleId) }));
  };

  const frontName = appName(apps, frontApp);
  const frontLinkedHere = frontApp ? profile.apps.includes(frontApp) : false;

  const profileColor = (p: Profile) => `#${p.keys.find((k) => k.action.type !== "none")?.color ?? "8e8e93"}`;

  return (
    <div className="shell">
      {/* ------------------------------------------------ sidebar */}
      <aside className="side">
        <div className="side-top" data-tauri-drag-region />
        <div className="brand" data-tauri-drag-region dangerouslySetInnerHTML={{ __html: logoSvg }} />

        <div className="side-section">{decks.length > 1 ? "Dispositivos" : "Dispositivo"}</div>
        <div className="devices">
          {decks.map((d) => (
            <button key={d.id} className={`device ${d.connected ? "ok" : ""} ${d.id === deck?.id ? "on" : ""}`} onClick={() => selectDeck(d)}>
              <span className="device-icon"><Icon name={d.model === "pro" ? "screen" : "keys"} size={15} /></span>
              <span className="device-text">
                <strong>{d.name}</strong>
                <small>{d.connected
                  ? `${d.model === "pro" ? "Pro" : "MX"} · ${config.profiles.find((p) => p.id === d.active)?.name ?? ""}`
                  : "Desligado"}</small>
              </span>
              <span className="device-dot" />
            </button>
          ))}
          {decks.length === 0 && (
            <div className="device">
              <span className="device-icon"><Icon name="usb" size={15} /></span>
              <span className="device-text"><strong>DIV Deck</strong><small>Procurando… ligue o deck no USB</small></span>
              <span className="device-dot" />
            </div>
          )}
        </div>
        {deck && (
          <div className="deck-opts">
            <input className="deck-name" value={deckName} maxLength={32} aria-label="Nome do deck"
              onChange={(e) => setDeckName(e.target.value)}
              onBlur={() => deckName.trim() !== deck.name && changeDeck({ name: deckName.trim() || modelName(deck.model) })}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
            <small className="deck-meta">{modelName(deck.model)}{deck.firmware ? ` · firmware ${deck.firmware}` : ""}</small>
            <Toggle label="Segue o app em foco" checked={deck.followApp} onChange={(v) => changeDeck({ followApp: v })} />
            {deck.model === "pro" && <Toggle label="Tela invertida (180°)" checked={deck.flipped} onChange={(v) => changeDeck({ flipped: v })} />}
            {!deck.connected && decks.length > 1 && (
              <button className="btn plain small danger" onClick={() => { api.forgetDeck(deck.id); setDeckId(null); }}>Remover da lista</button>
            )}
          </div>
        )}

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
              {decks.some((d) => d.connected && d.active === p.id) && (
                <span className="live" title={`Agora em: ${decks.filter((d) => d.connected && d.active === p.id).map((d) => d.name).join(", ")}`} />
              )}
              {!saved.profiles.some((q) => q.id === p.id) || JSON.stringify(saved.profiles.find((q) => q.id === p.id)) !== JSON.stringify(p)
                ? <span className="unsaved" title="Alterações não salvas" /> : null}
            </button>
          ))}
        </nav>

        <div className="side-foot">
          {update && (
            <div className="update">
              <div>
                <strong>Atualização disponível</strong>
                <small>Versão {update.version}</small>
              </div>
              <button className="btn primary small" disabled={updating !== null} onClick={installUpdate}>
                {updating === null ? "Atualizar" : updating < 100 ? `${updating}%` : "Reiniciando…"}
              </button>
            </div>
          )}
          <div className="slider">
            <Icon name="sun" size={14} />
            <input type="range" min={0} max={96} value={config.brightness}
              onChange={(e) => { const v = +e.target.value; setConfig((c) => ({ ...c, brightness: v })); api.previewBrightness(v); }} />
            <b>{Math.round((config.brightness / 96) * 100)}%</b>
          </div>
          <Toggle label="Trocar pelo app em foco" checked={config.autoSwitch} onChange={(v) => setConfig((c) => ({ ...c, autoSwitch: v }))} />
          <Toggle label="Abrir ao iniciar sessão" checked={autostart} onChange={(v) => api.autostart(v).then(setAutostart)} />
          <button className="btn wide" disabled={!deck?.connected} onClick={() => { if (deck) { api.saveToDevice(deck.id); say(`Gravado em ${deck.name}`); } }}>
            {deck?.model === "pro" ? "Gravar teclas no deck" : "Gravar cores no deck"}
          </button>
        </div>
      </aside>

      {/* ------------------------------------------------ main */}
      <main className="main">
        <header className="toolbar" data-tauri-drag-region>
          <div className="title-block" data-tauri-drag-region>
            <input className="profile-title" value={profile.name} onChange={(e) => updateProfile((p) => ({ ...p, name: e.target.value }), `name-${profile.id}`)} />
            <p className="profile-sub" data-tauri-drag-region>
              {profile.apps.length
                ? "Ativa sozinho quando um destes apps está em foco"
                : profile.id === config.baseProfile ? "Perfil base · aparece quando nenhum app vinculado está em foco" : "Vincule um app para ativar sozinho"}
            </p>
          </div>
          <div className="tool-actions">
            <button className="tool-btn" onClick={undo} disabled={!hist.past.length} title={`Desfazer (${isWindows ? "Ctrl" : "⌘"}Z)`}><Icon name="undo" size={16} /></button>
            <button className="tool-btn" onClick={redo} disabled={!hist.future.length} title={`Refazer (${isWindows ? "Ctrl+Y" : "⇧⌘Z"})`}><Icon name="redo" size={16} /></button>
            <span className="tool-sep" />
            <button className="tool-btn" onClick={duplicateProfile} title="Duplicar perfil"><Icon name="layers" size={16} /></button>
            <button className="tool-btn" onClick={deleteProfile} disabled={config.profiles.length < 2} title="Apagar perfil"><Icon name="trash" size={16} /></button>
            <span className="tool-sep" />
            {dirty && <button className="btn plain" onClick={discard}>Descartar</button>}
            <button className="btn primary" onClick={save} disabled={!dirty} title={`Salvar (${isWindows ? "Ctrl" : "⌘"}S)`}>
              {dirty ? "Salvar" : "Salvo"}
            </button>
          </div>
        </header>

        <div className="links">
          {profile.apps.map((b) => (
            <span key={b} className={`app-chip ${locked.includes(b) ? "locked" : ""}`} title={locked.includes(b) ? "App fixo deste perfil padrão" : undefined}>
              <AppIcon bundleId={b} size={16} /> {appName(apps, b)}
              {locked.includes(b)
                ? <Icon name="lock" size={11} className="chip-lock" />
                : <button onClick={() => unlinkApp(b)} aria-label="Remover"><Icon name="x" size={11} /></button>}
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
          <Deck model={deck?.model ?? "mx"} profile={profile} profiles={config.profiles} selected={selected} pressed={pressed} pressColor={config.pressColor} onSelect={setSelected} />
          <p className="deck-hint">
            {deck && decks.length > 1 ? `${deck.name} · ` : ""}
            Clique numa tecla para editar — ou {deck?.model === "pro" ? "toque-a na tela" : "aperte-a no deck"}
          </p>
        </div>
        {flash && <div className="toast">{flash}</div>}
      </main>

      {/* ------------------------------------------------ inspector */}
      <aside className="panel">
        <div className="panel-top" data-tauri-drag-region />
        <KeyEditor key={`${profile.id}-${selected}`} model={deck?.model ?? "mx"} index={selected} value={profile.keys[selected]} profiles={config.profiles}
          pressColor={config.pressColor}
          onChange={updateKey}
          onPreviewColor={(c) => deck && api.previewLed(deck.id, selected, c)}
          onTest={() => api.testAction(profile.keys[selected].action)} />
      </aside>
    </div>
  );
}
