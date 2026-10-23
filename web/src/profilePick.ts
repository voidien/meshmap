/** Picking a spot on a link's terrain profile. */

/**
 * Index of the highest ground between the two ends, away from them: a node usually sits on a summit already, so the peak
 * right next to an end is no use for placing another. Skips the first and last 5 % of the path (at least 500 m); on a short
 * path where that leaves nothing, takes the highest interior sample. Null when there is no interior.
 */
export function highestAwayFromEnds(dist: ArrayLike<number>, elev: ArrayLike<number>): number | null {
  const n = elev.length;
  if (n < 3) return null;
  const total = dist[n - 1];
  const margin = Math.max(500, total * 0.05);
  let hi = -1;
  for (let i = 1; i < n - 1; i++) {
    if (dist[i] < margin || total - dist[i] < margin) continue;
    if (hi < 0 || elev[i] > elev[hi]) hi = i;
  }
  if (hi >= 0) return hi;
  hi = 1;
  for (let i = 2; i < n - 1; i++) if (elev[i] > elev[hi]) hi = i;
  return hi;
}

/** Position of profile sample `i` on the straight line from a to b (the profile is sampled evenly along that line). */
export function pointOnPath(a: { lat: number; lon: number }, b: { lat: number; lon: number }, dist: ArrayLike<number>, i: number): { lat: number; lon: number } {
  const t = dist[i] / dist[dist.length - 1];
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}
