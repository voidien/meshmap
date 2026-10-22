import { describe, expect, it } from "vitest";
import { decodeTerrarium, lonLatToPixel, TerrainSampler } from "./terrain";

describe("terrarium decoding", () => {
  it("decodes R*256+G+B/256-32768", () => {
    const rgba = new Uint8Array([128, 0, 0, 255, 131, 232, 128, 255]);
    const e = decodeTerrarium(rgba);
    expect(e[0]).toBe(0);
    expect(e[1]).toBeCloseTo(131 * 256 + 232 + 128 / 256 - 32768, 5);
  });
});

describe("web mercator pixels", () => {
  it("maps lon/lat 0,0 to the world centre", () => {
    const [x, y] = lonLatToPixel(0, 0, 1);
    expect(x).toBeCloseTo(256, 6);
    expect(y).toBeCloseTo(256, 6);
  });
});

describe("TerrainSampler", () => {
  it("bilinearly interpolates and caches tiles", async () => {
    let loads = 0;
    // elevation = x pixel index (a ramp), so interpolation between pixels is exact
    const loader = async () => {
      loads++;
      const t = new Float32Array(256 * 256);
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) t[y * 256 + x] = x * 10;
      return t;
    };
    const s = new TerrainSampler(2, loader);
    // zoom 2: world = 1024 px. lon such that pixel centre x = 100.5 -> sample = 1000 on the first tile
    const lon = ((100.5 / 1024) * 360) - 180 + 0;
    const out = await s.elevations([60, 60], [lon, lon + (1 / 1024) * 360 * 0.5]);
    expect(out[0]).toBeCloseTo(1000, 3);
    expect(out[1]).toBeCloseTo(1005, 3);
    const before = loads;
    await s.elevations([60], [lon]);
    expect(loads).toBe(before);
  });
});
