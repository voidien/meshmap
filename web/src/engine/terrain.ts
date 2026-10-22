/**
 * Elevation sampling from public Terrarium terrain-RGB tiles (AWS Open Data / Mapzen).
 * elevation_m = (R * 256 + G + B / 256) - 32768
 */

export const TERRAIN_TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
export const TERRAIN_ZOOM = 12;
const TILE = 256;
const MAX_CACHED_TILES = 400;

export function decodeTerrarium(rgba: Uint8ClampedArray | Uint8Array): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = rgba[4 * i] * 256 + rgba[4 * i + 1] + rgba[4 * i + 2] / 256 - 32768;
  }
  return out;
}

/** Fractional global pixel coordinates (pixel centres at +0.5) for a lat/lon at zoom z. */
export function lonLatToPixel(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z * TILE;
  const x = ((lon + 180) / 360) * n;
  const s = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return [x, y];
}

type TileLoader = (z: number, x: number, y: number) => Promise<Float32Array>;

async function fetchTile(z: number, x: number, y: number): Promise<Float32Array> {
  const url = TERRAIN_TILE_URL.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  const resp = await fetch(url, { mode: "cors" });
  if (!resp.ok) throw new Error(`terrain tile ${z}/${x}/${y} failed: HTTP ${resp.status}`);
  const bmp = await createImageBitmap(await resp.blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const canvas = new OffscreenCanvas(TILE, TILE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return decodeTerrarium(ctx.getImageData(0, 0, TILE, TILE).data);
}

export class TerrainSampler {
  private cache = new Map<string, Promise<Float32Array>>();

  constructor(
    private zoom = TERRAIN_ZOOM,
    private loader: TileLoader = fetchTile,
  ) {}

  private tile(tx: number, ty: number): Promise<Float32Array> {
    const key = `${tx}/${ty}`;
    let p = this.cache.get(key);
    if (p) {
      // refresh LRU position
      this.cache.delete(key);
      this.cache.set(key, p);
      return p;
    }
    p = this.loader(this.zoom, tx, ty);
    p.catch(() => this.cache.delete(key));
    this.cache.set(key, p);
    while (this.cache.size > MAX_CACHED_TILES) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
    return p;
  }

  /** Bilinearly interpolated ground elevations (m) for the given points. */
  async elevations(lats: ArrayLike<number>, lons: ArrayLike<number>): Promise<Float64Array> {
    const n = lats.length;
    const worldPx = 2 ** this.zoom * TILE;
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    const needed = new Set<string>();
    for (let i = 0; i < n; i++) {
      const [x, y] = lonLatToPixel(lons[i], lats[i], this.zoom);
      px[i] = x - 0.5;
      py[i] = Math.min(Math.max(y - 0.5, 0), worldPx - 2);
      for (const dx of [0, 1]) {
        for (const dy of [0, 1]) {
          const ix = Math.floor(px[i]) + dx;
          const iy = Math.floor(py[i]) + dy;
          needed.add(`${Math.floor(this.wrapX(ix, worldPx) / TILE)}/${Math.floor(iy / TILE)}`);
        }
      }
    }
    const tiles = new Map<string, Float32Array>();
    await Promise.all(
      [...needed].map(async (k) => {
        const [tx, ty] = k.split("/").map(Number);
        tiles.set(k, await this.tile(tx, ty));
      }),
    );
    const px_at = (ix: number, iy: number): number => {
      const wx = this.wrapX(ix, worldPx);
      const t = tiles.get(`${Math.floor(wx / TILE)}/${Math.floor(iy / TILE)}`)!;
      return t[(iy % TILE) * TILE + (wx % TILE)];
    };
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x0 = Math.floor(px[i]);
      const y0 = Math.floor(py[i]);
      const fx = px[i] - x0;
      const fy = py[i] - y0;
      const top = px_at(x0, y0) * (1 - fx) + px_at(x0 + 1, y0) * fx;
      const bot = px_at(x0, y0 + 1) * (1 - fx) + px_at(x0 + 1, y0 + 1) * fx;
      out[i] = top * (1 - fy) + bot * fy;
    }
    return out;
  }

  private wrapX(ix: number, worldPx: number): number {
    return ((ix % worldPx) + worldPx) % worldPx;
  }
}

export const terrain = new TerrainSampler();
