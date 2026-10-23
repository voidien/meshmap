import { LINK_COLORS } from "../map/MapView";
import { Card } from "./Card";
import type { Link, MeshNode } from "../types";

interface Props {
  nodes: MeshNode[];
  links: Link[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

const ORDER = { obstructed: 0, marginal: 1, clear: 2, none: 3 } as const;

export function LinkList({ nodes, links, selectedKey, onSelect }: Props) {
  const name = new Map(nodes.map((n) => [n.id, n.name]));
  const sorted = [...links].sort(
    (a, b) => ORDER[a.class] - ORDER[b.class] || (a.result?.margin_db ?? 0) - (b.result?.margin_db ?? 0),
  );
  return (
    <Card id="links" title={`Links (${links.length})`}>
      {sorted.length === 0 ? <p className="hint">Add two or more nodes within range to see links.</p> : null}
      <ul className="links">
        {sorted.map((l) => (
          <li key={l.key} className={l.key === selectedKey ? "sel" : ""} onClick={() => onSelect(l.key)}>
            <span className="dot" style={{ background: LINK_COLORS[l.class] }} />
            <span className="lname">
              {name.get(l.a)} – {name.get(l.b)}
            </span>
            <span className="lmeta">
              {(l.distanceM / 1000).toFixed(1)} km{l.result ? ` · ${l.result.margin_db.toFixed(1)} dB` : ""}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
