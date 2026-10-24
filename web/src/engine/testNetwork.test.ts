import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../types";
import { cleanTags } from "../workspace";
import { generateNetwork, rng } from "./testNetwork";

describe("test network generator", () => {
  const c = { lat: 36, lon: -85 };
  it("is repeatable, sized and spaced", () => {
    const a = generateNetwork(DEFAULT_SETTINGS, c, 120, 40, 1.5, 7);
    const b = generateNetwork(DEFAULT_SETTINGS, c, 120, 40, 1.5, 7);
    expect(a.length).toBe(120);
    expect(a.map((n) => [n.lat, n.lon])).toEqual(b.map((n) => [n.lat, n.lon]));
    expect(new Set(a.map((n) => n.id)).size).toBe(120);
    const km = 111.32;
    for (let i = 0; i < a.length; i++)
      for (let j = i + 1; j < a.length; j++) expect(Math.hypot((a[i].lat - a[j].lat) * km, (a[i].lon - a[j].lon) * km * Math.cos((36 * Math.PI) / 180))).toBeGreaterThanOrEqual(1.49);
    expect(a.every((n) => n.tags?.length === 1)).toBe(true);
  });
  it("differs with the seed and stops when the area is full", () => {
    expect(generateNetwork(DEFAULT_SETTINGS, c, 5, 20, 1, 1)[0].lat).not.toBe(generateNetwork(DEFAULT_SETTINGS, c, 5, 20, 1, 2)[0].lat);
    expect(generateNetwork(DEFAULT_SETTINGS, c, 500, 2, 1, 1).length).toBeLessThan(20);
    expect(rng(3)()).toBeGreaterThanOrEqual(0);
  });
});

describe("tags", () => {
  it("are trimmed, unique, limited and optional", () => {
    expect(cleanTags([" a ", "A", "b", "", 5])).toEqual(["a", "b"]);
    expect(cleanTags([])).toBeUndefined();
    expect(cleanTags("x")).toBeUndefined();
    expect(cleanTags(Array.from({ length: 30 }, (_, i) => `t${i}`))?.length).toBe(12);
  });
});
