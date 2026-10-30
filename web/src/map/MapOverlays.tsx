import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { bearingDeg, compass, distanceM, fmtDistance } from "../fieldMath";
import type { SpotInfo } from "../engine/terrain";
import type { MeshNode } from "../types";
import type { Units } from "./contours";
import type { CursorKind } from "./cursors";

export interface MapLayers {
  relief: boolean;
  contours: boolean;
  hillshade: boolean;
  units: Units;
  cursor: CursorKind;
}

export const DEFAULT_LAYERS: MapLayers = { relief: false, contours: false, hillshade: true, units: "m", cursor: "precise" };
const KEY = "meshmap.maplayers";

export function loadLayers(): MapLayers {
  try {
    return { ...DEFAULT_LAYERS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULT_LAYERS;
  }
}
export function saveLayers(l: MapLayers) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* ignore */
  }
}

/** Elevation colours: metres above sea level (shared with the legend). */
export const RELIEF_STOPS: [number, string][] = [
  [-50, "#3b7bb5"],
  [0, "#a7d3a0"],
  [150, "#d3e5a0"],
  [400, "#f2e29a"],
  [800, "#dcb67e"],
  [1300, "#bd8d6b"],
  [2000, "#a37a70"],
  [3000, "#f4f4f4"],
];

const FT = 3.28084;
export const fmtElev = (m: number) => `${Math.round(m).toLocaleString()} m (${Math.round(m * FT).toLocaleString()} ft)`;

export function LayersControl({ value, onChange }: { value: MapLayers; onChange: (l: MapLayers) => void }) {
  const [open, setOpen] = useState(false);
  const set = (p: Partial<MapLayers>) => onChange({ ...value, ...p });
  return (
    <div className="maplayers">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} id="map-layers-btn">
        Layers
      </button>
      {open ? (
        <div className="maplayers-menu" role="group" aria-label="Map layers">
          <label className="check">
            <input type="checkbox" checked={value.hillshade} onChange={(e) => set({ hillshade: e.target.checked })} />
            Shaded relief
          </label>
          <label className="check">
            <input type="checkbox" checked={value.relief} onChange={(e) => set({ relief: e.target.checked })} />
            Elevation colours
          </label>
          <label className="check">
            <input type="checkbox" checked={value.contours} onChange={(e) => set({ contours: e.target.checked })} />
            Contour lines
          </label>
          {value.contours ? (
            <label className="field inline">
              <span>Contour units</span>
              <select value={value.units} onChange={(e) => set({ units: e.target.value as Units })}>
                <option value="m">metres</option>
                <option value="ft">feet</option>
              </select>
            </label>
          ) : null}
          {value.relief ? (
            <div className="relief-legend" aria-label="Elevation colour scale">
              <div className="bar" style={{ background: `linear-gradient(to right, ${RELIEF_STOPS.map(([e, c]) => `${c} ${(((Math.max(0, e) + 0) / 3000) * 100).toFixed(0)}%`).join(", ")})` }} />
              <div className="ticks">
                <span>0</span>
                <span>1000 m</span>
                <span>2000 m</span>
                <span>3000+</span>
              </div>
            </div>
          ) : null}
          <label className="field inline">
            <span>Cursor on the map</span>
            <select value={value.cursor} onChange={(e) => set({ cursor: e.target.value as CursorKind })} id="cursor-select">
              <option value="precise">Precision crosshair</option>
              <option value="crosshair">Standard crosshair</option>
              <option value="default">Hand</option>
            </select>
          </label>
          <p className="hint">Contours are drawn from the same terrain data the predictions use, for the part of the map you see (zoom in to see them).</p>
        </div>
      ) : null}
    </div>
  );
}

/** Live readout of the ground under the cursor. */
export function ElevationReadout({ spot, busy }: { spot: SpotInfo | null; busy: boolean }) {
  // on a touch screen there is no pointer to hover with, so do not show the hint (it only covers the map credits)
  if (!spot && typeof window !== "undefined" && window.matchMedia?.("(hover: none)").matches) return null;
  if (!spot) return <div className="elev-readout" id="elev-readout"><span className="lmeta">Move the pointer over the map for elevation. Right-click for more.</span></div>;
  return (
    <div className="elev-readout" id="elev-readout" aria-live="off">
      <b>{fmtElev(spot.groundM)}</b> ground{busy ? "…" : ""}
      {spot.clutterM !== null && spot.clutterM >= 1 ? (
        <>
          {" · "}
          <b>+{Math.round(spot.clutterM)} m</b> trees/buildings → {fmtElev(spot.groundM + spot.clutterM)} surface
        </>
      ) : null}
      <span className="lmeta"> · {spot.lat.toFixed(5)}, {spot.lon.toFixed(5)}</span>
    </div>
  );
}

export interface MenuState {
  x: number;
  y: number;
  lat: number;
  lon: number;
  info: SpotInfo | null;
}

/** Right-click menu: what is here, and what to do about it. */
export function MapContextMenu(p: { menu: MenuState; nodes: MeshNode[]; readOnly: boolean; onClose: () => void; onAddNode?: (lat: number, lon: number) => void; onPlanAround?: (lat: number, lon: number) => void }) {
  const { menu: m } = p;
  const [copied, setCopied] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(m.y);
  // keep the whole menu on the map: near the bottom edge (a long press low on a phone) it opens upwards
  useLayoutEffect(() => {
    const el = box.current;
    const room = (el?.offsetParent as HTMLElement | null)?.clientHeight;
    setTop(el && room ? Math.max(4, Math.min(m.y, room - el.offsetHeight - 4)) : m.y);
  }, [m.y, m.info, copied]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [p]);
  const near = p.nodes.length
    ? p.nodes.map((n) => ({ n, d: distanceM(m.lat, m.lon, n.lat, n.lon) })).sort((a, b) => a.d - b.d)[0]
    : null;
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setCopied("couldn't copy");
    }
  };
  const coords = `${m.lat.toFixed(6)}, ${m.lon.toFixed(6)}`;
  return (
    <div ref={box} className="ctxmenu" style={{ left: m.x, top }} role="menu" id="map-context-menu" onContextMenu={(e) => e.preventDefault()}>
      <div className="ctxhead">{coords}</div>
      <div className="ctxinfo">
        {m.info ? (
          <>
            <div>
              Ground: <b>{fmtElev(m.info.groundM)}</b>
            </div>
            {m.info.clutterM !== null && m.info.clutterM >= 1 ? (
              <div>
                Trees/buildings: <b>+{Math.round(m.info.clutterM)} m</b> → surface {fmtElev(m.info.groundM + m.info.clutterM)}
              </div>
            ) : m.info.clutterM !== null ? (
              <div className="lmeta">Open ground (no trees or buildings in the clutter data)</div>
            ) : null}
            <div className="lmeta">Source: {m.info.source}</div>
          </>
        ) : (
          <div className="lmeta">Reading elevation…</div>
        )}
        {near ? (
          <div className="lmeta">
            Nearest node: {near.n.name.trim() || "(unnamed)"}, {fmtDistance(near.d)} {compass(bearingDeg(m.lat, m.lon, near.n.lat, near.n.lon))}
          </div>
        ) : null}
      </div>
      <button role="menuitem" onClick={() => void copy(coords, "coordinates")}>
        Copy coordinates
      </button>
      {m.info ? (
        <button role="menuitem" onClick={() => void copy(`${Math.round(m.info!.groundM)} m`, "elevation")}>
          Copy elevation
        </button>
      ) : null}
      {p.onAddNode && !p.readOnly ? (
        <button
          role="menuitem"
          onClick={() => {
            p.onAddNode!(m.lat, m.lon);
            p.onClose();
          }}
        >
          Add a node here
        </button>
      ) : null}
      {p.onPlanAround ? (
        <button
          role="menuitem"
          onClick={() => {
            p.onPlanAround!(m.lat, m.lon);
            p.onClose();
          }}
        >
          Suggest sites around here
        </button>
      ) : null}
      {copied ? <div className="lmeta">Copied {copied}</div> : null}
    </div>
  );
}
