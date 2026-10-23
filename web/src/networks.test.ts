import { describe, expect, it } from "vitest";
import { familyOfPreset, fitsNetwork, inferNetwork, isNetwork, NETWORKS } from "./networks";

describe("networks", () => {
  it("MeshCore and Reticulum start from their own radio settings, not Meshtastic's", () => {
    expect(NETWORKS.meshcore.presetId).toBe("meshcore_us");
    expect(NETWORKS.reticulum.presetId).toBe("reticulum_sf8_125");
    expect(NETWORKS.meshcore.freqMhz).toBeCloseTo(910.525, 3);
    expect(NETWORKS.meshtastic.hopLimit).toBe(3);
    expect(NETWORKS.meshcore.hopLimit).toBeGreaterThan(3);
  });

  it("recognises radio setting families, including custom ones", () => {
    expect(familyOfPreset("long_fast")).toBe("meshtastic");
    expect(familyOfPreset("meshcore_sf9")).toBe("meshcore");
    expect(familyOfPreset("reticulum_sf10_125")).toBe("reticulum");
    expect(familyOfPreset("lora:8:125")).toBe("custom");
    expect(fitsNetwork("lora:8:125", "meshcore")).toBe(true);
    expect(fitsNetwork("long_fast", "meshcore")).toBe(false);
    expect(fitsNetwork("meshcore_us", "meshcore")).toBe(true);
  });

  it("keeps old projects as they were planned", () => {
    expect(inferNetwork(["long_fast", "long_fast"])).toBe("meshtastic");
    expect(inferNetwork([])).toBe("meshcore");
    expect(inferNetwork(["reticulum_sf8_125"])).toBe("reticulum");
    expect(isNetwork("meshcore")).toBe(true);
    expect(isNetwork("lora")).toBe(false);
  });
});
