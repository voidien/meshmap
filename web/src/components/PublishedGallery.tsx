import { useEffect, useMemo, useState } from "react";
import { Card } from "./Card";
import { api } from "../api";
import { ago, type Publication } from "../collab";

interface Props {
  openId: string | null;
  onOpen: (p: Publication) => void;
  /** Bumps to reload (after publishing or unpublishing). */
  reloadKey: number;
}

/** Everything published on this site: browse, search and open (read-only). */
export function PublishedGallery({ openId, onOpen, reloadKey }: Props) {
  const [items, setItems] = useState<Publication[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    let live = true;
    api
      .get<Publication[]>("/api/published")
      .then((v) => live && setItems(v))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [reloadKey]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (items ?? []).filter((p) => !t || `${p.title} ${p.description} ${p.owner.displayName} ${p.owner.username}`.toLowerCase().includes(t));
  }, [items, q]);

  return (
    <Card id="gallery" domId="published-gallery" title="Published projects" defaultOpen>
      <p className="hint">Shared by people on this site. Open one to look around, read and add comments, or copy it into your own projects.</p>
      <input type="search" placeholder="Search title, description or person…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search published projects" />
      {error ? <p className="err">{error}</p> : null}
      {items === null && !error ? <p className="hint">Loading…</p> : null}
      {items && items.length === 0 ? <p className="hint">Nothing has been published yet. Open one of your projects and use Publish.</p> : null}
      <ul className="published">
        {shown.map((p) => (
          <li key={p.id} className={p.id === openId ? "sel" : ""} onClick={() => onOpen(p)}>
            <div className="ptitle">
              <b>{p.title}</b>
              {p.mine ? <span className="tag">yours</span> : null}
            </div>
            <div className="lmeta">
              {p.owner.displayName} · {p.nodeCount} node{p.nodeCount === 1 ? "" : "s"} · updated {ago(p.updatedAt)} · {p.commentCount} comment{p.commentCount === 1 ? "" : "s"}
            </div>
            {p.description ? <div className="pdesc">{p.description.length > 160 ? `${p.description.slice(0, 160)}…` : p.description}</div> : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
