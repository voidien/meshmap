/** Horizontal antenna pattern (gain relative to the antenna's peak); omni when a node has none. */
export type AntennaPattern =
  | { kind: "omni" }
  | { kind: "directional"; azimuthDeg: number; beamwidthDeg: number; frontToBackDb: number }
  | { kind: "table"; azimuthDeg: number; gainsDb: number[] };

import type { Network } from "./networks";

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
  /** Absent = omni. */
  antenna?: AntennaPattern;
  /** Connects the mesh to the outside (an internet or MQTT uplink); used by mesh health. */
  gateway?: boolean;
  presetId: string;
  status: NodeStatus;
  notes: string;
}

export interface Settings {
  /** The mesh software the project is planned for: sets the radio settings new nodes start with. */
  network: Network;
  freqMhz: number;
  k: number;
  maxRangeKm: number;
  /** A link with less spare signal than this is "marginal" (default 10 dB). */
  marginalMarginDb: number;
  /** A link counts as usable (for mesh health and for suggested sites' links) from this much spare signal (default 6 dB). */
  usableMarginDb: number;
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
  /** Coverage heatmaps (server jobs). */
  coverageRadiusKm: number;
  coverageResolutionM: number;
  /** The client device a heatmap is predicted for (its height comes from each node's "client height"). */
  clientGainDbi: number;
  clientCableLossDb: number;
  /** Which ground model drives link colours and numbers: bare earth only, or terrain plus trees/buildings where a data pack has them. */
  terrainMode: TerrainMode;
  /** Foliage loss multiplier (1 = the published model); calibrate it with field readings. */
  foliageScale: number;
  /** Trees in leaf (true) or bare (false). */
  foliageLeafOn: boolean;
  /** What a node placed on the map starts with (the radio comes from the network). Factory values when absent. */
  nodeDefaults?: NodeDefaults;
}

export interface NodeDefaults {
  heightM: number;
  clientHeightM: number;
  txDbm: number;
  gainDbi: number;
  cableLossDb: number;
}

/** bare earth only; trees and buildings as solid obstacles; or bare earth plus foliage loss for the path through trees */
export type TerrainMode = "bare" | "clutter" | "foliage";

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
  /** "meshcore", "reticulum", "meshtastic", or "custom" for a setting written as lora:<sf>:<bw> */
  family: string;
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
  /** Foliage loss included in the path loss (foliage result only), dB. */
  foliage_db?: number;
  /** Length of the ray inside trees/buildings that the foliage loss was computed for, metres. */
  foliage_depth_m?: number;
  series: { terrain_eff_m: number[]; ray_m: number[]; fresnel_m: number[] };
}

export interface Link {
  /** `${nodeA.id}|${nodeB.id}` with ids sorted. */
  key: string;
  a: string;
  b: string;
  class: LinkClass;
  distanceM: number;
  /** Result for the selected terrain mode; absent for links classified without terrain (`none`). */
  result?: LinkResult;
  /** Bare-earth result. */
  bare?: LinkResult;
  /** Terrain + clutter (solid) result; absent when no clutter data covers the path. */
  clutter?: LinkResult;
  /** Bare earth + foliage loss; absent when no clutter data covers the path. */
  foliage?: LinkResult;
  /** The path has clutter data (so `clutter` is meaningful). */
  hasClutter?: boolean;
  warning?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  network: "meshcore",
  freqMhz: 910.525,
  k: 4 / 3,
  maxRangeKm: 50,
  marginalMarginDb: 10,
  usableMarginDb: 6,
  noiseFigureDb: 6,
  showNone: false,
  itmClimate: 5,
  itmN0: 301,
  groundEpsilon: 15,
  groundSigma: 0.005,
  verticalPolarization: true,
  confidencePct: 50,
  reliabilityPct: 50,
  coverageRadiusKm: 25,
  coverageResolutionM: 100,
  clientGainDbi: 0,
  clientCableLossDb: 0,
  terrainMode: "foliage",
  foliageScale: 1,
  foliageLeafOn: true,
};
