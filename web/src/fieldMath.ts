import type { FieldReading } from "./collab";
import type { MeshNode } from "./types";

export type DeltaClass = "good" | "weak" | "bad" | "unknown";

/** Measured minus predicted signal: how the real world compares with the model. */
export function deltaClass(deltaDb: number | null): DeltaClass {
  if (deltaDb === null) return "unknown";
  if (deltaDb >= -3) return "good";
  if (deltaDb >= -10) return "weak";
  return "bad";
}

export const DELTA_COLORS: Record<DeltaClass, string> = { good: "#1a9850", weak: "#e0a800", bad: "#d73027", unknown: "#6b7280" };

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export interface Nearby {
  node: MeshNode;
  distanceM: number;
  bearing: number;
}

/** The closest nodes to a position, nearest first. */
export function nearestNodes(nodes: MeshNode[], lat: number, lon: number, limit = 4): Nearby[] {
  return nodes
    .map((node) => ({ node, distanceM: distanceM(lat, lon, node.lat, node.lon), bearing: bearingDeg(lat, lon, node.lat, node.lon) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit);
}

export const compass = (deg: number) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];

export function fmtDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

export interface ReadingRow extends FieldReading {
  nodeName: string;
  predictedRssiDbm: number | null;
  deltaDb: number | null;
}

const q = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function readingsCsv(rows: ReadingRow[]): string {
  const head = ["taken_at_utc", "node", "lat", "lon", "gps_accuracy_m", "rssi_dbm", "snr_db", "predicted_rssi_dbm", "measured_minus_predicted_db", "note", "recorded_by"];
  const lines = rows.map((r) =>
    [new Date(r.takenAt * 1000).toISOString(), r.nodeName, r.lat, r.lon, r.accuracyM ?? "", r.rssiDbm ?? "", r.snrDb ?? "", r.predictedRssiDbm === null ? "" : r.predictedRssiDbm.toFixed(1), r.deltaDb === null ? "" : r.deltaDb.toFixed(1), r.note, r.by ?? ""].map(q).join(","),
  );
  return [head.join(","), ...lines].join("\n") + "\n";
}
