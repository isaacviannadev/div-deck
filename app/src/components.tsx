import { useEffect, useMemo, useRef, useState } from "react";
import { COLS, api, isWindows, type Action, type AppInfo, type DeckModel, type KeyConfig, type KeyIcon, type LogiDevice, type MacroState, type Profile } from "./api";
import { EMOJI, FACE_H, FACE_W, brands, drawFace, drawKeyIcon, imageFileToIcon } from "./tileIcons";
import { confirmDialog, toast } from "./feedback";
import {
  ACTION_TYPES, AppIcon, Icon, MEDIA, MODS, STEP_TYPES, actionIcon, actionSummary, defaultAction, formatShortcut, hostTargets, keyFromEvent, keyLabel, shortDevice, useApps,
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

// ------------------------------------------------------------------ MX OLED preview

const WD = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SAB"];
const MO = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];

/** What the 0.96" OLED of the MX pod shows (same layout as the firmware), as 1-bit pixels. */
export function OledPreview({ status, profile, connected }: { status: { show: boolean; time: boolean; date: boolean; profile: boolean }; profile: string; connected: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const blink = Math.floor(now.getTime() / 600) % 2 === 1;
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const g = c.getContext("2d")!;
    g.fillStyle = "#000"; g.fillRect(0, 0, 128, 64);
    if (status.show) {
      g.fillStyle = "#fff"; g.textBaseline = "alphabetic";
      const name = profile.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const showP = status.profile && !!name, showT = status.time, showD = status.date;
      if (!connected || (!showP && !showT && !showD)) {
        g.font = "bold 18px 'Helvetica Neue', Arial"; g.textAlign = "center";
        g.fillText("DIV DECK", 64, 28);
        g.font = "10px Menlo, monospace";
        g.fillText(!connected ? `> abra o app${blink ? " _" : "  "}` : `> mx${blink ? " _" : "  "}`, 64, 50);
      } else {
        let y = 0;
        if (showP) {
          g.font = "10px Menlo, monospace"; g.textAlign = "left";
          g.fillText(`> ${name.slice(0, 19)}`, 2, 10);
          g.fillRect(0, 13, 128, 1);
          y = 14;
        }
        if (showT) {
          g.font = "bold 30px 'Helvetica Neue', Arial"; g.textAlign = "center";
          g.fillText(`${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`, 64, showD ? y + 34 : y + 40);
        }
        if (showD) {
          g.font = "10px Menlo, monospace"; g.textAlign = "center";
          g.fillText(`${WD[now.getDay()]} ${String(now.getDate()).padStart(2, "0")} ${MO[now.getMonth()]}`, 64, showT ? 62 : y + 30);
        }
      }
      // 1-bit like the real panel
      const img = g.getImageData(0, 0, 128, 64);
      for (let i = 0; i < img.data.length; i += 4) {
        const on = img.data[i] > 110;
        img.data[i] = on ? 0xe8 : 0; img.data[i + 1] = on ? 0xf4 : 0; img.data[i + 2] = on ? 0xff : 0; img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    }
  }, [status.show, status.time, status.date, status.profile, profile, connected, now.getMinutes(), blink]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="oled-preview"><canvas ref={ref} width={128} height={64} style={{ width: 192, height: 96 }} /></div>;
}

// ------------------------------------------------------------------ deck

/** A user-chosen picture (brand, emoji, own image), drawn exactly like it will be on the Pro. */
function CustomIcon({ k, size }: { k: KeyConfig; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const apps = useApps();
  const sig = JSON.stringify(k.icon);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = c.height = Math.round(size * dpr);
    drawKeyIcon(c.getContext("2d")!, k, c.width, apps);
  }, [sig, size, apps]); // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={ref} className="custom-icon" style={{ width: size, height: size }} />;
}

function KeyGlyph({ k, size }: { k: KeyConfig; size: number }) {
  const a = k.action;
  if (k.icon && (k.icon.kind === "brand" || k.icon.kind === "emoji" || k.icon.kind === "image")) return <CustomIcon k={k} size={size} />;
  if (a.type === "openApp" && a.path && k.icon?.kind !== "none") return <AppIcon path={a.path} size={size} />;
  if (a.type === "shortcut" && a.key) {
    const t = formatShortcut(a.mods, a.key);
    return <span className="kbd" style={{ fontSize: t.length > 4 ? 13 : 17 }}>{t}</span>;
  }
  return <Icon name={actionIcon(a)} size={Math.round(size * 0.72)} />;
}

/** A Pro tile drawn by the same code that renders the picture sent to the deck: what you see is what it shows. */
function FaceTile({ k, profiles }: { k: KeyConfig; profiles: Profile[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const apps = useApps();
  const sig = JSON.stringify([k, profiles.map((p) => [p.id, p.name]), apps.length]);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    let alive = true;
    const S = 3;
    const off = document.createElement("canvas"); off.width = FACE_W * S; off.height = FACE_H * S;
    const g = off.getContext("2d")!; g.scale(S, S);
    drawFace(g, k, profiles, apps).then((ok) => {
      if (!alive) return;
      const out = c.getContext("2d")!;
      c.width = off.width; c.height = off.height;
      if (ok) out.drawImage(off, 0, 0);
      else { out.fillStyle = "#15161a"; out.beginPath(); out.roundRect(0, 0, c.width, c.height, 15 * S); out.fill(); }
    }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return <canvas ref={ref} className="face" width={FACE_W * 3} height={FACE_H * 3} />;
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
              {model === "pro" ? <FaceTile k={k} profiles={profiles} /> : <>
                <span className="led" />
                <span className="key-glyph">
                  <KeyGlyph k={k} size={30} />
                </span>
                <span className="key-label">{k.label || (empty ? "" : actionSummary(k.action, profiles))}</span>
              </>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ key editor

export const SWATCHES = ["0a84ff", "38d6ff", "30d158", "ffd60a", "ff9f0a", "ff453a", "ff375f", "bf5af2", "5e5ce6", "f5f5f7"];

/** Is the action filled in enough to do something? (the "Configurar" step can't be left half done) */
function actionReady(a: Action): boolean {
  switch (a.type) {
    case "none": return true;
    case "openApp": return !!a.path;
    case "shortcut": return !!a.key;
    case "openUrl": return a.url.trim().length > 3;
    case "typeText": return a.text.length > 0 || !!a.submit;
    case "shell": return a.command.trim().length > 0;
    case "media": case "switchProfile": case "wait": case "mouse": return true;
    case "key": case "keyEvent": return !!a.key;
    case "changeHost": return hostTargets(a).length > 0;
    case "sequence": return a.steps.length > 0 && a.steps.every(actionReady);
  }
}

type StepId = "type" | "details" | "look" | "done";
const STEPS: { id: StepId; title: string; optional?: boolean }[] = [
  { id: "type", title: "Ação" },
  { id: "details", title: "Configurar" },
  { id: "look", title: "Aparência", optional: true },
  { id: "done", title: "Resumo" },
];

/** Key inspector as a short wizard: Ação → Configurar → Aparência → Resumo. A key that is already
 * set up opens on the summary; every step can be revisited from there or from the step bar. */
export function KeyEditor({ model = "mx", index, value, profiles, pressColor, onChange, onPreviewColor, onTest }: {
  model?: DeckModel; index: number; value: KeyConfig; profiles: Profile[]; pressColor: string;
  onChange: (k: KeyConfig) => void; onPreviewColor: (c: string) => void; onTest: () => void;
}) {
  const a = value.action;
  const setAction = (action: Action, label?: string) => onChange({ ...value, action, label: label ?? value.label });
  const autoLabel = (old: Action) => !value.label || value.label === actionSummary(old, profiles) || (old.type === "openApp" && value.label === old.name) || (old.type === "media" && MEDIA.some((m) => m.label === value.label));
  const row = Math.floor(index / COLS) + 1, col = (index % COLS) + 1;
  const empty = a.type === "none";
  const ready = actionReady(a);
  const [step, setStep] = useState<StepId>(empty ? "type" : "done");
  const at = STEPS.findIndex((x) => x.id === step);
  const skipDetails = empty;
  const go = (id: StepId) => setStep(id === "details" && skipDetails ? "look" : id);
  const next = () => {
    const n = STEPS[at + 1]?.id;
    if (n) go(n);
  };
  const back = () => {
    let p = STEPS[at - 1]?.id;
    if (p === "details" && skipDetails) p = "type";
    if (p) setStep(p);
  };
  const typeLabel = ACTION_TYPES.find((t) => t.type === a.type)?.label;

  return (
    <div className="inspector wizard">
      <div className="preview compact">
        <div className={`key big ${model === "pro" ? "pro" : ""} ${empty ? "empty" : ""}`} style={{ ["--led" as string]: `#${value.color}` }}>
          <span className="led" />
          <span className="key-glyph"><KeyGlyph k={value} size={28} /></span>
          <span className="key-label">{value.label || (empty ? "" : actionSummary(a, profiles))}</span>
        </div>
        <div className="preview-meta">Tecla {index + 1} · linha {row}, coluna {col}</div>
      </div>

      <ol className="stepper">
        {STEPS.map((x, i) => {
          const disabled = x.id === "details" && skipDetails;
          const doneMark = i < at || (x.id === "done" && ready && !empty);
          return (
            <li key={x.id}>
              <button className={`stp ${step === x.id ? "on" : ""} ${doneMark ? "done" : ""}`} disabled={disabled} onClick={() => go(x.id)}>
                <span className="stp-n">{i + 1}</span>
                <span className="stp-t">{x.title}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="step-body">
        {step === "type" && (
          <>
            <p className="step-lead">O que esta tecla faz?</p>
            <div className="types">
              {ACTION_TYPES.map((t) => (
                <button key={t.type} className={`type ${a.type === t.type ? "on" : ""}`}
                  onClick={() => {
                    if (a.type !== t.type) setAction(defaultAction(t.type, profiles), autoLabel(a) ? "" : undefined);
                    setStep(t.type === "none" ? "done" : "details");
                  }}>
                  <span className="type-icon"><Icon name={t.icon} size={16} /></span>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === "details" && !empty && (
          <>
            <p className="step-lead">{typeLabel}{a.type === "sequence" ? ": os passos correm por ordem" : ""}</p>
            <div className="fields">
              <ActionFields a={a} profiles={profiles} autoLabel={autoLabel} onChange={setAction} />
            </div>
            {!ready && <p className="hint warn">Falta preencher {a.type === "sequence" ? "pelo menos um passo completo" : "este passo"} para a tecla funcionar.</p>}
          </>
        )}

        {step === "look" && (
          <>
            <p className="step-lead">Como a tecla aparece {model === "pro" ? "na tela" : "no deck"} <small>(opcional)</small></p>
            <div className="group">
              <label className="row">
                <span>Nome</span>
                <input className="row-input" value={value.label} placeholder={empty ? "Sem nome" : actionSummary(a, profiles)} maxLength={14}
                  onChange={(e) => onChange({ ...value, label: e.target.value })} />
              </label>
            </div>
            <div className="group-title">Ícone <small>· aparece na tela do DIV Deck Pro</small></div>
            <div className="group pad">
              <IconPicker value={value} onChange={(icon) => onChange({ ...value, icon })} />
            </div>
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
          </>
        )}

        {step === "done" && (
          <>
            <p className="step-lead">{empty ? "Tecla vazia" : ready ? "Tudo pronto" : "Quase lá: falta configurar a ação"}</p>
            <div className="group summary">
              <button className="row link" onClick={() => setStep("type")}>
                <span>Ação</span><span className="row-value">{typeLabel}</span><span className="chev">›</span>
              </button>
              {!empty && (
                <button className="row link" onClick={() => setStep("details")}>
                  <span>Faz</span><span className={`row-value ${ready ? "" : "warn"}`}>{actionSummary(a, profiles)}</span><span className="chev">›</span>
                </button>
              )}
              <button className="row link" onClick={() => setStep("look")}>
                <span>Nome</span><span className="row-value">{value.label || "—"}</span><span className="chev">›</span>
              </button>
              <button className="row link" onClick={() => setStep("look")}>
                <span>{model === "pro" ? "Cor" : "Luz"}</span>
                <span className="row-value"><i className="dot" style={{ background: `#${value.color}` }} /> #{value.color}</span><span className="chev">›</span>
              </button>
            </div>
            <div className="summary-actions">
              <button className="btn" onClick={onTest} disabled={empty || !ready}><Icon name="bolt" size={14} /> Testar agora</button>
              <button className="btn plain danger" onClick={async () => {
                const ok = await confirmDialog({ title: `Limpar a tecla ${index + 1}?`, message: "A ação, o nome, o ícone e a cor voltam ao vazio. Pode desfazer com ⌘Z.", confirm: "Limpar", destructive: true });
                if (!ok) return;
                onChange({ label: "", color: "1c1f26", action: { type: "none" } });
                setStep("type");
                toast.success("Tecla limpa", { description: "⌘Z para desfazer" });
              }}>Limpar tecla</button>
            </div>
          </>
        )}
      </div>

      {step !== "done" && (
        <div className="wizard-foot">
          <button className="btn plain" onClick={back} disabled={at === 0}>Voltar</button>
          <span className="grow" />
          {STEPS[at].optional && <button className="btn plain" onClick={next}>Pular</button>}
          {step !== "type" && (
            <button className="btn primary" disabled={step === "details" && !ready} onClick={next}>
              {STEPS[at + 1]?.id === "done" ? "Concluir" : "Próximo"}
            </button>
          )}
        </div>
      )}
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
      {a.type === "key" && (
        <div className="keystep">
          <KeyCapture value={a.key} onChange={(key) => onChange({ ...a, key })} />
          <label className="mini">segurar <input className="input num" type="number" min={5} max={2000} value={a.holdMs}
            onChange={(e) => onChange({ ...a, holdMs: clampInt(e.target.value, 5, 2000) })} /> ms</label>
          <label className="mini">× <input className="input num" type="number" min={1} max={50} value={a.repeat}
            onChange={(e) => onChange({ ...a, repeat: clampInt(e.target.value, 1, 50) })} /></label>
          {a.repeat > 1 && <label className="mini">a cada <input className="input num" type="number" min={0} max={5000} value={a.gapMs}
            onChange={(e) => onChange({ ...a, gapMs: clampInt(e.target.value, 0, 5000) })} /> ms</label>}
        </div>
      )}
      {a.type === "keyEvent" && (
        <div className="keystep">
          <div className="seg small">
            <button className={a.down ? "on" : ""} onClick={() => onChange({ ...a, down: true })}>Premir</button>
            <button className={!a.down ? "on" : ""} onClick={() => onChange({ ...a, down: false })}>Soltar</button>
          </div>
          <KeyCapture value={a.key} modifiers onChange={(key) => onChange({ ...a, key })} />
        </div>
      )}
      {a.type === "mouse" && (
        <div className="keystep">
          <select className="input" value={a.button} onChange={(e) => onChange({ ...a, button: e.target.value as "left" })}>
            <option value="left">Botão esquerdo</option>
            <option value="right">Botão direito</option>
            <option value="middle">Botão do meio</option>
          </select>
          <select className="input" value={a.down === undefined ? "click" : a.down ? "down" : "up"}
            onChange={(e) => onChange({ ...a, down: e.target.value === "click" ? undefined : e.target.value === "down" })}>
            <option value="click">Clique</option>
            <option value="down">Premir</option>
            <option value="up">Soltar</option>
          </select>
        </div>
      )}
      {a.type === "changeHost" && <ChangeHostFields a={a} inStep={inStep} onChange={onChange} />}
      {a.type === "sequence" && <SequenceEditor seq={a} profiles={profiles} onChange={(seq) => onChange(seq)} />}
    </>
  );
}

const clampInt = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(+v || 0)));

/** One key, captured from the keyboard (for game keys: no modifiers, the physical key). */
function KeyCapture({ value, onChange, modifiers = false }: { value: string; onChange: (k: string) => void; modifiers?: boolean }) {
  const [rec, setRec] = useState(false);
  useEffect(() => {
    if (!rec) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const mod: Record<string, string> = { Meta: "Meta", Control: "Control", Alt: "Alt", Shift: "Shift" };
      if (modifiers && mod[e.key]) { onChange(mod[e.key]); setRec(false); return; }
      const k = keyFromEvent(e);
      if (!k) return;
      onChange(k);
      setRec(false);
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [rec, onChange, modifiers]);
  return (
    <button className={`shortcut-display keycap-btn ${rec ? "rec" : ""}`} onClick={() => setRec(!rec)}>
      {rec ? <><Icon name="record" size={12} /> Carregue na tecla…</> : value ? keyLabel(value) : "Escolher tecla"}
    </button>
  );
}

/** Logitech Easy-Switch: each device gets its own channel (or stays where it is). */
function ChangeHostFields({ a, inStep, onChange }: { a: Extract<Action, { type: "changeHost" }>; inStep: boolean; onChange: (a: Action, label?: string) => void }) {
  const [devs, setDevs] = useState<LogiDevice[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dest, setDest] = useState("");
  const load = () => { setErr(null); setDevs(null); api.logiDevices().then(setDevs).catch((e) => { setDevs([]); setErr(String(e)); }); };
  useEffect(load, []);
  const targets = hostTargets(a);
  // 0.6.0 form ("every device -> channel N") is shown per device once the list is known
  const chanFor = (name: string) => targets.find((t) => t.device === name)?.host ?? targets.find((t) => t.device === "")?.host ?? 0;
  const names = [...new Set([...(devs ?? []).map((d) => d.name), ...targets.filter((t) => t.device).map((t) => t.device)])];
  const setChan = (name: string, host: number) => {
    const next = names.map((n) => ({ device: n, host: n === name ? host : chanFor(n) })).filter((t) => t.host >= 1);
    onChange({ type: "changeHost", targets: next });
  };
  const all = (host: number) => onChange({ type: "changeHost", targets: names.map((device) => ({ device, host })) }, !inStep && !dest ? `PC ${host}` : undefined);
  return (
    <div className="hoststep">
      {!inStep && <p className="hint">Muda o teclado e o rato Logitech de computador, como os botões Easy-Switch (1 · 2 · 3) deles. Escolha o canal de cada um: cada aparelho guarda os seus computadores, por isso o mesmo PC pode ser o canal 2 no teclado e o 3 no rato.</p>}
      {devs === null && <p className="hint">A procurar dispositivos Logitech…</p>}
      {names.length > 0 && (
        <div className="host-table">
          {names.map((n) => {
            const d = devs?.find((x) => x.name === n);
            const ch = chanFor(n);
            return (
              <div key={n} className="host-row">
                <div className="host-name">
                  <strong>{shortDevice(n)}</strong>
                  <small>{d ? `agora no canal ${d.current || "?"}` : "não está ligado a este computador agora"}</small>
                </div>
                <div className="seg host-seg">
                  <button className={ch === 0 ? "on" : ""} onClick={() => setChan(n, 0)} title="Não mudar">—</button>
                  {[1, 2, 3].map((h) => <button key={h} className={ch === h ? "on" : ""} onClick={() => setChan(n, h)}>{h}</button>)}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {names.length > 1 && (
        <div className="row-btns">
          <span className="hint" style={{ margin: 0 }}>Todos para o canal</span>
          {[1, 2, 3].map((h) => <button key={h} className="btn small" onClick={() => all(h)}>{h}</button>)}
        </div>
      )}
      {!inStep && names.length > 0 && (
        <label className="row dest-row">
          <span>Nome do destino</span>
          <input className="row-input" value={dest} placeholder="ex.: MacBook, PC trabalho" maxLength={14}
            onChange={(e) => setDest(e.target.value)} onBlur={() => dest.trim() && onChange(a, dest.trim())} />
        </label>
      )}
      {!inStep && names.length > 0 && <p className="hint">O nome aparece na tecla (pode mudar depois em Aparência). “—” deixa o aparelho onde está.</p>}
      {devs && names.length === 0 && !err && <p className="hint">Nenhum teclado/rato Logitech com Easy-Switch ligado.</p>}
      {err && (
        <>
          <p className="hint warn">{err.includes("Monitoriza") ? "O macOS precisa da permissão “Monitorização de entrada” para falar com o teclado." : err}</p>
          <div className="row-btns">
            <button className="btn" onClick={async () => { await api.inputAccess(true); api.openInputSettings(); }}>Abrir permissões</button>
            <button className="btn" onClick={load}>Procurar de novo</button>
          </div>
        </>
      )}
      {devs && devs.length > 0 && <button className="btn plain small" onClick={load}>Atualizar lista</button>}
    </div>
  );
}

/** "● Gravar": arm, then the deck key starts and stops the recording. */
function MacroRecorder({ onDone }: { onDone: (steps: Action[]) => void }) {
  const [st, setSt] = useState<MacroState["state"]>("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [needPerm, setNeedPerm] = useState(false);
  const [secs, setSecs] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const un = api.onMacro((m) => {
      setSt(m.state);
      if (m.error) {
        setNeedPerm(m.error === "permissão");
        setMsg(m.error === "permissão" ? null : m.error);
      }
      if (m.state === "idle" && m.steps) {
        if (m.steps.length) { done.current(m.steps); toast.success(`Macro gravada: ${m.steps.length} passos`); }
        else setMsg("Nada foi gravado.");
      }
    });
    return () => { un.then((f) => f()); api.macroCancel(); };
  }, []);
  useEffect(() => {
    if (st !== "recording") return;
    setSecs(0);
    const t = setInterval(() => setSecs((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [st]);
  const arm = async () => {
    setMsg(null);
    if (!(await api.inputAccess(true))) { setNeedPerm(true); return; }
    setNeedPerm(false);
    api.macroArm().catch((e) => { if (String(e).includes("permiss")) setNeedPerm(true); else setMsg(String(e)); });
  };
  return (
    <div className={`recorder ${st}`}>
      {st === "idle" && (
        <>
          <button className="btn rec-btn" onClick={arm}><span className="rec-dot" /> Gravar macro</button>
          <span className="hint">Grava o que faz no teclado e no rato, com os tempos reais.</span>
        </>
      )}
      {st === "armed" && (
        <>
          <p><b>Pronto.</b> Vá para o jogo ou app e carregue <b>numa tecla do deck</b> para começar. Carregue outra vez para terminar.</p>
          <div className="row-btns">
            <button className="btn" onClick={() => api.macroStart()}>Começar já</button>
            <button className="btn ghost" onClick={() => api.macroCancel()}>Cancelar</button>
          </div>
        </>
      )}
      {st === "recording" && (
        <>
          <p><span className="rec-dot live" /> <b>A gravar… {secs}s</b> Carregue numa tecla do deck para terminar.</p>
          <div className="row-btns">
            <button className="btn" onClick={() => api.macroStop()}>Parar</button>
            <button className="btn ghost" onClick={() => api.macroCancel()}>Descartar</button>
          </div>
        </>
      )}
      {needPerm && (
        <div className="hint warn">
          O macOS precisa da permissão <b>Monitorização de entrada</b> para gravar. Ative o DIV Deck lá e tente de novo.
          <button className="btn small" onClick={() => api.openInputSettings()}>Abrir definições</button>
        </div>
      )}
      {msg && <p className="hint warn">{msg}</p>}
    </div>
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
    label: "Combo de jogo",
    steps: [
      { type: "key", key: "q", holdMs: 40, repeat: 1, gapMs: 60 },
      { type: "key", key: "w", holdMs: 40, repeat: 1, gapMs: 60 },
      { type: "key", key: "e", holdMs: 40, repeat: 1, gapMs: 60 },
      { type: "key", key: "r", holdMs: 40, repeat: 1, gapMs: 60 },
      { type: "wait", ms: 120 },
      { type: "key", key: "e", holdMs: 40, repeat: 3, gapMs: 70 },
      { type: "key", key: "r", holdMs: 40, repeat: 1, gapMs: 60 },
    ],
  },
  {
    label: "Trocar teclado e rato para o PC 2",
    steps: [{ type: "changeHost", targets: [{ device: "", host: 2 }] }],
  },
  {
    label: "Commit e push",
    steps: [
      { type: "typeText", text: "git add -A && git commit -m \"wip\" && git push", submit: true },
    ],
  },
];

function SequenceEditor({ seq, profiles, onChange: setSeq }: { seq: Extract<Action, { type: "sequence" }>; profiles: Profile[]; onChange: (seq: Extract<Action, { type: "sequence" }>) => void }) {
  const steps = seq.steps;
  const onChange = (steps: Action[]) => setSeq({ ...seq, steps });
  const set = (i: number, a: Action) => onChange(steps.map((s, j) => (j === i ? a : s)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const n = [...steps]; [n[i], n[j]] = [n[j], n[i]]; onChange(n);
  };
  return (
    <div className="seq">
      <MacroRecorder onDone={(rec) => setSeq({ type: "sequence", steps: rec, exact: true })} />
      {steps.length === 0 && (
        <div className="seq-empty">
          <p className="hint">Monte uma sequência de passos: atalhos, teclas de jogo, textos, pausas, abrir apps… Ou comece por um modelo:</p>
          <div className="seq-templates">
            {SEQUENCE_TEMPLATES.map((t) => <button key={t.label} className="chip" onClick={() => setSeq({ type: "sequence", steps: structuredClone(t.steps), exact: t.label === "Combo de jogo" })}>{t.label}</button>)}
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
      {steps.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={!!seq.exact} onChange={(e) => setSeq({ ...seq, exact: e.target.checked || undefined })} />
          <span>Ritmo exato <small>(sem a pausa automática de 60 ms entre passos: para jogos e macros gravadas)</small></span>
        </label>
      )}
      <p className="hint">Os passos correm por ordem{seq.exact ? ", só com as pausas que estão na lista" : ", com uma pequena pausa entre eles"}. Use “Esperar” quando um app demora a abrir. Em jogos, use “Tecla (jogos)”: carrega e solta como uma pessoa.</p>
    </div>
  );
}

// ------------------------------------------------------------------ icon picker (Pro tiles)

const ICON_TABS: { kind: KeyIcon["kind"]; label: string }[] = [
  { kind: "auto", label: "Automático" },
  { kind: "brand", label: "Marcas" },
  { kind: "emoji", label: "Emoji" },
  { kind: "image", label: "Imagem" },
  { kind: "none", label: "Nenhum" },
];
const BRAND_SUGGESTIONS = ["visualstudiocode", "figma", "discord", "steam", "spotify", "github", "notion", "claude", "openai",
  "googlechrome", "safari", "firefoxbrowser", "youtube", "twitch", "obsstudio", "zoom", "whatsapp", "telegram", "gmail",
  "googlemeet", "trello", "jira", "linear", "cursor", "docker", "postman", "apple", "netflix", "dota2", "googledrive"];

function BrandSwatch({ b, size = 34 }: { b: { slug: string; hex: string; path: string; title: string }; size?: number }) {
  const lum = parseInt(b.hex.slice(0, 2), 16) * 0.299 + parseInt(b.hex.slice(2, 4), 16) * 0.587 + parseInt(b.hex.slice(4, 6), 16) * 0.114;
  return (
    <svg width={size} height={size} viewBox="-6 -6 36 36" aria-hidden>
      <rect x="-5" y="-5" width="34" height="34" rx="8" fill={`#${b.hex}`} />
      <path d={b.path} fill={lum > 186 ? "#000" : "#fff"} transform="translate(2.9 2.9) scale(.76)" />
    </svg>
  );
}

function IconPicker({ value, onChange }: { value: KeyConfig; onChange: (icon: KeyIcon) => void }) {
  const cur = value.icon ?? { kind: "auto" as const };
  const [tab, setTab] = useState<KeyIcon["kind"]>(cur.kind);
  const [q, setQ] = useState("");
  const [all, setAll] = useState<{ title: string; slug: string; hex: string; path: string }[] | null>(null);
  const [emoji, setEmoji] = useState("");
  useEffect(() => { if (tab === "brand" && !all) brands().then(setAll); }, [tab, all]);
  const list = !all ? [] : q.trim()
    ? all.filter((b) => b.title.toLowerCase().includes(q.toLowerCase()) || b.slug.includes(q.toLowerCase().replace(/\s+/g, ""))).slice(0, 40)
    : BRAND_SUGGESTIONS.map((s) => all.find((b) => b.slug === s)).filter(Boolean) as typeof all;
  const autoText = value.action.type === "openApp" ? "Usa o ícone do próprio app." : "Usa o símbolo da ação (atalho, mídia, iniciais…).";
  return (
    <div className="iconpick">
      <div className="seg">
        {ICON_TABS.map((t) => (
          <button key={t.kind} className={tab === t.kind ? "on" : ""}
            onClick={() => { setTab(t.kind); if (t.kind === "auto" || t.kind === "none") onChange({ kind: t.kind }); }}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "auto" && <p className="hint">{autoText}</p>}
      {tab === "none" && <p className="hint">Só o nome e a cor, sem imagem.</p>}
      {tab === "brand" && (
        <>
          <input className="input" placeholder="Procurar marca: GitHub, Notion, Spotify…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          {!all ? <p className="hint">A carregar marcas…</p> : (
            <div className="icon-grid">
              {list.map((b) => (
                <button key={b.slug} title={b.title} className={cur.kind === "brand" && cur.slug === b.slug ? "on" : ""}
                  onClick={() => onChange({ kind: "brand", slug: b.slug, title: b.title, hex: b.hex })}>
                  <BrandSwatch b={b} />
                </button>
              ))}
              {list.length === 0 && <p className="hint">Nenhuma marca com esse nome.</p>}
            </div>
          )}
          <p className="hint">Logótipos da Simple Icons, com a cor oficial de cada marca.</p>
        </>
      )}
      {tab === "emoji" && (
        <>
          <div className="icon-grid emoji">
            {EMOJI.map((e) => (
              <button key={e} className={cur.kind === "emoji" && cur.char === e ? "on" : ""} onClick={() => onChange({ kind: "emoji", char: e })}>{e}</button>
            ))}
          </div>
          <div className="emoji-own">
            <input className="input" placeholder="Ou cole outro emoji" value={emoji} maxLength={8} onChange={(e) => setEmoji(e.target.value)} />
            <button className="btn" disabled={!emoji.trim()} onClick={() => onChange({ kind: "emoji", char: emoji.trim() })}>Usar</button>
          </div>
        </>
      )}
      {tab === "image" && (
        <>
          <label className="btn wide file">
            <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden
              onChange={async (e) => { const f = e.target.files?.[0]; if (f) onChange({ kind: "image", data: await imageFileToIcon(f) }); }} />
            {cur.kind === "image" ? "Trocar imagem…" : "Escolher imagem…"}
          </label>
          <p className="hint">PNG, JPG, SVG ou WebP. É recortada ao centro, em quadrado.</p>
        </>
      )}
    </div>
  );
}
