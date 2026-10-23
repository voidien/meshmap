# meshmap-etl: terrain packs

Builds the terrain packs the server reads from `MESHMAP_PACKS_DIR` (default `data/packs`). A pack holds, for an area:

- **bare earth** from USGS 3DEP 1/3 arc-second (about 10 m) elevation, and
- **clutter** (height of trees and buildings above the ground), taken first from USGS 3DEP **lidar** (per-pixel 95th percentile of the first-return surface minus the median ground return) and, where there is no lidar, from the Meta/WRI 1 m **canopy height** map combined with **Overture** building footprints and heights.

## Format (`meshmap-pack/1`)

```
<id>/pack.json            name, bbox, zoom, builtAt, sources, attribution, tile counts
<id>/tiles.json           the tiles present, and which of them have clutter
<id>/<z>/<x>/<y>.bare.png    256x256 RGB: R,G = big-endian u16 of round((elevation_m + 500) * 10), B = 0
<id>/<z>/<x>/<y>.clutter.png 256x256 grey8: round(height_m * 2)   (0.5 m steps, up to 127 m)
```

Tiles are Web-Mercator at zoom 13 (about 15 m per pixel at 36 N). They are plain 8-bit PNGs, so the browser decodes exactly what the server reads. Cost is about 0.1 MB per tile. Dropping a pack folder into the packs directory is enough: the server notices it without a restart, and heatmap results computed with other terrain stay valid because the terrain identity is part of the cache key.

## Use

```bash
pip install ./tools/etl        # needs Python 3.10+, rasterio, laspy[lazrs], pyarrow, shapely, numpy, Pillow
meshmap-etl lidar-projects TN_                   # which USGS lidar projects exist for a state
meshmap-etl build --id nashville --bbox=-86.80,36.15,-86.765,36.185 --out data/packs --lidar TN_DavidsonCo_1_2022
meshmap-etl build --id tn --state TN --out data/packs --clutter canopy   # whole state, no lidar: canopy + buildings
meshmap-etl info data/packs/tn
meshmap-etl verify data/packs/tn
```

Builds resume where they stopped (`tiles.partial.jsonl`). `--clutter auto` (default) uses lidar where `--lidar`/`--lidar-prefix` projects cover a tile and canopy + buildings elsewhere. `--limit N` builds only the first N tiles, which is a good first try.

With Docker: `docker compose --profile etl run --rm etl build --id nashville --bbox=... ` writes to `./data/packs`.

## Time and size (measured on a 4-core machine)

| step | cost |
|---|---|
| 4 tiles (about 60 km2) with lidar | about 1.6 min |
| 4 tiles, canopy + buildings only | about 45 s (buildings query is about 30 s per 4x4-tile block) |
| pack size | about 0.1 MB per tile; a whole state at zoom 13 is thousands of tiles, so expect hours and a few hundred MB |

The ETL needs unrestricted internet access to `prd-tnm.s3.amazonaws.com`, `usgs-lidar-public.s3.amazonaws.com`, `s3.amazonaws.com/dataforgood-fb-data`, `overturemaps-us-west-2.s3.amazonaws.com`.

## Data and attribution

- Elevation and lidar: USGS 3D Elevation Program (public domain).
- Canopy height: Meta and World Resources Institute, "High Resolution Canopy Height Maps" (CC BY 4.0).
- Buildings: Overture Maps Foundation (ODbL for the buildings theme; attribution is stored in `pack.json`).

## Caveats

- Clutter is treated as solid geometry by the radio model; there is no foliage attenuation, no seasons, and no penetration of buildings.
- The canopy/buildings fallback underestimates lidar clutter somewhat (see `docs/validation.md`).
- Both antennas are placed on the ground at their position, so a mast beside a tree or on a roof is described by its height above ground, not above the clutter.

## Example: Cookeville and Crossville, Tennessee

What exists: USGS's index shows one lidar collection over both towns, the Tennessee "27 County" Cumberland Plateau survey
(quality level 2, about 2 points per square metre), flown 3 December 2015 to 13 January 2016. The 2023 USGS copy
(`TN_27_County_QL2_LiDAR_Cumberland_Plateau_BAA`) is the same data. Nothing newer was found. Its public Entwine copies are the
projects `USGS_LPC_TN_27County_blk1_2015_LAS_2018` to `blk4` (list them with `meshmap-etl lidar-projects USGS_LPC_TN_27County`;
blocks 2 and 3 cover the whole area).

Two caveats follow from its age and season: buildings and clearings since early 2016 are missing, and it was flown with the leaves
off, so canopy is thinner in the data than in summer.

Build in two layers. A regional pack at zoom 13 (about 15 m per pixel) for the area between and around the towns, then finer
packs at zoom 14 (about 7.6 m per pixel) for each town. **Where packs overlap, the finest one wins**, so the town packs simply sit
on top of the regional one; the regional pack keeps supplying clutter wherever a fine tile has none.

```bash
# regional, zoom 13 (about 330 tiles, 30-40 MB; hours on a small server; interrupted builds resume)
docker compose --profile etl run --rm etl build --id upper-cumberland --bbox=-85.75,35.80,-84.85,36.30 --lidar-prefix USGS_LPC_TN_27County --buildings-over-lidar

# towns, zoom 14: Cookeville (about 56 tiles) and Crossville (about 42 tiles)
docker compose --profile etl run --rm etl build --id cookeville-z14 --zoom 14 --bbox=-85.58,36.11,-85.42,36.21 --lidar-prefix USGS_LPC_TN_27County --buildings-over-lidar
docker compose --profile etl run --rm etl build --id crossville-z14 --zoom 14 --bbox=-85.10,35.91,-84.96,36.00 --lidar-prefix USGS_LPC_TN_27County --buildings-over-lidar
```

`--buildings-over-lidar` adds Overture building footprints where the lidar saw open ground (so buildings put up since the survey
show up) and leaves buildings the lidar measured as measured. Try `--limit 4` first. At zoom 14 the lidar is read at the same
depth as before, so for the finest detail also try `--lidar-depth 8` (about eight times the lidar data per tile, so slower and
heavier on memory: keep `--workers 1` on a 16 GB machine).
