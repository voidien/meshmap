import { describe, expect, it } from "vitest";
import { analyzeHealth, edgesFromLinks, simulateFailure, type Edge, type HealthInput } from "./meshHealth";

const e = (a: string, b: string, marginDb = 10): Edge => ({ a, b, marginDb });
const input = (ids: string, edges: Edge[], gateways: string[] = [], hopLimit = 3): HealthInput => ({ nodeIds: ids.split(""), edges, gateways, hopLimit });

describe("mesh health", () => {
  it("a chain: every middle node and every link is a single point of failure", () => {
    const h = analyzeHealth(input("abcd", [e("a", "b"), e("b", "c"), e("c", "d")], ["a"]));
    // the lone gateway counts too: lose it and nothing is connected to the outside
    expect(h.spofs.map((s) => [s.id, s.cutOff.sort()])).toEqual([["a", ["b", "c", "d"]], ["b", ["c", "d"]], ["c", ["d"]]]);
    expect(h.bridges).toHaveLength(3);
    expect(h.bridges[0].cutOff.length).toBe(3);
    expect(h.hops!.get("d")).toBe(3);
    expect(h.maxHops).toBe(3);
    expect(h.singleLinked.sort()).toEqual(["a", "d"]);
  });

  it("a ring has no single point of failure (other than a lone gateway) and no bridge", () => {
    const h = analyzeHealth(input("abcd", [e("a", "b"), e("b", "c"), e("c", "d"), e("d", "a")], ["a"]));
    expect(h.spofs.map((s) => s.id)).toEqual(["a"]);
    expect(analyzeHealth(input("abcd", [e("a", "b"), e("b", "c"), e("c", "d"), e("d", "a")], ["a", "c"])).spofs).toEqual([]);
    expect(analyzeHealth(input("abcd", [e("a", "b"), e("b", "c"), e("c", "d"), e("d", "a")])).spofs).toEqual([]);
    expect(h.bridges).toEqual([]);
    expect(h.singleLinked).toEqual([]);
  });

  it("a star's centre is the failure that matters", () => {
    const h = analyzeHealth(input("cabde", [e("c", "a"), e("c", "b"), e("c", "d"), e("c", "e")]));
    expect(h.spofs).toHaveLength(1);
    expect(h.spofs[0].id).toBe("c");
    expect(h.spofs[0].cutOff).toHaveLength(3); // the four leaves split apart; one stays as the "largest group"
  });

  it("without gateways the largest group is what counts; isolated nodes and groups are reported", () => {
    const h = analyzeHealth(input("abcdefg", [e("a", "b"), e("b", "c"), e("d", "e")]));
    expect(h.groups.map((g) => g.length)).toEqual([3, 2, 1, 1]);
    expect(h.isolated.sort()).toEqual(["f", "g"]);
    expect(h.fromGateways).toBe(false);
    expect([...h.reach].sort()).toEqual(["a", "b", "c"]);
    expect(h.hops).toBeNull();
  });

  it("with a gateway, nodes that cannot reach it are listed, and hop limits flagged", () => {
    const h = analyzeHealth(input("abcdef", [e("a", "b"), e("b", "c"), e("c", "d"), e("d", "e")], ["a"], 3));
    expect(h.noGateway).toEqual(["f"]);
    expect(h.beyondHopLimit).toEqual(["e"]);
    expect(h.hops!.get("f")).toBe(-1);
  });

  it("a second gateway shortens hops and removes single points of failure", () => {
    const edges = [e("a", "b"), e("b", "c"), e("c", "d")];
    const one = analyzeHealth(input("abcd", edges, ["a"]));
    const two = analyzeHealth(input("abcd", edges, ["a", "d"]));
    expect(one.spofs.length).toBeGreaterThan(0);
    expect(two.maxHops).toBe(1);
    expect(two.noGateway).toEqual([]);
    expect(two.spofs).toEqual([]);
  });

  it("simulating a failure matches the single-point-of-failure list", () => {
    const i = input("abcde", [e("a", "b"), e("b", "c"), e("c", "d"), e("b", "e")], ["a"]);
    const f = simulateFailure(i, "b");
    expect(f.cutOff.sort()).toEqual(["c", "d", "e"]);
    expect(f.groupsAfter).toBeGreaterThan(f.groupsBefore);
    expect(simulateFailure(i, "d").cutOff).toEqual([]);
    const gw = simulateFailure(i, "a");
    expect(gw.cutOff.sort()).toEqual(["b", "c", "d", "e"]);
  });

  it("losing a node can push others past the hop limit", () => {
    // ring of 6 with the gateway at a: losing b makes c, d, e, f go the long way round
    const ring = [e("a", "b"), e("b", "c"), e("c", "d"), e("d", "e"), e("e", "f"), e("f", "a")];
    const f = simulateFailure(input("abcdef", ring, ["a"], 2), "b");
    expect(f.cutOff).toEqual([]);
    expect(f.nowBeyondHopLimit.sort()).toEqual(["c"]); // d was already beyond; c now has to go the long way round
  });

  it("matches brute force on random graphs", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let t = 0; t < 40; t++) {
      const n = 4 + Math.floor(rnd() * 8);
      const ids = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));
      const edges: Edge[] = [];
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (rnd() < 0.25) edges.push(e(ids[i], ids[j]));
      const gws = rnd() < 0.5 ? [ids[0]] : [];
      const inp: HealthInput = { nodeIds: ids, edges, gateways: gws, hopLimit: 3 };
      const h = analyzeHealth(inp);
      for (const s of h.spofs) {
        const f = simulateFailure(inp, s.id);
        expect(f.cutOff.sort()).toEqual([...s.cutOff].sort());
      }
      // every node outside the SPOF list loses nobody
      for (const id of ids) if (!h.spofs.some((s) => s.id === id) && h.reach.has(id)) expect(simulateFailure(inp, id).cutOff).toEqual([]);
    }
  });

  it("ignores links to nodes that are no longer in the graph (a node was just deleted)", () => {
    // the link list can still mention a deleted node for a moment; nothing may throw and the stale links must not count
    const edges = [e("a", "b"), e("b", "gone"), e("gone", "c"), e("c", "d")];
    const inp = input("abcd", edges, ["a"]);
    const h = analyzeHealth(inp);
    expect(h.groups.map((g) => g.length)).toEqual([2, 2]);
    expect(h.noGateway.sort()).toEqual(["c", "d"]);
    expect(h.bridges.map((x) => `${x.a}${x.b}`)).toEqual(["ab"]);
    expect(() => simulateFailure(inp, "b")).not.toThrow();
    expect(() => simulateFailure(inp, "a")).not.toThrow();
  });

  it("builds edges from links by margin, skipping 'none'", () => {
    const links = [
      { a: "a", b: "b", class: "clear", result: { margin_db: 20 } },
      { a: "b", b: "c", class: "obstructed", result: { margin_db: 2 } },
      { a: "c", b: "d", class: "none" },
      { a: "d", b: "e", class: "marginal", result: { margin_db: 8 } },
    ];
    expect(edgesFromLinks(links, 6).map((x) => `${x.a}${x.b}`)).toEqual(["ab", "de"]);
    expect(edgesFromLinks(links, 0).map((x) => `${x.a}${x.b}`)).toEqual(["ab", "bc", "de"]);
  });
});

import { rng } from "./engine/testNetwork";

describe("mesh health: the fast path agrees with checking every removal", () => {
  it("on many random graphs, with and without gateways", () => {
    const rand = rng(42);
    for (let round = 0; round < 400; round++) {
      const n = 2 + Math.floor(rand() * 11);
      const ids = Array.from({ length: n }, (_, i) => `n${i}`);
      const edges: Edge[] = [];
      const m = Math.floor(rand() * n * 1.6);
      for (let k = 0; k < m; k++) {
        const a = Math.floor(rand() * n);
        const b = Math.floor(rand() * n);
        if (a !== b) edges.push({ a: ids[a], b: ids[b], marginDb: 10 });
      }
      const gateways = rand() < 0.4 ? ids.filter(() => rand() < 0.25) : [];
      const input = { nodeIds: ids, edges, gateways, hopLimit: 3 };
      const fast = analyzeHealth(input);
      const slow = analyzeHealth(input, { exact: true });
      expect(fast.spofs).toEqual(slow.spofs);
      expect(fast.bridges).toEqual(slow.bridges);
    }
  });
  it("handles a few hundred nodes quickly", () => {
    const n = 300;
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    const rand = rng(7);
    const edges: Edge[] = [];
    for (let i = 0; i < n; i++) for (let k = 0; k < 16; k++) edges.push({ a: ids[i], b: ids[Math.floor(rand() * n)], marginDb: 10 });
    const t = Date.now();
    analyzeHealth({ nodeIds: ids, edges, gateways: [], hopLimit: 3 });
    expect(Date.now() - t).toBeLessThan(1500);
  });
});
