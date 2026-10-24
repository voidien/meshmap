import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { api } from "../api";
import { renderMarkdown } from "../markdown";

interface DocInfo {
  id: string;
  title: string;
}

interface Props {
  onClose: () => void;
}

/** The project's documentation, read from the server and shown inside the app. */
export function HelpDialog({ onClose }: Props) {
  const [docs, setDocs] = useState<DocInfo[] | null>(null);
  const [current, setCurrent] = useState("readme");
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<DocInfo[]>("/api/docs").then(setDocs, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    let live = true;
    setText(null);
    setError(null);
    api
      .text(`/api/docs/${current}`)
      .then((t) => live && setText(t))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [current]);

  const rendered = useMemo(() => (text === null ? null : renderMarkdown(text)), [text]);

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    if (pendingAnchor) {
      document.getElementById(`doc-${pendingAnchor}`)?.scrollIntoView({ block: "start" });
      setPendingAnchor(null);
    } else {
      el.scrollTop = 0;
    }
  }, [rendered]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const goto = (id: string) => document.getElementById(`doc-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" });

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    const doc = a.getAttribute("data-doc");
    if (doc) {
      e.preventDefault();
      const anchor = a.getAttribute("data-anchor");
      if (doc === current) {
        if (anchor) goto(anchor);
      } else {
        setPendingAnchor(anchor);
        setCurrent(doc);
      }
    } else if (href.startsWith("#") && href.length > 1) {
      e.preventDefault();
      goto(href.slice(1));
    }
  };

  // ids are prefixed so they cannot collide with the app's own element ids
  const html = useMemo(() => rendered?.html.replace(/ id="([^"]+)"/g, ' id="doc-$1"').replace(/href="#([^"]+)"/g, 'href="#$1"') ?? "", [rendered]);

  return (
    <Modal onClose={onClose} label="Help" className="help">
        <div className="modal-head">
          <h2>Help</h2>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="tabs" role="tablist">
          {(docs ?? [{ id: "readme", title: "Guide" }]).map((d) => (
            <button key={d.id} role="tab" aria-selected={current === d.id} className={current === d.id ? "on" : ""} onClick={() => { setPendingAnchor(null); setCurrent(d.id); }}>
              {d.title}
            </button>
          ))}
        </div>
        {error ? <p className="err">{error}</p> : null}
        {text === null && !error ? <p className="hint">Loading…</p> : null}
        {rendered ? (
          <div className="helpbody">
            {rendered.headings.some((h) => h.level === 2) ? (
              <nav className="helptoc" aria-label="Contents">
                {rendered.headings
                  .filter((h) => h.level <= 3)
                  .map((h) => (
                    <a key={h.id} href={`#${h.id}`} className={`l${h.level}`} onClick={(e) => { e.preventDefault(); goto(h.id); }}>
                      {h.text}
                    </a>
                  ))}
              </nav>
            ) : null}
            <div ref={body} className="doc" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        ) : null}
    </Modal>
  );
}
