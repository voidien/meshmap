import { describe, expect, it } from "vitest";
import { appStartFrame, heardAdvert, parseAdvert, parsePacket, parseRxLog, SerialDeframer, serialFrame } from "./meshcore";

function advertPacket(name: string, hops: number, withLatLon = false): Uint8Array {
  const nm = new TextEncoder().encode(name);
  const app: number[] = [1 | (withLatLon ? 0x10 : 0) | 0x80];
  if (withLatLon) {
    const d = new DataView(new ArrayBuffer(8));
    d.setInt32(0, 36_012_345, true);
    d.setInt32(4, -85_123_456, true);
    app.push(...new Uint8Array(d.buffer));
  }
  app.push(...nm);
  const payload = [...Array(32).fill(0xab), 1, 2, 3, 4, ...Array(64).fill(0), ...app];
  return Uint8Array.of(0x11, hops, ...Array(hops).fill(7), ...payload); // header: flood route (1), advert type (4)<<2
}
const rx = (snrQ: number, rssi: number, raw: Uint8Array) => Uint8Array.of(0x88, snrQ & 0xff, rssi & 0xff, ...raw);

describe("meshcore protocol", () => {
  it("frames commands for serial and splits them back out of arbitrary chunks", () => {
    const f = serialFrame(Uint8Array.of(1, 2, 3));
    expect([...f]).toEqual([0x3c, 3, 0, 1, 2, 3]);
    const incoming = Uint8Array.of(0x3e, 2, 0, 9, 8, 0x3e, 1, 0, 5);
    const d = new SerialDeframer();
    expect(d.push(incoming.slice(0, 4))).toEqual([]);
    const got = d.push(incoming.slice(4));
    expect(got.map((x) => [...x])).toEqual([[9, 8], [5]]);
  });
  it("skips garbage between frames", () => {
    const d = new SerialDeframer();
    expect(d.push(Uint8Array.of(0, 0, 0x3e, 1, 0, 7)).map((x) => [...x])).toEqual([[7]]);
  });
  it("app start carries the app name", () => {
    const f = appStartFrame("abc");
    expect(f[0]).toBe(1);
    expect(f.length).toBe(11);
  });
  it("reads signed RSSI and quarter-dB SNR from a log push", () => {
    const r = parseRxLog(rx(-22, -104, Uint8Array.of(1, 2)))!;
    expect(r.rssiDbm).toBe(-104);
    expect(r.snrDb).toBe(-5.5);
    expect([...r.raw]).toEqual([1, 2]);
    expect(parseRxLog(Uint8Array.of(0x10, 0, 0))).toBeNull();
  });
  it("parses packets with and without path and transport codes", () => {
    const p = parsePacket(advertPacket("x", 2))!;
    expect(p.payloadType).toBe(4);
    expect(p.hops).toBe(2);
    const t = parsePacket(Uint8Array.of(0x10, 1, 2, 3, 4, 0, 99))!; // route 0 = flood + transport codes
    expect(t.hops).toBe(0);
    expect([...t.payload]).toEqual([99]);
    expect(parsePacket(Uint8Array.of(0x11, 5, 1))).toBeNull(); // path longer than packet
  });
  it("parses an advert's name and position", () => {
    const pkt = parsePacket(advertPacket("Hilltop", 0, true))!;
    const a = parseAdvert(pkt.payload)!;
    expect(a.name).toBe("Hilltop");
    expect(a.lat).toBeCloseTo(36.012345, 6);
    expect(a.lon).toBeCloseTo(-85.123456, 6);
    expect(a.publicKeyHex.startsWith("abab")).toBe(true);
  });
  it("only reports adverts heard straight from the sender", () => {
    const direct = heardAdvert(rx(20, -97, advertPacket("Hilltop", 0)))!;
    expect(direct.advert.name).toBe("Hilltop");
    expect(direct.rssiDbm).toBe(-97);
    expect(direct.snrDb).toBe(5);
    expect(heardAdvert(rx(20, -97, advertPacket("Hilltop", 1)))).toBeNull();
    expect(heardAdvert(rx(20, -97, Uint8Array.of(0x09, 0, 1, 2, 3)))).toBeNull(); // not an advert
  });
});
