export type NodeStatus = "planned" | "installed";
export type LinkClass = "clear" | "marginal" | "obstructed" | "none";

export interface MeshNode {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Antenna height above ground level (m). */
  heightM: number;
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
}

export interface Project {
  name: string;
  nodes: MeshNode[];
  settings: Settings;
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
};
