import { describe, expect, it } from "vitest";
import { nearestSnap, nextSnap, snapHeights } from "./sheet";

describe("bottom sheet snap points", () => {
  it("peek is fixed, half is half of the room, full leaves a strip of map", () => {
    expect(snapHeights(800)).toEqual({ peek: 96, half: 400, full: 690 });
    expect(snapHeights(300).full).toBeGreaterThanOrEqual(136);
  });
  it("snaps to the nearest, and a flick goes further", () => {
    expect(nearestSnap(120, 800)).toBe("peek");
    expect(nearestSnap(380, 800)).toBe("half");
    expect(nearestSnap(650, 800)).toBe("full");
    expect(nearestSnap(300, 800, 0)).toBe("half");
    expect(nearestSnap(300, 800, 40)).toBe("full"); // a hard flick up from 300 goes past half
    expect(nearestSnap(200, 800, -20)).toBe("peek");
  });
  it("tapping cycles", () => {
    expect([nextSnap("peek"), nextSnap("half"), nextSnap("full")]).toEqual(["half", "full", "peek"]);
  });
});
