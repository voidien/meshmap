/**
 * Terrain packs (bare earth + clutter tiles built by tools/etl and served by the meshmap server).
 *
 * bare.png   RGB:  (R << 8 | G) * 0.1 - 500  metres
 * clutter.png grey: value * 0.5 metres (height of trees and buildings above the ground)
 */
import { api } from "../api";
import { lonLatToPixel } from "./terrain";

export interface PackInfo {
  id: string;
  name: string;
  zoom: number;
  bbox: [number, number, number, number];
  builtAt: string;
  tileCount: number;
  bytes: number;
  bareSource: string;
  clutterSources: string[];
  attribution: string[];
  clutterTiles: Record<string, number>;
}

const TILE = 256;
const MAX_CACHED = 240;

export function decodeBareRgba(rgba: Uint8ClampedArray | Uint8Array): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = ((rgba[4 * i] << 8) | rgba[4 * i + 1]) * 0.1 - 500;
  return out;
}

export function decodeClutterRgba(rgba: Uint8ClampedArray | Uint8Array): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = rgba[4 * i] * 0.5;
  return out;
}

type Loader = (url: string) => Promise<Uint8ClampedArray | null>;

async function fetchRgba(url: string): Promise<Uint8ClampedArray | null> {
  const resp = await fetch(url, { credentials: "same-origin" });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`terrain pack tile failed: HTTP ${resp.status}`);
  const bmp = await createImageBitmap(await resp.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const canvas = new OffscreenCanvas(TILE, TILE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, TILE, TILE).data;
}

export interface PackSample {
  bare: Float64Array;
  /** null when no sample lies in a tile with clutter data */
  clutter: Float64Array | null;
  /** which points came from a pack (the rest need public terrain) */
  inPack: Uint8Array;
  /** the pack each in-pack point came from */
  packIds: (string | null)[];
}

/** Reads the packs the server has and samples them. Knows nothing about the public terrain fallback. */
export class PackSampler {
  packs: PackInfo[] = [];
  private index = new Map<string, Map<number, 0 | 1>>(); // pack id -> (x * 2^24 + y) -> has clutter
  private cache = new Map<string, Promise<Float32Array | null>>();
  private ready: Promise<void> | null = null;

  constructor(private load: Loader = fetchRgba) {}

  /** Fetch the pack list and tile indexes (once; call `refresh` to look again). */
  init(): Promise<void> {
    this.ready ??= this.refresh();
    return this.ready;
  }

  async refresh(): Promise<void> {
    try {
      const packs = await api.get<PackInfo[]>("/api/packs");
      const index = new Map<string, Map<number, 0 | 1>>();
      for (const p of packs) {
        const t = await api.get<{ zoom: number; tiles: [number, number, 0 | 1][] }>(`/api/packs/${encodeURIComponent(p.id)}/tiles`);
        index.set(p.id, new Map(t.tiles.map(([x, y, c]) => [x * 16777216 + y, c])));
      }
      this.packs = packs;
      this.index = index;
      this.cache.clear();
    } catch {
      // no packs reachable (signed out, offline): behave as if there are none
      this.packs = [];
      this.index = new Map();
    }
  }

  private url(p: PackInfo, x: number, y: number, band: "bare" | "clutter") {
    return `/api/packs/${encodeURIComponent(p.id)}/${p.zoom}/${x}/${y}.${band}.png`;
  }

  private tile(p: PackInfo, x: number, y: number, band: "bare" | "clutter"): Promise<Float32Array | null> {
    const key = `${p.id}/${x}/${y}/${band}`;
    let t = this.cache.get(key);
    if (t) {
      this.cache.delete(key);
      this.cache.set(key, t);
      return t;
    }
    t = this.load(this.url(p, x, y, band)).then((rgba) => (rgba ? (band === "bare" ? decodeBareRgba(rgba) : decodeClutterRgba(rgba)) : null));
    t.catch(() => this.cache.delete(key));
    this.cache.set(key, t);
    while (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value as string);
    return t;
  }

  /** Does any pack have the four tiles a bilinear sample at this pixel needs? Returns that pack. */
  private packFor(zoom: number, px: number, py: number): PackInfo | null {
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    for (const p of this.packs) {
      if (p.zoom !== zoom) continue;
      const idx = this.index.get(p.id);
      if (!idx) continue;
      const ok = [0, 1].every((dx) => [0, 1].every((dy) => idx.has(Math.floor((x0 + dx) / TILE) * 16777216 + Math.floor((y0 + dy) / TILE))));
      if (ok) return p;
    }
    return null;
  }

  async sample(lats: ArrayLike<number>, lons: ArrayLike<number>): Promise<PackSample> {
    await this.init();
    const n = lats.length;
    const bare = new Float64Array(n);
    const clutter = new Float64Array(n);
    const inPack = new Uint8Array(n);
    const packIds: (string | null)[] = new Array(n).fill(null);
    let anyClutter = false;
    // finest first: where a fine pack and a coarse one overlap, the fine one wins
    const zooms = [...new Set(this.packs.map((p) => p.zoom))].sort((a, b) => b - a);
    const plan: { i: number; p: PackInfo; px: number; py: number }[] = [];
    for (let i = 0; i < n; i++) {
      for (const z of zooms) {
        const [gx, gy] = lonLatToPixel(lons[i], lats[i], z);
        const px = gx - 0.5;
        const py = Math.min(Math.max(gy - 0.5, 0), 2 ** z * TILE - 2);
        const p = this.packFor(z, px, py);
        if (p) {
          plan.push({ i, p, px, py });
          break;
        }
      }
    }
    // load every tile the plan needs, then sample
    const needed = new Map<string, () => Promise<Float32Array | null>>();
    for (const { p, px, py } of plan) {
      const idx = this.index.get(p.id)!;
      for (const dx of [0, 1]) {
        for (const dy of [0, 1]) {
          const tx = Math.floor((Math.floor(px) + dx) / TILE);
          const ty = Math.floor((Math.floor(py) + dy) / TILE);
          needed.set(`${p.id}/${tx}/${ty}/bare`, () => this.tile(p, tx, ty, "bare"));
          if (idx.get(tx * 16777216 + ty) === 1) needed.set(`${p.id}/${tx}/${ty}/clutter`, () => this.tile(p, tx, ty, "clutter"));
        }
      }
    }
    const loaded = new Map<string, Float32Array | null>();
    await Promise.all([...needed].map(async ([k, f]) => loaded.set(k, await f())));

    for (const { i, p, px, py } of plan) {
      const idx = this.index.get(p.id)!;
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const fx = px - x0;
      const fy = py - y0;
      const at = (band: "bare" | "clutter", ix: number, iy: number): number | null => {
        const tx = Math.floor(ix / TILE);
        const ty = Math.floor(iy / TILE);
        const t = loaded.get(`${p.id}/${tx}/${ty}/${band}`);
        return t ? t[(iy % TILE) * TILE + (ix % TILE)] : null;
      };
      const bil = (band: "bare" | "clutter"): number | null => {
        const a = at(band, x0, y0), b = at(band, x0 + 1, y0), c = at(band, x0, y0 + 1), d = at(band, x0 + 1, y0 + 1);
        if (a === null || b === null || c === null || d === null) return null;
        return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      };
      const g = bil("bare");
      if (g === null) continue; // fall back to the public terrain for this point
      bare[i] = g;
      inPack[i] = 1;
      packIds[i] = p.id;
      // clutter exists only where the tile under the point has a clutter band
      if (idx.get(Math.floor(Math.round(px) / TILE) * 16777216 + Math.floor(Math.round(py) / TILE)) === 1) {
        const c = bil("clutter");
        if (c !== null) {
          clutter[i] = c;
          anyClutter = true;
        }
      }
    }
    return { bare, clutter: anyClutter ? clutter : null, inPack, packIds };
  }
}

export const packSampler = new PackSampler();
