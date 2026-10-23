import { useState } from "react";
import { api } from "../api";
import { fitFoliageScale, type CalPoint, type Fit, type Skipped } from "../calibrate";
import type { FieldReading } from "../collab";
import { predictAt } from "../engine/fieldPredict";
import { LEAF_OFF_FACTOR, weissberger } from "../foliageModel";
import type { MeshNode, Settings } from "../types";
import { Card } from "./Card";

interface Props {
  projectId: string;
  nodes: MeshNode[];
  settings: Settings;
  readOnly: boolean;
  /** Use this foliage scale (and leaf state) in the project. */
  onApply: (scale: number, leafOn: boolean) => void;
}

const MAX_READINGS = 300;
const POOR_GPS_M = 30;

interface Result {
  fit: Fit;
  points: CalPoint[];
  skipped: Skipped[];
  leafOn: boolean;
  withOffset: boolean;
}

/** Fit the foliage loss to measured signal: where the readings fall relative to the model, and the scale that matches them best. */
export function CalibrationPanel({ projectId, nodes, settings, readOnly, onApply }: Props) {
  const [leafOn, setLeafOn] = useState(settings.foliageLeafOn);
  const [withOffset, setWithOffset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const readings = await api.get<FieldReading[]>(`/api/projects/${projectId}/readings`);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const points: CalPoint[] = [];
      const skipped: Skipped[] = [];
      const usable = readings.slice(-MAX_READINGS);
      for (let i = 0; i < usable.length; i++) {
        const r = usable[i];
        setProgress(`Predicting ${i + 1} of ${usable.length}…`);
        const label = `${new Date(r.takenAt * 1000).toLocaleString()} · ${r.rssiDbm ?? "no RSSI"} dBm`;
        const node = r.nodeRef ? byId.get(r.nodeRef) : undefined;
        if (r.rssiDbm === null) skipped.push({ id: r.id, label, reason: "no RSSI recorded" });
        else if (!node) skipped.push({ id: r.id, label, reason: "no node chosen (or the node was deleted)" });
        else if (r.accuracyM !== null && r.accuracyM > POOR_GPS_M) skipped.push({ id: r.id, label, reason: `GPS accuracy ±${Math.round(r.accuracyM)} m is too poor` });
        else {
          try {
            const p = await predictAt(node, r.lat, r.lon, settings);
            if (p.clutterDepthM === null) skipped.push({ id: r.id, label, reason: "no clutter data on this path (build a terrain pack for the area)" });
            else if (p.bareClearancePct < 0) skipped.push({ id: r.id, label, reason: "terrain blocks the path, so the shortfall is not foliage" });
            else points.push({ id: r.id, label: `${node.name.trim() || "node"} · ${label}`, measuredRssi: r.rssiDbm, bareRssi: p.bareRssi, depthM: p.clutterDepthM, distanceM: p.distanceM });
          } catch {
            skipped.push({ id: r.id, label, reason: "terrain data not available" });
          }
        }
      }
      setResult({ fit: fitFoliageScale(points, { freqMhz: settings.freqMhz, leafOn, currentScale: settings.foliageScale, withOffset }), points, skipped, leafOn, withOffset });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  return (
    <Card id="calibrate" title="Calibrate foliage (field readings)" domId="calibrate-panel">
      <p className="hint">
        Compares the signal you measured (Field mode → Record, or import a CSV) with what bare earth would give, against how much tree the straight path crosses, and finds the foliage loss scale that fits. Needs readings with an RSSI and the node they came from, taken along paths that go through trees, plus a few in the open.
      </p>
      <div className="grid2">
        <label className="field">
          <span>Trees when you measured</span>
          <select value={leafOn ? "on" : "off"} onChange={(e) => setLeafOn(e.target.value === "on")}>
            <option value="on">In leaf</option>
            <option value="off">Bare (leaves off)</option>
          </select>
        </label>
        <label className="check" style={{ alignSelf: "end" }}>
          <input type="checkbox" checked={withOffset} onChange={(e) => setWithOffset(e.target.checked)} />
          Also fit a constant offset (antenna, cable or device errors)
        </label>
      </div>
      <button className="on" id="calibrate-run" disabled={busy || nodes.length === 0} onClick={() => void run()}>
        {busy ? progress || "Working…" : "Analyse my readings"}
      </button>
      {error ? <p className="err">{error}</p> : null}
      {result ? <Report r={result} settings={settings} readOnly={readOnly} onApply={onApply} /> : null}
    </Card>
  );
}

function Report({ r, settings, readOnly, onApply }: { r: Result; settings: Settings; readOnly: boolean; onApply: Props["onApply"] }) {
  const { fit, points, skipped } = r;
  const f1 = (v: number | null) => (v === null || !Number.isFinite(v) ? "–" : v.toFixed(1));
  const leaf = r.leafOn ? 1 : LEAF_OFF_FACTOR;
  return (
    <div id="calibrate-result">
      <p className="lmeta">
        {fit.n} reading{fit.n === 1 ? "" : "s"} used ({fit.nFoliage} through trees, {fit.nControl} in the open); {skipped.length} left out.
      </p>
      {fit.scale !== null ? (
        <div className="banner" id="fit-summary">
          Best foliage scale: <b id="fit-scale">{fit.scale.toFixed(2)}</b>
          {r.withOffset ? ` with an offset of ${fit.offsetDb.toFixed(1)} dB` : ""}. Typical error {f1(fit.rmseFit)} dB with it, {f1(fit.rmseCurrent)} dB with your current scale ({settings.foliageScale}), {f1(fit.rmseBare)} dB with no foliage loss.
          {!readOnly ? (
            <div className="row-actions">
              <button className="on" id="apply-scale" onClick={() => onApply(Number(fit.scale!.toFixed(2)), r.leafOn)}>
                Use {fit.scale.toFixed(2)} in this project
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {fit.warnings.map((w, i) => (
        <p key={i} className="lmeta warn">
          {w}
        </p>
      ))}
      {fit.controlBiasDb !== null && fit.nControl > 0 ? <p className="lmeta">Open-path readings average {f1(fit.controlBiasDb)} dB weaker than predicted (0 is ideal).</p> : null}
      {points.length > 0 ? <Scatter points={points} freqMhz={settings.freqMhz} leaf={leaf} current={settings.foliageScale} fitScale={fit.scale} offset={r.withOffset ? fit.offsetDb : 0} /> : null}
      {skipped.length > 0 ? (
        <details>
          <summary>Readings left out ({skipped.length})</summary>
          <ul className="hlist">
            {skipped.slice(0, 40).map((s) => (
              <li key={s.id} style={{ cursor: "default" }}>
                {s.label}: <span className="lmeta">{s.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** Excess loss (how much weaker than bare earth predicts) against the depth of trees on the path, with the model curves. */
function Scatter({ points, freqMhz, leaf, current, fitScale, offset }: { points: CalPoint[]; freqMhz: number; leaf: number; current: number; fitScale: number | null; offset: number }) {
  const W = 320;
  const H = 190;
  const M = { l: 36, r: 8, t: 8, b: 28 };
  const xmax = Math.max(60, ...points.map((p) => p.depthM)) * 1.05;
  const ex = points.map((p) => p.bareRssi - p.measuredRssi);
  const ymax = Math.max(10, ...ex, leaf * weissberger(freqMhz, xmax) * Math.max(current, fitScale ?? 0)) * 1.1;
  const ymin = Math.min(-5, ...ex) * 1.1;
  const X = (d: number) => M.l + (d / xmax) * (W - M.l - M.r);
  const Y = (v: number) => H - M.b - ((v - ymin) / (ymax - ymin)) * (H - M.t - M.b);
  const curve = (s: number, c = 0) => Array.from({ length: 41 }, (_, i) => `${i ? "L" : "M"}${X((xmax * i) / 40).toFixed(1)},${Y(c + s * leaf * weissberger(freqMhz, (xmax * i) / 40)).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="scatter" role="img" aria-label="Excess loss against depth of trees on the path">
      <line x1={M.l} x2={W - M.r} y1={Y(0)} y2={Y(0)} stroke="#999" strokeDasharray="3 3" />
      <line x1={M.l} x2={M.l} y1={M.t} y2={H - M.b} stroke="#999" />
      <path d={curve(current)} fill="none" stroke="#888" strokeWidth={1.5} />
      {fitScale !== null ? <path d={curve(fitScale, offset)} fill="none" stroke="#2457d6" strokeWidth={2} /> : null}
      {points.map((p, i) => (
        <circle key={p.id} cx={X(p.depthM)} cy={Y(ex[i])} r={3.5} fill="#7c3aed" fillOpacity={0.75} stroke="#fff" strokeWidth={0.8}>
          <title>{`${p.label}: ${Math.round(p.depthM)} m of trees, ${ex[i].toFixed(1)} dB weaker than bare earth`}</title>
        </circle>
      ))}
      <text x={W / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="currentColor">
        trees on the path (m)
      </text>
      <text x={10} y={H / 2} fontSize={10} fill="currentColor" transform={`rotate(-90 10 ${H / 2})`} textAnchor="middle">
        extra loss (dB)
      </text>
      <text x={W - M.r} y={M.t + 10} textAnchor="end" fontSize={10} fill="#2457d6">
        fit
      </text>
      <text x={W - M.r} y={M.t + 22} textAnchor="end" fontSize={10} fill="#888">
        current scale
      </text>
    </svg>
  );
}
