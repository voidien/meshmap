import { presetById } from "./engine/analysis";
import type { Link, MeshNode, Project } from "./types";

const COLORS: Record<string, string> = { clear: "#1a9850", marginal: "#e0a800", obstructed: "#d73027", none: "#888888" };

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows: (string | number)[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r = (x: number, d = 2) => Number(x.toFixed(d));

export function nodesCsv(nodes: MeshNode[]): string {
  return csv([
    ["name", "lat", "lon", "height_agl_m", "client_height_m", "tx_dbm", "gain_dbi", "cable_loss_db", "preset", "status", "notes"],
    ...nodes.map((n) => [n.name, n.lat, n.lon, n.heightM, n.clientHeightM, n.txDbm, n.gainDbi, n.cableLossDb, presetById(n.presetId).name, n.status, n.notes]),
  ]);
}

export function linksCsv(nodes: MeshNode[], links: Link[]): string {
  const name = new Map(nodes.map((n) => [n.id, n.name]));
  return csv([
    ["node_a", "node_b", "class", "distance_km", "fresnel_clearance_pct", "fspl_db", "diffraction_db", "path_loss_db", "margin_ab_db", "margin_ba_db", "margin_db", "warning"],
    ...links.map((l) => [
      name.get(l.a) ?? l.a, name.get(l.b) ?? l.b, l.class, r(l.distanceM / 1000, 3),
      l.result ? r(l.result.clearance_pct, 1) : "", l.result ? r(l.result.fspl_db) : "", l.result ? r(l.result.diffraction_db) : "",
      l.result ? r(l.result.path_loss_db) : "", l.result ? r(l.result.margin_ab_db) : "", l.result ? r(l.result.margin_ba_db) : "",
      l.result ? r(l.result.margin_db) : "", l.warning ?? "",
    ]),
  ]);
}

export function geojson(p: Project, links: Link[]): string {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const features: unknown[] = p.nodes.map((n) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [n.lon, n.lat] },
    properties: { kind: "node", name: n.name, height_agl_m: n.heightM, tx_dbm: n.txDbm, gain_dbi: n.gainDbi, cable_loss_db: n.cableLossDb, preset: n.presetId, status: n.status, notes: n.notes },
  }));
  for (const l of links) {
    const a = byId.get(l.a), b = byId.get(l.b);
    if (!a || !b) continue;
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
      properties: {
        kind: "link", node_a: a.name, node_b: b.name, class: l.class, distance_km: r(l.distanceM / 1000, 3),
        clearance_pct: l.result ? r(l.result.clearance_pct, 1) : null, margin_db: l.result ? r(l.result.margin_db) : null,
      },
    });
  }
  return JSON.stringify({ type: "FeatureCollection", features }, null, 2);
}

export function kml(p: Project, links: Link[]): string {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  // KML colours are aabbggrr
  const kmlColor = (hex: string) => "ff" + hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3);
  const styles = Object.entries(COLORS)
    .map(([k, c]) => `<Style id="${k}"><LineStyle><color>${kmlColor(c)}</color><width>3</width></LineStyle></Style>`)
    .join("");
  const nodes = p.nodes
    .map((n) => `<Placemark><name>${xml(n.name)}</name><description>${xml(`${n.status}; ${n.heightM} m AGL; ${n.txDbm} dBm; ${presetById(n.presetId).name}. ${n.notes}`)}</description><Point><coordinates>${n.lon},${n.lat},0</coordinates></Point></Placemark>`)
    .join("");
  const lines = links
    .map((l) => {
      const a = byId.get(l.a), b = byId.get(l.b);
      if (!a || !b) return "";
      const m = l.result ? `margin ${r(l.result.margin_db)} dB, clearance ${r(l.result.clearance_pct, 0)}%` : l.warning ?? "";
      return `<Placemark><name>${xml(`${a.name} – ${b.name}`)}</name><description>${xml(`${l.class}; ${r(l.distanceM / 1000, 2)} km; ${m}`)}</description><styleUrl>#${l.class}</styleUrl><LineString><tessellate>1</tessellate><coordinates>${a.lon},${a.lat},0 ${b.lon},${b.lat},0</coordinates></LineString></Placemark>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xml(p.name)}</name>${styles}<Folder><name>Nodes</name>${nodes}</Folder><Folder><name>Links (estimates)</name>${lines}</Folder></Document></kml>\n`;
}

export function download(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
