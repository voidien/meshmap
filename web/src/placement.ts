/** Placement suggestions: where would new nodes add the most coverage? (server job `placement`) */
import type { JobState } from "./coverage";
import { NETWORKS } from "./networks";
import type { MeshNode, Settings } from "./types";

export interface Area {
  lat: number;
  lon: number;
  radiusKm: number;
}

export interface Backhaul {
  minMarginDb: number;
  maxKm: number;
  /** A blocked path does not count as a link, even if the predicted margin is positive. */
  avoidObstructed: boolean;
  /** Each site after the first must also link directly to an earlier suggestion. */
  connectSuggestions: boolean;
}

export const DEFAULT_BACKHAUL: Backhaul = { minMarginDb: 6, maxKm: 30, avoidObstructed: true, connectSuggestions: true };

export interface PlacementOptions {
  count: number;
  coverageRadiusKm: number;
  minSpacingKm: number;
  minReliefM: number;
  minGainKm2: number;
  /** null = new sites need no link back to the network */
  backhaul: Backhaul | null;
}

export const DEFAULT_PLACEMENT: PlacementOptions = {
  count: 3,
  coverageRadiusKm: 15,
  minSpacingKm: 3,
  minReliefM: 30,
  minGainKm2: 1,
  backhaul: { ...DEFAULT_BACKHAUL },
};

export interface BackhaulLink {
  to: "existing" | "suggestion";
  index: number;
  name: string;
  distanceKm: number;
  marginDb: number;
  clearancePct: number;
  class: string;
}

export interface Suggestion {
  rank: number;
  lat: number;
  lon: number;
  elevM: number;
  reliefM: number;
  newKm2: number;
  newPct: number;
  soloKm2: number;
  cumulativePct: number;
  backhaul: BackhaulLink[];
  backhaulChecked: boolean;
}

export interface PlacementResult {
  kind: "placement";
  hash: string;
  area: Area;
  targetKm2: number;
  baselinePct: number;
  candidates: number;
  requested: number;
  stoppedBecause: "count" | "gain" | "backhaul";
  suggestions: Suggestion[];
  terrain: "bare" | "clutter";
  clutterShare?: number | null;
}

export interface PlacementJob {
  id: string;
  state: JobState;
  progress: number;
  message: string;
  error: string | null;
  result: PlacementResult | null;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function placementRequest(area: Area, template: MeshNode | null, existing: MeshNode[], s: Settings, o: PlacementOptions) {
  const t = template ?? { heightM: 10, txDbm: 22, gainDbi: 3, cableLossDb: 0.5, presetId: NETWORKS[s.network].presetId, clientHeightM: 1 };
  const nodeIn = (n: Pick<MeshNode, "heightM" | "txDbm" | "gainDbi" | "cableLossDb" | "presetId" | "clientHeightM"> & { antenna?: MeshNode["antenna"] }, lat: number, lon: number, name?: string) => ({
    lat: round6(lat),
    lon: round6(lon),
    heightM: n.heightM,
    txDbm: n.txDbm,
    gainDbi: n.gainDbi,
    cableLossDb: n.cableLossDb,
    presetId: n.presetId,
    clientHeightM: n.clientHeightM,
    ...(n.antenna && n.antenna.kind !== "omni" ? { pattern: n.antenna } : {}),
    ...(name ? { name } : {}),
  });
  return {
    kind: "placement" as const,
    area: { lat: round6(area.lat), lon: round6(area.lon), radiusKm: area.radiusKm },
    existing: existing.map((n) => nodeIn(n, n.lat, n.lon, n.name)),
    template: nodeIn(t, area.lat, area.lon),
    client: { heightM: 1.5, gainDbi: s.clientGainDbi, cableLossDb: s.clientCableLossDb },
    settings: {
      freqMhz: s.freqMhz,
      noiseFigureDb: s.noiseFigureDb,
      foliage: { scale: s.foliageScale, leafOn: s.foliageLeafOn },
      itm: {
        climate: s.itmClimate,
        n0: s.itmN0,
        epsilon: s.groundEpsilon,
        sigma: s.groundSigma,
        verticalPolarization: s.verticalPolarization,
        confidencePct: s.confidencePct,
        reliabilityPct: s.reliabilityPct,
      },
    },
    terrain: s.terrainMode,
    count: o.count,
    coverageRadiusKm: o.coverageRadiusKm,
    resolutionM: Math.max(100, Math.round((o.coverageRadiusKm * 1000) / 75 / 50) * 50),
    minSpacingKm: o.minSpacingKm,
    minReliefM: o.minReliefM,
    minGainKm2: o.minGainKm2,
    ...(o.backhaul ? { backhaul: o.backhaul } : {}),
  };
}

/** A circle on the ground as a closed ring of [lon, lat] points. */
export function circleRing(lat: number, lon: number, radiusKm: number, steps = 90): [number, number][] {
  const out: [number, number][] = [];
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (2 * Math.PI * i) / steps;
    out.push([lon + dLon * Math.sin(a), lat + dLat * Math.cos(a)]);
  }
  return out;
}

export function describeStop(r: PlacementResult): string {
  const n = r.suggestions.length;
  if (n === 0 && r.stoppedBecause === "backhaul") return "No high point has a good enough link back to your network (enough margin, and not blocked). Lower the margin, allow a longer link, or allow blocked paths.";
  if (n === 0) return "No site adds enough new coverage. Lower the minimum gain or widen the area.";
  if (r.stoppedBecause === "gain") return `Stopped after ${n}: the next best site would add less than the minimum gain.`;
  if (r.stoppedBecause === "backhaul") return `Stopped after ${n}: no remaining site has a good link to the network${n > 0 ? " and to the sites already chosen" : ""}.`;
  return n < r.requested ? `${n} of ${r.requested} sites.` : "";
}
