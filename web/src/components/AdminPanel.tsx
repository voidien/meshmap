import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "member";
  disabled: boolean;
  createdAt: number;
  lastLogin: number | null;
  hasPassword: boolean;
  passkeyCount: number;
  pendingInvite: boolean;
  projectCount: number;
}

interface Invite {
  username: string;
  token: string;
  expiresAt: number;
}

const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleString() : "never");
const link = (token: string) => `${window.location.origin}/?invite=${encodeURIComponent(token)}`;

/** Admin dialog: add accounts (one-time invite links), change roles, disable, reset sign-in, delete. */
export function AdminPanel({ meId, onClose }: { meId: string; onClose: () => void }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({ username: "", displayName: "", role: "member" });

  const load = useCallback(() => api.get<UserRow[]>("/api/admin/users").then(setUsers, (e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const showInvite = (username: string, r: { inviteToken: string; inviteExpiresAt: number }) => {
    setCopied(false);
    setInvite({ username, token: r.inviteToken, expiresAt: r.inviteExpiresAt });
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Admin">
        <div className="modal-head">
          <h2>Accounts</h2>
          <button onClick={onClose}>Close</button>
        </div>
        {error ? <p className="err">{error}</p> : null}

        <h3>Add an account</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const r = await api.post<{ user: { username: string }; inviteToken: string; inviteExpiresAt: number }>("/api/admin/users", form);
              showInvite(r.user.username, r);
              setForm({ username: "", displayName: "", role: "member" });
            });
          }}
        >
          <div className="grid3">
            <label className="field">
              <span>Username</span>
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
            </label>
            <label className="field">
              <span>Name</span>
              <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="optional" />
            </label>
            <label className="field">
              <span>Role</span>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </label>
          </div>
          <button className="on">Create account and invite link</button>
          <p className="hint">You get a one-time link (valid 7 days) to send them. They choose their own password, then can add a passkey. Admins can manage accounts; members can't.</p>
        </form>

        {invite ? (
          <div className="invite">
            Invite link for <b>{invite.username}</b> (expires {when(invite.expiresAt)}). It is shown once; make a new one if it gets lost.
            <code>{link(invite.token)}</code>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link(invite.token));
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        ) : null}

        <h3>People ({users.length})</h3>
        <table className="tbl">
          <thead>
            <tr>
              <th>Account</th>
              <th>Status</th>
              <th>Last sign-in</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <b>{u.displayName}</b>
                  <br />
                  <span className="lmeta">
                    {u.username} · {u.projectCount} project{u.projectCount === 1 ? "" : "s"}
                  </span>
                </td>
                <td>
                  <select value={u.role} disabled={u.id === meId} onChange={(e) => void act(() => api.patch(`/api/admin/users/${u.id}`, { role: e.target.value }))} aria-label={`Role of ${u.username}`}>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                  {u.disabled ? <span className="tag off">disabled</span> : null}
                  {!u.hasPassword ? <span className="tag pending">{u.pendingInvite ? "invite pending" : "no password"}</span> : null}
                  {u.passkeyCount ? <span className="tag">🔑 {u.passkeyCount}</span> : null}
                </td>
                <td>{when(u.lastLogin)}</td>
                <td>
                  <div className="acts">
                    <button
                      onClick={() =>
                        void act(async () => {
                          if (u.hasPassword && !confirm(`Reset ${u.username}? Their password, passkeys and sessions are removed and they get a new invite link.`)) return;
                          showInvite(u.username, await api.post(`/api/admin/users/${u.id}/reset`, {}));
                        })
                      }
                    >
                      {u.hasPassword ? "Reset sign-in" : "New invite link"}
                    </button>
                    {u.id !== meId ? (
                      <>
                        <button onClick={() => void act(() => api.patch(`/api/admin/users/${u.id}`, { disabled: !u.disabled }))}>{u.disabled ? "Enable" : "Disable"}</button>
                        <button
                          className="danger"
                          onClick={() => {
                            if (confirm(`Delete ${u.username}? Their ${u.projectCount} project${u.projectCount === 1 ? "" : "s"} will be transferred to you.`)) void act(() => api.del(`/api/admin/users/${u.id}`));
                          }}
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
