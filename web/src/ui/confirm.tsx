import { useEffect, useState } from "react";
import { Modal } from "./Modal";

export interface ConfirmOptions {
  title?: string;
  /** the question; line breaks are kept */
  body: string;
  confirm?: string;
  cancel?: string;
  /** style the confirm button as destructive */
  danger?: boolean;
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

let setPending: ((p: Pending | null) => void) | null = null;

/** Ask the person to confirm. Resolves true on confirm, false on cancel/Esc. Replaces window.confirm. */
export function confirmDialog(opts: ConfirmOptions | string): Promise<boolean> {
  const o = typeof opts === "string" ? { body: opts } : opts;
  if (!setPending) return Promise.resolve(window.confirm(o.body)); // no host mounted (tests): fall back
  return new Promise((resolve) => setPending!({ ...o, resolve }));
}

/** Mount once near the root. */
export function ConfirmHost() {
  const [p, set] = useState<Pending | null>(null);
  useEffect(() => {
    setPending = set;
    return () => {
      setPending = null;
    };
  }, []);
  if (!p) return null;
  const done = (ok: boolean) => {
    p.resolve(ok);
    set(null);
  };
  return (
    <Modal label={p.title ?? "Confirm"} className="confirm" onClose={() => done(false)}>
      {p.title ? <h2>{p.title}</h2> : null}
      <p className="confirm-body">{p.body}</p>
      <div className="btnrow end">
        <button onClick={() => done(false)}>{p.cancel ?? "Cancel"}</button>
        <button className={p.danger ? "danger" : "on"} onClick={() => done(true)} autoFocus>
          {p.confirm ?? "OK"}
        </button>
      </div>
    </Modal>
  );
}
