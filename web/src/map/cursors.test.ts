import { describe, expect, it } from "vitest";
import { cursorCss } from "./cursors";

describe("map cursors", () => {
  it("keeps the hand unless something is being placed", () => {
    expect(cursorCss("default", false)).toBe("");
    expect(cursorCss("default", true)).toBe("crosshair");
    expect(cursorCss("crosshair", false)).toBe("crosshair");
  });

  it("draws the precision crosshair with its hotspot at the centre pixel and a fallback", () => {
    const c = cursorCss("precise", false);
    expect(c).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(c).toMatch(/ 16 16, crosshair$/);
    const svg = decodeURIComponent(c.slice(c.indexOf(",") + 1, c.indexOf('")')));
    expect(svg).toContain('width="33"');
    expect(svg).toContain("#111827");
    expect(cursorCss("precise", true)).not.toBe(c);
    expect(decodeURIComponent(cursorCss("precise", true))).toContain("#d92d20");
  });

  it("stays within the size browsers accept for custom cursors", () => {
    expect(cursorCss("precise", false).length).toBeLessThan(2000);
  });
});
