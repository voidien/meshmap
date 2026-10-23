import { getPresets } from "../engine/wasm";
import { Card } from "./Card";
import { LINK_COLORS } from "../map/MapView";
import { AntennaEditor } from "./AntennaEditor";
import type { Link, MeshNode } from "../types";

export interface Connection {
  link: Link;
  other: MeshNode;
}

interface Props {
  node: MeshNode;
  connections: Connection[];
  /** The project's other nodes (to aim a directional antenna at). */
  others: MeshNode[];
  onChange: (patch: Partial<MeshNode>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onZoom: () => void;
  onOpenLink: (key: string) => void;
  onSelectNode: (id: string) => void;
  onReport: () => void;
  reportBusy: boolean;
}

function Num(props: { label: string; value: number; step?: number; unit?: string; min?: number; max?: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>
        {props.label}
        {props.unit ? <em> ({props.unit})</em> : null}
      </span>
      <input
        type="number"
        value={props.value}
        step={props.step ?? 1}
        min={props.min}
        max={props.max}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) props.onChange(v);
        }}
      />
    </label>
  );
}

export function NodePanel({ node, connections, others, onChange, onDelete, onDuplicate, onZoom, onOpenLink, onSelectNode, onReport, reportBusy }: Props) {
  const presets = getPresets();
  return (
    <Card id="node" title={`Node: ${node.name.trim() || "(unnamed)"}`} openWhen={node.id}>
      <label className="field">
        <span>Name</span>
        <input value={node.name} onChange={(e) => onChange({ name: e.target.value })} />
      </label>
      <div className="grid2">
        <Num label="Latitude" value={Number(node.lat.toFixed(6))} step={0.0001} min={-90} max={90} onChange={(v) => onChange({ lat: v })} />
        <Num label="Longitude" value={Number(node.lon.toFixed(6))} step={0.0001} min={-180} max={180} onChange={(v) => onChange({ lon: v })} />
        <Num label="Antenna height AGL" unit="m" value={node.heightM} min={0} step={0.5} onChange={(v) => onChange({ heightM: v })} />
        <Num label="Client height (MeshCore)" unit="m" value={node.clientHeightM} min={0} step={0.5} onChange={(v) => onChange({ clientHeightM: v })} />
        <Num label="TX power" unit="dBm" value={node.txDbm} onChange={(v) => onChange({ txDbm: v })} />
        <Num label="Antenna gain" unit="dBi" value={node.gainDbi} step={0.1} onChange={(v) => onChange({ gainDbi: v })} />
        <Num label="Cable loss" unit="dB" value={node.cableLossDb} min={0} step={0.1} onChange={(v) => onChange({ cableLossDb: v })} />
      </div>
      <AntennaEditor node={node} others={others} onChange={onChange} />
      <label className="field">
        <span>Radio preset</span>
        <select value={node.presetId} onChange={(e) => onChange({ presetId: e.target.value })}>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={node.gateway === true} onChange={(e) => onChange({ gateway: e.target.checked ? true : undefined })} />
        Gateway (connects the mesh to the internet/MQTT)
      </label>
      <label className="field">
        <span>Status</span>
        <select value={node.status} onChange={(e) => onChange({ status: e.target.value as MeshNode["status"] })}>
          <option value="planned">planned</option>
          <option value="installed">installed</option>
        </select>
      </label>
      <label className="field">
        <span>Notes</span>
        <textarea rows={3} value={node.notes} onChange={(e) => onChange({ notes: e.target.value })} />
      </label>
      <h3>Connections ({connections.length})</h3>
      {connections.length === 0 ? <p className="hint">No links within range. Raise the antenna, move closer, or increase the max range.</p> : null}
      <ul className="conns">
        {connections.map(({ link, other }) => (
          <li key={link.key} onClick={() => onOpenLink(link.key)} title="Open terrain profile">
            <span className="dot" style={{ background: LINK_COLORS[link.class] }} />
            <span className="lname">
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onSelectNode(other.id);
                }}
              >
                {other.name.trim() || "(unnamed)"}
              </a>
            </span>
            <span className="lmeta">
              {(link.distanceM / 1000).toFixed(1)} km{link.result ? ` · ${link.result.margin_db.toFixed(1)} dB` : ""}
            </span>
          </li>
        ))}
      </ul>
      <div className="row-actions">
        <button onClick={onZoom}>Zoom to</button>
        <button id="site-report-btn" onClick={onReport} disabled={reportBusy} title="A printable one-page summary of this site">
          {reportBusy ? "Preparing…" : "Site report"}
        </button>
        <button onClick={onDuplicate} title="Copy this node (placed ~100 m away)">
          Duplicate
        </button>
        <button className="danger" onClick={onDelete}>
          Delete node
        </button>
      </div>
    </Card>
  );
}
