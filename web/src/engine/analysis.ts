import { wasm, getPresets } from "./wasm";
import { terrain } from "./terrain";
import type { Link, LinkResult, MeshNode, Preset, Settings } from "../types";

export interface Endpoint {
  h_agl_m: number;
  tx_dbm: number;
  gain_dbi: number;
  cable_loss_db: number;
  sensitivity_dbm: number;
}

/** Profile spacing in metres: fine for final results, coarse while dragging. */
export const SPACING_FULL_M = 40;
export const SPACING_FAST_M = 150;
const MAX_SAMPLES = 2000;

let presetMap: Map<string, Preset> | null = null;
export function presetById(id: string): Preset {
  presetMap ??= new Map(getPresets().map((p) => [p.id, p]));
  return presetMap.get(id) ?? presetMap.get("long_fast")!;
}

export function endpointOf(n: MeshNode, s: Settings): Endpoint {
  const p = presetById(n.presetId);
  return {
    h_agl_m: n.heightM,
    tx_dbm: n.txDbm,
    gain_dbi: n.gainDbi,
    cable_loss_db: n.cableLossDb,
    sensitivity_dbm: wasm.sensitivity_dbm(p.sf, p.bw_khz, s.noiseFigureDb),
  };
}

export function linkKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

const nodeSig = (n: MeshNode) =>
  [n.lat.toFixed(6), n.lon.toFixed(6), n.heightM, n.txDbm, n.gainDbi, n.cableLossDb, n.presetId].join(",");

const settingsSig = (s: Settings) => [s.freqMhz, s.k, s.marginalMarginDb, s.noiseFigureDb].join(",");

/** Evenly spaced lat/lon samples (linear interpolation; error is negligible below ~100 km). */
export function sampleLine(a: MeshNode, b: MeshNode, spacingM: number) {
  const total = wasm.haversine_m(a.lat, a.lon, b.lat, b.lon);
  const n = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(total / spacingM) + 1));
  const lats = new Float64Array(n);
  const lons = new Float64Array(n);
  const dist = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    lats[i] = a.lat + (b.lat - a.lat) * t;
    lons[i] = a.lon + (b.lon - a.lon) * t;
    dist[i] = total * t;
  }
  return { lats, lons, dist, total };
}

export interface ProfileData {
  dist: Float64Array;
  elev: Float64Array;
  result: LinkResult;
}

/** Fetch the terrain profile and run the WASM link analysis. */
export async function analyzeWithProfile(
  a: MeshNode,
  b: MeshNode,
  s: Settings,
  spacingM: number,
  includeSeries: boolean,
): Promise<ProfileData> {
  const { lats, lons, dist } = sampleLine(a, b, spacingM);
  const elev = await terrain.elevations(lats, lons);
  const result = wasm.analyze_link(
    { freq_mhz: s.freqMhz, k: s.k, marginal_margin_db: s.marginalMarginDb },
    endpointOf(a, s),
    endpointOf(b, s),
    dist,
    elev,
    includeSeries,
  ) as LinkResult;
  return { dist, elev, result };
}

const linkCache = new Map<string, Link>();
const MAX_CACHE = 6000;

async function analyzePair(a: MeshNode, b: MeshNode, s: Settings, spacingM: number): Promise<Link> {
  const [x, y] = a.id < b.id ? [a, b] : [b, a];
  const key = linkKey(x.id, y.id);
  const cacheKey = `${spacingM}|${settingsSig(s)}|${nodeSig(x)}|${nodeSig(y)}|${x.id}|${y.id}`;
  const hit = linkCache.get(cacheKey);
  if (hit) return hit;

  const distanceM = wasm.haversine_m(x.lat, x.lon, y.lat, y.lon);
  const px = presetById(x.presetId);
  const py = presetById(y.presetId);
  let link: Link;
  if (px.sf !== py.sf || px.bw_khz !== py.bw_khz) {
    link = { key, a: x.id, b: y.id, class: "none", distanceM, warning: "Radio presets differ (SF/BW): LoRa cannot demodulate across presets." };
  } else {
    const [mAb, mBa] = wasm.fspl_margins(endpointOf(x, s), endpointOf(y, s), distanceM, s.freqMhz);
    if (Math.min(mAb, mBa) < 0) {
      link = { key, a: x.id, b: y.id, class: "none", distanceM, warning: "Out of range even in free space." };
    } else {
      const { result } = await analyzeWithProfile(x, y, s, spacingM, false);
      link = { key, a: x.id, b: y.id, class: result.class, distanceM, result };
    }
  }
  if (linkCache.size >= MAX_CACHE) linkCache.clear();
  linkCache.set(cacheKey, link);
  return link;
}

export interface ComputeOptions {
  spacingM: number;
  isCancelled: () => boolean;
  onProgress?: (done: number, total: number) => void;
}

/** Spatially prune node pairs, then analyse each candidate (cached per pair inputs). */
export async function computeLinks(nodes: MeshNode[], s: Settings, opt: ComputeOptions): Promise<Link[]> {
  const coords = new Float64Array(nodes.length * 2);
  nodes.forEach((n, i) => {
    coords[2 * i] = n.lat;
    coords[2 * i + 1] = n.lon;
  });
  const flat = wasm.candidate_pairs(coords, s.maxRangeKm * 1000);
  const pairs: [MeshNode, MeshNode][] = [];
  for (let i = 0; i < flat.length; i += 2) pairs.push([nodes[flat[i]], nodes[flat[i + 1]]]);

  const out: Link[] = [];
  const BATCH = 8;
  for (let i = 0; i < pairs.length; i += BATCH) {
    if (opt.isCancelled()) return out;
    const batch = pairs.slice(i, i + BATCH);
    out.push(...(await Promise.all(batch.map(([a, b]) => analyzePair(a, b, s, opt.spacingM)))));
    opt.onProgress?.(out.length, pairs.length);
  }
  return out;
}
