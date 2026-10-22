import { describe, expect, it } from "vitest";
import { parseCoords } from "./NodeList";

describe("parseCoords", () => {
  it("accepts comma or space separated decimals", () => {
    expect(parseCoords("36.1507, -85.4376")).toEqual([36.1507, -85.4376]);
    expect(parseCoords(" 36 -85 ")).toEqual([36, -85]);
    expect(parseCoords("-33.9,151.2")).toEqual([-33.9, 151.2]);
  });
  it("rejects junk and out-of-range values", () => {
    for (const bad of ["", "abc", "36.1", "91, 0", "0, 181", "36.1, -85.4, 5"]) expect(parseCoords(bad)).toBeNull();
  });
});
