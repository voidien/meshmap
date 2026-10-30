import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { analyzeWithProfile, SPACING_FULL_M } from "../engine/analysis";
import { GOOD_CLEARANCE_PCT, suggestRaise, type PairNote, type Raise } from "../engine/pairInfo";
import { NumberField } from "../ui/NumberField";
import { clickWord, coarsePointer } from "../ui/pointer";
import { LINK_COLORS } from "../map/MapView";
import { highestAwayFromEnds, pointOnPath } from "../profilePick";
import type { LinkResult, MeshNode, Settings, TerrainMode } from "../types";
import type { ProfileData } from "../engine/analysis";

interface Props {
  a: MeshNode;
  b: MeshNode;
  settings: Settings;
  onClose: () => void;
  /** Put a new node at a spot picked on the profile. */
  onPlaceNode?: (lat: number, lon: number) => void;
  /** The spot under the pointer / picked, for showing on the map (null = none). */
  onCursor?: (pt: { lat: number; lon: number } | null) => void;
  readOnly?: boolean;
  /** Change an end's antenna height while looking at the profile (live). */
  onChangeNode?: (id: string, patch: Partial<MeshNode>) => void;
  /** True while a height slider is held, so the rest of the app can analyse coarsely until it is let go. */
  onLive?: (live: boolean) => void;
  /** Why the app does not draw this link, with a fix for each reason. */
  notes?: PairNote[];
  onFix?: (kind: PairNote["kind"]) => void;
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

export function ProfileChart({ a, b, settings, onClose, onPlaceNode, onCursor, readOnly = false, onChangeNode, onLive, notes = [], onFix }: Props) {
  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(null);

  // keep showing the last profile while a changed node is re-analysed; clear it only for a different pair
  const pairKey = useRef("");
  useEffect(() => {
    let live = true;
    const key = `${a.id}|${b.id}`;
    if (pairKey.current !== key) {
      pairKey.current = key;
      setData(null);
      setPicked(null);
    }
    setError(null);
    analyzeWithProfile(a, b, settings, SPACING_FULL_M, true)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [a, b, settings]);

  const high = useMemo(() => (data ? highestAwayFromEnds(data.dist, data.elev) : null), [data]);

  // "raise A by 4 m": worked out on the profile already loaded, a moment after it appears so the chart is never held up
  const [raise, setRaise] = useState<Raise | null | "none">(null);
  useEffect(() => {
    setRaise(null);
    if (!data) return;
    const t = setTimeout(() => setRaise(suggestRaise(data, a, b, settings) ?? "none"), 30);
    return () => clearTimeout(t);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const pointAt = (i: number) => pointOnPath(a, b, data!.dist, i);

  // show the spot under the pointer (or the picked one) on the map
  useEffect(() => {
    const i = hover ?? picked;
    onCursor?.(data && i !== null ? pointAt(i) : null);
  }, [hover, picked, data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onCursor?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const pickBar = data ? (
    <div className="pickbar" id="pickbar">
      <div className="btnrow">
        {high !== null ? (
          <button id="pick-highest" onClick={() => setPicked(high)}>
            ▲ Highest ridge between
          </button>
        ) : null}
        {data.dist.length > 2 ? (
          <button id="pick-worst" onClick={() => setPicked(Math.min(data.dist.length - 2, Math.max(1, data.result.worst_index)))}>
            ◎ Worst obstruction
          </button>
        ) : null}
      </div>
      {picked !== null ? (
        <>
          <div id="pick-info">
            <b>{(data.dist[picked] / 1000).toFixed(2)} km</b> from {a.name.trim() || "A"} ({((data.dist[data.dist.length - 1] - data.dist[picked]) / 1000).toFixed(2)} km from {b.name.trim() || "B"}) · ground <b>{Math.round(data.elev[picked])} m</b>
            {data.clutter && data.clutter[picked] >= 1 ? ` (+${Math.round(data.clutter[picked])} m trees/buildings)` : ""} ·{" "}
            {(() => {
              const gap = data.result.series.ray_m[picked] - data.result.series.terrain_eff_m[picked];
              return gap >= 0 ? `${Math.round(gap)} m below the line of sight` : `${Math.round(-gap)} m above the line of sight`;
            })()}
          </div>
          <div className="btnrow">
            <button className="on" id="place-here" disabled={readOnly || !onPlaceNode} title={readOnly ? "View only" : "Add a node at this spot"} onClick={() => onPlaceNode?.(pointAt(picked).lat, pointAt(picked).lon)}>
              Place a node here
            </button>
            <button onClick={() => setPicked(null)}>Clear</button>
          </div>
        </>
      ) : (
        <p className="hint tight">{clickWord(true)} the profile to pick a spot, or jump to the highest point, then place a node there.</p>
      )}
    </div>
  ) : null;

  return (
    <div className="link-drawer" id="link-drawer">
      <div className="chart-head">
        <strong>
          {a.name} ↔ {b.name}
        </strong>
        {data ? (
          <span className={`badge ${data.result.class}`} style={{ background: LINK_COLORS[data.result.class] }}>
            {data.result.class}
          </span>
        ) : null}
        <span className="spacer" />
        <button onClick={onClose} aria-label="Close the link view">
          ✕
        </button>
      </div>
      {data ? <p className="verdict" id="link-verdict">{verdict(data.result, settings)}</p> : null}
      {notes.map((n) => (
        <p key={n.kind} className="banner warn note">
          {n.text}
          {onFix && !readOnly && n.kind === "range" ? <button onClick={() => onFix("range")}>Look this far</button> : null}
          {onFix && !readOnly && n.kind === "radio" ? <button onClick={() => onFix("radio")}>Give {b.name.trim() || "B"} {a.name.trim() || "A"}'s radio settings</button> : null}
        </p>
      ))}
      {error ? <p className="err">Could not load terrain: {error}</p> : null}
      {!data && !error ? <p className="hint">Sampling terrain…</p> : null}
      {data ? (
        <Body
          data={data}
          a={a}
          b={b}
          settings={settings}
          hover={hover}
          setHover={setHover}
          picked={picked}
          onPick={setPicked}
          high={high}
          extra={pickBar}
          readOnly={readOnly}
          onChangeNode={onChangeNode}
          onLive={onLive}
          raise={raise}
        />
      ) : null}
    </div>
  );
}

const good = (r: LinkResult) => r.margin_db >= 0 && r.clearance_pct >= GOOD_CLEARANCE_PCT;

/** One sentence on what the result means. */
export function verdict(r: LinkResult, s: Settings): string {
  const spare = Math.min(r.margin_ab_db, r.margin_ba_db);
  const km = (r.distance_m / 1000).toFixed(1);
  const clr = r.clearance_pct < -100 ? "< -100" : r.clearance_pct.toFixed(0);
  if (r.class === "clear") return `Clear: both directions work with ${spare.toFixed(1)} dB to spare over ${km} km, and the radio path has ${clr} % clearance.`;
  if (r.class === "marginal") {
    const why = r.clearance_pct < 60 ? `the radio path is partly blocked (${clr} % clearance, 60 % wanted)` : `only ${spare.toFixed(1)} dB to spare (${s.marginalMarginDb} dB wanted)`;
    return `Marginal over ${km} km: it works on paper, but ${why}.`;
  }
  if (r.class === "obstructed") {
    const why = spare < 0 ? `the signal falls ${(-spare).toFixed(1)} dB short` : `the path is blocked (${clr} % clearance${r.obstruction_m > 0 ? `, ${r.obstruction_m.toFixed(0)} m above the ray` : ""})`;
    return `Obstructed over ${km} km: ${why}.`;
  }
  return `No usable link over ${km} km.`;
}

/** The terrain profile drawing: also used (without hover) in printed site reports. */
export function ProfileSvg(props: { data: ProfileData; a: MeshNode; b: MeshNode; settings: Settings; hover?: number | null; setHover?: (i: number | null) => void; picked?: number | null; onPick?: (i: number) => void; high?: number | null }) {
  const { data, a, b, settings, hover = null, setHover = () => undefined, picked = null, onPick, high = null } = props;
  const { dist, elev, result: r, bare, withClutter } = data;
  // trees and buildings are drawn in the solid-obstacle and foliage models (as a wall, or as lossy foliage); not for bare earth
  const showClutter = settings.terrainMode !== "bare" && withClutter !== null;
  const solid = settings.terrainMode === "clutter";
  const n = dist.length;
  const total = dist[n - 1];
  const s = r.series;
  const surface = withClutter ? withClutter.series.terrain_eff_m : s.terrain_eff_m;

  const upper = s.ray_m.map((y, i) => y + s.fresnel_m[i]);
  const lower = s.ray_m.map((y, i) => y - s.fresnel_m[i]);
  const bareLine = bare.series.terrain_eff_m;
  const ymin0 = Math.min(...bareLine, ...surface, ...lower);
  const ymax0 = Math.max(...bareLine, ...surface, ...upper);
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
  const clutterFill = showClutter ? poly(surface, bareLine) : "";

  const yTicks = niceTicks(ymin, ymax, 5);
  const xTicks = niceTicks(0, total / 1000, 8);
  const worstX = X(r.worst_dist_m);

  const indexAt = (e: { clientX: number; currentTarget: Element }): number | null => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    const d = ((x - M.l) / (W - M.l - M.r)) * total;
    return d < 0 || d > total ? null : Math.round((d / total) * (n - 1));
  };
  // a finger scrubs along the profile (the readout follows it); a tap picks the spot. The mouse hovers and clicks.
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => setHover(indexAt(e));
  const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    const step = e.shiftKey ? 10 : 1;
    const at = hover ?? Math.floor(n / 2);
    if (e.key === "ArrowRight") (e.preventDefault(), setHover(Math.min(n - 1, at + step)));
    else if (e.key === "ArrowLeft") (e.preventDefault(), setHover(Math.max(0, at - step)));
    else if ((e.key === "Enter" || e.key === " ") && onPick && hover !== null) (e.preventDefault(), onPick(Math.min(n - 2, Math.max(1, hover))));
    // Esc first clears the spot the arrow keys moved to; a second Esc closes the link view as usual
    else if (e.key === "Escape" && hover !== null) (e.stopPropagation(), setHover(null));
  };
  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const i = indexAt(e);
    if (i !== null && onPick) onPick(Math.min(n - 2, Math.max(1, i))); // the nodes' own spots are not places for a new node
  };


  return (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="profile"
          role="img"
          tabIndex={0}
          aria-label={`Terrain profile between ${a.name.trim() || "A"} and ${b.name.trim() || "B"}, ${(total / 1000).toFixed(1)} km, ${r.class}. Arrow keys move along it${onPick ? "; Enter picks a spot" : ""}.`}
          onPointerMove={onMove}
          onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
          onKeyDown={onKey}
          onClick={onClick}
          style={{ touchAction: "pan-y", ...(onPick ? { cursor: "crosshair" } : {}) }}
        >
          <path d={terrainFill} fill="#b59a73" opacity={0.85} />
          {showClutter ? <path d={clutterFill} fill="#3f8f4f" opacity={solid ? 0.75 : 0.4} /> : null}
          <path d={path(bareLine)} fill="none" stroke="#6b5836" strokeWidth={1.2} />
          {showClutter ? <path d={path(surface)} fill="none" stroke="#1f5f2f" strokeWidth={1.2} strokeDasharray={solid ? undefined : "4 2"} /> : null}
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
          {high !== null && n > 2 ? (
            <g>
              <path d={`M${X(dist[high])},${Y(elev[high]) - 4}l-6,-11h12z`} fill="#7c3aed" stroke="#fff" strokeWidth={1} />
              <text x={X(dist[high])} y={Y(elev[high]) - 19} textAnchor="middle" className="tick" fill="#5b21b6">{Math.round(elev[high])} m</text>
            </g>
          ) : null}
          {picked !== null ? (
            <g>
              <line x1={X(dist[picked])} x2={X(dist[picked])} y1={M.t} y2={H - M.b} stroke="#7c3aed" strokeWidth={1.5} strokeDasharray="4 3" />
              <circle cx={X(dist[picked])} cy={Y(s.terrain_eff_m[picked])} r={5.5} fill="#7c3aed" stroke="#fff" strokeWidth={1.5} />
            </g>
          ) : null}
          {hover !== null ? (
            <g>
              <line x1={X(dist[hover])} x2={X(dist[hover])} y1={M.t} y2={H - M.b} stroke="#111" opacity={0.4} />
              <circle cx={X(dist[hover])} cy={Y(s.terrain_eff_m[hover])} r={3.5} fill="#6b5836" />
            </g>
          ) : null}
        </svg>
  );
}

function HeightRow(props: { node: MeshNode; readOnly: boolean; onChangeNode?: (id: string, patch: Partial<MeshNode>) => void; onLive?: (live: boolean) => void; label: string }) {
  const { node, readOnly, onChangeNode, onLive, label } = props;
  const max = Math.max(60, Math.ceil(node.heightM / 10) * 10 + 10);
  const disabled = readOnly || !onChangeNode;
  return (
    <div className="hrow">
      <span className="hname">
        {label} <b>{node.name.trim() || "(unnamed)"}</b> antenna
      </span>
      <input
        type="range"
        min={0}
        max={max}
        step={0.5}
        value={node.heightM}
        disabled={disabled}
        aria-label={`Antenna height of ${node.name}`}
        onChange={(e) => onChangeNode?.(node.id, { heightM: Number(e.target.value) })}
        onPointerDown={() => onLive?.(true)}
        onPointerUp={() => onLive?.(false)}
        onPointerCancel={() => onLive?.(false)}
        onKeyUp={() => onLive?.(false)}
      />
      <span className="hnum">
        <NumberField value={node.heightM} min={0} max={500} step={0.5} aria-label={`Antenna height of ${node.name} in metres`} onCommit={(v) => onChangeNode?.(node.id, { heightM: v })} />
        <em>m</em>
      </span>
    </div>
  );
}

function Body(props: { data: ProfileData; a: MeshNode; b: MeshNode; settings: Settings; hover: number | null; setHover: (i: number | null) => void; picked: number | null; onPick: (i: number) => void; high: number | null; extra: ReactNode; readOnly: boolean; onChangeNode?: (id: string, patch: Partial<MeshNode>) => void; onLive?: (live: boolean) => void; raise: Raise | null | "none" }) {
  const { data, a, b, settings, hover, setHover, picked, onPick, high, extra, readOnly, onChangeNode, onLive, raise } = props;
  const { dist, elev, result: r, bare, withClutter } = data;
  const showClutter = settings.terrainMode !== "bare" && withClutter !== null;
  const s = r.series;
  const sensA = r.rx_ab_dbm - r.margin_ab_db;
  const sensB = r.rx_ba_dbm - r.margin_ba_db;
  const f = (v: number, d = 1) => v.toFixed(d);
  const clr = r.clearance_pct < -100 ? "< -100" : f(r.clearance_pct, 0);
  const target = raise && raise !== "none" ? (raise.end === "a" ? a : b) : null;

  return (
    <div className="chart-body">
      <div className="keynums">
        <div className={r.margin_ab_db < 0 ? "bad" : ""}>
          <span>{a.name.trim() || "A"} → {b.name.trim() || "B"}</span>
          <b>{f(r.margin_ab_db)} dB</b>
          <small>spare signal</small>
        </div>
        <div className={r.margin_ba_db < 0 ? "bad" : ""}>
          <span>{b.name.trim() || "B"} → {a.name.trim() || "A"}</span>
          <b>{f(r.margin_ba_db)} dB</b>
          <small>spare signal</small>
        </div>
        <div className={r.clearance_pct < 60 ? "bad" : ""}>
          <span>Radio path clear</span>
          <b>{clr} %</b>
          <small>60 % wanted</small>
        </div>
        <div className={r.obstruction_m > 0 ? "bad" : ""}>
          <span>Worst obstruction</span>
          <b>{r.obstruction_m > 0 ? `${f(r.obstruction_m, 0)} m` : "none"}</b>
          <small>{f(r.worst_dist_m / 1000, 1)} km along</small>
        </div>
      </div>
      <ProfileSvg data={data} a={a} b={b} settings={settings} hover={hover} setHover={setHover} picked={picked} onPick={onPick} high={high} />
      <div className="readout">
        {hover !== null ? (
          <>
            at {f(dist[hover] / 1000, 2)} km: ground {f(elev[hover], 0)} m · ray {f(s.ray_m[hover], 0)} m · clearance{" "}
            {f((100 * (s.ray_m[hover] - s.terrain_eff_m[hover])) / (s.fresnel_m[hover] || Infinity), 0)} % of F1
          </>
        ) : (
          coarsePointer() ? "Drag a finger along the profile for details, or tap it to pick a spot." : "Point at the profile for details, or click it to pick a spot."
        )}
      </div>
      <div className="heights">
        <HeightRow node={a} label="Raise or lower" readOnly={readOnly} onChangeNode={onChangeNode} onLive={onLive} />
        <HeightRow node={b} label="Raise or lower" readOnly={readOnly} onChangeNode={onChangeNode} onLive={onLive} />
        {raise === "none" ? (
          good(r) ? null : <p className="hint tight">No height change up to +60 m on either end gives 60 % clearance with spare signal; look at a relay site or another route.</p>
        ) : target && raise ? (
          <p className="suggest" id="raise-suggestion">
            To clear 60 % of the radio path, raise <b>{target.name.trim() || (raise.end === "a" ? "A" : "B")}</b> by about <b>{raise.byM} m</b> (to {f(target.heightM + raise.byM, 0)} m).
            <button className="on" disabled={readOnly || !onChangeNode} onClick={() => onChangeNode?.(target.id, { heightM: target.heightM + raise.byM })}>
              Apply
            </button>
          </p>
        ) : null}
      </div>
      {extra}
      <div className="legend-line">
        <span><i className="sw" style={{ background: "#b59a73" }} />terrain + earth curvature (k={Number(settings.k.toFixed(2))})</span>
        <span><i className="sw" style={{ background: "#1d4ed8" }} />direct ray</span>
        <span><i className="sw" style={{ background: "#4f8ff7", opacity: 0.5 }} />1st Fresnel zone (inner = 60 %)</span>
        {showClutter ? (
          <span><i className="sw" style={{ background: "#3f8f4f" }} />trees and buildings (clutter){settings.terrainMode === "foliage" ? ": lossy, not a wall" : ""}</span>
        ) : data.clutter === null ? (
          <span>no clutter data on this path: bare earth only</span>
        ) : (
          <span>clutter hidden (terrain model: bare earth)</span>
        )}
      </div>
      <details className="more">
        <summary>Link budget and assumptions</summary>
        <table className="budget">
          <tbody>
            <tr><th>Distance</th><td>{f(r.distance_m / 1000, 2)} km</td><th>Fresnel clearance</th><td className={r.clearance_pct < 60 ? "bad" : ""}>{clr} % {r.clearance_pct < 60 ? "(below 60 %)" : ""}</td></tr>
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
        {withClutter ? <CompareTable bare={bare} clutter={withClutter} foliage={data.withFoliage} mode={settings.terrainMode} /> : null}
        {r.itm && r.itm.warnings.length ? <p className="hint">ITM warnings: {r.itm.warnings.join("; ")}.</p> : null}
        <p className="hint">
          Estimate only: Longley-Rice over {settings.terrainMode === "foliage" && showClutter ? `bare-earth terrain plus foliage loss for the stretch of path inside trees (${Math.round(data.withFoliage?.foliage_depth_m ?? 0)} m, +${(data.withFoliage?.foliage_db ?? 0).toFixed(1)} dB, scale ${settings.foliageScale}, ${settings.foliageLeafOn ? "in leaf" : "leaves off"}; an average model with a large spread)` : showClutter ? "terrain plus trees and buildings treated as solid obstacles (no foliage loss; both antennas stay on the ground)" : "bare-earth terrain (no trees or buildings)"}, at {settings.reliabilityPct} % reliability / {settings.confidencePct} % confidence.
          The "regime" is ITM's own classification by distance and horizons; clearance above shows whether the direct ray is actually blocked.
        </p>
      </details>
    </div>
  );
}

function CompareTable({ bare, clutter, foliage, mode }: { bare: LinkResult; clutter: LinkResult; foliage: LinkResult | null; mode: TerrainMode }) {
  const f = (v: number, d = 1) => v.toFixed(d);
  const rows: [string, (r: LinkResult) => string][] = [
    ["Class", (r) => r.class],
    ["Path loss", (r) => `${f(r.path_loss_db)} dB`],
    ["Worst margin", (r) => `${f(r.margin_db)} dB`],
    ["Fresnel clearance", (r) => `${r.clearance_pct < -100 ? "< -100" : f(r.clearance_pct, 0)} %`],
    ["Obstruction above ray", (r) => (r.obstruction_m > 0 ? `${f(r.obstruction_m, 0)} m` : "none")],
  ];
  const cols: [string, TerrainMode, LinkResult][] = [["Bare earth", "bare", bare]];
  if (foliage) cols.push(["Bare + foliage loss", "foliage", foliage]);
  cols.push(["Trees as solid", "clutter", clutter]);
  return (
    <table className="budget compare-terrain">
      <thead>
        <tr>
          <th />
          {cols.map(([label, m]) => (
            <th key={m} className={mode === m ? "sel" : ""}>{label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {foliage ? (
          <tr>
            <th>Ray inside trees</th>
            {cols.map(([, m, r]) => (
              <td key={m}>{m === "foliage" ? `${Math.round(r.foliage_depth_m ?? 0)} m → +${f(r.foliage_db ?? 0)} dB` : ""}</td>
            ))}
          </tr>
        ) : null}
        {rows.map(([label, fn]) => (
          <tr key={label}>
            <th>{label}</th>
            {cols.map(([, m, r]) => (
              <td key={m}>{fn(r)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
