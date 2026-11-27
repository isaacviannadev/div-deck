import { useEffect, useRef, useState } from "react";
import { modelName, type DeckInfo, type Profile, type StatusBar } from "./api";
import { OledPreview } from "./components";
import { Icon, Toggle } from "./ui";

const DEFAULT_STATUS: StatusBar = { show: true, time: true, date: true, profile: true };

/** "1.1.0" < "1.2.0" */
export const fwOlder = (v: string, than: string) => {
  const a = v.split(".").map(Number), b = than.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  return false;
};

const deckSub = (d: DeckInfo, profiles: Profile[]) =>
  d.connected ? `${d.model === "pro" ? "Touch" : "MX"} · ${profiles.find((p) => p.id === d.active)?.name ?? ""}` : "Desligado";

/** Device picker as a cascader (Miller columns): decks → the deck's settings → its status bar / OLED.
 * The trigger shows the whole path, so with several decks it stays clear which one is being edited. */
export function DeckCascader({ decks, deck, profiles, onSelect, onChange, onForget }: {
  decks: DeckInfo[]; deck: DeckInfo | null; profiles: Profile[];
  onSelect: (d: DeckInfo) => void; onChange: (patch: Partial<DeckInfo>) => void; onForget: (d: DeckInfo) => void;
}) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState(1);
  const [name, setName] = useState(deck?.name ?? "");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setName(deck?.name ?? ""), [deck?.id, deck?.name]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" && e.key !== "Escape") return;
      if (e.key === "Escape" || e.key === "ArrowLeft") {
        e.preventDefault();
        if (level > 1) setLevel(level - 1); else if (e.key === "Escape") setOpen(false);
      } else if (e.key === "ArrowRight" && level < 3 && deck) { e.preventDefault(); setLevel(level + 1); }
      else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && level === 1 && decks.length) {
        e.preventDefault();
        const i = Math.max(0, decks.findIndex((d) => d.id === deck?.id));
        onSelect(decks[(i + (e.key === "ArrowDown" ? 1 : decks.length - 1)) % decks.length]);
      }
    };
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", down); window.removeEventListener("keydown", key); };
  }, [open, level, deck, decks, onSelect]);

  if (decks.length === 0) {
    return (
      <div className="device cascade-trigger idle">
        <span className="device-icon"><Icon name="usb" size={15} /></span>
        <span className="device-text"><strong>DIV Deck</strong><small>Procurando… ligue o deck no USB</small></span>
        <span className="device-dot" />
      </div>
    );
  }
  const status = deck?.status ?? DEFAULT_STATUS;
  const statusName = deck?.model === "pro" ? "Barra de estado" : "Tela OLED";
  const statusSum = !status.show ? "Desligada" : ([["time", "Hora"], ["date", "Data"], ["profile", "Perfil"]] as const)
    .filter(([k]) => status[k]).map(([, l]) => l).join(" · ") || "Vazia";
  const setStatus = (p: Partial<StatusBar>) => onChange({ status: { ...status, ...p } });

  return (
    <div className="cascade" ref={box}>
      <button className={`device cascade-trigger ${deck?.connected ? "ok" : ""} ${open ? "open" : ""}`}
        onClick={() => { setOpen(!open); setLevel(deck ? 2 : 1); }} aria-haspopup="menu" aria-expanded={open}>
        <span className="device-icon"><Icon name={deck?.model === "pro" ? "screen" : "keys"} size={15} /></span>
        <span className="device-text">
          <strong>{deck?.name ?? "Escolher deck"}</strong>
          <small>{deck ? deckSub(deck, profiles) : `${decks.length} dispositivos`}</small>
        </span>
        {decks.length > 1 && <span className="cascade-count">{decks.length}</span>}
        <span className="device-dot" />
        <span className="cascade-chev"><Icon name="down" size={13} /></span>
      </button>

      {open && (
        <div className="cascade-pop" role="menu">
          {/* 1: decks */}
          <div className="cascade-col">
            <div className="cascade-head">Dispositivos</div>
            {decks.map((d) => (
              <button key={d.id} className={`cascade-row ${d.id === deck?.id ? "on" : ""} ${d.connected ? "ok" : ""}`}
                onClick={() => { onSelect(d); setLevel(2); }}>
                <span className="device-icon"><Icon name={d.model === "pro" ? "screen" : "keys"} size={14} /></span>
                <span className="device-text"><strong>{d.name}</strong><small>{deckSub(d, profiles)}</small></span>
                <span className="device-dot" />
                <Icon name="next" size={10} className="cascade-arrow" />
              </button>
            ))}
          </div>

          {/* 2: the deck's settings */}
          {level >= 2 && deck && (
            <div className="cascade-col">
              <div className="cascade-head">
                <button className="cascade-back" onClick={() => setLevel(1)} aria-label="Voltar"><Icon name="prev" size={10} /></button>
                {deck.name}
              </div>
              <div className="cascade-body">
                <input className="deck-name" value={name} maxLength={32} aria-label="Nome do deck"
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => name.trim() !== deck.name && onChange({ name: name.trim() || modelName(deck.model) })}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
                <small className="deck-meta">{modelName(deck.model)}{deck.firmware ? ` · firmware ${deck.firmware}` : ""}{deck.port ? "" : ""}</small>
                <Toggle label="Segue o app em foco" checked={deck.followApp} onChange={(v) => onChange({ followApp: v })} />
                {deck.model === "pro" && <Toggle label="Tela invertida (180°)" checked={deck.flipped} onChange={(v) => onChange({ flipped: v })} />}
                <button className={`cascade-row sub ${level === 3 ? "on" : ""}`} onClick={() => setLevel(3)}>
                  <span className="device-text"><strong>{statusName}</strong><small>{statusSum}</small></span>
                  <Icon name="next" size={10} className="cascade-arrow" />
                </button>
                {!deck.connected && decks.length > 1 && (
                  <button className="btn plain small danger" onClick={() => onForget(deck)}>Remover da lista</button>
                )}
              </div>
            </div>
          )}

          {/* 3: status bar (Pro) / OLED (MX) */}
          {level >= 3 && deck && (
            <div className="cascade-col">
              <div className="cascade-head">
                <button className="cascade-back" onClick={() => setLevel(2)} aria-label="Voltar"><Icon name="prev" size={10} /></button>
                {statusName}
              </div>
              <div className="cascade-body">
                <Toggle label="Mostrar" checked={status.show} onChange={(v) => setStatus({ show: v })} />
                {status.show && (
                  <div className="status-opts">
                    {([["time", "Hora"], ["date", "Data"], ["profile", "Perfil"]] as const).map(([k, l]) => (
                      <label key={k} className="chk">
                        <input type="checkbox" checked={status[k]} onChange={(e) => setStatus({ [k]: e.target.checked })} />
                        {l}
                      </label>
                    ))}
                  </div>
                )}
                {deck.model === "mx" && (
                  <>
                    <OledPreview status={status} profile={profiles.find((p) => p.id === deck.active)?.name ?? ""} connected={deck.connected} />
                    {deck.connected && deck.firmware && fwOlder(deck.firmware, "1.2.0") && (
                      <small className="deck-meta">A tela OLED precisa do firmware 1.2 ou mais recente.</small>
                    )}
                  </>
                )}
                {deck.model === "pro" && <small className="deck-meta">Aparece no topo da tela, por cima das teclas.</small>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
