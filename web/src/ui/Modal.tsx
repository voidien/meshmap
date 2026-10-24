import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Props {
  onClose: () => void;
  /** accessible name of the dialog */
  label: string;
  /** extra class on the dialog box (for example "help") */
  className?: string;
  children: ReactNode;
}

/** A dialog: Esc closes it, Tab stays inside it, and focus goes back to what opened it. */
export function Modal({ onClose, label, className, children }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>("input, select, textarea") ?? box.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? box.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab" && box.current) {
        const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (items.length === 0) return e.preventDefault();
        const [a, z] = [items[0], items[items.length - 1]];
        if (e.shiftKey && (document.activeElement === a || !box.current.contains(document.activeElement))) (e.preventDefault(), z.focus());
        else if (!e.shiftKey && (document.activeElement === z || !box.current.contains(document.activeElement))) (e.preventDefault(), a.focus());
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      opener?.focus?.();
    };
  }, []);

  return (
    <div className="modal-back" onClick={onClose}>
      <div ref={box} className={`modal${className ? " " + className : ""}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
