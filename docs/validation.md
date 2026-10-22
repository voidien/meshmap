# Validation

meshmap's numbers are estimates. This page records what has been checked, how to re-run it, and what has **not** been checked.

## Longley-Rice (ITM) port: `crates/meshmap-itm`

The model is a Rust port of NTIA's reference implementation ([NTIA/itm](https://github.com/NTIA/itm), version 1.3, commit
`183ad95`), which is functionally identical to the FORTRAN 1.2.2 code. NTIA's software is a US-government work released to the
public; the port keeps its algorithms, constants and operation order, and credits it in the crate docs.

### 1. NTIA's published vectors (`tests/reference.rs::ntia_published_vectors`)

`p2p.csv` / `pfls.csv` from the NTIA repository (5 point-to-point cases: 230 MHz to 5.6 GHz, several climates and variability
modes). All five match NTIA's published loss to within the 0.01 dB the file is rounded to.

### 2. The reference code itself, on 1000 generated cases (`tests/reference.rs::matches_reference_on_generated_cases`)

`tools/itm_reference/` builds the **unmodified NTIA C++** (only Windows path separators and the DLL export attribute are patched)
and runs it over generated inputs; `tests/data/golden.csv` holds the inputs and the reference's outputs. The Rust port must
reproduce, for every case: the error / warning code, the warning bit mask, the propagation mode, the basic transmission loss
and the intermediate values (reference attenuation, free-space loss, terrain irregularity, horizon distances and angles,
effective heights, surface refractivity).

The cases cover all 7 climates, both polarizations, 18 variability modes, frequencies from 20 MHz to 20 GHz (40 % at 915 MHz),
antenna heights 0.6 m to 900 m, paths from 0.3 km to 250 km, flat, fractal, ridge and sea-level terrain, and about 3 % invalid
inputs. Mode mix of the successful cases: 713 line-of-sight, 137 diffraction, 122 troposcatter.

**Result: all 1000 cases agree; the largest relative difference in any compared value is 8.5e-14** (floating-point rounding;
the test tolerance is 1e-9). The port also handles the reference's error paths identically (28 cases).

Re-run:

```bash
cargo test -p meshmap-itm --release -- --nocapture            # compares against the stored reference output
git clone https://github.com/NTIA/itm /tmp/itm
tools/itm_reference/build_and_run.sh /tmp/itm 1000            # regenerates golden.csv from the reference C++ (needs g++, python3)
```

### What the port deliberately does differently

- Only point-to-point mode (TLS and confidence/reliability entry points). Area mode is not ported.
- A profile with fewer than 3 points, non-positive spacing or NaN is rejected up front (`BadProfile`); the reference would read
  out of bounds.
- Complex arithmetic is a small in-crate implementation, so results can differ from C++ `std::complex` in the last bit
  (hence the 8.5e-14, not exactly 0).

## meshmap link analysis (`crates/meshmap-core`)

Unit and property tests cover distance/bearing, free-space loss, Fresnel radius, earth-curvature bulge, a known ridge profile,
the margin arithmetic, the headline-model selection and its fallbacks (see `cargo test -p meshmap-core`).

## Coverage heatmaps: `crates/meshmap-coverage`

- **A heatmap cell is a link analysis.** For every distance along a radial the engine runs ITM on exactly the terrain profile from
  the node out to that distance. A unit test checks the per-distance values against a direct `p2p_cr` call on the same profile
  (equal to within 0.001 dB), and that very short distances fall back to free space.
- Behavioural tests: flat ground gives a round footprint that fades with distance and is direction-independent (within 1.5 dB);
  a 300 m ridge east of the node leaves the ground behind it at least 10 dB weaker than the same distance on the open side;
  cancelling stops a job; progress reaches 1; combining nodes counts overlaps and takes the best margin; oversized requests are refused.
- Server tests (`crates/meshmap-server/tests/jobs.rs`, synthetic terrain, no network): job lifecycle, monotonic progress, cache
  hits that never touch the terrain source, results shared across projects while images stay private to people with a job for
  them, per-node reuse inside network jobs, cancellation of queued and running jobs, failure messages when terrain cannot be
  downloaded, recovery of jobs interrupted by a restart, permission checks, and trimming of the cache.
- **Not validated:** the raster is interpolated between radials and distances (about 1 cell of smoothing), so a single cell can
  differ from a separately analysed link by a few dB where terrain changes abruptly; heatmaps have not been compared with
  SPLAT! or Radio Mobile coverage plots, nor with measurements.

## Clutter and terrain packs: `tools/etl`, `crates/meshmap-coverage`

- Unit tests: tile encoding round-trips between Python and Rust (`tests/packs.rs` decodes tiles written by the Python ETL) and
  browser decoding is tested in `web/src/engine/packs.test.ts`; trees shadow a radial in the coverage engine and results are
  bit-identical when no clutter source is present; a hot-added pack changes the cache key.
- End to end (headless Chromium, synthetic pack with a 25 m tree belt across a path): the 5.1 km link goes from marginal
  (107.8 dB, 50.7 dB margin) on bare earth to obstructed (134.3 dB, 24.2 dB margin, clearance -66 %) with clutter.
- **Lidar vs the canopy + buildings fallback** (Nashville downtown, 4 z13 tiles, ground truth = lidar surface minus ground):
  with the `max` canopy statistic, 70.4 % of pixels are at least 3 m tall in the fallback against 77.1 % in the lidar
  product; Jaccard overlap of the 3 m masks 0.825; median height difference -1.5 m, mean absolute difference 4.5 m,
  correlation 0.67. The fallback therefore underestimates clutter a little (missed small buildings, thin canopy). The default
  statistic changed from the 75th percentile (Jaccard 0.725, median -3.5 m) to `max` because of this.
- **3DEP 1/3" vs Terrarium z12 bare earth** (same area): mean absolute difference 0.48 m, 95th percentile 1.63 m, maximum 17.2 m,
  so the main benefit of a pack is the clutter, not the bare ground.
- **Not validated:** one urban area only; no comparison with measured links; ITM treats clutter as terrain geometry, so there is
  no foliage or building-penetration loss, seasons are ignored, and antennas stay on the ground (their height is above ground,
  not above clutter). Heatmaps over areas without clutter data silently use bare earth, which the UI reports as a percentage.

## Not yet done

- **Spot checks against SPLAT! and Radio Mobile are not done.** Neither tool could be run in the environment this was built in.
  The plan: pick 5-10 real links (clear, marginal, obstructed), run them in SPLAT! (ITM/ITWOM) and Radio Mobile with the same
  DEM, antenna heights, frequency, climate and ground constants, and record the differences here. Expect differences from DEM
  resolution and interpolation, how each tool samples the profile, k-factor / refractivity handling, ITM version (SPLAT!'s ITWOM
  is a different model), and rounding of the reliability settings.
- **No field calibration.** Predictions have not been compared with measured RSSI/SNR (a later phase).
- **Terrain data.** Without a terrain pack the app uses public ~30 m Terrarium tiles with no clutter; real paths through trees and
  buildings will be worse than predicted. With a pack, clutter is modelled as solid obstacles, but foliage loss is not.
- ITM is defined for 20 MHz-20 GHz and path distances above roughly 1 km; shorter paths return a result with a warning, and
  inputs ITM rejects fall back to free space + knife-edge, labelled as such in the UI.
