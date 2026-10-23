import { describe, expect, it } from "vitest";
import { cleanAntenna, describeAntenna, parsePatternFile, polarPoints, relGainDb } from "./antenna";

const yagi = { kind: "directional", azimuthDeg: 90, beamwidthDeg: 60, frontToBackDb: 20 } as const;

describe("antenna patterns", () => {
  it("matches the Rust core on the same cases", () => {
    expect(relGainDb(undefined, 123)).toBe(0);
    expect(relGainDb(yagi, 90)).toBe(0);
    expect(relGainDb(yagi, 120)).toBeCloseTo(-3, 9);
    expect(relGainDb(yagi, 60)).toBeCloseTo(-3, 9);
    expect(relGainDb(yagi, 270)).toBe(-20);
    const wrap = { kind: "directional", azimuthDeg: 350, beamwidthDeg: 60, frontToBackDb: 25 } as const;
    expect(relGainDb(wrap, 20)).toBeCloseTo(relGainDb(wrap, 320), 9);
  });

  it("rotates and interpolates tables", () => {
    const g = new Array(360).fill(-30);
    g[0] = 0;
    g[1] = -10;
    const t = { kind: "table", azimuthDeg: 100, gainsDb: g } as const;
    expect(relGainDb(t, 100)).toBe(0);
    expect(relGainDb(t, 100.5)).toBeCloseTo(-5, 9);
    expect(relGainDb(t, 99.5)).toBeCloseTo(-15, 9);
  });

  it("reads an MSI Planet file (attenuation values) and normalises to the peak", () => {
    const rows = Array.from({ length: 360 }, (_, a) => `${a} ${a === 0 ? 0 : a < 30 || a > 330 ? 3 : 20}`).join("\n");
    const msi = `NAME Test Yagi\nFREQUENCY 915\nGAIN 9.5 dBd\nHORIZONTAL 360\n${rows}\nVERTICAL 360\n0 0\n`;
    const p = parsePatternFile(msi, "yagi.msi");
    expect(p.format).toBe("msi");
    expect(p.name).toBe("Test Yagi");
    expect(p.peakGainDbi).toBeCloseTo(11.65, 2);
    expect(p.gainsDb).toHaveLength(360);
    expect(p.gainsDb[0]).toBe(0);
    expect(p.gainsDb[10]).toBe(-3);
    expect(p.gainsDb[180]).toBe(-20);
  });

  it("reads angle,gain CSV in absolute dBi, with a header and unsorted rows", () => {
    const rows = ["angle,gain", ...[0, 90, 180, 270, 45, 135, 225, 315].map((a) => `${a},${a === 90 ? 7 : 1}`)].join("\n");
    const p = parsePatternFile(rows, "panel.csv");
    expect(p.format).toBe("csv");
    expect(p.gainsDb[90]).toBe(0);
    expect(p.gainsDb[270]).toBe(-6);
    expect(p.gainsDb[45]).toBe(-6);
    expect(p.gainsDb[67]).toBeLessThan(0);
    expect(p.gainsDb[67]).toBeGreaterThan(-6);
    expect(() => parsePatternFile("hello\nworld")).toThrow(/angle and gain/);
  });

  it("cleans untrusted patterns", () => {
    expect(cleanAntenna(yagi)).toEqual(yagi);
    expect(cleanAntenna({ kind: "directional", azimuthDeg: -90, beamwidthDeg: 60, frontToBackDb: 20 })).toMatchObject({ azimuthDeg: 270 });
    expect(cleanAntenna({ kind: "directional", azimuthDeg: 0, beamwidthDeg: 0, frontToBackDb: 20 })).toBeUndefined();
    expect(cleanAntenna({ kind: "table", azimuthDeg: 0, gainsDb: [0, 0] })).toBeUndefined();
    expect(cleanAntenna({ kind: "omni" })).toBeUndefined();
    expect(cleanAntenna("x")).toBeUndefined();
  });

  it("draws the front lobe longer than the back", () => {
    const pts = polarPoints(yagi, 50, -30, 360);
    const r = (i: number) => Math.hypot(pts[i][0], pts[i][1]);
    expect(r(90)).toBeCloseTo(50, 5);
    expect(r(270)).toBeLessThan(25);
    expect(describeAntenna(yagi, 9)).toContain("pointing 90°");
  });
});
