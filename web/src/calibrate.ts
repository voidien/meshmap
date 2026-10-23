/**
 * Fit the foliage loss scale to field readings.
 *
 * Each reading is a measured signal (RSSI) at a spot from a node. The model predicts what the same path would give over bare
 * earth, and how much of the path runs through trees. The measured signal falls short of the bare-earth prediction by the
 * "excess loss"; the foliage model says that should be `scale x leaf factor x W(depth)`. The best scale is the least-squares one.
 * Readings the model cannot explain with foliage (terrain-blocked paths, no clutter data on the path) are left out and listed.
 */
import { LEAF_OFF_FACTOR, weissberger } from "./foliageModel";

export interface CalPoint {
  id: string;
  label: string;
  measuredRssi: number;
  bareRssi: number;
  /** length of the ray inside trees, metres */
  depthM: number;
  distanceM: number;
}

export interface Skipped {
  id: string;
  label: string;
  reason: string;
}

export interface Fit {
  n: number;
  /** readings with enough foliage on the path to say anything about it */
  nFoliage: number;
  /** fitted foliage scale (null: too little data) */
  scale: number | null;
  /** constant offset in dB fitted along with the scale (0 when not allowed): measurement or radio errors that are not foliage */
  offsetDb: number;
  /** average excess loss on paths with (almost) no foliage: a gauge of non-foliage error */
  controlBiasDb: number | null;
  nControl: number;
  rmseBare: number;
  rmseCurrent: number;
  rmseFit: number | null;
  /** why the fit is not trustworthy, in words */
  warnings: string[];
}

export interface FitOptions {
  freqMhz: number;
  leafOn: boolean;
  currentScale: number;
  /** also fit a constant offset (for antenna, cable, TX power or device errors) */
  withOffset: boolean;
  /** paths with less foliage than this count as "no foliage" controls, metres */
  minDepthM?: number;
}

const rmse = (xs: number[]) => (xs.length ? Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length) : NaN);

export function fitFoliageScale(points: CalPoint[], o: FitOptions): Fit {
  const minDepth = o.minDepthM ?? 5;
  const leaf = o.leafOn ? 1 : LEAF_OFF_FACTOR;
  const e = points.map((p) => p.bareRssi - p.measuredRssi); // excess loss, dB (positive = weaker than bare earth predicts)
  const m = points.map((p) => leaf * weissberger(o.freqMhz, p.depthM)); // model loss at scale 1
  const n = points.length;
  const foliageIdx = points.map((p, i) => (p.depthM >= minDepth ? i : -1)).filter((i) => i >= 0);
  const controlIdx = points.map((p, i) => (p.depthM < minDepth ? i : -1)).filter((i) => i >= 0);
  const warnings: string[] = [];

  let scale: number | null = null;
  let offset = 0;
  if (foliageIdx.length >= 3 && n >= 5) {
    if (o.withOffset) {
      // e = c + s m  by ordinary least squares
      const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
      const me = mean(e);
      const mm = mean(m);
      const sxx = m.reduce((a, v) => a + (v - mm) ** 2, 0);
      if (sxx > 1e-9) {
        scale = m.reduce((a, v, i) => a + (v - mm) * (e[i] - me), 0) / sxx;
        offset = me - scale * mm;
      }
    } else {
      const sxx = m.reduce((a, v) => a + v * v, 0);
      if (sxx > 1e-9) scale = m.reduce((a, v, i) => a + v * e[i], 0) / sxx;
    }
    if (scale !== null && scale < 0) {
      warnings.push("The readings are stronger than the bare-earth prediction where trees are in the way, so no foliage loss fits. Check the readings, the node's height and the radio settings.");
      scale = 0;
    }
  } else {
    warnings.push(`Need at least 5 readings with RSSI, 3 of them through ${minDepth} m or more of trees (have ${n} and ${foliageIdx.length}).`);
  }

  const controlBias = controlIdx.length ? controlIdx.reduce((a, i) => a + e[i], 0) / controlIdx.length : null;
  if (controlBias !== null && Math.abs(controlBias) > 4 && controlIdx.length >= 2) {
    warnings.push(`Readings on paths with almost no trees are on average ${controlBias.toFixed(1)} dB ${controlBias > 0 ? "weaker" : "stronger"} than predicted. That is not foliage: check antenna gain, cable loss, TX power, the radio settings and how you held the device; consider allowing an offset in the fit.`);
  }
  if (new Set(foliageIdx.map((i) => Math.round(points[i].depthM / 25))).size < 3 && foliageIdx.length >= 3) {
    warnings.push("The readings through trees are all at similar depths; the fit mostly measures one depth. Add readings deeper in and nearer the edge.");
  }

  const err = (s: number, c: number) => e.map((v, i) => v - (c + s * m[i]));
  return {
    n,
    nFoliage: foliageIdx.length,
    scale,
    offsetDb: offset,
    controlBiasDb: controlBias,
    nControl: controlIdx.length,
    rmseBare: rmse(err(0, 0)),
    rmseCurrent: rmse(err(o.currentScale, 0)),
    rmseFit: scale === null ? null : rmse(err(scale, offset)),
    warnings,
  };
}
