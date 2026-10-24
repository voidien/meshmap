/** Filtering and ordering of the Nodes and Links lists, and tag helpers. All plain functions. */
import type { Link, LinkClass, MeshNode } from "./types";

export interface NodeStat {
  links: number;
  /** best margin of its links (dB), null without links */
  best: number | null;
}

export type NodeSort = "name" | "links" | "height" | "status" | "weakest";

export interface NodeFilter {
  query: string;
  /** only these statuses; empty = all */
  status: ReadonlySet<string>;
  /** only nodes carrying this tag; "" = any */
  tag: string;
  /** only nodes with no link, or whose best link is below `weakBelowDb` */
  problems: boolean;
  weakBelowDb: number;
}

export const NO_NODE_FILTER: NodeFilter = { query: "", status: new Set(), tag: "", problems: false, weakBelowDb: 10 };

export function nodeStats(nodes: MeshNode[], links: Link[]): Map<string, NodeStat> {
  const m = new Map<string, NodeStat>();
  for (const n of nodes) m.set(n.id, { links: 0, best: null });
  for (const l of links) {
    if (l.class === "none") continue;
    for (const id of [l.a, l.b]) {
      const s = m.get(id);
      if (!s) continue;
      s.links++;
      if (l.result && (s.best === null || l.result.margin_db > s.best)) s.best = l.result.margin_db;
    }
  }
  return m;
}

export const hasProblem = (s: NodeStat | undefined, weakBelowDb: number) => !s || s.links === 0 || (s.best !== null && s.best < weakBelowDb);

export function filterNodes(nodes: MeshNode[], stats: Map<string, NodeStat>, f: NodeFilter, sort: NodeSort): MeshNode[] {
  const q = f.query.trim().toLowerCase();
  const list = nodes.filter((n) => {
    if (q && !`${n.letter ?? ""} ${n.name} ${n.notes} ${(n.tags ?? []).join(" ")}`.toLowerCase().includes(q)) return false;
    if (f.status.size > 0 && !f.status.has(n.status)) return false;
    if (f.tag && !(n.tags ?? []).some((t) => t.toLowerCase() === f.tag.toLowerCase())) return false;
    if (f.problems && !hasProblem(stats.get(n.id), f.weakBelowDb)) return false;
    return true;
  });
  const by: Record<NodeSort, (a: MeshNode, b: MeshNode) => number> = {
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
    links: (a, b) => (stats.get(b.id)?.links ?? 0) - (stats.get(a.id)?.links ?? 0),
    height: (a, b) => b.heightM - a.heightM,
    status: (a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name),
    // no links first, then the lowest best margin
    weakest: (a, b) => (stats.get(a.id)?.best ?? -Infinity) - (stats.get(b.id)?.best ?? -Infinity),
  };
  return [...list].sort(by[sort]);
}

export type LinkSort = "weakest" | "distance" | "name";

export interface LinkFilter {
  query: string;
  /** only these classes; empty = all */
  classes: ReadonlySet<LinkClass>;
}

export const NO_LINK_FILTER: LinkFilter = { query: "", classes: new Set() };

const ORDER: Record<LinkClass, number> = { obstructed: 0, marginal: 1, clear: 2, none: 3 };

export function filterLinks(links: Link[], nameOf: (id: string) => string, f: LinkFilter, sort: LinkSort): Link[] {
  const q = f.query.trim().toLowerCase();
  const list = links.filter((l) => {
    if (f.classes.size > 0 && !f.classes.has(l.class)) return false;
    return !q || `${nameOf(l.a)} ${nameOf(l.b)}`.toLowerCase().includes(q);
  });
  const by: Record<LinkSort, (a: Link, b: Link) => number> = {
    weakest: (a, b) => ORDER[a.class] - ORDER[b.class] || (a.result?.margin_db ?? 0) - (b.result?.margin_db ?? 0),
    distance: (a, b) => b.distanceM - a.distanceM,
    name: (a, b) => `${nameOf(a.a)}${nameOf(a.b)}`.localeCompare(`${nameOf(b.a)}${nameOf(b.b)}`, undefined, { numeric: true }),
  };
  return [...list].sort(by[sort]);
}

/** The two directions differ a lot (more than 6 dB): worth a hint about antennas, power or patterns. */
export function asymmetryDb(l: Link): number | null {
  if (!l.result) return null;
  const d = Math.abs(l.result.margin_ab_db - l.result.margin_ba_db);
  return d > 6 ? d : null;
}

/** Every tag used in the project, sorted, with how many nodes carry it. */
export function allTags(nodes: MeshNode[]): { tag: string; count: number }[] {
  const m = new Map<string, { tag: string; count: number }>();
  for (const n of nodes)
    for (const t of n.tags ?? []) {
      const k = t.toLowerCase();
      const e = m.get(k);
      if (e) e.count++;
      else m.set(k, { tag: t, count: 1 });
    }
  return [...m.values()].sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }));
}

/** Add and remove tags on one node (case-insensitive, no duplicates, at most 12). */
export function applyTagOps(node: MeshNode, add: string | null, remove: string | null): string[] | undefined {
  let tags = [...(node.tags ?? [])];
  if (remove) tags = tags.filter((t) => t.toLowerCase() !== remove.toLowerCase());
  const a = add?.trim().slice(0, 40);
  if (a && !tags.some((t) => t.toLowerCase() === a.toLowerCase()) && tags.length < 12) tags.push(a);
  return tags.length ? tags : undefined;
}
