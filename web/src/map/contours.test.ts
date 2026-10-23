import { describe, expect, it } from "vitest";
import { buildContours, contourInterval, FT, type Sampler } from "./contours";

// a cone: 1000 m at the centre, falling 1 m per 100 m of distance
const centre = { lat: 36, lon: -85 };
const cone: Sampler = async (lats, lons) => lats.map((la, i) => {
  const dy = (la - centre.lat) * 111_320;
  const dx = (lons[i] - centre.lon) * 111_320 * Math.cos((36 * Math.PI) / 180);
  return 1000 - Math.hypot(dx, dy) / 100;
});
const view = { west: -85.1, south: 35.9, east: -84.9, north: 36.1 };

describe("contours", () => {
  it("picks a sensible spacing for the zoom level and hides when zoomed out", () => {
    expect(contourInterval(9, "m")).toBeNull();
    expect(contourInterval(15, "m")).toBe(10);
    expect(contourInterval(14, "m")).toBe(10);
    expect(contourInterval(12, "m")).toBeGreaterThan(contourInterval(14, "m")!);
    expect(contourInterval(10, "m")).toBeGreaterThanOrEqual(contourInterval(12, "m")!);
    expect(contourInterval(13, "ft")).toBeGreaterThanOrEqual(50);
  });

  it("draws rings around a hill at the chosen heights, with every fifth line major", async () => {
    const zoom = 11; // 100 m spacing here
    const interval = contourInterval(zoom, "m")!;
    const fc = await buildContours(view, zoom, "m", cone);
    expect(fc.features.length).toBeGreaterThan(0);
    const levels = new Set(fc.features.map((f) => f.properties!.ele as number));
    for (const l of levels) expect(l % interval).toBe(0);
    for (const f of fc.features) expect(f.properties!.major).toBe(Math.round((f.properties!.ele as number) / interval) % 5 === 0);
    // the 900 m ring sits 10 km from the summit
    const ring = fc.features.find((f) => f.properties!.ele === 900 && f.geometry.type === "LineString")!;
    const pts = (ring.geometry as GeoJSON.LineString).coordinates;
    const d = pts.map(([lo, la]) => Math.hypot((lo - centre.lon) * 111_320 * Math.cos((36 * Math.PI) / 180), (la - centre.lat) * 111_320));
    expect(Math.min(...d)).toBeGreaterThan(9500);
    expect(Math.max(...d)).toBeLessThan(10500);
  });

  it("works in feet", async () => {
    const fc = await buildContours(view, 11, "ft", cone);
    const levels = [...new Set(fc.features.map((f) => f.properties!.ele as number))];
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.every((l) => l % 100 === 0 || l % 200 === 0 || l % 50 === 0)).toBe(true);
    expect(Math.max(...levels)).toBeLessThanOrEqual(Math.round(1000 * FT));
  });

  it("returns nothing when zoomed out or over flat ground", async () => {
    expect((await buildContours(view, 8, "m", cone)).features).toHaveLength(0);
    expect((await buildContours(view, 12, "m", async (la) => la.map(() => 305))).features).toHaveLength(0);
  });
});
