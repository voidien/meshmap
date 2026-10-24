/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import init from "../wasm/pkg/meshmap_wasm";
import { explainPair, reanalyze, suggestRaise } from "./pairInfo";
import type { ProfileData } from "./analysis";
import { DEFAULT_SETTINGS, type MeshNode } from "../types";

const WASM = new URL("../wasm/pkg/meshmap_wasm_bg.wasm", import.meta.url);
const have = existsSync(WASM);

const node = (id: string, lat: number, lon: number, heightM: number, presetId = "meshcore_us"): MeshNode => ({
  id, name: id, lat, lon, heightM, clientHeightM: 1, txDbm: 22, gainDbi: 3, cableLossDb: 0.5, presetId, status: "planned", notes: "",
});
const s = { ...DEFAULT_SETTINGS, terrainMode: "bare" as const };

/** A path of the given length over flat ground with one hill in the middle. */
function profile(a: MeshNode, b: MeshNode, hillM: number, lengthM = 10_000): ProfileData {
  const n = 51;
  const dist = Float64Array.from({ length: n }, (_, i) => (lengthM * i) / (n - 1));
  const elev = Float64Array.from({ length: n }, (_, i) => 100 + (i === 25 ? hillM : 0));
  const base = { dist, elev, clutter: null } as unknown as ProfileData;
  const result = reanalyze(base, a, b, s);
  return { ...base, bare: result, withClutter: null, withFoliage: null, result };
}

describe.skipIf(!have)("pair analysis helpers", () => {
  beforeAll(async () => {
    await init({ module_or_path: readFileSync(WASM) });
  });

  it("says nothing about two ordinary nodes close together", () => {
    const info = explainPair(node("a", 36, -85, 10), node("b", 36.02, -85, 10), s);
    expect(info.notes).toEqual([]);
    expect(info.distanceM).toBeGreaterThan(2000);
  });
  it("explains a pair beyond the search range and a pair with different radios", () => {
    const far = explainPair(node("a", 36, -85, 10), node("b", 36.9, -85, 10), { ...s, maxRangeKm: 50 });
    expect(far.notes.map((n) => n.kind)).toContain("range");
    const radios = explainPair(node("a", 36, -85, 10), node("b", 36.02, -85, 10, "meshcore_sf8"), s);
    expect(radios.notes.map((n) => n.kind)).toEqual(["radio"]);
  });
  it("proposes the smallest raise that clears a hill, and the raise works", () => {
    const a = node("a", 36, -85, 12);
    const b = node("b", 36.09, -85, 12);
    const p = profile(a, b, 12);
    expect(p.result.clearance_pct).toBeLessThan(60);
    const raise = suggestRaise(p, a, b, s);
    expect(raise).not.toBeNull();
    const after = reanalyze(p, raise!.end === "a" ? { ...a, heightM: a.heightM + raise!.byM } : a, raise!.end === "b" ? { ...b, heightM: b.heightM + raise!.byM } : b, s);
    expect(after.clearance_pct).toBeGreaterThanOrEqual(60);
    // one metre less is not enough on that end
    const less = reanalyze(p, raise!.end === "a" ? { ...a, heightM: a.heightM + raise!.byM - 1 } : a, raise!.end === "b" ? { ...b, heightM: b.heightM + raise!.byM - 1 } : b, s);
    expect(less.clearance_pct < 60 || less.margin_db < 0).toBe(true);
  });
  it("has no suggestion for a path that is already good", () => {
    const a = node("a", 36, -85, 10);
    const b = node("b", 36.0135, -85, 10);
    const flat = profile(a, b, 0, 1500);
    expect(suggestRaise(flat, a, b, s)).toBeNull();
  });
});
