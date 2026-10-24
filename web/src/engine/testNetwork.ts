import { newNodeFor } from "../workspace";
import type { MeshNode, Settings } from "../types";

/** A small seeded random generator (mulberry32), so a generated network is the same every time. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A scatter of `count` planned nodes around a centre, at least `minSpacingKm` apart, with mixed mast heights and a few tags,
 * for trying the app with hundreds of nodes. Not a plan of anything real.
 */
export function generateNetwork(settings: Settings, center: { lat: number; lon: number }, count: number, radiusKm: number, minSpacingKm = 1.2, seed = 1): MeshNode[] {
  const rand = rng(seed);
  const nodes: MeshNode[] = [];
  const kmPerDegLon = 111.32 * Math.cos((center.lat * Math.PI) / 180);
  let tries = 0;
  while (nodes.length < count && tries < count * 200) {
    tries++;
    const r = radiusKm * Math.sqrt(rand());
    const th = 2 * Math.PI * rand();
    const lat = center.lat + (r * Math.sin(th)) / 111.32;
    const lon = center.lon + (r * Math.cos(th)) / kmPerDegLon;
    const tooClose = nodes.some((n) => Math.hypot((n.lat - lat) * 111.32, (n.lon - lon) * kmPerDegLon) < minSpacingKm);
    if (tooClose) continue;
    const i = nodes.length + 1;
    const node = newNodeFor(settings, Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6, `T${String(i).padStart(3, "0")}`, `test-${seed}-${i}`);
    node.heightM = [5, 8, 10, 12, 15, 20, 25][Math.floor(rand() * 7)];
    node.status = rand() < 0.3 ? "installed" : "planned";
    node.tags = [["phase 1", "phase 2", "phase 3"][Math.floor(rand() * 3)]];
    nodes.push(node);
  }
  return nodes;
}
