/** Predictions for a spot on the ground (a phone, a test receiver): what a node's signal should be there. */
import type { MeshNode, Settings } from "../types";
import { analyzeWithProfile, SPACING_FAST_M } from "./analysis";

/** A stand-in node for the phone: where the person stands, with a client radio like the project's heatmaps assume. */
export function phoneAt(lat: number, lon: number, like: MeshNode, s: Settings): MeshNode {
  return { id: "phone", name: "You", lat, lon, heightM: like.clientHeightM || 1.5, clientHeightM: like.clientHeightM, txDbm: like.txDbm, gainDbi: s.clientGainDbi, cableLossDb: s.clientCableLossDb, presetId: like.presetId, status: "planned", notes: "" };
}

export interface SpotPrediction {
  /** signal from the node at the spot, dBm, for the selected terrain model */
  rssi: number;
  margin: number;
  cls: string;
  /** the same over bare earth, dBm */
  bareRssi: number;
  /** Fresnel clearance over bare earth, percent (negative: terrain blocks the ray) */
  bareClearancePct: number;
  /** length of the ray inside trees and buildings, metres (null: no clutter data on the path) */
  clutterDepthM: number | null;
  /** distance from the node, metres */
  distanceM: number;
}

/** What `node` should deliver at (lat, lon): the headline value and the bare-earth one, and how much tree the ray crosses. */
export async function predictAt(node: MeshNode, lat: number, lon: number, s: Settings): Promise<SpotPrediction> {
  const d = await analyzeWithProfile(node, phoneAt(lat, lon, node, s), s, SPACING_FAST_M, false);
  return {
    rssi: d.result.rx_ab_dbm,
    margin: d.result.margin_ab_db,
    cls: d.result.class,
    bareRssi: d.bare.rx_ab_dbm,
    bareClearancePct: d.bare.clearance_pct,
    clutterDepthM: d.withFoliage ? d.withFoliage.foliage_depth_m ?? 0 : null,
    distanceM: d.result.distance_m,
  };
}
