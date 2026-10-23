import { describe, expect, it } from "vitest";
import { describeDiff, diffVersion } from "./versionDiff";
import { DEFAULT_SETTINGS, type MeshNode } from "./types";

const node = (id: string, name: string, lat = 36, lon = -85, heightM = 10): MeshNode => ({
  id, name, lat, lon, heightM, clientHeightM: 1, txDbm: 22, gainDbi: 3, cableLossDb: 0.5, presetId: "meshcore_us", status: "planned", notes: "",
});
const proj = (nodes: MeshNode[]) => ({ nodes, settings: { ...DEFAULT_SETTINGS } });

describe("diffVersion", () => {
  it("is empty for identical projects", () => {
    expect(describeDiff(diffVersion(proj([node("a", "A")]), proj([node("a", "A")])))).toEqual([]);
  });
  it("tells what comes back, goes away, moves and changes", () => {
    const now = proj([node("a", "A", 36.01), node("b", "B", 36, -85, 12), node("c", "New")]);
    const then = proj([node("a", "A", 36.0), node("b", "B", 36, -85, 10), node("d", "Old one")]);
    const d = diffVersion(now, then);
    expect(d.returning).toEqual(["Old one"]);
    expect(d.disappearing).toEqual(["New"]);
    expect(d.moved).toEqual(["A"]);
    expect(d.changed).toEqual(["B"]);
    expect(describeDiff(d)).toHaveLength(4);
  });
  it("ignores GPS-noise sized moves and notices settings", () => {
    const a = proj([node("a", "A", 36.0, -85.0)]);
    const b = { nodes: [node("a", "A", 36.00001, -85.0)], settings: { ...DEFAULT_SETTINGS, freqMhz: 910 } };
    const d = diffVersion(a, b);
    expect(d.moved).toEqual([]);
    expect(d.settingsChanged).toBe(true);
  });
  it("shortens long lists", () => {
    const many = Array.from({ length: 7 }, (_, i) => node(`n${i}`, `N${i}`));
    expect(describeDiff(diffVersion(proj([]), proj(many)))[0]).toContain("and 3 more");
  });
});
