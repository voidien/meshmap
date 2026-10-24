import { useCallback, useEffect, useState } from "react";
import { confirmDialog } from "../ui/confirm";
import { api } from "../api";
import { Card } from "./Card";
import { describeDiff, diffVersion } from "../versionDiff";
import { parseProject } from "../workspace";
import type { Project } from "../types";

interface Version {
  number: number;
  label: string;
  auto: boolean;
  createdAt: number;
  createdBy: string | null;
  nodes: number;
}

interface Props {
  project: Project;
  readOnly: boolean;
  onRestore: (number: number) => Promise<void>;
}

const when = (t: number) => new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Named versions you save, and automatic ones taken before edits; any can be put back. */
export function HistoryPanel({ project, readOnly, onRestore }: Props) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [label, setLabel] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = project.id;

  const load = useCallback(async () => {
    try {
      setVersions(await api.get<Version[]>(`/api/projects/${id}/versions`));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!label.trim()) return setMsg("Give the version a name.");
    setBusy(true);
    try {
      await api.post(`/api/projects/${id}/versions`, { label });
      setLabel("");
      setMsg("Saved.");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (v: Version) => {
    setBusy(true);
    setMsg(null);
    try {
      const full = await api.get<{ data: Record<string, unknown> }>(`/api/projects/${id}/versions/${v.number}`);
      const then = parseProject({ ...full.data, id, name: project.name });
      const lines = then ? describeDiff(diffVersion(project, then)) : [];
      const what = v.label || `the automatic version from ${when(v.createdAt)}`;
      const text = lines.length ? `Restore “${what}”?\n\n• ${lines.join("\n• ")}\n\nWhat you have now is kept as a new version, so this can be undone.` : `“${what}” is the same as the project now. Restore anyway?`;
      if (!(await confirmDialog({ title: "Restore this version?", body: text, confirm: "Restore" }))) return;
      await onRestore(v.number);
      setMsg("Restored. The previous state is in the list below.");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (v: Version) => {
    if (!(await confirmDialog({ body: `Delete the version “${v.label}”?`, confirm: "Delete", danger: true }))) return;
    try {
      await api.del(`/api/projects/${id}/versions/${v.number}`);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Card id="history" domId="history-panel" title={<>History ({versions.length})</>}>
      <p className="hint">The app keeps the state before your edits (at most one every 10 minutes, the last 40) and the versions you name. Restoring never loses what you have now: it becomes a version too.</p>
      {readOnly ? null : (
        <div className="btnrow">
          <input id="version-label" placeholder="Name this version (e.g. “Before moving Hinch”)" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
          <button id="version-save" disabled={busy} onClick={() => void save()}>
            Save version
          </button>
        </div>
      )}
      {msg ? <div className="lmeta">{msg}</div> : null}
      <ul className="versions">
        {versions.length === 0 ? <li className="hint">No versions yet. One appears with your next edit.</li> : null}
        {versions.map((v) => (
          <li key={v.number}>
            <div className="lrow">
              <b>{v.label || "Automatic"}</b>
              <span className="spacer" />
              <span className="lmeta">{when(v.createdAt)}</span>
            </div>
            <div className="lmeta">
              {v.nodes} node{v.nodes === 1 ? "" : "s"}
              {v.createdBy ? ` · ${v.createdBy}` : ""}
            </div>
            {readOnly ? null : (
              <div className="btnrow">
                <button className="restore" disabled={busy} onClick={() => void restore(v)}>
                  Restore
                </button>
                {v.auto ? null : <button disabled={busy} onClick={() => void remove(v)}>Delete</button>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
