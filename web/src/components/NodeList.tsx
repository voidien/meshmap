import { useContext, useMemo, useState } from "react";
import { Card, PanelMode } from "./Card";
import { SelectionTray } from "./SelectionTray";
import { VirtualList } from "../ui/VirtualList";
import { allTags, filterNodes, NO_NODE_FILTER, nodeStats, type NodeFilter, type NodeSort } from "../listFilters";
import type { Network } from "../networks";
import type { Link, MeshNode } from "../types";

interface Props {
  nodes: MeshNode[];
  links: Link[];
  focusId: string | null;
  network: Network;
  checked: ReadonlySet<string>;
  /** below this much spare signal a node counts as weak (the project's "good link" figure) */
  weakBelowDb: number;
  /** show the edit tray for ticked nodes under the list (the new layout shows it in the details panel instead) */
  showTray?: boolean;
  readOnly?: boolean;
  onFocus: (id: string) => void;
  onToggle: (id: string) => void;
  onSetChecked: (ids: string[]) => void;
  onBulk: (ids: string[], patch: Partial<MeshNode>) => void;
  onTags: (ids: string[], add: string | null, remove: string | null) => void;
  onDeleteMany: (ids: string[]) => void;
  onAddAt: (lat: number, lon: number, name: string) => void;
}

/** "36.15, -85.43" or "36.15 -85.43" -> [lat, lon] */
export function parseCoords(text: string): [number, number] | null {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}

export function NodeList(p: Props) {
  const flat = useContext(PanelMode) === "flat";
  const [filter, setFilter] = useState<NodeFilter>({ ...NO_NODE_FILTER, weakBelowDb: p.weakBelowDb });
  const [sort, setSort] = useState<NodeSort>("name");
  const [coords, setCoords] = useState("");
  const [newName, setNewName] = useState("");

  const stats = useMemo(() => nodeStats(p.nodes, p.links), [p.nodes, p.links]);
  const f = useMemo(() => ({ ...filter, weakBelowDb: p.weakBelowDb }), [filter, p.weakBelowDb]);
  const visible = useMemo(() => filterNodes(p.nodes, stats, f, sort), [p.nodes, stats, f, sort]);
  const tags = useMemo(() => allTags(p.nodes), [p.nodes]);
  const filtering = f.query.trim() !== "" || f.status.size > 0 || f.tag !== "" || f.problems;

  const checkedIds = p.nodes.filter((n) => p.checked.has(n.id)).map((n) => n.id);
  const allVisibleChecked = visible.length > 0 && visible.every((n) => p.checked.has(n.id));
  const toggleStatus = (s: string) => setFilter((x) => ({ ...x, status: new Set(x.status.has(s) ? [...x.status].filter((v) => v !== s) : [...x.status, s]) }));

  const parsed = parseCoords(coords);
  return (
    <Card id="nodes" title={`Nodes (${p.nodes.length})${checkedIds.length ? ` · ${checkedIds.length} ticked` : ""}`}>
      <div className="nodes-tools">
        <input placeholder="Search name, notes or tag…" value={filter.query} onChange={(e) => setFilter({ ...filter, query: e.target.value })} aria-label="Search nodes" />
        <select value={sort} onChange={(e) => setSort(e.target.value as NodeSort)} aria-label="Sort nodes">
          <option value="name">Name</option>
          <option value="weakest">Weakest first</option>
          <option value="links">Most links</option>
          <option value="height">Tallest</option>
          <option value="status">Status</option>
        </select>
      </div>
      {p.nodes.length > 0 ? (
        <div className="chips-row" aria-label="Filters">
          {["planned", "installed"].map((s) => (
            <button key={s} className={`chip${filter.status.has(s) ? " on" : ""}`} aria-pressed={filter.status.has(s)} onClick={() => toggleStatus(s)}>
              {s}
            </button>
          ))}
          <button className={`chip${filter.problems ? " on" : ""}`} aria-pressed={filter.problems} title="No link, or a best link weaker than the project's good-link figure" onClick={() => setFilter({ ...filter, problems: !filter.problems })}>
            problems
          </button>
          {tags.length > 0 ? (
            <select className="chip" value={filter.tag} aria-label="Filter by tag" onChange={(e) => setFilter({ ...filter, tag: e.target.value })}>
              <option value="">any tag</option>
              {tags.map((t) => (
                <option key={t.tag} value={t.tag}>
                  {t.tag} ({t.count})
                </option>
              ))}
            </select>
          ) : null}
          {filtering ? (
            <button className="chip" onClick={() => setFilter({ ...NO_NODE_FILTER, weakBelowDb: p.weakBelowDb })}>
              clear filters
            </button>
          ) : null}
        </div>
      ) : null}
      {p.nodes.length === 0 ? <p className="hint">No nodes yet. Use “+ Add node” on the map, add by coordinates below, or import a file.</p> : null}
      {p.nodes.length > 0 ? (
        <label className="check">
          <input type="checkbox" checked={allVisibleChecked} onChange={() => p.onSetChecked(allVisibleChecked ? [] : visible.map((n) => n.id))} />
          Tick {filtering ? "matching" : "all"} ({visible.length}{filtering ? ` of ${p.nodes.length}` : ""})
        </label>
      ) : null}
      {visible.length === 0 && p.nodes.length > 0 ? <p className="hint">No node matches these filters.</p> : null}
      <VirtualList
        items={visible}
        rowHeight={30}
        maxHeight={280}
        fill={flat}
        className="nodelist"
        ariaLabel="Nodes"
        keyOf={(n) => n.id}
        rowClass={(n) => (n.id === p.focusId ? "sel" : "")}
        onRowClick={(n) => p.onFocus(n.id)}
        row={(n) => {
          const s = stats.get(n.id);
          return (
            <>
              <input type="checkbox" checked={p.checked.has(n.id)} onClick={(e) => e.stopPropagation()} onChange={() => p.onToggle(n.id)} aria-label={`Tick ${n.name}`} />
              <span className={`sdot ${n.status}`} title={n.status} />
              <span className="nname" title={(n.tags ?? []).join(", ")}>
                {n.letter ? <span className="letter">{n.letter}</span> : null}
                {n.name.trim() || "(unnamed)"}
              </span>
              <span className="lmeta">
                {s?.links ?? 0} link{s?.links === 1 ? "" : "s"}
                {s?.best != null ? ` · ${s.best.toFixed(0)} dB` : ""}
              </span>
            </>
          );
        }}
      />

      {checkedIds.length > 0 && p.showTray !== false ? (
        <SelectionTray nodes={p.nodes} ids={checkedIds} network={p.network} onBulk={p.onBulk} onTags={p.onTags} onSetChecked={p.onSetChecked} onDelete={p.onDeleteMany} readOnly={!!p.readOnly} />
      ) : null}

      <details className="bulk">
        <summary>Add a node by coordinates</summary>
        <label className="field">
          <span>Latitude, longitude</span>
          <input placeholder="36.1507, -85.4376" value={coords} onChange={(e) => setCoords(e.target.value)} />
        </label>
        <label className="field">
          <span>Name (optional)</span>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} />
        </label>
        <button
          disabled={!parsed}
          onClick={() => {
            if (!parsed) return;
            p.onAddAt(parsed[0], parsed[1], newName.trim());
            setCoords("");
            setNewName("");
          }}
        >
          Add node
        </button>
        {coords && !parsed ? <p className="hint err">Enter “latitude, longitude” in decimal degrees.</p> : null}
      </details>
    </Card>
  );
}
