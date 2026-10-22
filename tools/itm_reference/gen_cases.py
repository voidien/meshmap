#!/usr/bin/env python3
"""Generate deterministic random ITM test cases (terrain + parameters) in the ref_driver.cpp input format.

Usage: gen_cases.py N > cases.txt
Terrain is fractal (midpoint displacement) with random roughness, so it spans flat plains to rugged mountains;
parameters cover all climates, polarizations, variability modes and a spread of frequencies, heights and distances.
"""
import math
import random
import sys


def terrain(rng, n_points, rough_m, base_m, kind):
    if kind == "sea":
        return [0.0] * n_points
    if kind == "flat":
        return [base_m + rng.uniform(-1, 1) for _ in range(n_points)]
    size = 1
    while size + 1 < n_points:
        size *= 2
    pts = [0.0] * (size + 1)
    pts[0] = rng.uniform(-1, 1) * rough_m
    pts[size] = rng.uniform(-1, 1) * rough_m
    step, amp = size, rough_m
    while step > 1:
        half = step // 2
        for i in range(half, size, step):
            pts[i] = (pts[i - half] + pts[i + half]) / 2 + rng.uniform(-1, 1) * amp
        step, amp = half, amp * 0.55
    out = []
    for i in range(n_points):
        out.append(base_m + pts[round(i * size / (n_points - 1))])
    if kind == "ridge":
        mid = n_points // 2
        h = rng.uniform(30, 600)
        w = max(2, n_points // rng.randint(8, 40))
        for i in range(max(0, mid - 3 * w), min(n_points, mid + 3 * w)):
            out[i] += h * math.exp(-((i - mid) / w) ** 2)
    return out


def main():
    n = int(sys.argv[1])
    rng = random.Random(20261022)
    for idx in range(n):
        invalid = rng.random() < 0.03
        f = 915.0 if rng.random() < 0.4 else math.exp(rng.uniform(math.log(30), math.log(6000)))
        if rng.random() < 0.05:
            f = rng.choice([20.0, 25.0, 15000.0, 20000.0])
        h_tx = math.exp(rng.uniform(math.log(0.6), math.log(80)))
        h_rx = math.exp(rng.uniform(math.log(0.6), math.log(80)))
        if rng.random() < 0.08:
            h_tx = rng.uniform(100, 900)
        if invalid:
            h_tx = rng.choice([0.2, 3500.0, h_tx])
        d_m = math.exp(rng.uniform(math.log(300), math.log(250e3)))
        xi = rng.uniform(20, 250)
        np_ = max(3, min(int(d_m / xi), 1500))
        xi = d_m / np_
        kind = rng.choices(["fractal", "flat", "sea", "ridge"], [60, 15, 5, 20])[0]
        rough = math.exp(rng.uniform(math.log(2), math.log(900)))
        base = rng.choice([0, 20, 150, 400, 1200, 2500]) + rng.uniform(0, 100)
        elev = terrain(rng, np_ + 1, rough, base, kind)
        dm = [int(round(e * 10)) for e in elev]
        eps = rng.choice([4.0, 15.0, 25.0, 81.0])
        sigma = rng.choice([0.001, 0.005, 0.02, 5.0])
        n0 = rng.choice([250.0, 301.0, 301.0, 320.0, 360.0, 400.0])
        pol = rng.randint(0, 1)
        climate = rng.randint(1, 7)
        mdvar = rng.choice([0, 1, 2, 3, 3, 3, 10, 11, 12, 13, 20, 21, 22, 23, 30, 31, 32, 33])
        if invalid and rng.random() < 0.5:
            climate = rng.choice([0, 8])
        pick = lambda: rng.choice([50.0, 50.0, 10.0, 90.0, 99.0, 1.0, round(rng.uniform(0.5, 99.5), 2)])
        t, l, s = pick(), pick(), pick()
        print(f"{idx},{h_tx:.6f},{h_rx:.6f},{eps},{sigma},{n0},{f:.6f},{pol},{climate},{mdvar},{t},{l},{s},{xi:.9f},{np_};" + " ".join(map(str, dm)))


if __name__ == "__main__":
    main()
