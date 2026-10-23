import { useCallback, useEffect, useMemo, useState } from "react";
import { Card } from "./Card";
import { api } from "../api";
import { ago, commentsUrl, type Comment, type CommentScope } from "../collab";
import type { MeshNode } from "../types";

interface Props {
  scope: CommentScope;
  nodes: MeshNode[];
  /** What the user has selected on the map: the comment box is about this. */
  selectedNode: MeshNode | null;
  selectedLink: { key: string; label: string } | null;
  /** Bumps when something else (a node deleted...) should refresh the thread. */
  title?: string;
}

const POLL_MS = 20000;

/** A comment thread for a project or a published copy, filterable to the selected node or link. */
export function CommentsPanel({ scope, nodes, selectedNode, selectedLink, title }: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const url = commentsUrl(scope);

  const load = useCallback(async () => {
    try {
      setComments(await api.get<Comment[]>(url));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [url]);

  useEffect(() => {
    setComments([]);
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const target = selectedLink ? { kind: "link" as const, ref: selectedLink.key, label: `link ${selectedLink.label}` } : selectedNode ? { kind: "node" as const, ref: selectedNode.id, label: selectedNode.name.trim() || "this node" } : { kind: "project" as const, ref: "", label: "the project" };
  const names = useMemo(() => new Map(nodes.map((n) => [n.id, n.name.trim() || "(unnamed)"])), [nodes]);
  const visible = comments.filter((c) => showAll || (c.targetKind === target.kind && c.targetRef === target.ref));
  const aboutWhat = (c: Comment) => (c.targetKind === "node" ? `node ${names.get(c.targetRef) ?? "(deleted)"}` : c.targetKind === "link" ? "a link" : "the project");

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const c = await api.post<Comment>(url, { targetKind: target.kind, targetRef: target.ref, body });
      setComments((cs) => [...cs, c]);
      setText("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const open = comments.filter((c) => !c.resolved).length;
  return (
    <Card id="comments" domId="comments-panel" title={<>{title ?? "Comments"} <span className="count">({comments.length}{open !== comments.length ? `, ${open} open` : ""})</span></>}>
      <label className="check">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        Show every comment, not just about {target.label}
      </label>
      {error ? <p className="err">{error}</p> : null}
      <ul className="comments">
        {visible.map((c) => (
          <li key={c.id} className={c.resolved ? "resolved" : ""}>
            <div className="chead">
              <b>{c.author?.displayName ?? "a deleted account"}</b>
              <span className="lmeta">
                {ago(c.createdAt)}
                {showAll ? ` · ${aboutWhat(c)}` : ""}
              </span>
            </div>
            <div className="cbody">{c.body}</div>
            <div className="cact">
              {c.canResolve ? <button onClick={() => void act(() => api.patch(`/api/comments/${c.id}`, { resolved: !c.resolved }))}>{c.resolved ? "Reopen" : "Resolve"}</button> : c.resolved ? <span className="lmeta">resolved</span> : null}
              {c.canDelete ? <button onClick={() => void act(() => api.del(`/api/comments/${c.id}`))}>Delete</button> : null}
            </div>
          </li>
        ))}
      </ul>
      {visible.length === 0 ? <p className="hint">{showAll ? "No comments yet." : `No comments about ${target.label} yet.`}</p> : null}
      <label className="field">
        <span>Comment on {target.label}</span>
        <textarea rows={2} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} placeholder="Ask a question, flag a problem, leave a note…" />
      </label>
      <button className="on" disabled={!text.trim() || busy} onClick={() => void send()}>
        Post comment
      </button>
    </Card>
  );
}
