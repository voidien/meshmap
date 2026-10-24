import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./types";
import { FACTORY_NODE_DEFAULTS, newNodeFor, parseProject } from "./workspace";

describe("defaults for new nodes", () => {
  it("uses factory values until the project sets its own", () => {
    const n = newNodeFor(DEFAULT_SETTINGS, 36, -85, "A", "id1");
    expect(n).toMatchObject({ id: "id1", heightM: FACTORY_NODE_DEFAULTS.heightM, txDbm: 22, status: "planned" });
    const m = newNodeFor({ ...DEFAULT_SETTINGS, nodeDefaults: { heightM: 12, clientHeightM: 1.5, txDbm: 20, gainDbi: 6, cableLossDb: 1 } }, 36, -85, "B");
    expect(m).toMatchObject({ heightM: 12, clientHeightM: 1.5, txDbm: 20, gainDbi: 6, cableLossDb: 1 });
  });
  it("keeps them through save and load, and ignores junk", () => {
    const p = parseProject({ name: "x", nodes: [], settings: { nodeDefaults: { heightM: 9, txDbm: "loud" } } })!;
    expect(p.settings.nodeDefaults).toMatchObject({ heightM: 9, txDbm: FACTORY_NODE_DEFAULTS.txDbm });
    expect(parseProject({ name: "x", nodes: [], settings: {} })!.settings.nodeDefaults).toBeUndefined();
  });
});
