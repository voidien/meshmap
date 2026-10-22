import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { deviceName, passkeyErrorMessage, passkeysSupported, registerPasskey } from "../auth/webauthn";
import type { AuthContext } from "../auth/AuthGate";

interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: number;
  lastUsed: number | null;
}

const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleDateString() : "never");

/** Account dialog: add or remove passkeys, change password, sign out. */
export function AccountMenu({ auth, onClose }: { auth: AuthContext; onClose: () => void }) {
  const [keys, setKeys] = useState<PasskeyInfo[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [name, setName] = useState(deviceName());
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const supported = passkeysSupported();

  const load = useCallback(() => api.get<PasskeyInfo[]>("/api/passkeys").then(setKeys, () => undefined), []);
  useEffect(() => void load(), [load]);

  const fail = (e: unknown) => setMsg({ ok: false, text: passkeyErrorMessage(e) });

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Account">
        <div className="modal-head">
          <h2>
            {auth.user.displayName} <span className="tag">{auth.user.username}</span>
            {auth.user.role === "admin" ? <span className="tag admin">admin</span> : null}
          </h2>
          <button onClick={onClose}>Close</button>
        </div>
        {msg ? <p className={msg.ok ? "hint" : "err"}>{msg.text}</p> : null}

        <h3>Passkeys (fingerprint, face, device PIN)</h3>
        {!supported ? (
          <p className="hint">
            This page can't use passkeys: they need the secure <b>https://</b> address (for example your Tailscale address), not an IP address or plain http.
          </p>
        ) : (
          <>
            <ul className="difflist">
              {keys.length === 0 ? <li>No passkeys yet. Add one to sign in without typing your password on this device.</li> : null}
              {keys.map((k) => (
                <li key={k.id}>
                  <span className="lname">🔑 {k.name}</span>
                  <span className="lmeta">added {when(k.createdAt)} · last used {when(k.lastUsed)}</span>
                  <button
                    onClick={async () => {
                      if (!confirm(`Remove the passkey "${k.name}"? You can still sign in with your password.`)) return;
                      await api.del(`/api/passkeys/${k.id}`).catch(() => undefined);
                      await load();
                      await auth.refresh();
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <div className="nodes-tools">
              <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Passkey name" />
              <button
                className="on"
                onClick={async () => {
                  setMsg(null);
                  try {
                    await registerPasskey(name.trim() || deviceName());
                    setMsg({ ok: true, text: "Passkey added. Next time, type your username and choose “Sign in with a passkey”." });
                    await load();
                    await auth.refresh();
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                Add a passkey to this device
              </button>
            </div>
          </>
        )}

        <h3>Change password</h3>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setMsg(null);
            try {
              await api.post("/api/password", { current: cur, newPassword: next });
              setCur("");
              setNext("");
              setMsg({ ok: true, text: "Password changed. Other devices were signed out." });
            } catch (err) {
              setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
            }
          }}
        >
          <div className="grid2">
            <label className="field">
              <span>Current password</span>
              <input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
            </label>
            <label className="field">
              <span>New password (10+ characters)</span>
              <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} />
            </label>
          </div>
          <button>Change password</button>
        </form>

        <h3>Session</h3>
        <button onClick={() => void auth.signOut()}>Sign out</button>
      </div>
    </div>
  );
}
