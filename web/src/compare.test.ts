import { describe, expect, it } from "vitest";
import { diffLinks, diffNodes, matchKey, summarize } from "./compare";
import type { Link, MeshNode } from "./types";

const node = (id: string, p: Partial<MeshNode> = {}): MeshNode => ({
  id, name: id, lat: 36, lon: -85, heightM: 5, clientHeightM: 1, txDbm: 22, gainDbi: 3, cableLossDb: 0.5,
  presetId: "long_fast", status: "planned", notes: "", ...p,
});
// crude flat distance in metres: good enough for the thresholds tested here
const dist = (a: number, b: number, c: number, d: number) => Math.hypot((c - a) * 111_000, (d - b) * 90_000);
const link = (a: string, b: string, cls: Link["class"], margin?: number): Link => ({
  key: `${a}|${b}`, a, b, class: cls, distanceM: 1000,
  result: margin === undefined ? undefined : ({ margin_db: margin } as Link["result"]),
});

describe("diffNodes", () => {
  it("matches by letter first, then by name", () => {
    expect(matchKey(node("x", { letter: "A", name: "Brandon" }))).toBe(matchKey(node("y", { letter: "A", name: "Point A" })));
    expect(matchKey(node("x", { name: " Hill " }))).toBe(matchKey(node("y", { name: "hill" })));
  });

  it("finds added, removed, moved and changed nodes", () => {
    const other = [node("1", { letter: "A" }), node("2", { letter: "B" }), node("3", { letter: "C", heightM: 5 })];
    const cur = [
      node("a", { letter: "A", lat: 36.01 }), // moved ~1.1 km
      node("c", { letter: "C", heightM: 20, txDbm: 27 }), // changed
      node("d", { letter: "D" }), // added
    ];
    const d = diffNodes(cur, other, dist);
    expect(d.added.map((n) => n.letter)).toEqual(["D"]);
    expect(d.removed.map((n) => n.letter)).toEqual(["B"]);
    expect(d.moved).toHaveLength(1);
    expect(d.moved[0].distM).toBeGreaterThan(1000);
    expect(d.changed[0].fields).toEqual(["antenna height", "TX power"]);
  });

  it("ignores sub-threshold GPS jitter", () => {
    const d = diffNodes([node("a", { letter: "A", lat: 36.00001 })], [node("b", { letter: "A" })], dist);
    expect(d.moved).toHaveLength(0);
  });
});

describe("diffLinks", () => {
  it("reports class changes, new and lost links, worst first", () => {
    const other = [node("o1", { letter: "A" }), node("o2", { letter: "B" }), node("o3", { letter: "C" })];
    const cur = [node("c1", { letter: "A" }), node("c2", { letter: "B" }), node("c3", { letter: "C" })];
    const oLinks = [link("o1", "o2", "obstructed", -5), link("o2", "o3", "clear", 20), link("o1", "o3", "marginal", 3)];
    const cLinks = [link("c1", "c2", "clear", 15), link("c2", "c3", "marginal", 4), link("c1", "c3", "marginal", 8)];
    const ch = diffLinks(cur, cLinks, other, oLinks);
    expect(ch).toHaveLength(2); // A-C unchanged class
    expect(ch[0]).toMatchObject({ a: "c2", b: "c3", from: "clear", to: "marginal", delta: -1 }); // worsened first
    expect(ch[1]).toMatchObject({ a: "c1", b: "c2", from: "obstructed", to: "clear", delta: 2 });
  });

  it("treats none as absent", () => {
    const n1 = [node("a", { letter: "A" }), node("b", { letter: "B" })];
    const n2 = [node("x", { letter: "A" }), node("y", { letter: "B" })];
    expect(diffLinks(n1, [link("a", "b", "none")], n2, [])).toEqual([]);
    const ch = diffLinks(n1, [link("a", "b", "clear", 12)], n2, [link("x", "y", "none")]);
    expect(ch[0]).toMatchObject({ from: "absent", to: "clear", delta: 3 });
  });
});

describe("summarize", () => {
  it("counts classes and averages margin, skipping none", () => {
    const s = summarize([node("a"), node("b")], [link("a", "b", "clear", 10), link("a", "b", "marginal", 4), link("a", "b", "none")]);
    expect(s).toMatchObject({ nodes: 2, links: 2, clear: 1, marginal: 1, obstructed: 0, avgMarginDb: 7 });
  });
});
