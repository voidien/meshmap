import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  /** the button's content */
  label: ReactNode;
  title?: string;
  className?: string;
  id?: string;
  align?: "left" | "right";
  children: (close: () => void) => ReactNode;
}

/** A button that opens a small menu under it; closes on outside click, Esc, or when an item calls `close`. */
export function Popover({ label, title, className = "", id, align = "left", children }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  return (
    <div className="popover" ref={box}>
      <button id={id} className={className} title={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open ? (
        <div className={`popmenu ${align}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
