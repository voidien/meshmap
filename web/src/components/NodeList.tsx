import { useMemo, useState } from "react";
import { Card } from "./Card";
import { getPresets } from "../engine/wasm";
import type { Link, MeshNode, NodeStatus } from "../types";

interface Props {
  nodes: MeshNode[];
  links: Link[];
  focusId: string | null;
  checked: ReadonlySet<string>;
  onFocus: (id: string) => void;
  onToggle: (id: string) => void;
  onSetChecked: (ids: string[]) => void;
  onBulk: (ids: string[], patch: Partial<MeshNode>) => void;
  onDeleteMany: (ids: string[]) => void;
  onAddAt: (lat: number, lon: number, name: string) => void;
}

type SortKey = "name" | "links" | "height" | "status";

/** "36.15, -85.43" or "36.15 -85.43" -> [lat, lon] */
export function parseCoords(text: string): [number, number] | null {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}

export function NodeList(p: Props) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("name");
  const [coords, setCoords] = useState("");
  const [newName, setNewName] = useState("");
  const [bulk, setBulk] = useState({ heightM: "", clientHeightM: "", txDbm: "", gainDbi: "", cableLossDb: "", presetId: "", status: "" });
  const presets = getPresets();

  const stats = useMemo(() => {
    const m = new Map<string, { links: number; best: number | null }>();
    for (const n of p.nodes) m.set(n.id, { links: 0, best: null });
    for (const l of p.links) {
      if (l.class === "none") continue;
      for (const id of [l.a, l.b]) {
        const s = m.get(id);
        if (!s) continue;
        s.links++;
        if (l.result && (s.best === null || l.result.margin_db > s.best)) s.best = l.result.margin_db;
      }
    }
    return m;
  }, [p.nodes, p.links]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = p.nodes.filter((n) => !q || `${n.letter ?? ""} ${n.name} ${n.notes}`.toLowerCase().includes(q));
    const by: Record<SortKey, (a: MeshNode, b: MeshNode) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      links: (a, b) => (stats.get(b.id)?.links ?? 0) - (stats.get(a.id)?.links ?? 0),
      height: (a, b) => b.heightM - a.heightM,
      status: (a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name),
    };
    return [...list].sort(by[sort]);
  }, [p.nodes, query, sort, stats]);

  const checkedIds = p.nodes.filter((n) => p.checked.has(n.id)).map((n) => n.id);
  const allVisibleChecked = visible.length > 0 && visible.every((n) => p.checked.has(n.id));

  const applyBulk = () => {
    const patch: Partial<MeshNode> = {};
    for (const k of ["heightM", "clientHeightM", "txDbm", "gainDbi", "cableLossDb"] as const) {
      const v = parseFloat(bulk[k]);
      if (bulk[k].trim() !== "" && Number.isFinite(v)) patch[k] = v;
    }
    if (bulk.presetId) patch.presetId = bulk.presetId;
    if (bulk.status) patch.status = bulk.status as NodeStatus;
    if (Object.keys(patch).length === 0) return;
    p.onBulk(checkedIds, patch);
    setBulk({ heightM: "", clientHeightM: "", txDbm: "", gainDbi: "", cableLossDb: "", presetId: "", status: "" });
  };

  const parsed = parseCoords(coords);
  const field = (k: "heightM" | "clientHeightM" | "txDbm" | "gainDbi" | "cableLossDb", label: string) => (
    <label className="field">
      <span>{label}</span>
      <input type="number" step="0.5" placeholder="–" value={bulk[k]} onChange={(e) => setBulk({ ...bulk, [k]: e.target.value })} />
    </label>
  );

  return (
    <Card id="nodes" title={`Nodes (${p.nodes.length})${checkedIds.length ? ` · ${checkedIds.length} ticked` : ""}`}>
      <div className="nodes-tools">
        <input placeholder="Search name or notes…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search nodes" />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort nodes">
          <option value="name">Name</option>
          <option value="links">Most links</option>
          <option value="height">Tallest</option>
          <option value="status">Status</option>
        </select>
      </div>
      {p.nodes.length === 0 ? <p className="hint">No nodes yet. Use “+ Add node” on the map, add by coordinates below, or import a file.</p> : null}
      {p.nodes.length > 0 ? (
        <label className="check">
          <input type="checkbox" checked={allVisibleChecked} onChange={() => p.onSetChecked(allVisibleChecked ? [] : visible.map((n) => n.id))} />
          Tick {query ? "matching" : "all"} ({visible.length})
        </label>
      ) : null}
      <ul className="nodelist">
        {visible.map((n) => {
          const s = stats.get(n.id);
          return (
            <li key={n.id} className={n.id === p.focusId ? "sel" : ""} onClick={() => p.onFocus(n.id)}>
              <input type="checkbox" checked={p.checked.has(n.id)} onClick={(e) => e.stopPropagation()} onChange={() => p.onToggle(n.id)} aria-label={`Tick ${n.name}`} />
              <span className={`sdot ${n.status}`} title={n.status} />
              <span className="nname">
                {n.letter ? <span className="letter">{n.letter}</span> : null}
                {n.name.trim() || "(unnamed)"}
              </span>
              <span className="lmeta">
                {s?.links ?? 0} link{s?.links === 1 ? "" : "s"}
                {s?.best != null ? ` · ${s.best.toFixed(0)} dB` : ""}
              </span>
            </li>
          );
        })}
      </ul>

      {checkedIds.length > 0 ? (
        <div className="bulk">
          <strong>Edit {checkedIds.length} ticked node{checkedIds.length === 1 ? "" : "s"}</strong>
          <p className="hint">Only fields you fill in are changed.</p>
          <div className="grid3">
            {field("heightM", "Height (m)")}
            {field("clientHeightM", "Client h. (m)")}
            {field("txDbm", "TX (dBm)")}
            {field("gainDbi", "Gain (dBi)")}
            {field("cableLossDb", "Cable (dB)")}
          </div>
          <div className="grid2">
            <label className="field">
              <span>Preset</span>
              <select value={bulk.presetId} onChange={(e) => setBulk({ ...bulk, presetId: e.target.value })}>
                <option value="">(unchanged)</option>
                {presets.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Status</span>
              <select value={bulk.status} onChange={(e) => setBulk({ ...bulk, status: e.target.value })}>
                <option value="">(unchanged)</option>
                <option value="planned">planned</option>
                <option value="installed">installed</option>
              </select>
            </label>
          </div>
          <div className="row-actions">
            <button onClick={applyBulk}>Apply</button>
            <button onClick={() => p.onSetChecked([])}>Untick all</button>
            <button className="danger" onClick={() => p.onDeleteMany(checkedIds)}>
              Delete {checkedIds.length}
            </button>
          </div>
        </div>
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
