import { useContext, useMemo, useState } from "react";
import { LINK_COLORS } from "../map/MapView";
import { Card, PanelMode } from "./Card";
import { VirtualList } from "../ui/VirtualList";
import { asymmetryDb, filterLinks, NO_LINK_FILTER, type LinkFilter, type LinkSort } from "../listFilters";
import type { Link, LinkClass, MeshNode } from "../types";

interface Props {
  nodes: MeshNode[];
  links: Link[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

const CLASSES: LinkClass[] = ["obstructed", "marginal", "clear"];

export function LinkList({ nodes, links, selectedKey, onSelect }: Props) {
  const flat = useContext(PanelMode) === "flat";
  const [filter, setFilter] = useState<LinkFilter>(NO_LINK_FILTER);
  const [sort, setSort] = useState<LinkSort>("weakest");
  const name = useMemo(() => new Map(nodes.map((n) => [n.id, n.name])), [nodes]);
  const visible = useMemo(() => filterLinks(links, (id) => name.get(id) ?? id, filter, sort), [links, name, filter, sort]);
  const filtering = filter.query.trim() !== "" || filter.classes.size > 0;
  const toggle = (c: LinkClass) => setFilter((x) => ({ ...x, classes: new Set(x.classes.has(c) ? [...x.classes].filter((v) => v !== c) : [...x.classes, c]) }));
  return (
    <Card id="links" title={`Links (${links.length})`}>
      {links.length > 0 ? (
        <>
          <div className="nodes-tools">
            <input placeholder="Search by node name…" value={filter.query} onChange={(e) => setFilter({ ...filter, query: e.target.value })} aria-label="Search links" />
            <select value={sort} onChange={(e) => setSort(e.target.value as LinkSort)} aria-label="Sort links">
              <option value="weakest">Weakest first</option>
              <option value="distance">Longest first</option>
              <option value="name">Name</option>
            </select>
          </div>
          <div className="chips-row" aria-label="Filters">
            {CLASSES.map((c) => (
              <button key={c} className={`chip${filter.classes.has(c) ? " on" : ""}`} aria-pressed={filter.classes.has(c)} onClick={() => toggle(c)}>
                {c}
              </button>
            ))}
            {filtering ? (
              <button className="chip" onClick={() => setFilter(NO_LINK_FILTER)}>
                clear filters
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="hint">Add two or more nodes within range to see links.</p>
      )}
      {filtering ? <p className="lmeta">{visible.length} of {links.length} shown</p> : null}
      <VirtualList
        items={visible}
        rowHeight={30}
        maxHeight={260}
        fill={flat}
        className="links"
        ariaLabel="Links"
        keyOf={(l) => l.key}
        rowClass={(l) => (l.key === selectedKey ? "sel" : "")}
        onRowClick={(l) => onSelect(l.key)}
        row={(l) => {
          const asym = asymmetryDb(l);
          return (
            <>
              <span className="dot" style={{ background: LINK_COLORS[l.class] }} />
              <span className="lname" title={asym ? `The two directions differ by ${asym.toFixed(0)} dB` : undefined}>
                {name.get(l.a)} – {name.get(l.b)}
                {asym ? <span className="asym"> ⇄ {asym.toFixed(0)} dB apart</span> : null}
              </span>
              <span className="lmeta">
                {(l.distanceM / 1000).toFixed(1)} km{l.result ? ` · ${l.result.margin_db.toFixed(1)} dB` : ""}
              </span>
            </>
          );
        }}
      />
    </Card>
  );
}
