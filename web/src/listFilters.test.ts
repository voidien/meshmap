import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Link, type MeshNode } from "./types";
import { applyTagOps, asymmetryDb, allTags, filterLinks, filterNodes, NO_LINK_FILTER, NO_NODE_FILTER, nodeStats } from "./listFilters";
import { newNodeFor } from "./workspace";
import { windowRange } from "./ui/windowing";

const node = (id: string, extra: Partial<MeshNode> = {}): MeshNode => ({ ...newNodeFor(DEFAULT_SETTINGS, 36, -85, id, id), ...extra });
const link = (a: string, b: string, cls: Link["class"], margin: number, ab = margin, ba = margin): Link =>
  ({ key: `${a}|${b}`, a, b, class: cls, distanceM: 5000, result: { margin_db: margin, margin_ab_db: ab, margin_ba_db: ba } as Link["result"] });

describe("node filters", () => {
  const nodes = [node("Alpha", { tags: ["north"] }), node("Bravo", { status: "installed", tags: ["south", "phase 1"] }), node("Charlie")];
  const links = [link("Alpha", "Bravo", "clear", 20)];
  const stats = nodeStats(nodes, links);
  it("searches names, notes and tags", () => {
    expect(filterNodes(nodes, stats, { ...NO_NODE_FILTER, query: "phase" }, "name").map((n) => n.id)).toEqual(["Bravo"]);
    expect(filterNodes(nodes, stats, { ...NO_NODE_FILTER, query: "alp" }, "name").map((n) => n.id)).toEqual(["Alpha"]);
  });
  it("filters by status, tag and problems", () => {
    expect(filterNodes(nodes, stats, { ...NO_NODE_FILTER, status: new Set(["installed"]) }, "name").map((n) => n.id)).toEqual(["Bravo"]);
    expect(filterNodes(nodes, stats, { ...NO_NODE_FILTER, tag: "NORTH" }, "name").map((n) => n.id)).toEqual(["Alpha"]);
    expect(filterNodes(nodes, stats, { ...NO_NODE_FILTER, problems: true }, "name").map((n) => n.id)).toEqual(["Charlie"]);
    expect(filterNodes(nodes, stats, { ...NO_NODE_FILTER, problems: true, weakBelowDb: 30 }, "name").map((n) => n.id)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });
  it("sorts the unconnected first by weakest", () => {
    expect(filterNodes(nodes, stats, NO_NODE_FILTER, "weakest")[0].id).toBe("Charlie");
  });
});

describe("link filters", () => {
  const names = new Map([["a", "Hinch"], ["b", "Ridge"], ["c", "Gap"]]);
  const nameOf = (id: string) => names.get(id) ?? id;
  const links = [link("a", "b", "clear", 20), link("a", "c", "obstructed", -5), link("b", "c", "marginal", 4)];
  it("orders weakest first and filters by class and name", () => {
    expect(filterLinks(links, nameOf, NO_LINK_FILTER, "weakest").map((l) => l.class)).toEqual(["obstructed", "marginal", "clear"]);
    expect(filterLinks(links, nameOf, { query: "", classes: new Set(["clear"]) }, "weakest")).toHaveLength(1);
    expect(filterLinks(links, nameOf, { query: "gap", classes: new Set() }, "name")).toHaveLength(2);
  });
  it("flags directions that differ a lot", () => {
    expect(asymmetryDb(link("a", "b", "clear", 10, 20, 8))).toBe(12);
    expect(asymmetryDb(link("a", "b", "clear", 10, 12, 10))).toBeNull();
  });
});

describe("tags", () => {
  it("lists and counts them", () => {
    expect(allTags([node("a", { tags: ["x", "Y"] }), node("b", { tags: ["y"] })])).toEqual([{ tag: "x", count: 1 }, { tag: "Y", count: 2 }]);
  });
  it("adds and removes without duplicates", () => {
    const n = node("a", { tags: ["one", "two"] });
    expect(applyTagOps(n, "THREE", "one")).toEqual(["two", "THREE"]);
    expect(applyTagOps(n, "TWO", null)).toEqual(["one", "two"]);
    expect(applyTagOps(node("b"), null, "x")).toBeUndefined();
  });
});

describe("windowing", () => {
  it("draws the visible rows and a margin", () => {
    expect(windowRange(0, 100, 20, 1000, 2)).toEqual({ start: 0, end: 7 });
    expect(windowRange(2000, 100, 20, 1000, 2)).toEqual({ start: 98, end: 107 });
    expect(windowRange(99999, 100, 20, 1000, 2).end).toBe(1000);
    expect(windowRange(0, 100, 20, 0)).toEqual({ start: 0, end: 0 });
  });
});
