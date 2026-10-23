/** What restoring an earlier version would change, in terms a person can check before confirming. */
import type { MeshNode, Settings } from "./types";

export interface VersionDiff {
  /** in the version but not in the project now: would come back */
  returning: string[];
  /** in the project now but not in the version: would disappear */
  disappearing: string[];
  /** same node, different position (more than ~5 m) */
  moved: string[];
  /** same node, other settings differ (name, mast height, power, radio, antenna, notes...) */
  changed: string[];
  settingsChanged: boolean;
}

const label = (n: MeshNode) => n.name.trim() || "(unnamed)";

function metres(a: MeshNode, b: MeshNode): number {
  const dLat = (a.lat - b.lat) * 111_195;
  const dLon = (a.lon - b.lon) * 111_195 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffVersion(current: { nodes: MeshNode[]; settings: Settings }, version: { nodes: MeshNode[]; settings: Settings }): VersionDiff {
  const now = new Map(current.nodes.map((n) => [n.id, n]));
  const then = new Map(version.nodes.map((n) => [n.id, n]));
  const out: VersionDiff = { returning: [], disappearing: [], moved: [], changed: [], settingsChanged: !same(current.settings, version.settings) };
  for (const [id, n] of then) {
    const c = now.get(id);
    if (!c) {
      out.returning.push(label(n));
      continue;
    }
    if (metres(c, n) > 5) out.moved.push(label(n));
    const { lat: _a, lon: _b, ...restNow } = c;
    const { lat: _c, lon: _d, ...restThen } = n;
    if (!same(restNow, restThen)) out.changed.push(label(n));
  }
  for (const [id, n] of now) if (!then.has(id)) out.disappearing.push(label(n));
  return out;
}

const list = (names: string[]) => (names.length > 4 ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more` : names.join(", "));

/** One line per kind of change; empty when the version is identical to the project. */
export function describeDiff(d: VersionDiff): string[] {
  const lines: string[] = [];
  if (d.returning.length) lines.push(`${d.returning.length} node${d.returning.length === 1 ? " comes" : "s come"} back: ${list(d.returning)}`);
  if (d.disappearing.length) lines.push(`${d.disappearing.length} node${d.disappearing.length === 1 ? "" : "s"} added since ${d.disappearing.length === 1 ? "goes" : "go"} away: ${list(d.disappearing)}`);
  if (d.moved.length) lines.push(`${d.moved.length} moved back: ${list(d.moved)}`);
  if (d.changed.length) lines.push(`${d.changed.length} get their old settings: ${list(d.changed)}`);
  if (d.settingsChanged) lines.push("project settings go back too");
  return lines;
}
