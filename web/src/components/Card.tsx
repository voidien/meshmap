import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/** "flat" shows panels open with a plain heading (the new layout's Browser and Inspector); "cards" collapses them (classic sidebar). */
export const PanelMode = createContext<"cards" | "flat">("cards");

const KEY = (id: string) => `meshmap.panel.${id}`;
const EVENT = "meshmap:panels";

function stored(id: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(KEY(id));
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

/** Open or close every panel at once (the buttons above the panels). */
export function setAllPanels(open: boolean) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { action: open ? "open-all" : "close-all" } }));
}

/** Open one panel by its id (for example from a map menu). */
export function openPanel(id: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { action: "open", id } }));
}

interface Props {
  /** Remembers whether it is open. */
  id: string;
  title: ReactNode;
  children: ReactNode;
  /** Open the first time (before the person has chosen). Panels start collapsed. */
  defaultOpen?: boolean;
  /** Opens the panel whenever this value changes to something truthy (a newly selected node...). */
  openWhen?: unknown;
  /** The element id of the card itself. */
  domId?: string;
  className?: string;
}

/** A sidebar panel with a heading that collapses it. State is remembered per panel. */
export function Card({ id, title, children, defaultOpen = false, openWhen, domId, className = "" }: Props) {
  const mode = useContext(PanelMode);
  const [open, setOpenState] = useState(() => stored(id, defaultOpen));
  const setOpen = useCallback(
    (v: boolean) => {
      setOpenState(v);
      try {
        localStorage.setItem(KEY(id), v ? "1" : "0");
      } catch {
        /* ignore */
      }
    },
    [id],
  );

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ action: string; id?: string }>).detail;
      if (d.action === "open-all") setOpen(true);
      else if (d.action === "close-all") setOpen(false);
      else if (d.action === "open" && d.id === id) setOpen(true);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [id, setOpen]);

  useEffect(() => {
    if (openWhen) setOpenState(true);
  }, [openWhen]);

  const bodyId = `card-body-${id}`;
  if (mode === "flat") {
    return (
      <section className={`card flat ${className}`} id={domId}>
        <h3 className="flat-title">{title}</h3>
        <div className="cardbody">{children}</div>
      </section>
    );
  }
  return (
    <section className={`card collapsible ${open ? "open" : "closed"} ${className}`} id={domId}>
      <button type="button" className="cardhead" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <span className="chev" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="cardtitle">{title}</span>
      </button>
      <div id={bodyId} className="cardbody" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
