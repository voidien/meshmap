import { describe, expect, it } from "vitest";
import { highestAwayFromEnds, pointOnPath } from "./profilePick";

const line = (n: number, spacing: number) => Float64Array.from({ length: n }, (_, i) => i * spacing);

describe("picking on the profile", () => {
  it("finds the highest ground away from the ends, ignoring the summit a node already sits on", () => {
    const dist = line(101, 100); // 10 km
    const elev = Float64Array.from({ length: 101 }, (_, i) => 300 + (i === 3 ? 900 : 0) + (i === 60 ? 400 : 0) + (i === 97 ? 800 : 0));
    // indices 3 and 97 are within 5 % (500 m) of the ends; the ridge at 60 is the answer
    expect(highestAwayFromEnds(dist, elev)).toBe(60);
  });

  it("falls back to the highest interior sample on a short path", () => {
    const dist = line(6, 50); // 250 m: every interior point is inside the margin
    expect(highestAwayFromEnds(dist, [10, 12, 30, 20, 11, 10])).toBe(2);
  });

  it("has no answer without an interior", () => {
    expect(highestAwayFromEnds([0, 100], [1, 2])).toBeNull();
  });

  it("places samples on the straight line between the nodes", () => {
    const a = { lat: 36, lon: -85 };
    const b = { lat: 37, lon: -83 };
    const dist = line(11, 1000);
    expect(pointOnPath(a, b, dist, 0)).toEqual(a);
    expect(pointOnPath(a, b, dist, 10)).toEqual(b);
    const mid = pointOnPath(a, b, dist, 5);
    expect(mid.lat).toBeCloseTo(36.5, 9);
    expect(mid.lon).toBeCloseTo(-84, 9);
  });
});
