/** Which tiles to keep for working offline in an area: terrain for predictions, map tiles to look at, and pack tiles (trees and buildings). */
import { TERRAIN_TILE_URL, TERRAIN_ZOOM, lonLatToPixel } from "../engine/terrain";

export type BBox = [number, number, number, number]; // west, south, east, north

export interface PackIndex {
  id: string;
  zoom: number;
  /** [x, y, hasClutter] for every tile of the pack */
  tiles: [number, number, 0 | 1][];
}

export interface OfflinePlan {
  terrain: string[];
  map: string[];
  pack: string[];
  /** rough download size in megabytes */
  estimateMb: number;
}

export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
/** the OpenStreetMap tile servers ask users not to bulk-download, so the map layer is kept small */
export const MAP_TILE_CAP = 600;
const MB = { terrain: 0.2, map: 0.02, pack: 0.05 };

export function tileRange(b: BBox, z: number) {
  const [x0, y1] = lonLatToPixel(b[0], b[1], z);
  const [x1, y0] = lonLatToPixel(b[2], b[3], z);
  return { x0: Math.floor(x0 / 256), x1: Math.floor(x1 / 256), y0: Math.floor(y0 / 256), y1: Math.floor(y1 / 256) };
}

const fill = (tpl: string, z: number, x: number, y: number) => tpl.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));

/** Grow a box by a distance in km on every side. */
export function padBBox(b: BBox, km: number): BBox {
  const dLat = km / 111.195;
  const mid = (b[1] + b[3]) / 2;
  const dLon = dLat / Math.max(0.05, Math.cos((mid * Math.PI) / 180));
  return [b[0] - dLon, Math.max(-85, b[1] - dLat), b[2] + dLon, Math.min(85, b[3] + dLat)];
}

export function planOffline(bbox: BBox, packs: PackIndex[], mapCap = MAP_TILE_CAP): OfflinePlan {
  const terrain: string[] = [];
  const t = tileRange(bbox, TERRAIN_ZOOM);
  for (let x = t.x0; x <= t.x1; x++) for (let y = t.y0; y <= t.y1; y++) terrain.push(fill(TERRAIN_TILE_URL, TERRAIN_ZOOM, x, y));

  // map tiles: as many zoom levels as fit under the cap, from wide to detailed
  const map: string[] = [];
  for (let z = 8; z <= 16; z++) {
    const r = tileRange(bbox, z);
    const n = (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
    if (map.length + n > mapCap) break;
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) map.push(fill(OSM_TILE_URL, z, x, y));
  }

  const pack: string[] = [];
  for (const p of packs) {
    const r = tileRange(bbox, p.zoom);
    for (const [x, y, clutter] of p.tiles) {
      if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
      pack.push(`/api/packs/${encodeURIComponent(p.id)}/${p.zoom}/${x}/${y}.bare.png`);
      if (clutter) pack.push(`/api/packs/${encodeURIComponent(p.id)}/${p.zoom}/${x}/${y}.clutter.png`);
    }
  }
  return { terrain, map, pack, estimateMb: terrain.length * MB.terrain + map.length * MB.map + pack.length * MB.pack };
}

export function bboxOfPoints(pts: { lat: number; lon: number }[]): BBox | null {
  if (pts.length === 0) return null;
  return [Math.min(...pts.map((p) => p.lon)), Math.min(...pts.map((p) => p.lat)), Math.max(...pts.map((p) => p.lon)), Math.max(...pts.map((p) => p.lat))];
}
