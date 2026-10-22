/** Coverage heatmap jobs: building requests for the server and describing their results. */
import type { MeshNode, Settings } from "./types";

export interface CoverageResult {
  kind: "coverage_node" | "coverage_network";
  hash: string;
  bounds: { west: number; south: number; east: number; north: number };
  width: number;
  height: number;
  images: { margin: string; count?: string };
  stats: { coveredKm2: number; redundantKm2: number; predictedKm2: number };
  nodes: number;
}

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobInfo {
  id: string;
  projectId: string;
  kind: string;
  state: JobState;
  progress: number;
  message: string;
  error: string | null;
  result: CoverageResult | null;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function coverageRequest(kind: "coverage_node" | "coverage_network", nodes: MeshNode[], s: Settings) {
  return {
    kind,
    nodes: nodes.map((n) => ({
      lat: round6(n.lat),
      lon: round6(n.lon),
      heightM: n.heightM,
      txDbm: n.txDbm,
      gainDbi: n.gainDbi,
      cableLossDb: n.cableLossDb,
      presetId: n.presetId,
      clientHeightM: n.clientHeightM,
    })),
    client: { heightM: 1.5, gainDbi: s.clientGainDbi, cableLossDb: s.clientCableLossDb },
    settings: {
      freqMhz: s.freqMhz,
      noiseFigureDb: s.noiseFigureDb,
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
    radiusKm: s.coverageRadiusKm,
    resolutionM: s.coverageResolutionM,
  };
}

/** Identifies the inputs of a request; a layer is out of date when this differs from the current project's. Node order doesn't matter. */
export function requestSig(req: ReturnType<typeof coverageRequest>): string {
  return JSON.stringify({ ...req, nodes: req.nodes.map((n) => JSON.stringify(n)).sort() });
}

export const LEGEND: { label: string; color: string }[] = [
  { label: "0-5 dB", color: "rgb(215,48,39)" },
  { label: "5-10 dB", color: "rgb(252,141,89)" },
  { label: "10-20 dB", color: "rgb(254,224,139)" },
  { label: "20-30 dB", color: "rgb(145,207,96)" },
  { label: "30+ dB", color: "rgb(26,152,80)" },
];
