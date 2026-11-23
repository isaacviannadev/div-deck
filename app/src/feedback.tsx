// Toasts (stacked, Sonner-style) and confirmation sheets for destructive actions.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "./ui";

// ------------------------------------------------------------------ toasts

type Kind = "success" | "error" | "info" | "warning";
export interface ToastItem {
  id: number;
  kind: Kind;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  duration: number;
}
type Opts = { description?: string; action?: { label: string; onClick: () => void }; duration?: number };

let items: ToastItem[] = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const add = (kind: Kind, title: string, o: Opts = {}) => {
  const t: ToastItem = { id: ++seq, kind, title, description: o.description, action: o.action, duration: o.duration ?? (o.action ? 6000 : 3500) };
  items = [t, ...items].slice(0, 5);
  emit();
  return t.id;
};
export const dismiss = (id: number) => { items = items.filter((t) => t.id !== id); emit(); };
export const toast = {
  success: (t: string, o?: Opts) => add("success", t, o),
  error: (t: string, o?: Opts) => add("error", t, o),
  info: (t: string, o?: Opts) => add("info", t, o),
  warning: (t: string, o?: Opts) => add("warning", t, o),
};

const ICON: Record<Kind, Parameters<typeof Icon>[0]["name"]> = { success: "check", error: "x", info: "info", warning: "alert" };

function ToastCard({ t, index, expanded, paused }: { t: ToastItem; index: number; expanded: boolean; paused: boolean }) {
  const left = useRef(t.duration);
  useEffect(() => {
    if (paused) return;
    const start = Date.now();
    const timer = setTimeout(() => dismiss(t.id), left.current);
    return () => { clearTimeout(timer); left.current -= Date.now() - start; };
  }, [paused, t.id]);
  const style = expanded
    ? { transform: `translateY(${-index * 62}px)`, opacity: 1 }
    : { transform: `translateY(${-index * 10}px) scale(${1 - index * 0.05})`, opacity: index > 2 ? 0 : 1 - index * 0.15 };
  return (
    <div className={`toast-card ${t.kind}`} style={{ ...style, zIndex: 100 - index }} role="status">
      <span className="toast-ico"><Icon name={ICON[t.kind]} size={14} /></span>
      <div className="toast-text">
        <strong>{t.title}</strong>
        {t.description && <small>{t.description}</small>}
      </div>
      {t.action && (
        <button className="toast-action" onClick={() => { t.action!.onClick(); dismiss(t.id); }}>{t.action.label}</button>
      )}
      <button className="toast-x" aria-label="Fechar" onClick={() => dismiss(t.id)}><Icon name="x" size={11} /></button>
    </div>
  );
}

export function Toaster() {
  const list = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => items);
  const [hover, setHover] = useState(false);
  if (!list.length) return null;
  return (
    <div className={`toaster ${hover ? "expanded" : ""}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ height: hover ? 56 + (list.length - 1) * 62 : 56 + Math.min(list.length - 1, 2) * 10 }}>
      {list.map((t, i) => <ToastCard key={t.id} t={t} index={i} expanded={hover} paused={hover} />)}
    </div>
  );
}

// ------------------------------------------------------------------ confirmation sheet

interface Ask { title: string; message?: string; confirm: string; cancel?: string; destructive?: boolean; resolve: (ok: boolean) => void }
let ask: Ask | null = null;
const askSubs = new Set<() => void>();

/** Ask before doing something that loses work. Resolves true when confirmed. */
export function confirmDialog(o: { title: string; message?: string; confirm: string; cancel?: string; destructive?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    ask?.resolve(false);
    ask = { ...o, resolve };
    askSubs.forEach((f) => f());
  });
}
const close = (ok: boolean) => { const a = ask; ask = null; askSubs.forEach((f) => f()); a?.resolve(ok); };

export function ConfirmHost() {
  const a = useSyncExternalStore((f) => { askSubs.add(f); return () => askSubs.delete(f); }, () => ask);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!a) return;
    okRef.current?.focus();
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(false); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [a]);
  if (!a) return null;
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div className="sheet" role="alertdialog" aria-modal="true" aria-labelledby="sheet-title">
        <div className={`sheet-ico ${a.destructive ? "danger" : ""}`}><Icon name={a.destructive ? "trash" : "info"} size={20} /></div>
        <h3 id="sheet-title">{a.title}</h3>
        {a.message && <p>{a.message}</p>}
        <div className="sheet-actions">
          <button className="btn" onClick={() => close(false)}>{a.cancel ?? "Cancelar"}</button>
          <button ref={okRef} className={`btn ${a.destructive ? "destructive" : "primary"}`} onClick={() => close(true)}>{a.confirm}</button>
        </div>
      </div>
    </div>
  );
}
