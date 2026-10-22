import type { Link, LinkClass, MeshNode } from "./types";

/** Nodes are the "same" across setups when they share a MeshCore letter, else the same name. */
export function matchKey(n: MeshNode): string {
  return n.letter ? `L:${n.letter}` : `N:${n.name.trim().toLowerCase()}`;
}

type DistFn = (lat1: number, lon1: number, lat2: number, lon2: number) => number;

export interface NodeDiff {
  added: MeshNode[];
  removed: MeshNode[];
  moved: { cur: MeshNode; other: MeshNode; distM: number }[];
  changed: { cur: MeshNode; other: MeshNode; fields: string[] }[];
}

const FIELDS: [keyof MeshNode, string][] = [
  ["heightM", "antenna height"],
  ["clientHeightM", "client height"],
  ["txDbm", "TX power"],
  ["gainDbi", "gain"],
  ["cableLossDb", "cable loss"],
  ["presetId", "preset"],
  ["status", "status"],
];

/** Differences going from `other` (the baseline) to `cur` (the open project). */
export function diffNodes(cur: MeshNode[], other: MeshNode[], dist: DistFn, movedThresholdM = 10): NodeDiff {
  const o = new Map(other.map((n) => [matchKey(n), n]));
  const c = new Map(cur.map((n) => [matchKey(n), n]));
  const out: NodeDiff = { added: [], removed: [], moved: [], changed: [] };
  for (const [k, n] of c) {
    const m = o.get(k);
    if (!m) {
      out.added.push(n);
      continue;
    }
    const d = dist(m.lat, m.lon, n.lat, n.lon);
    if (d > movedThresholdM) out.moved.push({ cur: n, other: m, distM: d });
    const fields = FIELDS.filter(([f]) => n[f] !== m[f]).map(([, label]) => label);
    if (fields.length) out.changed.push({ cur: n, other: m, fields });
  }
  for (const [k, n] of o) if (!c.has(k)) out.removed.push(n);
  return out;
}

export type ClassOrAbsent = LinkClass | "absent";

export interface LinkChange {
  a: string;
  b: string;
  from: ClassOrAbsent;
  to: ClassOrAbsent;
  marginFrom?: number;
  marginTo?: number;
  /** >0 improved, <0 worsened */
  delta: number;
}

const RANK: Record<ClassOrAbsent, number> = { clear: 3, marginal: 2, obstructed: 1, none: 0, absent: 0 };

/** Link class changes between setups, linking nodes by [`matchKey`]. Links classed `none` count as absent. */
export function diffLinks(curNodes: MeshNode[], curLinks: Link[], otherNodes: MeshNode[], otherLinks: Link[]): LinkChange[] {
  const index = (nodes: MeshNode[], links: Link[]) => {
    const key = new Map(nodes.map((n) => [n.id, matchKey(n)]));
    const name = new Map(nodes.map((n) => [matchKey(n), n.name]));
    const out = new Map<string, Link>();
    for (const l of links) {
      if (l.class === "none") continue;
      const ka = key.get(l.a);
      const kb = key.get(l.b);
      if (ka && kb) out.set(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`, l);
    }
    return { out, name };
  };
  const cur = index(curNodes, curLinks);
  const oth = index(otherNodes, otherLinks);
  const changes: LinkChange[] = [];
  for (const k of new Set([...cur.out.keys(), ...oth.out.keys()])) {
    const c = cur.out.get(k);
    const o = oth.out.get(k);
    const from: ClassOrAbsent = o?.class ?? "absent";
    const to: ClassOrAbsent = c?.class ?? "absent";
    if (from === to) continue;
    const [ka, kb] = k.split("|");
    const nm = (key: string) => cur.name.get(key) ?? oth.name.get(key) ?? key;
    changes.push({
      a: nm(ka),
      b: nm(kb),
      from,
      to,
      marginFrom: o?.result?.margin_db,
      marginTo: c?.result?.margin_db,
      delta: RANK[to] - RANK[from],
    });
  }
  return changes.sort((x, y) => x.delta - y.delta || x.a.localeCompare(y.a));
}

export interface Summary {
  nodes: number;
  links: number;
  clear: number;
  marginal: number;
  obstructed: number;
  avgMarginDb: number | null;
}

export function summarize(nodes: MeshNode[], links: Link[]): Summary {
  const s: Summary = { nodes: nodes.length, links: 0, clear: 0, marginal: 0, obstructed: 0, avgMarginDb: null };
  let sum = 0;
  let n = 0;
  for (const l of links) {
    if (l.class === "none") continue;
    s.links++;
    s[l.class]++;
    if (l.result) {
      sum += l.result.margin_db;
      n++;
    }
  }
  s.avgMarginDb = n ? sum / n : null;
  return s;
}
