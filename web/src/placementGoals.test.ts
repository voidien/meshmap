import { describe, expect, it } from "vitest";
import { DEFAULT_PLACEMENT, placementRequest } from "./placement";
import { DEFAULT_SETTINGS, type MeshNode } from "./types";

const node = (id: string, gateway?: boolean): MeshNode => ({
  id, name: id, lat: 36, lon: -85, heightM: 10, clientHeightM: 1, txDbm: 22, gainDbi: 3, cableLossDb: 0.5, presetId: "meshcore_us", status: "planned", notes: "", gateway,
});
const area = { lat: 36, lon: -85, radiusKm: 10 };
const settings = { ...DEFAULT_SETTINGS, network: "meshtastic" as const };

describe("placement request goals", () => {
  it("sends gateways and the hop limit only for the redundancy goal", () => {
    const nodes = [node("a"), node("b", true), node("c")];
    const cov = placementRequest(area, null, nodes, settings, DEFAULT_PLACEMENT) as Record<string, unknown>;
    expect(cov.goal).toBe("coverage");
    expect(cov.gateways).toBeUndefined();
    const red = placementRequest(area, null, nodes, settings, { ...DEFAULT_PLACEMENT, goal: "redundancy" }) as Record<string, unknown>;
    expect(red.gateways).toEqual([1]);
    expect(red.hopLimit).toBe(3); // Meshtastic's usual figure
    const custom = placementRequest(area, null, nodes, settings, { ...DEFAULT_PLACEMENT, goal: "redundancy", hopLimit: 5 }) as Record<string, unknown>;
    expect(custom.hopLimit).toBe(5);
  });
  it("leaves gateways out when none is marked", () => {
    const r = placementRequest(area, null, [node("a"), node("b")], settings, { ...DEFAULT_PLACEMENT, goal: "redundancy" }) as Record<string, unknown>;
    expect(r.gateways).toBeUndefined();
    expect(r.hopLimit).toBeUndefined();
  });
});
