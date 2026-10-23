import { describe, expect, it } from "vitest";
import { PackSampler, type PackInfo } from "./packs";
import { lonLatToPixel } from "./terrain";

const flatTile = (elevM: number) => {
  const v = Math.round((elevM + 500) * 10);
  const a = new Uint8ClampedArray(256 * 256 * 4);
  for (let i = 0; i < 256 * 256; i++) [a[4 * i], a[4 * i + 1], a[4 * i + 2], a[4 * i + 3]] = [v >> 8, v & 255, 0, 255];
  return a;
};

const info = (id: string, zoom: number): PackInfo => ({ id, name: id, zoom, bbox: [0, 0, 0, 0], builtAt: "", tileCount: 9, bytes: 0, bareSource: "", clutterSources: [], attribution: [], clutterTiles: {} });

/** A sampler whose packs are set up directly (no server): a coarse pack and a fine pack, each 3x3 tiles around the point. */
function sampler(lon: number, lat: number) {
  const s = new PackSampler(async (url) => flatTile(url.includes("/fine/") ? 700 : 300));
  const index = new Map<string, Map<number, 0 | 1>>();
  for (const [id, z] of [["coarse", 13], ["fine", 14]] as const) {
    const [px, py] = lonLatToPixel(lon, lat, z);
    const m = new Map<number, 0 | 1>();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) m.set((Math.floor(px / 256) + dx) * 16777216 + (Math.floor(py / 256) + dy), 0);
    index.set(id, m);
  }
  const priv = s as unknown as { packs: PackInfo[]; index: typeof index; ready: Promise<void> };
  priv.packs = [info("coarse", 13), info("fine", 14)]; // listed coarse first on purpose
  priv.index = index;
  priv.ready = Promise.resolve();
  return s;
}

describe("overlapping packs", () => {
  it("samples the finer pack where both cover the point", async () => {
    const r = await sampler(-85, 36).sample([36], [-85]);
    expect(r.inPack[0]).toBe(1);
    expect(r.packIds[0]).toBe("fine");
    expect(r.bare[0]).toBeCloseTo(700, 1);
  });

  it("falls back to the coarse pack outside the fine one", async () => {
    const lon = -85 + 4500 / (111320 * Math.cos((36 * Math.PI) / 180));
    const r = await sampler(-85, 36).sample([36], [lon]);
    expect(r.packIds[0]).toBe("coarse");
    expect(r.bare[0]).toBeCloseTo(300, 1);
  });
});
