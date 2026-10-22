import { getPresets } from "../engine/wasm";
import type { MeshNode } from "../types";

interface Props {
  node: MeshNode;
  onChange: (patch: Partial<MeshNode>) => void;
  onDelete: () => void;
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

export function NodePanel({ node, onChange, onDelete }: Props) {
  const presets = getPresets();
  return (
    <section className="card">
      <h3>Node</h3>
      <label className="field">
        <span>Name</span>
        <input value={node.name} onChange={(e) => onChange({ name: e.target.value })} />
      </label>
      <div className="grid2">
        <Num label="Latitude" value={Number(node.lat.toFixed(6))} step={0.0001} min={-90} max={90} onChange={(v) => onChange({ lat: v })} />
        <Num label="Longitude" value={Number(node.lon.toFixed(6))} step={0.0001} min={-180} max={180} onChange={(v) => onChange({ lon: v })} />
        <Num label="Antenna height AGL" unit="m" value={node.heightM} min={0} step={0.5} onChange={(v) => onChange({ heightM: v })} />
        <Num label="TX power" unit="dBm" value={node.txDbm} onChange={(v) => onChange({ txDbm: v })} />
        <Num label="Antenna gain" unit="dBi" value={node.gainDbi} step={0.1} onChange={(v) => onChange({ gainDbi: v })} />
        <Num label="Cable loss" unit="dB" value={node.cableLossDb} min={0} step={0.1} onChange={(v) => onChange({ cableLossDb: v })} />
      </div>
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
      <button className="danger" onClick={onDelete}>
        Delete node
      </button>
    </section>
  );
}
