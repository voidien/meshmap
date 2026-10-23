import { useEffect, useState } from "react";
import { api } from "../api";
import { ago, type Publication } from "../collab";
import type { Project } from "../types";

interface Props {
  project: Project;
  onClose: () => void;
  onChanged: () => void;
}

/** Publish a frozen, read-only copy of a project for everyone on this site to browse and copy. */
export function PublishDialog({ project, onClose, onChanged }: Props) {
  const [pub, setPub] = useState<Publication | null | undefined>(undefined);
  const [title, setTitle] = useState(project.name);
  const [description, setDescription] = useState("");
  const [includeNotes, setIncludeNotes] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isOwner = project.role === "owner";
  const url = `/api/projects/${project.id}/publication`;

  useEffect(() => {
    api
      .get<Publication | null>(url)
      .then((p) => {
        setPub(p);
        if (p) {
          setTitle(p.title);
          setDescription(p.description);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [url]);

  const run = async (fn: () => Promise<Publication | null>) => {
    setBusy(true);
    setError(null);
    try {
      setPub(await fn());
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Publish project">
        <div className="modal-head">
          <h2>Publish “{project.name}”</h2>
          <button onClick={onClose}>Close</button>
        </div>
        <p className="hint">
          Publishing puts a <b>frozen copy</b> of this project in the <b>Published</b> section, where every signed-in user on this site can look at it, comment on it and copy it into their own projects. Your project stays private and editable; the published copy only changes when you update it.
        </p>
        {error ? <p className="err">{error}</p> : null}
        {!isOwner ? <p className="hint">Only the project's owner can publish it.</p> : null}
        {pub === undefined && !error ? <p className="hint">Checking…</p> : null}
        {pub ? (
          <p className="banner">
            Published {ago(pub.publishedAt)}, last updated {ago(pub.updatedAt)} · {pub.nodeCount} nodes · {pub.commentCount} comments.
            {pub.outdated ? " The project has changed since: update the published copy to share the changes." : " It matches your project."}
          </p>
        ) : null}
        <fieldset className="plain" disabled={!isOwner || busy || pub === undefined}>
          <label className="field">
            <span>Title</span>
            <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>Description (what is it, where, what should people look at)</span>
            <textarea rows={4} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} />
            Include node notes (they stay private unless you tick this)
          </label>
          <p className="hint">Node positions, antenna settings and the project's settings are published. Comments, field readings, heatmap results and who you have shared the project with are not.</p>
          <div className="row-actions">
            <button className="on" onClick={() => void run(() => api.put<Publication>(url, { title, description, includeNotes }))}>
              {pub ? "Update published copy" : "Publish"}
            </button>
            {pub ? (
              <button className="danger" onClick={() => void run(async () => (await api.del(url), null))}>
                Unpublish
              </button>
            ) : null}
          </div>
        </fieldset>
      </div>
    </div>
  );
}
