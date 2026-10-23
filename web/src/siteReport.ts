/** A printable one-node site report: location, equipment, expected links with profiles, field readings, comments, assumptions. */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describeAntenna, relGainDb } from "./antenna";
import { ago, type Comment, type FieldReading } from "./collab";
import { PolarPlot } from "./components/AntennaEditor";
import { ProfileSvg } from "./components/ProfileChart";
import { analyzeWithProfile, endpointOf, presetById, SPACING_FULL_M } from "./engine/analysis";
import { terrain } from "./engine/terrain";
import { bearingDeg, compass, fmtDistance } from "./fieldMath";
import type { Link, MeshNode, Project } from "./types";
import type { ProfileData } from "./engine/analysis";

export interface ReportInput {
  project: Project;
  node: MeshNode;
  /** every link of the project (this node's are picked out) */
  links: Link[];
  comments: Comment[];
  readings: FieldReading[];
  /** server heatmap numbers for this node, when computed */
  coverage?: { coveredKm2: number; predictedKm2: number; radiusKm: number; terrain?: string } | null;
  mapImage?: string | null;
  generatedBy: string;
  now?: Date;
}

const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f = (v: number, d = 1) => v.toFixed(d);
const MAX_PROFILES = 6;

function dms(v: number, pos: string, neg: string) {
  const a = Math.abs(v);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = ((a - d) * 60 - m) * 60;
  return `${d}°${String(m).padStart(2, "0")}'${s.toFixed(1).padStart(4, "0")}" ${v >= 0 ? pos : neg}`;
}

const CSS = `
body{font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#111;max-width:900px;margin:0 auto;padding:24px}
h1{font-size:24px;margin:0 0 2px}h2{font-size:16px;border-bottom:2px solid #222;padding-bottom:2px;margin:22px 0 8px}h3{font-size:14px;margin:12px 0 4px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #ccc;padding:3px 6px;text-align:left;vertical-align:top}th{background:#f3f4f6}
.meta{color:#555}.warn{background:#fffbeb;border:1px solid #fcd34d;padding:6px 8px;border-radius:6px}
.cls{display:inline-block;padding:0 6px;border-radius:4px;color:#fff;font-size:12px}.clear{background:#1a9850}.marginal{background:#c58f00}.obstructed{background:#d73027}.none{background:#6b7280}
.profile{width:100%;height:auto;border:1px solid #ddd;border-radius:4px}.tick{font-size:10px;fill:#555}.axis{font-size:11px;fill:#333}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}img.map{width:100%;border:1px solid #ccc;border-radius:4px}
.noprint{margin-bottom:12px}.link{page-break-inside:avoid;margin-bottom:14px}
.legend-line,.readout{display:none}
@media print{.noprint{display:none}body{padding:0}h2{break-after:avoid}}
`;

const clsBadge = (c: string) => `<span class="cls ${esc(c)}">${esc(c)}</span>`;

/** HTML for the report (a complete standalone page). */
export async function buildSiteReport(input: ReportInput): Promise<string> {
  const { project, node, comments, readings } = input;
  const s = project.settings;
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  const mine = input.links
    .filter((l) => (l.a === node.id || l.b === node.id) && l.result)
    .sort((x, y) => (y.result?.margin_db ?? -999) - (x.result?.margin_db ?? -999));
  const preset = presetById(node.presetId);
  const ground = (await terrain.profile([node.lat], [node.lon])).bare[0];
  const eirp = node.txDbm + node.gainDbi - node.cableLossDb;
  const now = input.now ?? new Date();

  // link detail: both directions, with the profile drawing for the strongest few
  const linkBlocks: string[] = [];
  const rows: string[] = [];
  let drawn = 0;
  for (const l of mine) {
    const other = byId.get(l.a === node.id ? l.b : l.a);
    if (!other || !l.result) continue;
    const r = l.result;
    const toOther = bearingDeg(node.lat, node.lon, other.lat, other.lon);
    const mineIsA = l.a === node.id;
    const outMargin = mineIsA ? r.margin_ab_db : r.margin_ba_db;
    const inMargin = mineIsA ? r.margin_ba_db : r.margin_ab_db;
    const pat = relGainDb(node.antenna, toOther);
    rows.push(
      `<tr><td>${esc(other.name.trim() || "(unnamed)")}</td><td>${fmtDistance(l.distanceM)}</td><td>${compass(toOther)} ${Math.round(toOther)}°${pat < -0.05 ? ` <span class="meta">(${f(pat)} dB antenna)</span>` : ""}</td><td>${clsBadge(l.class)}</td><td>${f(r.path_loss_db)} dB</td><td>${outMargin >= 0 ? "+" : ""}${f(outMargin)} / ${inMargin >= 0 ? "+" : ""}${f(inMargin)} dB</td><td>${r.clearance_pct < -100 ? "&lt; -100" : f(r.clearance_pct, 0)} %</td></tr>`,
    );
    if (drawn < MAX_PROFILES) {
      drawn++;
      try {
        const a = mineIsA ? node : other;
        const b = mineIsA ? other : node;
        const data: ProfileData = await analyzeWithProfile(a, b, s, SPACING_FULL_M, true);
        const svg = renderToStaticMarkup(createElement(ProfileSvg, { data, a, b, settings: s }));
        linkBlocks.push(
          `<div class="link"><h3>${esc(node.name.trim() || "Node")} ↔ ${esc(other.name.trim() || "(unnamed)")} · ${fmtDistance(l.distanceM)} ${clsBadge(data.result.class)}</h3>${svg}<div class="meta">Model: ${data.result.model === "itm" ? "Longley-Rice (ITM)" : "free space + knife-edge (ITM did not run)"} · worst clearance ${f(data.result.clearance_pct, 0)} % of the first Fresnel zone at ${f(data.result.worst_dist_m / 1000, 2)} km${data.result.obstruction_m > 0 ? `, ${f(data.result.obstruction_m, 0)} m of obstruction above the ray` : ""}${data.withClutter ? ` · bare earth ${data.bare.class}, with trees and buildings ${data.withClutter.class}` : ""}</div></div>`,
        );
      } catch {
        linkBlocks.push(`<div class="link"><h3>${esc(other.name)}</h3><p class="meta">The terrain profile could not be loaded.</p></div>`);
      }
    }
  }

  const nodeComments = comments.filter((c) => c.targetKind === "node" && c.targetRef === node.id);
  const nodeReadings = readings.filter((r) => r.nodeRef === node.id);
  const endpointSens = endpointOf(node, s).sensitivity_dbm;

  const mapHtml = input.mapImage ? `<img class="map" alt="Map around the site" src="${input.mapImage}">` : `<p class="meta">No map picture was available. Open the location in any map app using the coordinates.</p>`;
  const polar = node.antenna && node.antenna.kind !== "omni" ? renderToStaticMarkup(createElement(PolarPlot, { pattern: node.antenna, size: 150 })) : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Site report: ${esc(node.name)} (${esc(project.name)})</title><style>${CSS}</style></head><body>
<div class="noprint"><button onclick="window.print()">Print or save as PDF</button></div>
<h1>Site report: ${esc(node.name.trim() || "Node")}</h1>
<div class="meta">Project “${esc(project.name)}” · ${esc(node.status)} · prepared ${esc(now.toLocaleString())} by ${esc(input.generatedBy)}</div>
<p class="warn"><b>Estimates only.</b> Predictions come from a radio model (Longley-Rice) over public terrain data and have not been verified in the field unless readings are listed below. Walk the site before building.</p>

<h2>1. Location</h2>
<div class="two"><div>
<table><tr><th>Latitude</th><td>${f(node.lat, 6)} (${esc(dms(node.lat, "N", "S"))})</td></tr>
<tr><th>Longitude</th><td>${f(node.lon, 6)} (${esc(dms(node.lon, "E", "W"))})</td></tr>
<tr><th>Ground elevation</th><td>${f(ground, 0)} m (${f(ground * 3.28084, 0)} ft)</td></tr>
<tr><th>Antenna height above ground</th><td>${f(node.heightM, 1)} m (${f(node.heightM * 3.28084, 0)} ft)</td></tr>
<tr><th>Antenna height above sea level</th><td>${f(ground + node.heightM, 0)} m</td></tr>
<tr><th>Map link</th><td>openstreetmap.org/?mlat=${f(node.lat, 6)}&amp;mlon=${f(node.lon, 6)}#map=16/${f(node.lat, 5)}/${f(node.lon, 5)}</td></tr></table>
</div><div>${mapHtml}</div></div>
${node.notes.trim() ? `<h3>Notes</h3><p>${esc(node.notes).replace(/\n/g, "<br>")}</p>` : ""}

<h2>2. Equipment and radio</h2>
<div class="two"><div><table>
<tr><th>Radio settings</th><td>${esc(preset.name)} (SF${preset.sf}, ${preset.bw_khz} kHz)</td></tr>
<tr><th>Frequency</th><td>${esc(s.freqMhz)} MHz</td></tr>
<tr><th>TX power</th><td>${f(node.txDbm)} dBm (${f(10 ** (node.txDbm / 10) / 1000, 2)} W)</td></tr>
<tr><th>Antenna</th><td>${esc(describeAntenna(node.antenna, node.gainDbi))}</td></tr>
<tr><th>Cable and connector loss</th><td>${f(node.cableLossDb)} dB</td></tr>
<tr><th>EIRP (peak)</th><td>${f(eirp)} dBm</td></tr>
<tr><th>Receiver sensitivity</th><td>${f(endpointSens)} dBm (noise figure ${esc(s.noiseFigureDb)} dB)</td></tr>
<tr><th>Client device assumed</th><td>${esc(node.clientHeightM)} m high, ${esc(s.clientGainDbi)} dBi, ${esc(s.clientCableLossDb)} dB loss</td></tr></table></div>
<div>${polar ? `<div style="text-align:center">${polar}<div class="meta">Antenna pattern, north up</div></div>` : ""}</div></div>

<h2>3. Expected links (${mine.length})</h2>
${rows.length ? `<table><tr><th>To</th><th>Distance</th><th>Bearing</th><th>Class</th><th>Path loss</th><th>Margin out / in</th><th>Fresnel clear</th></tr>${rows.join("")}</table><p class="meta">Margin is signal above the receiver's sensitivity, from this node outward / into this node. Clear = comfortable margin and line of sight; marginal = works only with a good day; obstructed = blocked terrain.</p>` : `<p>No links to other nodes within ${esc(s.maxRangeKm)} km.</p>`}
${linkBlocks.length ? `<h2>4. Terrain profiles${mine.length > linkBlocks.length ? ` (strongest ${linkBlocks.length} of ${mine.length})` : ""}</h2>${linkBlocks.join("")}` : ""}

<h2>5. Coverage</h2>
${input.coverage ? `<p>Predicted coverage of this node alone: <b>${f(input.coverage.coveredKm2, 0)} km²</b> with a usable signal (of ${f(input.coverage.predictedKm2, 0)} km² analysed within ${esc(input.coverage.radiusKm)} km), for a client at ${esc(node.clientHeightM)} m. Terrain model: ${esc(input.coverage.terrain ?? "bare earth")}.</p>` : `<p class="meta">No coverage prediction has been computed for this node. Use “Predict” in the project and create the report again to include it.</p>`}

<h2>6. Field readings (${nodeReadings.length})</h2>
${nodeReadings.length ? `<table><tr><th>When</th><th>Where</th><th>RSSI</th><th>SNR</th><th>Note</th><th>By</th></tr>${nodeReadings.map((r) => `<tr><td>${esc(new Date(r.takenAt * 1000).toLocaleString())}</td><td>${f(r.lat, 5)}, ${f(r.lon, 5)}${r.accuracyM ? ` ±${Math.round(r.accuracyM)} m` : ""}</td><td>${r.rssiDbm ?? ""}</td><td>${r.snrDb ?? ""}</td><td>${esc(r.note)}</td><td>${esc(r.by ?? "")}</td></tr>`).join("")}</table>` : `<p class="meta">No readings have been recorded for this node.</p>`}

<h2>7. Comments (${nodeComments.length})</h2>
${nodeComments.length ? nodeComments.map((c) => `<p><b>${esc(c.author?.displayName ?? "a deleted account")}</b> <span class="meta">${esc(ago(c.createdAt))}${c.resolved ? " · resolved" : ""}</span><br>${esc(c.body).replace(/\n/g, "<br>")}</p>`).join("") : `<p class="meta">No comments on this node.</p>`}

<h2>8. Assumptions</h2>
<ul>
<li>Model: Longley-Rice / ITM point-to-point, climate ${esc(s.itmClimate)}, surface refractivity ${esc(s.itmN0)} N-units, ground ε ${esc(s.groundEpsilon)} / σ ${esc(s.groundSigma)} S/m, ${s.verticalPolarization ? "vertical" : "horizontal"} polarization, ${esc(s.reliabilityPct)} % reliability, ${esc(s.confidencePct)} % confidence.</li>
<li>Terrain: ${s.terrainMode === "clutter" ? "bare earth plus trees and buildings where a terrain data pack covers the path (no foliage loss), otherwise bare earth" : "bare earth only (no trees or buildings)"}; public ~30 m elevation data unless a higher-resolution pack is installed.</li>
<li>Earth radius factor k = ${esc(Number(s.k.toFixed(2)))} for clearance; “marginal” means less than ${esc(s.marginalMarginDb)} dB of margin or less than 60 % of the first Fresnel zone clear.</li>
<li>Antenna gain in each direction follows the pattern shown; the horizontal plane only. Mast flex, ice, cable aging, interference and local obstacles are not modelled.</li>
</ul>
</body></html>`;
}
