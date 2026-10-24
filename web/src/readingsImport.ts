/** Reading field measurements from a CSV: a phone GPS logger plus signal values written down or exported from a radio's app. */
import { newReadingId, type NewReading } from "./fieldQueue";
import type { MeshNode } from "./types";

export interface ImportResult {
  readings: NewReading[];
  /** rows that could not be used, with the reason */
  errors: string[];
  /** rows whose node name matched none of the project's nodes */
  unmatchedNodes: number;
}

const ALIASES: Record<string, string[]> = {
  lat: ["lat", "latitude"],
  lon: ["lon", "lng", "long", "longitude"],
  rssi: ["rssi", "rssi_dbm", "rssi (dbm)", "rssidbm"],
  snr: ["snr", "snr_db", "snr (db)", "snrdb"],
  note: ["note", "notes", "comment", "comments"],
  node: ["node", "node_name", "heard_from", "from", "repeater"],
  time: ["time", "timestamp", "taken_at", "taken_at_utc", "date", "datetime"],
  accuracy: ["accuracy", "accuracy_m", "gps_accuracy_m", "gps_accuracy"],
};

export function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"', i++);
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) (out.push(cur), (cur = ""));
    else cur += c;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

function parseTime(v: string | undefined, nowS: number): number {
  if (!v) return nowS;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.round(n > 1e11 ? n / 1000 : n); // seconds or milliseconds
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.round(t / 1000) : nowS;
}

/** Parse CSV text into readings for the project. Needs a header row with at least latitude, longitude and an RSSI or SNR column. */
export function parseReadingsCsv(text: string, nodes: MeshNode[], nowSeconds = Math.round(Date.now() / 1000)): ImportResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const out: ImportResult = { readings: [], errors: [], unmatchedNodes: 0 };
  if (lines.length < 2) {
    out.errors.push("The file needs a header row and at least one reading.");
    return out;
  }
  const delim = [",", ";", "\t"].map((d) => [d, lines[0].split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const header = splitLine(lines[0], delim).map((h) => h.toLowerCase());
  const col = (key: string) => header.findIndex((h) => ALIASES[key].includes(h));
  const c = Object.fromEntries(Object.keys(ALIASES).map((k) => [k, col(k)])) as Record<string, number>;
  if (c.lat < 0 || c.lon < 0 || (c.rssi < 0 && c.snr < 0)) {
    out.errors.push("The header needs latitude and longitude columns and an RSSI or SNR column (for example: lat,lon,rssi,snr,node,note).");
    return out;
  }
  const byName = new Map(nodes.flatMap((n) => [[n.name.trim().toLowerCase(), n.id] as const, [n.id, n.id] as const]));
  for (let i = 1; i < lines.length; i++) {
    const f = splitLine(lines[i], delim);
    const at = (k: string) => (c[k] >= 0 ? f[c[k]] : undefined);
    const num = (k: string) => {
      const v = at(k);
      return v === undefined || v === "" ? null : Number(v);
    };
    const row = `row ${i + 1}`;
    const lat = num("lat");
    const lon = num("lon");
    const rssi = num("rssi");
    const snr = num("snr");
    if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      out.errors.push(`${row}: missing or invalid position`);
      continue;
    }
    if ((rssi !== null && !(rssi <= 0 && rssi >= -200)) || (snr !== null && !(Math.abs(snr) <= 50))) {
      out.errors.push(`${row}: RSSI must be a negative dBm value and SNR within ±50 dB`);
      continue;
    }
    if (rssi === null && snr === null) {
      out.errors.push(`${row}: no signal value`);
      continue;
    }
    const nodeName = at("node");
    const nodeRef = nodeName ? byName.get(nodeName.trim().toLowerCase()) ?? null : null;
    if (nodeName && !nodeRef) out.unmatchedNodes++;
    const acc = num("accuracy");
    out.readings.push({
      id: newReadingId(),
      nodeRef,
      lat,
      lon,
      accuracyM: acc !== null && Number.isFinite(acc) ? acc : null,
      rssiDbm: rssi,
      snrDb: snr,
      note: (at("note") ?? "").slice(0, 500),
      takenAt: parseTime(at("time"), nowSeconds),
    });
  }
  return out;
}
