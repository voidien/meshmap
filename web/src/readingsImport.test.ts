import { describe, expect, it } from "vitest";
import { parseReadingsCsv } from "./readingsImport";
import type { MeshNode } from "./types";

const node = (id: string, name: string): MeshNode => ({ id, name, lat: 36, lon: -85, heightM: 10, clientHeightM: 1, txDbm: 22, gainDbi: 3, cableLossDb: 0.5, presetId: "meshcore_us", status: "planned", notes: "" });
const nodes = [node("n1", "Hill Repeater"), node("n2", "Water Tower")];

describe("importing readings from CSV", () => {
  it("reads rows, matches nodes by name or id, and parses times", () => {
    const csv = ["lat,lon,rssi,snr,node,note,time,accuracy", '36.1,-85.2,-104,5.5,hill repeater,"under pines, wet",2025-12-01T15:30:00Z,6', "36.2,-85.3,-111,,n2,,1764603000,", ""].join("\n");
    const r = parseReadingsCsv(csv, nodes, 1_700_000_000);
    expect(r.errors).toEqual([]);
    expect(r.readings).toHaveLength(2);
    expect(r.readings[0]).toMatchObject({ lat: 36.1, lon: -85.2, rssiDbm: -104, snrDb: 5.5, nodeRef: "n1", note: "under pines, wet", takenAt: 1764603000, accuracyM: 6 });
    expect(r.readings[1]).toMatchObject({ nodeRef: "n2", snrDb: null, accuracyM: null, takenAt: 1764603000 });
    expect(new Set(r.readings.map((x) => x.id)).size).toBe(2);
  });

  it("understands other column names, delimiters and millisecond times", () => {
    const csv = "Latitude;Longitude;RSSI (dBm);Timestamp\n36,-85,-99;1700000000000".replace("-99;", "-99;");
    const r = parseReadingsCsv("Latitude;Longitude;RSSI (dBm);Timestamp\n36;-85;-99;1700000000000", nodes);
    void csv;
    expect(r.errors).toEqual([]);
    expect(r.readings[0]).toMatchObject({ lat: 36, lon: -85, rssiDbm: -99, takenAt: 1700000000 });
  });

  it("skips bad rows with a reason and counts unknown node names", () => {
    const csv = ["lat,lon,rssi,node", "99,-85,-100,", "36,-85,20,", "36,-85,,", "36,-85,-100,Nowhere", "x,y,-100,"].join("\n");
    const r = parseReadingsCsv(csv, nodes);
    expect(r.readings).toHaveLength(1);
    expect(r.readings[0].nodeRef).toBeNull();
    expect(r.unmatchedNodes).toBe(1);
    expect(r.errors).toHaveLength(4);
    expect(r.errors[0]).toMatch(/row 2.*position/);
    expect(r.errors[1]).toMatch(/row 3.*RSSI/);
    expect(r.errors[2]).toMatch(/row 4.*no signal/);
  });

  it("explains a missing header", () => {
    expect(parseReadingsCsv("a,b\n1,2", nodes).errors[0]).toMatch(/latitude and longitude/);
    expect(parseReadingsCsv("lat,lon,rssi", nodes).errors[0]).toMatch(/header row and at least one/);
  });
});
