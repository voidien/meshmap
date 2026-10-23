/** Weissberger foliage loss (the same formula as `meshmap-core::foliage`, which the predictions use). */
export const LEAF_OFF_FACTOR = 0.5;
export const MAX_DEPTH_M = 400;

/** Loss in dB for `depthM` of in-leaf foliage at `freqMhz` (unscaled). */
export function weissberger(freqMhz: number, depthM: number): number {
  const d = Math.min(Math.max(depthM, 0), MAX_DEPTH_M);
  if (d <= 0 || freqMhz <= 0) return 0;
  const f = (freqMhz / 1000) ** 0.284;
  return d <= 14 ? 0.45 * f * d : 1.33 * f * d ** 0.588;
}
