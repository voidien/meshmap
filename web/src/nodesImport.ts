/** Reading nodes from a CSV (the file "Nodes CSV" writes, plus a tags column, or a plain list of name, lat, lon). */
import { splitLine } from "./readingsImport";
import { cleanTags, newNodeFor } from "./workspace";
import type { MeshNode, NodeStatus, Settings } from "./types";

export interface ParsedNode {
  row: number;
  name: string;
  lat: number;
  lon: number;
  /** only the fields the file gave */
  fields: Partial<Pick<MeshNode, "heightM" | "clientHeightM" | "txDbm" | "gainDbi" | "cableLossDb" | "presetId" | "status" | "notes" | "tags">>;
}

export interface NodesParse {
  nodes: ParsedNode[];
  /** rows that cannot be used, and notes about values that were ignored */
  errors: string[];
  warnings: string[];
}

const ALIASES: Record<string, string[]> = {
  name: ["name", "node", "node_name", "site", "label"],
  lat: ["lat", "latitude"],
  lon: ["lon", "lng", "long", "longitude"],
  heightM: ["height_agl_m", "height_m", "height", "antenna_height_m", "mast_m"],
  clientHeightM: ["client_height_m", "client_height", "receiver_height_m"],
  txDbm: ["tx_dbm", "tx_power_dbm", "tx"],
  gainDbi: ["gain_dbi", "antenna_gain_dbi", "gain"],
  cableLossDb: ["cable_loss_db", "cable_loss", "cable_db"],
  antenna: ["antenna", "antenna_kind"],
  preset: ["preset", "radio", "radio_settings"],
  status: ["status", "state"],
  notes: ["notes", "note", "comment", "comments"],
  tags: ["tags", "tag", "groups", "group"],
};

/**
 * Parse CSV text. `resolvePreset` turns the text of a radio column (an id or a name) into a radio setting id, or null when it means nothing.
 * Needs a header row with at least name, latitude and longitude.
 */
export function parseNodesCsv(text: string, resolvePreset: (s: string) => string | null): NodesParse {
  const out: NodesParse = { nodes: [], errors: [], warnings: [] };
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) {
    out.errors.push("The file needs a header row and at least one node.");
    return out;
  }
  const delim = [",", ";", "\t"].map((d) => [d, lines[0].split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const header = splitLine(lines[0], delim).map((h) => h.toLowerCase().trim());
  const c = Object.fromEntries(Object.entries(ALIASES).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))])) as Record<string, number>;
  if (c.name < 0 || c.lat < 0 || c.lon < 0) {
    out.errors.push("The header needs name, latitude and longitude columns (for example: name,lat,lon,height_agl_m).");
    return out;
  }
  let ignoredAntenna = 0;
  let unknownRadio = 0;
  for (let i = 1; i < lines.length; i++) {
    const f = splitLine(lines[i], delim);
    const at = (k: string) => (c[k] >= 0 ? (f[c[k]] ?? "").trim() : "");
    const row = i + 1;
    const lat = Number(at("lat"));
    const lon = Number(at("lon"));
    if (at("lat") === "" || at("lon") === "" || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      out.errors.push(`row ${row}: missing or invalid position`);
      continue;
    }
    const fields: ParsedNode["fields"] = {};
    for (const [k, lo, hi, label] of [["heightM", 0, 500, "height"], ["clientHeightM", 0, 100, "client height"], ["txDbm", -10, 36, "TX power"], ["gainDbi", -10, 40, "antenna gain"], ["cableLossDb", 0, 30, "cable loss"]] as const) {
      const raw = at(k);
      if (raw === "") continue;
      const v = Number(raw);
      if (!Number.isFinite(v) || v < lo || v > hi) out.warnings.push(`row ${row}: ${label} "${raw}" is not between ${lo} and ${hi}; left at the default`);
      else fields[k] = v;
    }
    const radio = at("preset");
    if (radio) {
      const id = resolvePreset(radio);
      if (id) fields.presetId = id;
      else unknownRadio++;
    }
    const st = at("status").toLowerCase();
    if (st === "planned" || st === "installed") fields.status = st as NodeStatus;
    if (at("notes")) fields.notes = at("notes").slice(0, 2000);
    const tags = cleanTags(at("tags").split(/[;|]/));
    if (tags) fields.tags = tags;
    const ant = at("antenna").toLowerCase();
    if (ant && ant !== "omni" && ant !== "omnidirectional") ignoredAntenna++;
    out.nodes.push({ row, name: at("name") || `Node ${out.nodes.length + 1}`, lat, lon, fields });
  }
  if (unknownRadio) out.warnings.push(`${unknownRadio} row${unknownRadio === 1 ? " has" : "s have"} radio settings I do not recognise; they get the project's default radio`);
  if (ignoredAntenna) out.warnings.push(`${ignoredAntenna} row${ignoredAntenna === 1 ? " has" : "s have"} a directional antenna; antenna patterns are not imported, set them in the node panel`);
  return out;
}

export interface ImportPlan {
  add: MeshNode[];
  update: { id: string; name: string; patch: Partial<MeshNode> }[];
}

/**
 * What an import would do. "add": every row becomes a new node (a name already in use gets " 2", " 3"...). "update": a row whose name
 * matches an existing node (ignoring case) changes that node's position and the fields the file gave; the rest are added.
 */
export function planImport(parsed: ParsedNode[], existing: MeshNode[], settings: Settings, mode: "add" | "update"): ImportPlan {
  const plan: ImportPlan = { add: [], update: [] };
  const byName = new Map(existing.map((n) => [n.name.trim().toLowerCase(), n]));
  const used = new Set(byName.keys());
  for (const p of parsed) {
    const key = p.name.trim().toLowerCase();
    const match = mode === "update" ? byName.get(key) : undefined;
    if (match) {
      plan.update.push({ id: match.id, name: match.name, patch: { lat: p.lat, lon: p.lon, ...p.fields } });
      continue;
    }
    let name = p.name.trim() || "Node";
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${p.name.trim() || "Node"} ${k}`;
    used.add(name.toLowerCase());
    plan.add.push({ ...newNodeFor(settings, p.lat, p.lon, name), ...p.fields });
  }
  return plan;
}
