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

const settingsSig = (s: Settings) =>
  [s.freqMhz, s.k, s.marginalMarginDb, s.noiseFigureDb, s.itmClimate, s.itmN0, s.groundEpsilon, s.groundSigma, s.verticalPolarization, s.confidencePct, s.reliabilityPct].join(",");

/** Parameters object for the WASM `analyze_link`. */
export function linkParams(s: Settings) {
  return {
    freq_mhz: s.freqMhz,
    k: s.k,
    marginal_margin_db: s.marginalMarginDb,
    itm: {
      climate: s.itmClimate,
      n0: s.itmN0,
      epsilon: s.groundEpsilon,
      sigma: s.groundSigma,
      vertical_polarization: s.verticalPolarization,
      confidence_pct: s.confidencePct,
      reliability_pct: s.reliabilityPct,
    },
  };
}

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
  /** ground elevation */
  elev: Float64Array;
  /** height of trees/buildings above ground; null without clutter data */
  clutter: Float64Array | null;
  bare: LinkResult;
  withClutter: LinkResult | null;
  /** result for the selected terrain mode */
  result: LinkResult;
}

interface Both {
  bare: LinkResult;
  clutter: LinkResult | null;
}

function pick(b: Both, s: Settings): LinkResult {
  return s.terrainMode === "clutter" && b.clutter ? b.clutter : b.bare;
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
  const { bare: elev, clutter } = await terrain.profile(lats, lons);
  const both = wasm.analyze_link_both(
    linkParams(s),
    endpointOf(a, s),
    endpointOf(b, s),
    dist,
    elev,
    clutter ?? new Float64Array(0),
    includeSeries,
  ) as Both;
  return { dist, elev, clutter, bare: both.bare, withClutter: both.clutter ?? null, result: pick(both, s) };
}

const linkCache = new Map<string, Link>();
const MAX_CACHE = 6000;

async function analyzePair(a: MeshNode, b: MeshNode, s: Settings, spacingM: number): Promise<Link> {
  const [x, y] = a.id < b.id ? [a, b] : [b, a];
  const key = linkKey(x.id, y.id);
  const cacheKey = `${spacingM}|${settingsSig(s)}|${nodeSig(x)}|${nodeSig(y)}|${x.id}|${y.id}`;
  const hit = linkCache.get(cacheKey);
  if (hit) return withMode(hit, s);

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
      const p = await analyzeWithProfile(x, y, s, spacingM, false);
      link = { key, a: x.id, b: y.id, class: p.result.class, distanceM, result: p.result, bare: p.bare, hasClutter: p.withClutter !== null };
      if (p.withClutter) link.clutter = p.withClutter;
    }
  }
  if (linkCache.size >= MAX_CACHE) linkCache.clear();
  linkCache.set(cacheKey, link);
  return withMode(link, s);
}

/** Cached links hold both results; the terrain mode only picks which one is the headline. */
function withMode(link: Link, s: Settings): Link {
  if (!link.bare) return link;
  const result = s.terrainMode === "clutter" && link.clutter ? link.clutter : link.bare;
  return result === link.result ? link : { ...link, result, class: result.class };
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
