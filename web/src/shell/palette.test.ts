import { describe, expect, it } from "vitest";
import { parseCoordinates, score, search, type Command } from "./palette";

const cmd = (id: string, label: string, extra: Partial<Command> = {}): Command => ({ id, label, group: "Actions", run: () => undefined, ...extra });

describe("command palette matching", () => {
  const list = [cmd("a", "Add a node"), cmd("b", "Predict whole network", { keywords: "heatmap coverage" }), cmd("c", "Go to Hinch", { group: "Go to" }), cmd("d", "Export GeoJSON", { hint: "for QGIS" })];
  it("matches every word, in the label or the extra words", () => {
    expect(search(list, "heat").map((c) => c.id)).toEqual(["b"]);
    expect(search(list, "node add").map((c) => c.id)).toEqual(["a"]);
    expect(search(list, "qgis").map((c) => c.id)).toEqual(["d"]);
    expect(search(list, "zzz")).toEqual([]);
  });
  it("puts label starts before later matches, and keeps the order for an empty query", () => {
    const l = [cmd("x", "Show names"), cmd("y", "Names on the map"), cmd("z", "Rename project")];
    expect(search(l, "names").map((c) => c.id)).toEqual(["y", "x"]);
    expect(search(l, "name").map((c) => c.id)).toEqual(["y", "x", "z"]);
    expect(search(l, "").map((c) => c.id)).toEqual(["x", "y", "z"]);
  });
  it("ignores case and accents", () => {
    expect(score("HINCH", cmd("c", "Go to Hinch"))).toBeGreaterThan(0);
    expect(score("cafe", cmd("c", "Café node"))).toBeGreaterThan(0);
  });
});

describe("coordinates", () => {
  it("reads decimal degrees written a few ways", () => {
    expect(parseCoordinates("36.15, -85.43")).toEqual({ lat: 36.15, lon: -85.43 });
    expect(parseCoordinates(" 36.15 -85.43 ")).toEqual({ lat: 36.15, lon: -85.43 });
    expect(parseCoordinates("36;-85")).toEqual({ lat: 36, lon: -85 });
  });
  it("refuses text and impossible positions", () => {
    expect(parseCoordinates("Hinch")).toBeNull();
    expect(parseCoordinates("95, 10")).toBeNull();
    expect(parseCoordinates("10, 200")).toBeNull();
    expect(parseCoordinates("36.15")).toBeNull();
  });
});
