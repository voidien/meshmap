import { useState } from "react";
import { api } from "../api";
import type { Member, Project } from "../types";

interface Props {
  project: Project;
  onMembers: (members: Member[]) => void;
  onLeave: () => void;
  onClose: () => void;
}

/** Share a project with other accounts as editor (can change it) or viewer (read-only). */
export function ShareDialog({ project, onMembers, onLeave, onClose }: Props) {
  const isOwner = project.role === "owner";
  const members = project.members ?? [];
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<Member[]>) => {
    setError(null);
    try {
      onMembers(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const base = `/api/projects/${project.id}/members`;

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Share project">
        <div className="modal-head">
          <h2>Share “{project.name}”</h2>
          <button onClick={onClose}>Close</button>
        </div>
        <p className="hint">
          Owner: <b>{project.owner?.displayName}</b>. Editors can change the project; viewers can only look. Only the owner can share or delete it.
        </p>
        {error ? <p className="err">{error}</p> : null}
        <table className="tbl">
          <tbody>
            {members.length === 0 ? (
              <tr>
                <td>Not shared with anyone yet.</td>
              </tr>
            ) : null}
            {members.map((m) => (
              <tr key={m.id}>
                <td>
                  <b>{m.displayName}</b> <span className="lmeta">{m.username}</span>
                </td>
                <td>
                  {isOwner ? (
                    <select value={m.role} onChange={(e) => void run(() => api.patch<Member[]>(`${base}/${m.id}`, { role: e.target.value }))} aria-label={`Role of ${m.username}`}>
                      <option value="editor">editor</option>
                      <option value="viewer">viewer</option>
                    </select>
                  ) : (
                    m.role
                  )}
                </td>
                <td>
                  {isOwner ? (
                    <button onClick={() => void run(() => api.del<Member[]>(`${base}/${m.id}`))}>Remove</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {isOwner ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const r = await api.post<Member[]>(base, { username, role });
                setUsername("");
                return r;
              });
            }}
          >
            <h3>Add someone</h3>
            <div className="nodes-tools">
              <input placeholder="their username" value={username} onChange={(e) => setUsername(e.target.value)} required aria-label="Username to share with" />
              <select value={role} onChange={(e) => setRole(e.target.value as "editor" | "viewer")} aria-label="Role">
                <option value="editor">editor</option>
                <option value="viewer">viewer</option>
              </select>
              <button className="on">Share</button>
            </div>
          </form>
        ) : (
          <button
            className="danger"
            onClick={() => {
              if (confirm(`Leave “${project.name}”? You will lose access until the owner shares it again.`)) {
                onLeave();
                onClose();
              }
            }}
          >
            Leave this project
          </button>
        )}
      </div>
    </div>
  );
}
