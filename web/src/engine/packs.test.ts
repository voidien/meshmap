import { describe, expect, it } from "vitest";
import { decodeBareRgba, decodeClutterRgba } from "./packs";

describe("pack tile decoding", () => {
  it("decodes bare earth as (R<<8|G)/10 - 500", () => {
    const e = Math.round((312.4 + 500) * 10);
    const px = new Uint8Array([e >> 8, e & 255, 0, 255]);
    expect(decodeBareRgba(px)[0]).toBeCloseTo(312.4, 3);
  });
  it("decodes clutter as half metres", () => {
    expect(decodeClutterRgba(new Uint8Array([51, 51, 51, 255]))[0]).toBe(25.5);
  });
});
