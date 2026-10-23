/**
 * MeshCore "coverage layers" JSON import/export.
 *
 * File shape (as written by the MeshCore app):
 *   { "layers": [ { letter, name, latitude, longitude, antenna_height_a, antenna_height_b } ], "overlays": [] }
 *
 * Mapping: antenna_height_a = the node's antenna height (m AGL); antenna_height_b = the height of the
 * client/receiver at the other end of coverage (m), kept as `clientHeightM`. `letter` and `overlays` are
 * preserved so an import followed by an export reproduces the file.
 */
import { uid } from "./id";
import type { MeshNode } from "./types";

export interface MeshcoreImport {
  nodes: MeshNode[];
  overlays: unknown[];
  skipped: number;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function isMeshcoreFile(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && Array.isArray((raw as { layers?: unknown }).layers);
}

export function importMeshcore(raw: unknown, makeId: () => string = uid): MeshcoreImport | null {
  if (!isMeshcoreFile(raw)) return null;
  const o = raw as { layers: Record<string, unknown>[]; overlays?: unknown };
  const nodes: MeshNode[] = [];
  let skipped = 0;
  for (const l of o.layers) {
    if (!l || !isNum(l.latitude) || !isNum(l.longitude) || Math.abs(l.latitude) > 90 || Math.abs(l.longitude) > 180) {
      skipped++;
      continue;
    }
    const letter = typeof l.letter === "string" && l.letter ? l.letter : undefined;
    nodes.push({
      id: makeId(),
      letter,
      name: typeof l.name === "string" && l.name !== "" ? l.name : letter ? `Point ${letter}` : `Node ${nodes.length + 1}`,
      lat: l.latitude,
      lon: l.longitude,
      heightM: isNum(l.antenna_height_a) ? l.antenna_height_a : 5,
      clientHeightM: isNum(l.antenna_height_b) ? l.antenna_height_b : 1,
      txDbm: 22,
      gainDbi: 3,
      cableLossDb: 0.5,
      presetId: "meshcore_us",
      status: "planned",
      notes: "",
    });
  }
  return { nodes, overlays: Array.isArray(o.overlays) ? o.overlays : [], skipped };
}

/** A, B, ... Z, AA, AB, ... */
export function letterFor(index: number): string {
  let s = "";
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

export function exportMeshcore(nodes: MeshNode[], overlays: unknown[] = []): string {
  const used = new Set(nodes.map((n) => n.letter).filter((l): l is string => !!l));
  // a repeated letter (e.g. after copy/paste of nodes) is treated as unassigned
  const seen = new Set<string>();
  let next = 0;
  const free = () => {
    while (used.has(letterFor(next))) next++;
    const l = letterFor(next++);
    used.add(l);
    return l;
  };
  const layers = nodes.map((n) => {
    let letter = n.letter;
    if (!letter || seen.has(letter)) letter = free();
    seen.add(letter);
    return {
      letter,
      name: n.name,
      latitude: n.lat,
      longitude: n.lon,
      antenna_height_a: n.heightM,
      antenna_height_b: n.clientHeightM,
    };
  });
  return JSON.stringify({ layers, overlays }, null, 2) + "\n";
}
