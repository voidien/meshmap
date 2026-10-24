import { useEffect, useState } from "react";

export interface ToastOptions {
  kind?: "info" | "error" | "success";
  /** label of an action button, for example "Undo" */
  action?: string;
  onAction?: () => void;
  /** how long it stays, in ms (errors stay longer; 0 = until dismissed) */
  ms?: number;
}

interface Toast extends ToastOptions {
  id: number;
  text: string;
}

type Listener = (t: Toast[]) => void;
let toasts: Toast[] = [];
let next = 1;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l(toasts));

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Show a message that fades by itself. Usable anywhere, not only in components. Returns its id. */
export function notify(text: string, opts: ToastOptions = {}): number {
  const id = next++;
  const kind = opts.kind ?? "info";
  toasts = [...toasts.slice(-3), { ...opts, kind, id, text }];
  emit();
  const ms = opts.ms ?? (kind === "error" ? 9000 : opts.action ? 8000 : 4500);
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}

export const notifyError = (e: unknown) => notify(e instanceof Error ? e.message : String(e), { kind: "error" });

/** For tests. */
export function clearToasts() {
  toasts = [];
  emit();
}

/** The stack of messages at the bottom of the screen; mount once. */
export function Toasts() {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => void listeners.delete(setList);
  }, []);
  return (
    <div className="toasts" aria-live="polite" role="status">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.text}</span>
          {t.action ? (
            <button
              onClick={() => {
                t.onAction?.();
                dismissToast(t.id);
              }}
            >
              {t.action}
            </button>
          ) : null}
          <button className="x" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
