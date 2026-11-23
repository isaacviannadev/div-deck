import { useEffect, useMemo, useRef, useState } from "react";
import { COLS, isWindows, type Action, type AppInfo, type DeckModel, type KeyConfig, type Profile } from "./api";
import {
  ACTION_TYPES, AppIcon, Icon, MEDIA, MODS, STEP_TYPES, actionIcon, actionSummary, defaultAction, formatShortcut, keyFromEvent, useApps,
} from "./ui";

// ------------------------------------------------------------------ app picker

export function AppPicker({ onPick, onClose, exclude = [] }: { onPick: (a: AppInfo) => void; onClose: () => void; exclude?: string[] }) {
  const apps = useApps();
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return apps.filter((a) => !exclude.includes(a.bundleId ?? "") && (!s || a.name.toLowerCase().includes(s)));
  }, [apps, q, exclude]);

  useEffect(() => {
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    setTimeout(() => document.addEventListener("mousedown", away));
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [onClose]);

  return (
    <div className="picker" ref={ref}>
      <div className="picker-search">
        <Icon name="search" size={15} />
        <input autoFocus placeholder="Buscar app…" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && list[0] && onPick(list[0])} />
      </div>
      <div className="picker-list">
        {list.map((a) => (
          <button key={a.path} className="picker-item" onClick={() => onPick(a)}>
            <AppIcon app={a} size={22} />
            <span>{a.name}</span>
          </button>
        ))}
        {list.length === 0 && <div className="picker-empty">{apps.length ? "Nada encontrado" : "Carregando apps…"}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ shortcut field

function ShortcutField({ mods, keyName, onChange, compact = false }: { mods: string[]; keyName: string; onChange: (mods: string[], key: string) => void; compact?: boolean }) {
  const [rec, setRec] = useState(false);
  useEffect(() => {
    if (!rec) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && keyName) { setRec(false); return; }
      const k = keyFromEvent(e);
      if (!k) return; // only a modifier so far
      const m = [e.ctrlKey && (isWindows ? "cmd" : "ctrl"), e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "cmd"].filter(Boolean) as string[];
      onChange(m, k);
      setRec(false);
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [rec, keyName, onChange]);

  return (
    <div className="shortcut">
      <button className={`shortcut-display ${rec ? "rec" : ""}`} onClick={() => setRec(!rec)}>
        {rec ? <><Icon name="record" size={12} /> Pressione o atalho…</> : keyName ? formatShortcut(mods, keyName) : "Clique para gravar"}
      </button>
      <div className="shortcut-row">
        {MODS.map((m) => (
          <button key={m.id} className={`chip ${mods.includes(m.id) ? "on" : ""}`}
            onClick={() => onChange(mods.includes(m.id) ? mods.filter((x) => x !== m.id) : [...mods, m.id], keyName)}>
            {m.glyph}
          </button>
        ))}
        <input className="key-input" value={keyName} placeholder="tecla" maxLength={9}
          onChange={(e) => onChange(mods, e.target.value.length === 1 ? e.target.value.toLowerCase() : e.target.value)} />
      </div>
      {!compact && <p className="hint">Funciona com o layout do teclado atual. Atalhos que o sistema intercepta dá para montar pelos botões.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ deck

function KeyGlyph({ action: a, size }: { action: Action; size: number }) {
  if (a.type === "openApp" && a.path) return <AppIcon path={a.path} size={size} />;
  if (a.type === "shortcut" && a.key) {
    const t = formatShortcut(a.mods, a.key);
    return <span className="kbd" style={{ fontSize: t.length > 4 ? 13 : 17 }}>{t}</span>;
  }
  return <Icon name={actionIcon(a)} size={Math.round(size * 0.72)} />;
}

export function Deck({ model = "mx", profile, profiles, selected, pressed, pressColor, onSelect }: {
  model?: DeckModel; profile: Profile; profiles: Profile[]; selected: number; pressed: Set<number>; pressColor: string; onSelect: (k: number) => void;
}) {
  return (
    <div className={`deck ${model}`}>
      <div className="deck-face" style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)` }}>
        {profile.keys.map((k, i) => {
          const empty = k.action.type === "none";
          const isPressed = pressed.has(i);
          return (
            <button key={i}
              className={`key ${i === selected ? "sel" : ""} ${empty ? "empty" : ""} ${isPressed ? "down" : ""}`}
              style={{ ["--led" as string]: `#${isPressed ? pressColor : k.color}` }}
              onClick={() => onSelect(i)} title={actionSummary(k.action, profiles)}>
              <span className="led" />
              <span className="key-glyph">
                <KeyGlyph action={k.action} size={30} />
              </span>
              <span className="key-label">{k.label || (empty ? "" : actionSummary(k.action, profiles))}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ key editor

export const SWATCHES = ["0a84ff", "38d6ff", "30d158", "ffd60a", "ff9f0a", "ff453a", "ff375f", "bf5af2", "5e5ce6", "f5f5f7"];

export function KeyEditor({ model = "mx", index, value, profiles, pressColor, onChange, onPreviewColor, onTest }: {
  model?: DeckModel; index: number; value: KeyConfig; profiles: Profile[]; pressColor: string;
  onChange: (k: KeyConfig) => void; onPreviewColor: (c: string) => void; onTest: () => void;
}) {
  const a = value.action;
  const setAction = (action: Action, label?: string) => onChange({ ...value, action, label: label ?? value.label });
  const autoLabel = (old: Action) => !value.label || value.label === actionSummary(old, profiles) || (old.type === "openApp" && value.label === old.name) || (old.type === "media" && MEDIA.some((m) => m.label === value.label));
  const row = Math.floor(index / COLS) + 1, col = (index % COLS) + 1;
  const empty = a.type === "none";

  return (
    <div className="inspector">
      <div className="preview">
        <div className={`key big ${model === "pro" ? "pro" : ""} ${empty ? "empty" : ""}`} style={{ ["--led" as string]: `#${value.color}` }}>
          <span className="led" />
          <span className="key-glyph">
            <KeyGlyph action={a} size={34} />
          </span>
          <span className="key-label">{value.label || (empty ? "" : actionSummary(a, profiles))}</span>
        </div>
        <div className="preview-meta">Tecla {index + 1} · linha {row}, coluna {col}</div>
      </div>

      <div className="group">
        <label className="row">
          <span>Nome</span>
          <input className="row-input" value={value.label} placeholder="Sem nome" maxLength={14}
            onChange={(e) => onChange({ ...value, label: e.target.value })} />
        </label>
        <div className="row">
          <span>Ação</span>
          <span className="row-value">{actionSummary(a, profiles)}</span>
        </div>
      </div>

      <div className="group-title">Tipo de ação</div>
      <div className="group pad">
        <div className="types">
          {ACTION_TYPES.map((t) => (
            <button key={t.type} className={`type ${a.type === t.type ? "on" : ""}`}
              onClick={() => a.type !== t.type && setAction(defaultAction(t.type, profiles), autoLabel(a) ? "" : undefined)}>
              <span className="type-icon"><Icon name={t.icon} size={16} /></span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {a.type !== "none" && (
        <>
          <div className="group-title">{ACTION_TYPES.find((t) => t.type === a.type)?.label}</div>
          <div className="group pad fields">
            <ActionFields a={a} profiles={profiles} autoLabel={autoLabel} onChange={setAction} />
          </div>
        </>
      )}

      <div className="group-title">{model === "pro" ? "Cor" : "Luz"}</div>
      <div className="group pad">
        <div className="swatches">
          {SWATCHES.map((c) => (
            <button key={c} className={`swatch ${value.color === c ? "on" : ""}`} style={{ background: `#${c}` }}
              onClick={() => onChange({ ...value, color: c })} aria-label={`#${c}`} />
          ))}
          <label className="swatch custom" title="Outra cor">
            <input type="color" value={`#${value.color}`}
              onInput={(e) => onPreviewColor((e.target as HTMLInputElement).value.slice(1))}
              onChange={(e) => onChange({ ...value, color: e.target.value.slice(1) })} />
          </label>
        </div>
        <div className="led-meta"><span>#{value.color}</span><span>{model === "pro" ? "Ao tocar" : "Ao apertar"} <i style={{ background: `#${pressColor}` }} /> #{pressColor}</span></div>
      </div>

      <div className="inspector-foot">
        <button className="btn" onClick={onTest} disabled={empty}><Icon name="bolt" size={14} /> Testar</button>
        <button className="btn plain danger" onClick={() => onChange({ label: "", color: "1c1f26", action: { type: "none" } })}>Limpar tecla</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ action fields (key editor + sequence steps)

function ActionFields({ a, profiles, onChange, autoLabel, inStep = false }: {
  a: Action; profiles: Profile[]; onChange: (a: Action, label?: string) => void; autoLabel?: (old: Action) => boolean; inStep?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const auto = (old: Action) => (autoLabel ? autoLabel(old) : false);
  return (
    <>
      {a.type === "openApp" && (
        <div className="pick-wrap">
          <button className="field-btn" onClick={() => setPicking(true)}>
            {a.path ? <><AppIcon path={a.path} size={22} /><span>{a.name}</span></> : <span className="muted">Escolher aplicativo…</span>}
            <span className="chev">⌄</span>
          </button>
          {picking && (
            <AppPicker onClose={() => setPicking(false)}
              onPick={(app) => { onChange({ type: "openApp", path: app.path, name: app.name }, auto(a) ? app.name : undefined); setPicking(false); }} />
          )}
        </div>
      )}
      {a.type === "shortcut" && (
        <ShortcutField compact={inStep} mods={a.mods} keyName={a.key} onChange={(mods, key) => onChange({ type: "shortcut", mods, key })} />
      )}
      {a.type === "media" && (
        <div className="types media">
          {MEDIA.map((m) => (
            <button key={m.key} className={`type ${a.key === m.key ? "on" : ""}`}
              onClick={() => onChange({ type: "media", key: m.key }, auto(a) ? m.label : undefined)}>
              <span className="type-icon"><Icon name={m.icon} size={16} /></span><span>{m.label}</span>
            </button>
          ))}
        </div>
      )}
      {a.type === "openUrl" && (
        <>
          <input className="input" value={a.url} placeholder="https://…" onChange={(e) => onChange({ type: "openUrl", url: e.target.value })} />
          {!inStep && <p className="hint">Aceita links de apps também, como <code>steam://</code>, <code>slack://</code> ou <code>raycast://</code>.</p>}
        </>
      )}
      {a.type === "typeText" && (
        <>
          <textarea className="input" rows={inStep ? 2 : 4} value={a.text} placeholder="Texto que será digitado"
            onChange={(e) => onChange({ ...a, text: e.target.value })} />
          <label className="check">
            <input type="checkbox" checked={!!a.submit} onChange={(e) => onChange({ ...a, submit: e.target.checked })} />
            <span>Apertar Enter no fim <small>(enviar a mensagem)</small></span>
          </label>
        </>
      )}
      {a.type === "shell" && (
        <>
          <textarea className="input code" rows={inStep ? 2 : 4} value={a.command} placeholder="open -a 'Visual Studio Code' ~/dev/projeto" spellCheck={false}
            onChange={(e) => onChange({ type: "shell", command: e.target.value })} />
          {!inStep && <p className="hint">Roda em segundo plano com <code>{isWindows ? "cmd /C" : "zsh -lc"}</code>{isWindows ? "." : ", com o seu PATH."}</p>}
        </>
      )}
      {a.type === "switchProfile" && (
        <select className="input" value={a.profile} onChange={(e) => onChange({ type: "switchProfile", profile: e.target.value })}>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      {a.type === "wait" && (
        <div className="wait-row">
          <input className="input" type="number" min={50} max={10000} step={50} value={a.ms}
            onChange={(e) => onChange({ type: "wait", ms: Math.max(0, Math.min(10000, Math.round(+e.target.value || 0))) })} />
          <span>ms</span>
          {[250, 500, 1000, 2000].map((v) => (
            <button key={v} className={`chip ${a.ms === v ? "on" : ""}`} onClick={() => onChange({ type: "wait", ms: v })}>{v >= 1000 ? `${v / 1000} s` : `${v} ms`}</button>
          ))}
        </div>
      )}
      {a.type === "sequence" && <SequenceEditor steps={a.steps} profiles={profiles} onChange={(steps) => onChange({ type: "sequence", steps })} />}
    </>
  );
}

/** Ready-made macros to start from. */
const SEQUENCE_TEMPLATES: { label: string; steps: Action[] }[] = [
  {
    label: "Mensagem no Slack",
    steps: [
      { type: "openApp", path: isWindows ? "Slack" : "/Applications/Slack.app", name: "Slack" },
      { type: "wait", ms: 800 },
      { type: "shortcut", mods: ["cmd"], key: "k" },
      { type: "typeText", text: "nome do canal ou da pessoa", submit: true },
      { type: "wait", ms: 400 },
      { type: "typeText", text: "Bom dia! 👋", submit: true },
    ],
  },
  {
    label: "Prompt num chat de IA",
    steps: [
      { type: "shortcut", mods: ["cmd"], key: "a" },
      { type: "shortcut", mods: ["cmd"], key: "c" },
      { type: "openApp", path: isWindows ? "Claude" : "/Applications/Claude.app", name: "Claude" },
      { type: "wait", ms: 700 },
      { type: "typeText", text: "Revise este texto: " },
      { type: "shortcut", mods: ["cmd"], key: "v" },
      { type: "typeText", text: "", submit: true },
    ],
  },
  {
    label: "Commit e push",
    steps: [
      { type: "typeText", text: "git add -A && git commit -m \"wip\" && git push", submit: true },
    ],
  },
];

function SequenceEditor({ steps, profiles, onChange }: { steps: Action[]; profiles: Profile[]; onChange: (steps: Action[]) => void }) {
  const set = (i: number, a: Action) => onChange(steps.map((s, j) => (j === i ? a : s)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const n = [...steps]; [n[i], n[j]] = [n[j], n[i]]; onChange(n);
  };
  return (
    <div className="seq">
      {steps.length === 0 && (
        <div className="seq-empty">
          <p className="hint">Monte uma sequência de passos: atalhos, textos, pausas, abrir apps… Ou comece por um modelo:</p>
          <div className="seq-templates">
            {SEQUENCE_TEMPLATES.map((t) => <button key={t.label} className="chip" onClick={() => onChange(structuredClone(t.steps))}>{t.label}</button>)}
          </div>
        </div>
      )}
      <ol className="seq-list">
        {steps.map((st, i) => (
          <li key={i} className="seq-step">
            <div className="seq-head">
              <span className="seq-num">{i + 1}</span>
              <select className="seq-type" value={st.type} onChange={(e) => set(i, defaultAction(e.target.value as Action["type"], profiles))}>
                {STEP_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
              </select>
              <span className="seq-sum">{actionSummary(st, profiles)}</span>
              <button className="seq-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Subir"><Icon name="up" size={14} /></button>
              <button className="seq-btn" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Descer"><Icon name="down" size={14} /></button>
              <button className="seq-btn" onClick={() => onChange(steps.filter((_, j) => j !== i))} aria-label="Remover passo"><Icon name="x" size={13} /></button>
            </div>
            <div className="seq-body"><ActionFields a={st} profiles={profiles} inStep onChange={(a) => set(i, a)} /></div>
          </li>
        ))}
      </ol>
      <div className="seq-add">
        {STEP_TYPES.slice(0, 4).map((t) => (
          <button key={t.type} className="chip" onClick={() => onChange([...steps, defaultAction(t.type, profiles)])}>
            <Icon name={t.icon} size={12} /> {t.label}
          </button>
        ))}
        <select className="chip" value="" onChange={(e) => { if (e.target.value) onChange([...steps, defaultAction(e.target.value as Action["type"], profiles)]); }}>
          <option value="">Mais…</option>
          {STEP_TYPES.slice(4).map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
      </div>
      <p className="hint">Os passos correm por ordem, com uma pequena pausa entre eles. Use “Esperar” quando um app demora a abrir.</p>
    </div>
  );
}
