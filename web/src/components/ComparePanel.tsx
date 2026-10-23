import { LINK_COLORS } from "../map/MapView";
import { Card } from "./Card";
import { diffLinks, diffNodes, summarize } from "../compare";
import { wasm } from "../engine/wasm";
import type { Link, MeshNode, Project } from "../types";

interface Props {
  current: Project;
  currentLinks: Link[];
  projects: Project[];
  otherId: string | null;
  otherLinks: Link[];
  busy: boolean;
  onChange: (id: string | null) => void;
}

const dist = (a: number, b: number, c: number, d: number) => wasm.haversine_m(a, b, c, d);

export function ComparePanel({ current, currentLinks, projects, otherId, otherLinks, busy, onChange }: Props) {
  const other = otherId ? projects.find((p) => p.id === otherId) ?? null : null;
  return (
    <Card id="compare" title="Compare setups" openWhen={other?.id}>
      <label className="field">
        <span>Compare the open project with</span>
        <select value={otherId ?? ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">(nothing)</option>
          {projects.filter((p) => p.id !== current.id).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {other ? <Body current={current} currentLinks={currentLinks} other={other} otherLinks={otherLinks} busy={busy} /> : <p className="hint">Pick another project to draw it faintly on the map (dashed lines, grey dots) and see what changed.</p>}
    </Card>
  );
}

function Body({ current, currentLinks, other, otherLinks, busy }: { current: Project; currentLinks: Link[]; other: Project; otherLinks: Link[]; busy: boolean }) {
  const a = summarize(current.nodes, currentLinks);
  const b = summarize(other.nodes, otherLinks);
  const nd = diffNodes(current.nodes, other.nodes, dist);
  const ld = diffLinks(current.nodes, currentLinks, other.nodes, otherLinks);
  const d = (x: number, y: number, digits = 0) => {
    const v = x - y;
    return v === 0 ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
  };
  const names = (ns: MeshNode[]) => ns.map((n) => n.name.trim() || n.letter || "?").join(", ");
  const cls = (c: string) => (c === "absent" ? "no link" : c);
  const dot = (c: string) => <span className="dot" style={{ background: c === "absent" ? "#d1d5db" : LINK_COLORS[c as keyof typeof LINK_COLORS] }} />;

  return (
    <div className="compare">
      {busy ? <p className="hint">Analysing the other project…</p> : null}
      <table className="budget">
        <thead>
          <tr><th></th><th>Open</th><th>Other</th><th>Δ</th></tr>
        </thead>
        <tbody>
          <tr><th>Nodes</th><td>{a.nodes}</td><td>{b.nodes}</td><td>{d(a.nodes, b.nodes)}</td></tr>
          <tr><th>Links</th><td>{a.links}</td><td>{b.links}</td><td>{d(a.links, b.links)}</td></tr>
          <tr><th>Clear</th><td>{a.clear}</td><td>{b.clear}</td><td>{d(a.clear, b.clear)}</td></tr>
          <tr><th>Marginal</th><td>{a.marginal}</td><td>{b.marginal}</td><td>{d(a.marginal, b.marginal)}</td></tr>
          <tr><th>Obstructed</th><td>{a.obstructed}</td><td>{b.obstructed}</td><td>{d(a.obstructed, b.obstructed)}</td></tr>
          <tr>
            <th>Avg margin</th>
            <td>{a.avgMarginDb === null ? "–" : `${a.avgMarginDb.toFixed(1)} dB`}</td>
            <td>{b.avgMarginDb === null ? "–" : `${b.avgMarginDb.toFixed(1)} dB`}</td>
            <td>{a.avgMarginDb === null || b.avgMarginDb === null ? "–" : d(a.avgMarginDb, b.avgMarginDb, 1)}</td>
          </tr>
        </tbody>
      </table>

      <h4>Nodes (other → open)</h4>
      <ul className="difflist">
        {nd.added.length ? <li><b>Added:</b> {names(nd.added)}</li> : null}
        {nd.removed.length ? <li><b>Removed:</b> {names(nd.removed)}</li> : null}
        {nd.moved.map((m) => <li key={`m${m.cur.id}`}><b>Moved:</b> {m.cur.name.trim() || m.cur.letter} {(m.distM / 1000).toFixed(2)} km</li>)}
        {nd.changed.map((c) => <li key={`c${c.cur.id}`}><b>Changed:</b> {c.cur.name.trim() || c.cur.letter} – {c.fields.join(", ")}</li>)}
        {!nd.added.length && !nd.removed.length && !nd.moved.length && !nd.changed.length ? <li>No node differences.</li> : null}
      </ul>
      <p className="hint">Nodes are matched by MeshCore letter, otherwise by name.</p>

      <h4>Link changes ({ld.length})</h4>
      <ul className="difflist">
        {ld.slice(0, 40).map((c) => (
          <li key={`${c.a}|${c.b}`}>
            {dot(c.from)}
            <span className="arrow">→</span>
            {dot(c.to)}
            <span className="lname">{c.a} – {c.b}</span>
            <span className="lmeta">{cls(c.from)} → {cls(c.to)}{c.marginFrom !== undefined && c.marginTo !== undefined ? ` (${c.marginFrom.toFixed(0)} → ${c.marginTo.toFixed(0)} dB)` : ""}</span>
          </li>
        ))}
        {ld.length === 0 ? <li>No links changed class.</li> : null}
        {ld.length > 40 ? <li>…and {ld.length - 40} more</li> : null}
      </ul>
    </div>
  );
}
