import { describe, expect, it } from "vitest";
import { exportMeshcore, importMeshcore, letterFor } from "./meshcore";

// real exports from the MeshCore app
const samples = import.meta.glob<unknown>("./testdata/meshcore/*.json", { eager: true, import: "default" });
const files = Object.keys(samples);
const load = (f: string) => structuredClone(samples[f]) as { layers: { letter: string; name: string; latitude: number; longitude: number; antenna_height_a: number; antenna_height_b: number }[] };

describe("MeshCore coverage_layers.json", () => {
  it("has sample files", () => expect(files.length).toBeGreaterThanOrEqual(6));

  for (const f of files) {
    it(`round-trips ${f} exactly`, () => {
      const original = load(f);
      let i = 0;
      const imp = importMeshcore(original, () => `id${i++}`)!;
      expect(imp.skipped).toBe(0);
      expect(imp.nodes).toHaveLength(original.layers.length);
      expect(JSON.parse(exportMeshcore(imp.nodes, imp.overlays))).toEqual(original);
    });
  }

  it("maps fields onto nodes", () => {
    const original = load(files[0]);
    const n = importMeshcore(original)!.nodes[0];
    const l = original.layers[0];
    expect(n).toMatchObject({ letter: l.letter, name: l.name, lat: l.latitude, lon: l.longitude, heightM: l.antenna_height_a, clientHeightM: l.antenna_height_b });
  });

  it("skips invalid entries and rejects other formats", () => {
    const r = importMeshcore({ layers: [{ latitude: 95, longitude: 0 }, { latitude: "x" }, { letter: "A", latitude: 1, longitude: 2 }], overlays: [] })!;
    expect(r.skipped).toBe(2);
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0].name).toBe("Point A");
    expect(importMeshcore({ nodes: [] })).toBeNull();
  });

  it("assigns unique letters on export for nodes without one", () => {
    const base = importMeshcore({ layers: [{ letter: "A", latitude: 1, longitude: 1 }, { letter: "C", latitude: 2, longitude: 2 }] })!.nodes;
    const extra = { ...base[0], id: "x", letter: undefined, name: "new" };
    const dup = { ...base[1], id: "y" };
    const out = JSON.parse(exportMeshcore([...base, extra, dup]));
    expect(out.layers.map((l: { letter: string }) => l.letter)).toEqual(["A", "C", "B", "D"]);
  });

  it("letters continue past Z", () => {
    expect([letterFor(0), letterFor(25), letterFor(26), letterFor(27), letterFor(701), letterFor(702)]).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });
});
