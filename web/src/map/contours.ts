/** Contour lines for the part of the map you are looking at, computed in the browser from the same terrain the analysis uses. */
import { contours as d3Contours } from "d3-contour";

export type Units = "m" | "ft";
export const FT = 3.28084;
export const MIN_ZOOM = 10;

const STEPS_M = [10, 20, 50, 100, 200, 500];
const STEPS_FT = [50, 100, 200, 500, 1000, 2000];

/** Contour spacing for a zoom level (in the display units), or null when zoomed out too far. */
export function contourInterval(zoom: number, units: Units): number | null {
  if (zoom < MIN_ZOOM) return null;
  const steps = units === "m" ? STEPS_M : STEPS_FT;
  // 10 m at zoom 14 and closer, doubling-ish for each step out
  const i = Math.min(steps.length - 1, Math.max(0, Math.floor(14.99 - zoom) + 0));
  return steps[Math.min(steps.length - 1, i)];
}

const R = 6378137;
const toMerc = (lon: number, lat: number): [number, number] => [(lon * Math.PI * R) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
const fromMerc = (x: number, y: number): [number, number] => [(x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)];

export interface View {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type Sampler = (lats: number[], lons: number[]) => Promise<ArrayLike<number>>;

const COLS = 150;
const PAD = 0.25;
const MAX_LEVELS = 80;

/** Closed or open contour lines (GeoJSON LineStrings with `ele` in display units and `major` for every fifth) covering the view plus a margin. */
export async function buildContours(view: View, zoom: number, units: Units, sample: Sampler): Promise<GeoJSON.FeatureCollection> {
  const interval = contourInterval(zoom, units);
  if (interval === null) return { type: "FeatureCollection", features: [] };
  const [x0, y1] = toMerc(view.west, view.south);
  const [x1, y0] = toMerc(view.east, view.north);
  const w = x1 - x0;
  const h = y0 - y1;
  const left = x0 - w * PAD;
  const top = y0 + h * PAD;
  const cell = (w * (1 + 2 * PAD)) / COLS;
  const rows = Math.min(220, Math.max(8, Math.ceil((h * (1 + 2 * PAD)) / cell)));

  const lats: number[] = [];
  const lons: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < COLS; i++) {
      const [lon, lat] = fromMerc(left + (i + 0.5) * cell, top - (j + 0.5) * cell);
      lats.push(lat);
      lons.push(lon);
    }
  }
  const elev = await sample(lats, lons);
  const k = units === "ft" ? FT : 1;
  const values = new Float64Array(elev.length);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < elev.length; i++) {
    values[i] = elev[i] * k;
    if (values[i] < lo) lo = values[i];
    if (values[i] > hi) hi = values[i];
  }
  const levels: number[] = [];
  for (let v = Math.ceil(lo / interval) * interval; v <= hi && levels.length < MAX_LEVELS; v += interval) levels.push(v);
  if (levels.length === 0) return { type: "FeatureCollection", features: [] };

  const features: GeoJSON.Feature[] = [];
  for (const mp of d3Contours().size([COLS, rows]).thresholds(levels)(values as unknown as number[])) {
    const major = Math.round(mp.value / interval) % 5 === 0;
    for (const poly of mp.coordinates) {
      for (const ring of poly) {
        const coordinates = ring.map(([gx, gy]) => fromMerc(left + gx * cell, top - gy * cell));
        features.push({ type: "Feature", properties: { ele: Math.round(mp.value), major }, geometry: { type: "LineString", coordinates } });
      }
    }
  }
  return { type: "FeatureCollection", features };
}
