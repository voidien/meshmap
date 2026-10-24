import { describe, expect, it } from "vitest";
import { parseNodesCsv, planImport } from "./nodesImport";
import { DEFAULT_SETTINGS } from "./types";
import { newNodeFor } from "./workspace";

const resolve = (s: string) => (s.toLowerCase().includes("meshcore") ? "meshcore_us" : null);

describe("nodes CSV import", () => {
  it("reads the columns it knows and ignores the rest", () => {
    const r = parseNodesCsv("Name,Latitude,Longitude,Height,preset,status,tags,notes\nHinch,36.1,-85.2,12,MeshCore US,installed,north;phase 1,on the ridge\nGap,36.2,-85.3,,,,,", resolve);
    expect(r.errors).toEqual([]);
    expect(r.nodes[0]).toMatchObject({ name: "Hinch", lat: 36.1, lon: -85.2, fields: { heightM: 12, presetId: "meshcore_us", status: "installed", tags: ["north", "phase 1"], notes: "on the ridge" } });
    expect(r.nodes[1].fields).toEqual({});
  });
  it("needs name, latitude and longitude, and explains bad rows", () => {
    expect(parseNodesCsv("a,b\n1,2", resolve).errors[0]).toMatch(/header needs/);
    const r = parseNodesCsv("name;lat;lon;height_agl_m;tx_dbm\nOk;36;-85;10;22\nBad;99;-85;10;22\nNoPos;;;1;1\nLoud;36;-85;10;80", resolve);
    expect(r.nodes.map((n) => n.name)).toEqual(["Ok", "Loud"]);
    expect(r.errors).toHaveLength(2);
    expect(r.warnings.join(" ")).toMatch(/TX power "80"/);
  });
  it("notes unknown radios and directional antennas", () => {
    const r = parseNodesCsv("name,lat,lon,preset,antenna\nA,36,-85,Weird radio,directional", resolve);
    expect(r.warnings).toHaveLength(2);
    expect(r.nodes).toHaveLength(1);
  });
});

describe("import plan", () => {
  const existing = [newNodeFor(DEFAULT_SETTINGS, 36, -85, "Hinch", "h")];
  const parsed = parseNodesCsv("name,lat,lon,height_agl_m\nhinch,36.5,-85.5,30\nNew,36.6,-85.6,9\nNew,36.7,-85.7,9", () => null).nodes;
  it("add mode never overwrites and renames clashes", () => {
    const p = planImport(parsed, existing, DEFAULT_SETTINGS, "add");
    expect(p.update).toEqual([]);
    expect(p.add.map((n) => n.name)).toEqual(["hinch 2", "New", "New 2"]);
  });
  it("update mode changes the node with the same name and adds the rest", () => {
    const p = planImport(parsed, existing, DEFAULT_SETTINGS, "update");
    expect(p.update).toEqual([{ id: "h", name: "Hinch", patch: { lat: 36.5, lon: -85.5, heightM: 30 } }]);
    expect(p.add.map((n) => n.name)).toEqual(["New", "New 2"]);
    expect(p.add[0].heightM).toBe(9);
    expect(p.add[0].presetId).toBe(existing[0].presetId);
  });
});
