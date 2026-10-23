import { describe, expect, it } from "vitest";
import { bboxOfPoints, padBBox, planOffline, tileRange } from "./plan";

describe("offline plan", () => {
  const box = padBBox([-85.0, 36.0, -85.0, 36.0], 5);
  it("pads a point into a box of about 10 km", () => {
    expect(box[2] - box[0]).toBeGreaterThan(0.1);
    expect(box[3] - box[1]).toBeCloseTo(10 / 111.195, 3);
  });
  it("lists terrain tiles at the profile zoom and covers the box", () => {
    const p = planOffline(box, []);
    const r = tileRange(box, 12);
    expect(p.terrain.length).toBe((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1));
    expect(p.terrain[0]).toMatch(/elevation-tiles-prod\/terrarium\/12\//);
  });
  it("adds map zoom levels only while they fit under the cap", () => {
    const small = planOffline(box, [], 600);
    const zooms = new Set(small.map.map((u) => u.split("/").slice(-3)[0]));
    expect(zooms.has("8")).toBe(true);
    expect(small.map.length).toBeLessThanOrEqual(600);
    expect(planOffline(box, [], 3).map.length).toBeLessThanOrEqual(3);
  });
  it("takes pack tiles in the box, with the clutter file only where there is clutter data", () => {
    const r = tileRange(box, 13);
    const packs = [{ id: "p", zoom: 13, tiles: [[r.x0, r.y0, 1], [r.x0 + 1, r.y0, 0], [r.x1 + 50, r.y0, 1]] as [number, number, 0 | 1][] }];
    const p = planOffline(box, packs);
    expect(p.pack).toEqual([`/api/packs/p/13/${r.x0}/${r.y0}.bare.png`, `/api/packs/p/13/${r.x0}/${r.y0}.clutter.png`, `/api/packs/p/13/${r.x0 + 1}/${r.y0}.bare.png`]);
    expect(p.estimateMb).toBeGreaterThan(0);
  });
  it("finds the box around points", () => {
    expect(bboxOfPoints([])).toBeNull();
    expect(bboxOfPoints([{ lat: 1, lon: 2 }, { lat: 3, lon: -4 }])).toEqual([-4, 1, 2, 3]);
  });
});
