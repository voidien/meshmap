/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import init from "./wasm/pkg/meshmap_wasm";
import { nodesCsv } from "./export";
import { parseNodesCsv } from "./nodesImport";
import { DEFAULT_SETTINGS } from "./types";
import { newNodeFor } from "./workspace";

const WASM = new URL("./wasm/pkg/meshmap_wasm_bg.wasm", import.meta.url);

describe.skipIf(!existsSync(WASM))("nodes CSV round trip", () => {
  beforeAll(async () => {
    await init({ module_or_path: readFileSync(WASM) });
  });
  it("reads back what Nodes CSV writes (names, positions, heights)", () => {
    const nodes = [newNodeFor(DEFAULT_SETTINGS, 36.123456, -85.654321, "Ridge, north", "a"), newNodeFor(DEFAULT_SETTINGS, 36.2, -85.3, "Quote \"x\"", "b")];
    nodes[0].heightM = 17;
    const r = parseNodesCsv(nodesCsv(nodes), () => null);
    expect(r.errors).toEqual([]);
    expect(r.nodes.map((n) => [n.name, n.lat, n.lon, n.fields.heightM])).toEqual([["Ridge, north", 36.123456, -85.654321, 17], ['Quote "x"', 36.2, -85.3, 5]]);
  });
});
