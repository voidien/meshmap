/** Markdown to safe HTML for the in-app documentation. */
import DOMPurify from "dompurify";
import { marked } from "marked";

export interface Heading {
  id: string;
  text: string;
  level: number;
}

export interface Rendered {
  html: string;
  headings: Heading[];
}

/** GitHub-style anchor: lower case, punctuation dropped, spaces to hyphens. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

/** Maps a link target inside the docs (as written in the markdown) to a document id. */
export function docIdForPath(href: string): string | null {
  const path = href.split("#")[0].replace(/^\.?\//, "");
  if (/^(docs\/)?ARCHITECTURE\.md$/i.test(path)) return "architecture";
  if (/^(docs\/)?validation\.md$/i.test(path)) return "validation";
  if (/^tools\/etl\/README\.md$/i.test(path)) return "etl";
  if (/^README\.md$/i.test(path)) return "readme";
  return null;
}

/**
 * Render markdown: sanitised, headings get ids, links to other docs become `data-doc` links, other links open in a new
 * tab, and `#anchor` links stay in the page.
 */
export function renderMarkdown(md: string): Rendered {
  // without a working sanitiser (no DOM) show the text as is rather than risk unsafe HTML
  if (!DOMPurify.isSupported) return { html: `<pre>${md.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`, headings: [] };
  const raw = marked.parse(md, { gfm: true, async: false }) as string;
  const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  const doc = new DOMParser().parseFromString(`<div id="root">${clean}</div>`, "text/html");
  const root = doc.getElementById("root")!;
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  for (const h of Array.from(root.querySelectorAll("h1, h2, h3, h4"))) {
    const text = h.textContent ?? "";
    const base = slugify(text) || "section";
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    const id = n === 0 ? base : `${base}-${n}`;
    h.id = id;
    if (h.tagName !== "H1") headings.push({ id, text, level: Number(h.tagName[1]) });
  }
  for (const a of Array.from(root.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) continue;
    if (/^https?:\/\//i.test(href)) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      continue;
    }
    const id = docIdForPath(href);
    if (id) {
      a.setAttribute("data-doc", id);
      const hash = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
      if (hash) a.setAttribute("data-anchor", hash);
      a.setAttribute("href", "#");
    } else {
      // a file reference that only makes sense in the repository: show it as plain text
      const span = doc.createElement("span");
      span.className = "doc-file";
      span.innerHTML = a.innerHTML;
      a.replaceWith(span);
    }
  }
  return { html: root.innerHTML, headings };
}
