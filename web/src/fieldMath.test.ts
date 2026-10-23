import { describe, expect, it } from "vitest";
import { bearingDeg, compass, deltaClass, distanceM, fmtDistance, nearestNodes, readingsCsv, type ReadingRow } from "./fieldMath";
import type { MeshNode } from "./types";

const node = (id: string, lat: number, lon: number): MeshNode => ({ id, name: id, lat, lon, heightM: 5, clientHeightM: 1, txDbm: 22, gainDbi: 3, cableLossDb: 0.5, presetId: "long_fast", status: "planned", notes: "" });

describe("field maths", () => {
  it("distance and bearing", () => {
    expect(distanceM(36, -85, 36, -85)).toBe(0);
    expect(distanceM(36, -85, 37, -85)).toBeCloseTo(111195, -2);
    expect(bearingDeg(36, -85, 37, -85)).toBeCloseTo(0, 5);
    expect(bearingDeg(36, -85, 36, -84)).toBeCloseTo(90, 0);
    expect(compass(0)).toBe("N");
    expect(compass(92)).toBe("E");
    expect(compass(359)).toBe("N");
  });
  it("lists nearest nodes first", () => {
    const n = nearestNodes([node("far", 36.5, -85), node("near", 36.001, -85), node("mid", 36.1, -85)], 36, -85, 2);
    expect(n.map((x) => x.node.id)).toEqual(["near", "mid"]);
    expect(n[0].distanceM).toBeLessThan(200);
  });
  it("classifies measured minus predicted", () => {
    expect(deltaClass(null)).toBe("unknown");
    expect(deltaClass(2)).toBe("good");
    expect(deltaClass(-3)).toBe("good");
    expect(deltaClass(-7)).toBe("weak");
    expect(deltaClass(-20)).toBe("bad");
  });
  it("formats distances", () => {
    expect(fmtDistance(42.4)).toBe("42 m");
    expect(fmtDistance(1234)).toBe("1.23 km");
    expect(fmtDistance(25000)).toBe("25.0 km");
  });
  it("writes a CSV with quoting", () => {
    const row: ReadingRow = { id: "x", nodeRef: "n", nodeName: "Hill, north", lat: 36, lon: -85, accuracyM: 4, rssiDbm: -101, snrDb: 5.5, note: 'said "ok"', takenAt: 1_700_000_000, by: "Cy", predictedRssiDbm: -96.04, deltaDb: -4.96 };
    const out = readingsCsv([row]).split("\n");
    expect(out[0]).toContain("measured_minus_predicted_db");
    expect(out[1]).toBe('2023-11-14T22:13:20.000Z,"Hill, north",36,-85,4,-101,5.5,-96.0,-5.0,"said ""ok""",Cy');
  });
});
