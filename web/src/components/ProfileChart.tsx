import { useEffect, useState } from "react";
import { analyzeWithProfile, SPACING_FULL_M } from "../engine/analysis";
import { LINK_COLORS } from "../map/MapView";
import type { LinkResult, MeshNode, Settings, TerrainMode } from "../types";
import type { ProfileData } from "../engine/analysis";

interface Props {
  a: MeshNode;
  b: MeshNode;
  settings: Settings;
  onClose: () => void;
}

const W = 960;
const H = 300;
const M = { l: 56, r: 16, t: 14, b: 36 };

function niceTicks(lo: number, hi: number, count: number): number[] {
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

export function ProfileChart({ a, b, settings, onClose }: Props) {
  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    analyzeWithProfile(a, b, settings, SPACING_FULL_M, true)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [a, b, settings]);

  return (
    <div className="chart-panel">
      <div className="chart-head">
        <strong>
          {a.name} ↔ {b.name}
        </strong>
        {data ? (
          <span className="badge" style={{ background: LINK_COLORS[data.result.class] }}>
            {data.result.class}
          </span>
        ) : null}
        <span className="spacer" />
        <button onClick={onClose} aria-label="Close profile">
          ✕
        </button>
      </div>
      {error ? <p className="err">Could not load terrain: {error}</p> : null}
      {!data && !error ? <p className="hint">Sampling terrain…</p> : null}
      {data ? <Body data={data} a={a} b={b} settings={settings} hover={hover} setHover={setHover} /> : null}
    </div>
  );
}

/** The terrain profile drawing: also used (without hover) in printed site reports. */
export function ProfileSvg(props: { data: ProfileData; a: MeshNode; b: MeshNode; settings: Settings; hover?: number | null; setHover?: (i: number | null) => void }) {
  const { data, a, b, settings, hover = null, setHover = () => undefined } = props;
  const { dist, elev, result: r, bare, withClutter } = data;
  const showClutter = settings.terrainMode === "clutter" && withClutter !== null;
  const n = dist.length;
  const total = dist[n - 1];
  const s = r.series;

  const upper = s.ray_m.map((y, i) => y + s.fresnel_m[i]);
  const lower = s.ray_m.map((y, i) => y - s.fresnel_m[i]);
  const bareLine = bare.series.terrain_eff_m;
  const ymin0 = Math.min(...bareLine, ...s.terrain_eff_m, ...lower);
  const ymax0 = Math.max(...bareLine, ...s.terrain_eff_m, ...upper);
  const pad = Math.max(5, (ymax0 - ymin0) * 0.06);
  const ymin = ymin0 - pad;
  const ymax = ymax0 + pad;
  const X = (d: number) => M.l + (d / total) * (W - M.l - M.r);
  const Y = (v: number) => H - M.b - ((v - ymin) / (ymax - ymin)) * (H - M.t - M.b);
  const path = (ys: number[]) => ys.map((v, i) => `${i ? "L" : "M"}${X(dist[i]).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  const poly = (top: number[], bottom: number[]) =>
    path(top) + [...bottom].reverse().map((v, k) => `L${X(dist[n - 1 - k]).toFixed(1)},${Y(v).toFixed(1)}`).join("") + "Z";
  const inner = (sign: number) => s.ray_m.map((y, i) => y + sign * 0.6 * s.fresnel_m[i]);
  const terrainFill = path(bareLine) + `L${X(total)},${H - M.b}L${X(0)},${H - M.b}Z`;
  const clutterFill = showClutter ? poly(s.terrain_eff_m, bareLine) : "";

  const yTicks = niceTicks(ymin, ymax, 5);
  const xTicks = niceTicks(0, total / 1000, 8);
  const worstX = X(r.worst_dist_m);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    const d = ((x - M.l) / (W - M.l - M.r)) * total;
    setHover(d < 0 || d > total ? null : Math.round((d / total) * (n - 1)));
  };


  return (
        <svg viewBox={`0 0 ${W} ${H}`} className="profile" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <path d={terrainFill} fill="#b59a73" opacity={0.85} />
          {showClutter ? <path d={clutterFill} fill="#3f8f4f" opacity={0.75} /> : null}
          <path d={path(bareLine)} fill="none" stroke="#6b5836" strokeWidth={1.2} />
          {showClutter ? <path d={path(s.terrain_eff_m)} fill="none" stroke="#1f5f2f" strokeWidth={1.2} /> : null}
          <path d={poly(upper, lower)} fill="#4f8ff7" opacity={0.15} />
          <path d={poly(inner(1), inner(-1))} fill="#4f8ff7" opacity={0.22} />
          <path d={path(s.ray_m)} fill="none" stroke="#1d4ed8" strokeWidth={1.6} />
          {[0, total].map((d, i) => {
            const node = i ? b : a;
            const ground = i ? elev[n - 1] : elev[0];
            return (
              <g key={i}>
                <line x1={X(d)} x2={X(d)} y1={Y(ground)} y2={Y(ground + node.heightM)} stroke="#111" strokeWidth={3} />
                <circle cx={X(d)} cy={Y(ground + node.heightM)} r={4} fill="#111" />
              </g>
            );
          })}
          {n > 2 ? <circle cx={worstX} cy={Y(s.terrain_eff_m[r.worst_index])} r={5} fill="none" stroke={LINK_COLORS[r.class]} strokeWidth={2.5} /> : null}
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={M.l} x2={W - M.r} y1={Y(v)} y2={Y(v)} stroke="#000" opacity={0.08} />
              <text x={M.l - 6} y={Y(v) + 4} textAnchor="end" className="tick">
                {Math.round(v)}
              </text>
            </g>
          ))}
          {xTicks.map((v) => (
            <text key={v} x={X(v * 1000)} y={H - M.b + 16} textAnchor="middle" className="tick">
              {v}
            </text>
          ))}
          <text x={W / 2} y={H - 4} textAnchor="middle" className="axis">
            distance (km)
          </text>
          <text x={12} y={H / 2} textAnchor="middle" className="axis" transform={`rotate(-90 12 ${H / 2})`}>
            elevation (m)
          </text>
          {hover !== null ? (
            <g>
              <line x1={X(dist[hover])} x2={X(dist[hover])} y1={M.t} y2={H - M.b} stroke="#111" opacity={0.4} />
              <circle cx={X(dist[hover])} cy={Y(s.terrain_eff_m[hover])} r={3.5} fill="#6b5836" />
            </g>
          ) : null}
        </svg>
  );
}

function Body(props: { data: ProfileData; a: MeshNode; b: MeshNode; settings: Settings; hover: number | null; setHover: (i: number | null) => void }) {
  const { data, a, b, settings, hover, setHover } = props;
  const { dist, elev, result: r, bare, withClutter } = data;
  const showClutter = settings.terrainMode === "clutter" && withClutter !== null;
  const s = r.series;
  const sensA = r.rx_ab_dbm - r.margin_ab_db;
  const sensB = r.rx_ba_dbm - r.margin_ba_db;
  const f = (v: number, d = 1) => v.toFixed(d);

  return (
    <div className="chart-body">
      <ProfileSvg data={data} a={a} b={b} settings={settings} hover={hover} setHover={setHover} />
      <div className="legend-line">
        <span><i className="sw" style={{ background: "#b59a73" }} />terrain + earth curvature (k={Number(settings.k.toFixed(2))})</span>
        <span><i className="sw" style={{ background: "#1d4ed8" }} />direct ray</span>
        <span><i className="sw" style={{ background: "#4f8ff7", opacity: 0.5 }} />1st Fresnel zone (inner = 60 %)</span>
        {showClutter ? (
          <span><i className="sw" style={{ background: "#3f8f4f" }} />trees and buildings (clutter)</span>
        ) : data.clutter === null ? (
          <span>no clutter data on this path: bare earth only</span>
        ) : (
          <span>clutter hidden (terrain model: bare earth)</span>
        )}
      </div>
      <div className="readout">
        {hover !== null ? (
          <>
            at {f(dist[hover] / 1000, 2)} km: ground {f(elev[hover], 0)} m · ray {f(s.ray_m[hover], 0)} m · clearance{" "}
            {f((100 * (s.ray_m[hover] - s.terrain_eff_m[hover])) / (s.fresnel_m[hover] || Infinity), 0)} % of F1
          </>
        ) : (
          "Hover the profile for details."
        )}
      </div>
      <table className="budget">
        <tbody>
          <tr><th>Distance</th><td>{f(r.distance_m / 1000, 2)} km</td><th>Fresnel clearance</th><td className={r.clearance_pct < 60 ? "bad" : ""}>{r.clearance_pct < -100 ? "< -100" : f(r.clearance_pct, 0)} % {r.clearance_pct < 60 ? "(below 60 %)" : ""}</td></tr>
          <tr><th>Free-space loss</th><td>{f(r.fspl_db)} dB</td><th>Worst point</th><td>{f(r.worst_dist_m / 1000, 2)} km{r.obstruction_m > 0 ? ` (${f(r.obstruction_m, 0)} m above ray)` : ""}</td></tr>
          {r.itm ? (
            <tr>
              <th>Longley-Rice (ITM)</th><td><b>{f(r.itm.loss_db)} dB</b> · {r.itm.mode} regime · {f(r.itm.loss_db - r.fspl_db)} dB over free space</td>
              <th>Knife-edge check</th><td>{f(r.fspl_db + r.diffraction_db)} dB (free space + {f(r.diffraction_db)} dB)</td>
            </tr>
          ) : (
            <tr>
              <th>Model</th><td colSpan={3}>Free space + knife-edge diffraction: {f(r.fspl_db + r.diffraction_db)} dB. ITM did not run: {r.itm_error}</td>
            </tr>
          )}
          <tr><th>Path loss used</th><td><b>{f(r.path_loss_db)} dB</b> ({r.model === "itm" ? "ITM" : "knife-edge fallback"})</td><th>Reliability / confidence</th><td>{settings.reliabilityPct} % / {settings.confidencePct} %</td></tr>
          <tr><th>{a.name} → {b.name}</th><td>Rx {f(r.rx_ab_dbm)} dBm · sens {f(sensB)} → margin <b>{f(r.margin_ab_db)} dB</b></td>
              <th>{b.name} → {a.name}</th><td>Rx {f(r.rx_ba_dbm)} dBm · sens {f(sensA)} → margin <b>{f(r.margin_ba_db)} dB</b></td></tr>
        </tbody>
      </table>
      {withClutter ? <CompareTable bare={bare} clutter={withClutter} mode={settings.terrainMode} /> : null}
      {r.itm && r.itm.warnings.length ? (
        <p className="hint">ITM warnings: {r.itm.warnings.join("; ")}.</p>
      ) : null}
      <p className="hint">
        Estimate only: Longley-Rice over {showClutter ? "terrain plus trees and buildings treated as solid obstacles (no foliage loss; both antennas stay on the ground)" : "bare-earth terrain (no trees or buildings)"}, at {settings.reliabilityPct} % reliability / {settings.confidencePct} % confidence.
        The "regime" is ITM's own classification by distance and horizons; clearance above shows whether the direct ray is actually blocked.
      </p>
    </div>
  );
}

function CompareTable({ bare, clutter, mode }: { bare: LinkResult; clutter: LinkResult; mode: TerrainMode }) {
  const f = (v: number, d = 1) => v.toFixed(d);
  const rows: [string, (r: LinkResult) => string][] = [
    ["Class", (r) => r.class],
    ["Path loss", (r) => `${f(r.path_loss_db)} dB`],
    ["Worst margin", (r) => `${f(r.margin_db)} dB`],
    ["Fresnel clearance", (r) => `${r.clearance_pct < -100 ? "< -100" : f(r.clearance_pct, 0)} %`],
    ["Obstruction above ray", (r) => (r.obstruction_m > 0 ? `${f(r.obstruction_m, 0)} m` : "none")],
  ];
  return (
    <table className="budget compare-terrain">
      <thead>
        <tr><th /><th className={mode === "bare" ? "sel" : ""}>Bare earth</th><th className={mode === "clutter" ? "sel" : ""}>Terrain + clutter</th><th>Difference</th></tr>
      </thead>
      <tbody>
        {rows.map(([label, fn]) => (
          <tr key={label}>
            <th>{label}</th>
            <td>{fn(bare)}</td>
            <td>{fn(clutter)}</td>
            <td>{label === "Path loss" ? `${f(clutter.path_loss_db - bare.path_loss_db)} dB` : label === "Worst margin" ? `${f(clutter.margin_db - bare.margin_db)} dB` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
