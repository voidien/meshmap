/** Antenna patterns: gain by compass bearing, importing pattern files, and the polar shape for drawing. Mirrors `meshmap-core::antenna`. */
import type { AntennaPattern } from "./types";

export const TABLE_LEN = 360;
const wrap180 = (d: number) => {
  const x = ((d % 360) + 360) % 360;
  return x > 180 ? x - 360 : x;
};

/** Gain toward `bearing` relative to the peak, dB (<= 0). */
export function relGainDb(p: AntennaPattern | undefined, bearing: number): number {
  if (!p || p.kind === "omni") return 0;
  if (p.kind === "directional") {
    const off = Math.abs(wrap180(bearing - p.azimuthDeg));
    return 0 - Math.min(12 * (off / p.beamwidthDeg) ** 2, p.frontToBackDb);
  }
  if (p.gainsDb.length !== TABLE_LEN) return 0;
  const a = (((bearing - p.azimuthDeg) % 360) + 360) % 360;
  const i = Math.floor(a);
  const t = a - i;
  return p.gainsDb[i % TABLE_LEN] * (1 - t) + p.gainsDb[(i + 1) % TABLE_LEN] * t;
}

export const isOmni = (p: AntennaPattern | undefined) => !p || p.kind === "omni";

/** Check an untrusted pattern (a saved project, a shared file) and return a clean copy, or undefined for omni/invalid. */
export function cleanAntenna(raw: unknown): AntennaPattern | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const f = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (o.kind === "directional" && f(o.azimuthDeg) && f(o.beamwidthDeg) && f(o.frontToBackDb)) {
    const bw = o.beamwidthDeg as number;
    const fb = o.frontToBackDb as number;
    if (bw >= 1 && bw <= 360 && fb >= 0 && fb <= 60) return { kind: "directional", azimuthDeg: ((o.azimuthDeg as number) % 360 + 360) % 360, beamwidthDeg: bw, frontToBackDb: fb };
  }
  if (o.kind === "table" && f(o.azimuthDeg) && Array.isArray(o.gainsDb) && o.gainsDb.length === TABLE_LEN && o.gainsDb.every((g) => f(g) && (g as number) <= 0.001 && (g as number) >= -60)) {
    return { kind: "table", azimuthDeg: ((o.azimuthDeg as number) % 360 + 360) % 360, gainsDb: (o.gainsDb as number[]).map((g) => Math.min(0, g)) };
  }
  return undefined;
}

export interface ParsedPattern {
  /** 360 values, 1 degree steps clockwise from the antenna's forward direction, dB relative to the peak. */
  gainsDb: number[];
  /** Peak gain stated in the file, dBi, when there is one. */
  peakGainDbi?: number;
  format: "msi" | "csv";
  name?: string;
}

/** Spread (angle, value) pairs over 360 one-degree steps, interpolating around the circle. */
function resample(points: [number, number][]): number[] {
  const pts = points.map(([a, v]) => [((a % 360) + 360) % 360, v] as [number, number]).sort((x, y) => x[0] - y[0]);
  if (pts.length < 4) throw new Error("A pattern needs at least 4 angles.");
  const out: number[] = [];
  for (let d = 0; d < 360; d++) {
    let hi = pts.findIndex((p) => p[0] >= d);
    if (hi === -1) hi = 0;
    const lo = (hi - 1 + pts.length) % pts.length;
    const a0 = pts[lo][0] - (pts[lo][0] > pts[hi][0] ? 360 : 0);
    const a1 = pts[hi][0];
    const t = a1 === a0 ? 0 : (d - a0) / (a1 - a0);
    out.push(pts[lo][1] * (1 - t) + pts[hi][1] * t);
  }
  return out;
}

const toRelative = (vals: number[]) => {
  const peak = Math.max(...vals);
  return vals.map((v) => Math.max(-60, Math.min(0, v - peak)));
};

/**
 * Read a pattern file. Understands MSI Planet / PLN files (HORIZONTAL block, values are attenuation in dB) and plain
 * CSV / text with `angle, gain` per line (gain in dBi or dB relative to the peak; any header lines are skipped).
 */
export function parsePatternFile(text: string, filename = ""): ParsedPattern {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const hIdx = lines.findIndex((l) => /^horizontal\b/i.test(l));
  if (hIdx >= 0) {
    const count = parseInt(lines[hIdx].split(/\s+/)[1] ?? "360", 10);
    const pts: [number, number][] = [];
    for (const l of lines.slice(hIdx + 1, hIdx + 1 + (Number.isFinite(count) ? count : 360))) {
      const [a, v] = l.split(/[\s,;]+/).map(Number);
      if (Number.isFinite(a) && Number.isFinite(v)) pts.push([a, -v]); // MSI lists attenuation: bigger = weaker
    }
    const gain = lines.map((l) => /^gain\s+(-?[\d.]+)\s*(dBd|dBi)?/i.exec(l)).find(Boolean);
    const peak = gain ? Number(gain[1]) + (/dBd/i.test(gain[2] ?? "") ? 2.15 : 0) : undefined;
    const name = lines.map((l) => /^name\s+(.+)/i.exec(l)).find(Boolean)?.[1];
    return { gainsDb: toRelative(resample(pts)), peakGainDbi: peak, format: "msi", name: name ?? filename.replace(/\.[^.]+$/, "") };
  }
  const pts: [number, number][] = [];
  for (const l of lines) {
    const parts = l.split(/[\s,;\t]+/);
    if (parts.length < 2) continue;
    const [a, v] = [Number(parts[0]), Number(parts[1])];
    if (Number.isFinite(a) && Number.isFinite(v)) pts.push([a, v]);
  }
  if (pts.length < 4) throw new Error("Could not find angle and gain columns. Use lines like \"0, 2.1\" or an MSI Planet file.");
  return { gainsDb: toRelative(resample(pts)), format: "csv", name: filename.replace(/\.[^.]+$/, "") };
}

/** Points of the pattern's outline for a polar plot of radius `r`: 0 dB at the rim, `floorDb` at the centre. */
export function polarPoints(p: AntennaPattern | undefined, r: number, floorDb = -30, steps = 180): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const b = (360 * i) / steps;
    const g = Math.max(floorDb, relGainDb(p, b));
    const rad = r * (1 - g / floorDb);
    const t = (b * Math.PI) / 180;
    out.push([rad * Math.sin(t), -rad * Math.cos(t)]); // north up, clockwise
  }
  return out;
}

/** A short description for lists and reports. */
export function describeAntenna(p: AntennaPattern | undefined, gainDbi: number): string {
  if (!p || p.kind === "omni") return `Omni, ${gainDbi} dBi`;
  if (p.kind === "directional") return `Directional ${gainDbi} dBi, pointing ${Math.round(p.azimuthDeg)}°, ${Math.round(p.beamwidthDeg)}° beam, ${Math.round(p.frontToBackDb)} dB front-to-back`;
  return `Imported pattern, ${gainDbi} dBi peak, pointing ${Math.round(p.azimuthDeg)}°`;
}
