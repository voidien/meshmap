/** Why a pair of nodes has (or has no) drawn link, and what height change would fix a weak one. */
import { endpointOf, linkParams, pickResult, presetById, type ProfileData } from "./analysis";
import { wasm } from "./wasm";
import type { LinkResult, MeshNode, Settings } from "../types";

export interface PairNote {
  kind: "range" | "radio" | "budget";
  text: string;
}

export interface PairInfo {
  distanceM: number;
  notes: PairNote[];
}

/** The reasons the app does not draw a link between two nodes, if any. The profile can still be analysed. */
export function explainPair(a: MeshNode, b: MeshNode, s: Settings): PairInfo {
  const distanceM = wasm.haversine_m(a.lat, a.lon, b.lat, b.lon);
  const notes: PairNote[] = [];
  if (distanceM > s.maxRangeKm * 1000) {
    notes.push({ kind: "range", text: `They are ${(distanceM / 1000).toFixed(1)} km apart; the project only looks for links up to ${s.maxRangeKm} km, so no link is drawn.` });
  }
  const pa = presetById(a.presetId);
  const pb = presetById(b.presetId);
  if (pa.sf !== pb.sf || pa.bw_khz !== pb.bw_khz) {
    notes.push({ kind: "radio", text: `Different radio settings (${pa.name} and ${pb.name}): the two cannot hear each other, whatever the terrain.` });
  } else {
    const [mAb, mBa] = wasm.fspl_margins(endpointOf(a, s, b), endpointOf(b, s, a), distanceM, s.freqMhz);
    if (Math.min(mAb, mBa) < 0) notes.push({ kind: "budget", text: `Out of range even in free space (${Math.min(mAb, mBa).toFixed(1)} dB short with nothing in the way).` });
  }
  return { distanceM, notes };
}

/** Re-run the link maths on a profile that is already loaded (no terrain download), with different antenna heights. */
export function reanalyze(profile: ProfileData, a: MeshNode, b: MeshNode, s: Settings): LinkResult {
  const both = wasm.analyze_link_both(linkParams(s), endpointOf(a, s, b), endpointOf(b, s, a), profile.dist, profile.elev, profile.clutter ?? new Float64Array(0), false) as {
    bare: LinkResult;
    clutter?: LinkResult | null;
    foliage?: LinkResult | null;
  };
  return pickResult(both, s.terrainMode);
}

export interface Raise {
  /** which end to raise */
  end: "a" | "b";
  /** metres to add to that antenna */
  byM: number;
}

export const GOOD_CLEARANCE_PCT = 60;
const MAX_RAISE_M = 60;

const good = (r: LinkResult) => r.margin_db >= 0 && r.clearance_pct >= GOOD_CLEARANCE_PCT;

/**
 * The smallest raise of one antenna (whole metres, up to 60) after which the path has at least 60 % first-Fresnel clearance and a positive
 * margin. `null` when the link is already that good, or when no raise within 60 m gets there.
 */
export function suggestRaise(profile: ProfileData, a: MeshNode, b: MeshNode, s: Settings): Raise | null {
  if (good(profile.result)) return null;
  let best: Raise | null = null;
  for (const end of ["a", "b"] as const) {
    for (let up = 1; up <= MAX_RAISE_M; up++) {
      if (best && up >= best.byM) break;
      const r = reanalyze(profile, end === "a" ? { ...a, heightM: a.heightM + up } : a, end === "b" ? { ...b, heightM: b.heightM + up } : b, s);
      if (good(r)) {
        best = { end, byM: up };
        break;
      }
    }
  }
  return best;
}

