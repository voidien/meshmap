import { useRef, useState } from "react";
import { describeAntenna, parsePatternFile, polarPoints } from "../antenna";
import { wasm } from "../engine/wasm";
import type { AntennaPattern, MeshNode } from "../types";

interface Props {
  node: MeshNode;
  others: MeshNode[];
  onChange: (patch: Partial<MeshNode>) => void;
}

const SIZE = 150;

/** Small polar plot: north up, rim = peak gain, centre = 30 dB down. */
export function PolarPlot({ pattern, size = SIZE }: { pattern: AntennaPattern | undefined; size?: number }) {
  const r = size / 2 - 8;
  const c = size / 2;
  const pts = polarPoints(pattern, r).map(([x, y]) => `${(c + x).toFixed(1)},${(c + y).toFixed(1)}`);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label="Antenna pattern, north up" className="polar">
      {[1, 2 / 3, 1 / 3].map((f) => (
        <circle key={f} cx={c} cy={c} r={r * f} fill="none" stroke="currentColor" opacity={0.18} />
      ))}
      <line x1={c} y1={c - r} x2={c} y2={c + r} stroke="currentColor" opacity={0.18} />
      <line x1={c - r} y1={c} x2={c + r} y2={c} stroke="currentColor" opacity={0.18} />
      <polygon points={pts.join(" ")} fill="#2457d6" fillOpacity={0.25} stroke="#2457d6" strokeWidth={1.5} />
      <text x={c} y={9} textAnchor="middle" fontSize={9} fill="currentColor">N</text>
    </svg>
  );
}

/** Choose and shape a node's antenna pattern. */
export function AntennaEditor({ node, others, onChange }: Props) {
  const a = node.antenna;
  const kind = a?.kind ?? "omni";
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const set = (antenna: AntennaPattern | undefined) => onChange({ antenna });
  const setKind = (k: string) => {
    setError(null);
    if (k === "omni") set(undefined);
    else if (k === "directional") set(a?.kind === "directional" ? a : { kind: "directional", azimuthDeg: a && a.kind === "table" ? a.azimuthDeg : 0, beamwidthDeg: 65, frontToBackDb: 20 });
    else file.current?.click();
  };

  const importFile = async (f: File) => {
    setError(null);
    try {
      const parsed = parsePatternFile(await f.text(), f.name);
      set({ kind: "table", azimuthDeg: a && a.kind !== "omni" ? a.azimuthDeg : 0, gainsDb: parsed.gainsDb });
      if (parsed.peakGainDbi !== undefined) onChange({ gainDbi: Number(parsed.peakGainDbi.toFixed(2)) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const aim = (id: string) => {
    const t = others.find((o) => o.id === id);
    if (!t || !a || a.kind === "omni") return;
    const b = wasm.bearing_deg(node.lat, node.lon, t.lat, t.lon);
    set({ ...a, azimuthDeg: Math.round(b * 10) / 10 });
  };

  return (
    <div className="antenna">
      <label className="field">
        <span>Antenna pattern</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="omni">Omnidirectional</option>
          <option value="directional">Directional (yagi, panel, sector)</option>
          <option value="table">{kind === "table" ? "Imported pattern file" : "Import a pattern file…"}</option>
        </select>
      </label>
      <input
        ref={file}
        type="file"
        accept=".msi,.pln,.csv,.txt,text/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void importFile(f);
        }}
      />
      {a && a.kind !== "omni" ? (
        <div className="grid2">
          <label className="field">
            <span>
              Points toward <em>(° from north)</em>
            </span>
            <input type="number" min={0} max={360} step={1} value={Number(a.azimuthDeg.toFixed(1))} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && set({ ...a, azimuthDeg: ((e.target.valueAsNumber % 360) + 360) % 360 })} />
          </label>
          <label className="field">
            <span>Aim at node</span>
            <select value="" onChange={(e) => aim(e.target.value)}>
              <option value="">choose…</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name.trim() || "(unnamed)"}
                </option>
              ))}
            </select>
          </label>
          {a.kind === "directional" ? (
            <>
              <label className="field">
                <span>
                  Beamwidth <em>(° at −3 dB)</em>
                </span>
                <input type="number" min={1} max={360} step={5} value={a.beamwidthDeg} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && set({ ...a, beamwidthDeg: Math.min(360, Math.max(1, e.target.valueAsNumber)) })} />
              </label>
              <label className="field">
                <span>
                  Front-to-back <em>(dB)</em>
                </span>
                <input type="number" min={0} max={60} step={1} value={a.frontToBackDb} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && set({ ...a, frontToBackDb: Math.min(60, Math.max(0, e.target.valueAsNumber)) })} />
              </label>
            </>
          ) : null}
        </div>
      ) : null}
      {a && a.kind !== "omni" ? (
        <div className="polarrow">
          <PolarPlot pattern={a} />
          <p className="hint">
            {describeAntenna(a, node.gainDbi)}. “Antenna gain” above is the peak; every link and heatmap uses the gain in the direction it points.
            Horizontal plane only (no vertical beamwidth or tilt).
          </p>
        </div>
      ) : null}
      {error ? <p className="err">{error}</p> : null}
    </div>
  );
}
