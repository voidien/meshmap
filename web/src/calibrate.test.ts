import { describe, expect, it } from "vitest";
import { fitFoliageScale, type CalPoint } from "./calibrate";
import { weissberger } from "./foliageModel";

const F = 910.525;
const pt = (id: string, depthM: number, trueScale: number, noise = 0, bias = 0): CalPoint => ({
  id,
  label: id,
  bareRssi: -90,
  depthM,
  distanceM: 1000,
  measuredRssi: -90 - trueScale * weissberger(F, depthM) - bias + noise,
});
const depths = [0, 0, 10, 25, 40, 60, 90, 130, 180, 250];
const opts = { freqMhz: F, leafOn: true, currentScale: 1, withOffset: false };

describe("foliage calibration", () => {
  it("matches the Rust model's numbers", () => {
    // the same values as the Rust tests in meshmap-core/src/foliage.rs (100 m at 915 MHz is about 19.45 dB)
    expect(weissberger(915, 100)).toBeCloseTo(19.449, 2);
    expect(weissberger(915, 14)).toBeCloseTo(6.14, 2);
    expect(weissberger(915, 9999)).toBe(weissberger(915, 400));
  });

  it("recovers the scale that generated clean readings", () => {
    const fit = fitFoliageScale(depths.map((d, i) => pt(`p${i}`, d, 1.7)), opts);
    expect(fit.scale).toBeCloseTo(1.7, 6);
    expect(fit.rmseFit).toBeCloseTo(0, 6);
    expect(fit.rmseCurrent).toBeGreaterThan(fit.rmseFit! + 3);
    expect(fit.rmseBare).toBeGreaterThan(fit.rmseCurrent);
    expect(fit.nFoliage).toBe(8);
    expect(fit.nControl).toBe(2);
    expect(fit.warnings).toEqual([]);
  });

  it("copes with noise: the fitted scale is close and fits better than the published model", () => {
    const noise = [1.5, -2, 0.5, 3, -1, 2, -3, 1, -1.5, 2.5, 0, -2, 1];
    const fit = fitFoliageScale(depths.map((d, i) => pt(`p${i}`, d, 0.6, noise[i])), opts);
    expect(fit.scale!).toBeGreaterThan(0.45);
    expect(fit.scale!).toBeLessThan(0.8);
    expect(fit.rmseFit!).toBeLessThan(fit.rmseCurrent);
  });

  it("applies the leaf factor: the same readings give a larger scale for leafless trees", () => {
    const pts = depths.map((d, i) => pt(`p${i}`, d, 1));
    const on = fitFoliageScale(pts, opts);
    const off = fitFoliageScale(pts, { ...opts, leafOn: false });
    expect(off.scale! / on.scale!).toBeCloseTo(2, 6);
  });

  it("warns when open-path readings are off by a constant, and can fit the offset separately", () => {
    const pts = depths.map((d, i) => pt(`p${i}`, d, 1, 0, 8)); // everything 8 dB weaker than the model: not foliage
    const plain = fitFoliageScale(pts, opts);
    expect(plain.controlBiasDb).toBeCloseTo(8, 6);
    expect(plain.warnings.some((w) => /not foliage/.test(w))).toBe(true);
    const withOffset = fitFoliageScale(pts, { ...opts, withOffset: true });
    expect(withOffset.scale).toBeCloseTo(1, 6);
    expect(withOffset.offsetDb).toBeCloseTo(8, 6);
    expect(withOffset.rmseFit!).toBeCloseTo(0, 6);
  });

  it("refuses to fit with too little data and says what is missing", () => {
    const fit = fitFoliageScale([pt("a", 50, 1), pt("b", 0, 1)], opts);
    expect(fit.scale).toBeNull();
    expect(fit.warnings[0]).toMatch(/at least 5 readings/);
  });

  it("does not return a negative scale", () => {
    // stronger through the trees than bare earth predicts
    const pts = depths.map((d, i) => pt(`p${i}`, d, -0.5));
    const fit = fitFoliageScale(pts, opts);
    expect(fit.scale).toBe(0);
    expect(fit.warnings.some((w) => /stronger/.test(w))).toBe(true);
  });

  it("warns when all the foliage readings are at one depth", () => {
    const pts = [0, 0, 50, 52, 51, 49, 50].map((d, i) => pt(`p${i}`, d, 1));
    expect(fitFoliageScale(pts, opts).warnings.some((w) => /similar depths/.test(w))).toBe(true);
  });
});
