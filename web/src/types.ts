export type NodeStatus = "planned" | "installed";
export type LinkClass = "clear" | "marginal" | "obstructed" | "none";

export interface MeshNode {
  id: string;
  /** MeshCore layer letter (A, B, ...), kept so MeshCore files round-trip. */
  letter?: string;
  name: string;
  lat: number;
  lon: number;
  /** Antenna height above ground level (m). */
  heightM: number;
  /** Height of the client/receiver at the far end of coverage (m); MeshCore antenna_height_b. */
  clientHeightM: number;
  txDbm: number;
  gainDbi: number;
  cableLossDb: number;
  presetId: string;
  status: NodeStatus;
  notes: string;
}

export interface Settings {
  freqMhz: number;
  k: number;
  maxRangeKm: number;
  marginalMarginDb: number;
  noiseFigureDb: number;
  showNone: boolean;
  /** Longley-Rice (ITM) environment. */
  itmClimate: number;
  /** Surface refractivity reduced to sea level (N-units). */
  itmN0: number;
  groundEpsilon: number;
  groundSigma: number;
  verticalPolarization: boolean;
  /** Percent of situations / time the predicted loss is not exceeded (50 = median). */
  confidencePct: number;
  reliabilityPct: number;
}

export type ProjectRole = "owner" | "editor" | "viewer";

export interface Person {
  id: string;
  username: string;
  displayName: string;
}

export interface Member extends Person {
  role: "editor" | "viewer";
}

export interface Project {
  id: string;
  name: string;
  /** The signed-in user's role on this project (set for projects loaded from the server). */
  role?: ProjectRole;
  revision?: number;
  owner?: Person;
  members?: Member[];
  updatedBy?: string | null;
  nodes: MeshNode[];
  settings: Settings;
  /** Opaque MeshCore "overlays" passed through unchanged. */
  overlays?: unknown[];
}

export interface Preset {
  id: string;
  name: string;
  sf: number;
  bw_khz: number;
}

/** Result of `analyze_link` in the WASM core (snake_case as emitted by serde). */
export interface LinkResult {
  distance_m: number;
  fspl_db: number;
  diffraction_db: number;
  path_loss_db: number;
  model: "itm" | "knife_edge";
  itm: { loss_db: number; mode: string; warnings: string[]; a_ref_db: number; delta_h_m: number } | null;
  itm_error: string | null;
  clearance_pct: number;
  worst_index: number;
  worst_dist_m: number;
  obstruction_m: number;
  rx_ab_dbm: number;
  rx_ba_dbm: number;
  margin_ab_db: number;
  margin_ba_db: number;
  margin_db: number;
  fspl_margin_db: number;
  class: LinkClass;
  series: { terrain_eff_m: number[]; ray_m: number[]; fresnel_m: number[] };
}

export interface Link {
  /** `${nodeA.id}|${nodeB.id}` with ids sorted. */
  key: string;
  a: string;
  b: string;
  class: LinkClass;
  distanceM: number;
  /** Absent for links classified without terrain (`none`). */
  result?: LinkResult;
  warning?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  freqMhz: 915,
  k: 4 / 3,
  maxRangeKm: 50,
  marginalMarginDb: 10,
  noiseFigureDb: 6,
  showNone: false,
  itmClimate: 5,
  itmN0: 301,
  groundEpsilon: 15,
  groundSigma: 0.005,
  verticalPolarization: true,
  confidencePct: 50,
  reliabilityPct: 50,
};
