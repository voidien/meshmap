# meshmap — Architecture Proposal (v0)

Status: proposal, no code yet. Open decisions are listed in §14.

## 1. Guiding decisions

| Decision | Choice | Why |
|---|---|---|
| Frontend | **TypeScript + React + Vite**, MapLibre GL JS | MapLibre, deck-style overlays and chart libs are JS-native. A Rust UI framework (Leptos/Yew) would add interop friction on the map and chart code, which is the bulk of the UI. Rust value is kept where it matters: the RF/terrain core compiled to WASM. |
| Backend | Rust, **Axum**, **sqlx**, Tokio | Mature, async, easy to test. |
| DB | PostgreSQL + PostGIS | Spatial indexing of nodes/candidates, sharing/roles, versions. |
| Job queue | **Postgres-backed** (`SELECT … FOR UPDATE SKIP LOCKED`), separate `worker` binary | No Redis; one fewer service; transactional enqueue with project edits. Revisit only if throughput demands it. |
| Compute | `rayon` in workers; same core crate as WASM | One implementation of the math, tested once. |
| Blob storage | Local volume or S3-compatible (MinIO) | Terrain packs, coverage rasters, exports. |
| Tiles | **PMTiles** (single-file, HTTP range reads) | No tile server; works from S3/CDN/volume; browser can read directly. |
| Auth | Email magic links + optional OAuth (Google/GitHub); server-side sessions | Simple, no passwords to store. |

## 2. System overview

```
 Browser (React + MapLibre)                    Docker Compose / any container host
 ┌──────────────────────────┐   HTTPS   ┌─────────┐   ┌──────────────┐
 │ map, node editor, charts │──────────▶│ proxy   │──▶│ api (Axum)   │──┐
 │ Web Worker: meshmap-wasm │  range    │ (Caddy) │   └──────┬───────┘  │
 │   link math on drag      │◀─reads────│         │          │ enqueue  ▼
 └────────────┬─────────────┘  PMTiles  └─────────┘   ┌──────▼───────┐ ┌──────────────┐
              │ terrain/clutter tiles                  │ PostgreSQL   │ │ worker(s)    │
              └───────────────────────────────────────▶│ + PostGIS    │◀│ rayon, core  │
                                                       │ jobs, data   │ └──────┬───────┘
                                                       └──────────────┘        │
                                          object store / volume: terrain packs, coverage PMTiles
                                                                               ▲
                                              etl CLI (offline): 3DEP, lidar, NLCD, buildings → packs
```

## 3. Cargo workspace

```
crates/
  meshmap-core      pure RF/terrain math. No IO, no tokio, wasm-safe (no_std-friendly where practical)
  meshmap-itm       Longley-Rice ITM (point-to-point), pure Rust port of NTIA reference
  meshmap-terrain   tile pack format, decoding, profile sampling, bilinear interp, geodesy
  meshmap-wasm      wasm-bindgen wrapper over core+itm+terrain decode
  meshmap-server    Axum API (auth, projects, nodes, jobs API, exports, SSE)
  meshmap-worker    job runner: coverage, placement, bulk recompute
  meshmap-etl       CLI: build state terrain packs from source data
web/                React app
deploy/             Dockerfiles, compose, Caddyfile
```

`meshmap-core` exposes:
- `Radio` presets and sensitivity, `Node`, `LinkBudget`
- `Profile` (distance, bare-earth, clutter height) and curvature/k-factor
- `fresnel` clearance, `fspl`, `itm` adapter, `analyze_link(params, profile) -> LinkResult`
- `Classification` (clear / marginal / obstructed / none)

Quality bar: property tests (`proptest`), golden vectors against NTIA's published ITM test data and reference outputs, and a **WASM-vs-native parity test** in CI (same inputs, results within 0.01 dB).

## 4. RF model

### Link budget (per direction; links are asymmetric)
`Pr = Ptx + Gtx − Ltx_cable − PL + Grx − Lrx_cable`; `margin = Pr − sensitivity(rx preset)`.
Report A→B and B→A; the link's color uses the worse direction (shown both in the UI).

### Receiver sensitivity from preset
`S = −174 + 10·log10(BW_Hz) + NF + SNR_req(SF)`, with NF ≈ 6 dB (configurable) and
SNR_req: SF7 −7.5, SF8 −10, SF9 −12.5, SF10 −15, SF11 −17.5, SF12 −20 dB.
(e.g. SF11/250 kHz ≈ −130 dBm incl. NF.) Presets table is data, not code, so Meshtastic and MeshCore
presets (LongFast, MediumSlow, …) are just rows. Mixed-preset links are flagged: LoRa only
demodulates when SF/BW match.

### Geometry
- Profile sampled at ≤ DEM resolution (default 30 m spacing, 10 m or 1 m where available).
- Earth bulge with effective radius `k·6371 km` (default k = 4/3), applied to terrain+clutter for
  the **display and Fresnel/clearance geometry**.
- Note: ITM does not take k; it takes surface refractivity (N0, default 301), climate, ground
  conductivity/permittivity, polarization. We expose those as project-level "environment"
  settings and keep k separate, documented as affecting clearance only. This avoids a common
  conflation.
- First Fresnel zone radius `r1 = 17.32·sqrt(d1·d2 / (f·D))` (m, km, GHz); clearance % = min over
  path of (ray height above obstruction)/r1. Flag < 60 %; classify:
  - clear ≥ 100 % and margin ≥ threshold
  - marginal: 60–100 % clearance, or margin in [0, threshold)
  - obstructed: < 60 % or ITM-predicted loss pushes margin < 0 while FSPL margin > 0
  - none: margin < 0 even in free space (never worth drawing; hidden by default)

### Loss estimates
Both FSPL and ITM are always computed; **ITM is the headline number**, FSPL is shown as the
best-case reference. ITM variability defaults: 50/50/50 confidence, with a "design margin"
setting (e.g. 90 % reliability) that moves the quantiles.

## 5. Terrain and clutter data

### Sources
| Need | Source | Notes |
|---|---|---|
| Bare earth baseline | USGS 3DEP 1/3″ (~10 m) seamless, COGs on AWS | Whole US coverage (AK differs). |
| Bare earth, high-res | 3DEP 1 m DEM (project-based) | Coverage varies; per-tile `source` + `year` recorded. |
| Surface (DSM) | 3DEP lidar point clouds (EPT on AWS) → first-return max-height DSM via PDAL | Clutter = DSM − DTM, clamped ≥ 0, noise-filtered (drop < ~1 m, drop power-line/bird outliers via percentile). |
| Clutter fallback: vegetation | USFS NLCD Tree Canopy Cover (percent) **plus a height source** | TCC is a *percentage*, not a height. Combine with LANDFIRE Existing Vegetation Height (30 m) or a global canopy-height product to get meters. Pure TCC alone cannot give obstruction height. |
| Clutter fallback: buildings | Overture Maps / Microsoft building footprints | Height from attribute if present, else `levels × 3 m`, else a default (~6 m); rasterized to the pack grid (max). |

### Pack format (the core data contract)
One **terrain pack per state** (plus overlap buffer so cross-border links work; neighbouring
packs are stitched at read time):
- Geographic grid tiles (e.g. 512×512 samples), per-tile resolution level (1 m / 10 m), stored in a
  PMTiles-like single file, **zstd-compressed**, with range-read access.
- Per tile, bands:
  1. `bare` — int16, decimeters (NAVD88 orthometric; ellipsoid handled in ETL).
  2. `clutter` — uint8, 0.5 m units (obstruction height above ground).
  3. `meta` — source id, acquisition year, "clutter origin" (lidar | canopy+bldg | none).
- Separate **visual** products from the same ETL run: Terrarium/Mapbox-style **terrain-RGB**
  PMTiles for MapLibre `raster-dem` (3D terrain + hillshade), and optional vector tiles for
  coverage-quality boundaries.
- The same pack bytes are read by the server, workers, and the browser (via range requests), so
  results agree everywhere.
- Loading a state = ETL builds `packs/CO.pack` and registers it in a `regions` table; projects
  reference regions they use. A project can span states by listing several.

### Per-node/link analysis mode
`mode ∈ {bare, clutter}`; the API and WASM always return **both** in one `LinkResult`
(`bare: {...}, clutter: {...}`), since they share the profile read. UI shows them side by side
and lets the user pick which one drives the link color.

### Clutter handling choices (documented, configurable)
- Endpoint clutter: an antenna is on a mast/roof, so clutter within ~r m of a node (default 15 m)
  is ignored; node height is AGL above bare earth by default, with an option "above local clutter".
- Clutter as geometry (raised obstruction) by default; optional per-meter foliage loss
  (Weissberger / ITU-R P.833 style) as an advanced toggle, clearly labelled as empirical.
- Lidar clutter is a snapshot (leaf-off/on, year). Surface the collection year in the UI.

## 6. Performance design

### Pair pruning (100+ nodes → ≪ N² analyses)
1. PostGIS GiST index (server) / `rstar` R-tree (WASM) on node positions.
2. Radius query at `max_range` (default 50 km). Per-pair bound tighter than that: the maximum range
   at which free-space loss still leaves margin ≥ 0 (FSPL is a lower bound on loss, so beyond it no
   link is possible). Many pairs drop here.
3. Cheap stage: coarse profile (~100 m) bare-earth LOS/Fresnel screen.
4. Full stage: full-resolution profile + ITM for survivors only; run in parallel.
Results stored in `link_results` keyed by `(node_a, node_b, input_hash)`.

### Incremental invalidation
`input_hash` = hash of (both nodes' RF-relevant fields, positions, environment settings, terrain pack
version, model version). Moving one node invalidates only its ≤ k candidate links and its coverage
raster. Metadata edits (name, notes) don't affect hashes.

### Interactive dragging (WASM)
Web Worker holds the wasm module and the cached tiles. On drag: R-tree query for neighbours →
fetch/cached profile → `analyze_link` for each neighbour within range → update link layer, throttled to
animation frames. On drop, the client saves the node; the server authoritatively recomputes and
caches. During drag, results are marked provisional (reduced profile spacing).

### Background jobs
Table `jobs(id, project_id, kind, input_hash, state, progress, payload, result_ref, error, …)`.
Kinds: `coverage_node`, `coverage_network`, `placement_search`, `recompute_project`, `export`.
- Idempotent by `(kind, input_hash)`: identical requests attach to the existing job/result.
- Progress written periodically; pushed to the UI via **SSE** (`/projects/:id/events`).
- Cancellation flag checked between work chunks.
- Workers scale horizontally; heavy loops use rayon with chunked progress reporting.

## 7. Coverage heatmaps

- Per node, compute on **radials** (e.g. 720 azimuths): extract one profile per radial and evaluate the
  link budget along it at the grid spacing, reusing the profile instead of re-extracting per cell, then
  resample polar → grid (default 90 m cells at 50 km radius, finer for short radii).
- Output: per-node raster of received power (or margin) quantized to uint8, written as PMTiles XYZ
  tiles (zoom-limited) and cached by `input_hash`. Rendered via MapLibre; colorization either
  server-baked RGBA or client-side with a value-encoded raster (so the ramp/threshold is adjustable
  without recompute — preferred).
- **Network coverage** = per-cell best-server (max over nodes) and node-count, composited from the
  cached per-node rasters (cheap, no ITM re-run). Re-composited when any node raster changes.
- Receiver assumption for a "mobile" client (default 2 m AGL, 0 dBi, configurable) is part of the input
  hash.

## 8. Placement suggestions

Common: candidate sites → score → greedy selection → explanation.

**Candidates**: (a) user-drawn points/polygons, (b) auto-found high points: local maxima of the
bare-earth DEM with topographic prominence above a threshold inside the area, thinned by minimum spacing.
Optional filters: exclude water, protected land, steep; optional distance to road.

**Maximize coverage of a drawn area** (weighted maximum-coverage, submodular):
1. For each candidate, compute coverage raster restricted to the target polygon (fast LOS/FSPL pass
   first, ITM refine for the top-N candidates).
2. Greedy selection with **lazy evaluation**: pick the candidate with the largest marginal
   newly-covered weight, update covered set, repeat up to a budget or marginal-gain floor. This has a
   (1 − 1/e) guarantee.
3. Existing nodes count as already-covering; optionally require each new node to link back to the
   existing network (backhaul constraint) with margin ≥ threshold.

**Relay between isolated groups**: build the link graph; find connected components; for components
A and B, score each candidate by the **bottleneck margin** of connecting to the best node in A and in B
(max-min), supporting 2-hop relay chains via a modified shortest-widest path search when no single
site works.

**Explanations** are structured and generated from computed facts (no free text guessing), e.g.:
"+312 km² newly covered (14% of area); elevation 1,842 m, 210 m prominence; links to Node A
(margin +11 dB, 78% Fresnel clear) and Node C (+4 dB); main obstruction toward the east: ridge at 6.2 km."
The UI renders the record and highlights the contributing links and covered cells on the map.

## 9. Data model (PostgreSQL + PostGIS)

```
users(id, email unique, name, created_at)
login_tokens(token_hash, email, expires_at, used_at)           -- magic links
sessions(id_hash, user_id, expires_at, ip, ua)
oauth_identities(provider, subject, user_id)
projects(id, name, owner_id, region_ids[], settings jsonb, revision bigint, created_at, archived_at)
project_members(project_id, user_id, role enum(owner, editor, viewer))
project_invites(token_hash, project_id, role, email, expires_at)
nodes(id, project_id, name, geom geography(Point), ground_m?, antenna_agl_m, tx_dbm, gain_dbi,
      cable_loss_db, preset_id, status enum(planned, installed), notes, revision, updated_by, …)
radio_presets(id, name, sf, bw_hz, nf_db, snr_req_db, sensitivity_dbm)
project_versions(id, project_id, number, snapshot jsonb, label, created_by, created_at)  -- immutable
link_results(project_id, node_a, node_b, input_hash, result jsonb, computed_at)
candidate_sites / target_areas(…, geom)
jobs(…)                                                          -- see §6
artifacts(id, project_id, kind, input_hash, storage_ref, bytes)  -- coverage tiles, exports
regions(id, state, pack_ref, version, bbox)
audit_log(...)
```
Indexes: GiST on `nodes.geom`; `(project_id)` everywhere; unique `(project_id, input_hash, kind)` on artifacts.

**Collaboration**: nodes carry a per-row `revision` for optimistic concurrency; edits push through
SSE to other viewers of the project. Last-write-wins per node with conflict surfaced (not silent).
**Versioning**: a "version" is an immutable snapshot (nodes + settings) that can be named, diffed, and
restored (restore = new revision, history preserved).
**Roles**: owner (manage members, delete), editor (edit nodes/areas, run jobs, save versions), viewer
(read, export). Enforced in one authorization layer (an Axum extractor `ProjectAccess<Role>`), not scattered checks.

## 10. API sketch

REST + JSON, versioned `/api/v1`, OpenAPI generated (`utoipa`), TypeScript types generated from it.
- Auth: `POST /auth/magic-link`, `GET /auth/callback`, `POST /auth/logout`, `GET /auth/oauth/:provider`
- `GET/POST /projects`, `GET/PATCH/DELETE /projects/:id`, members/invites endpoints
- `GET/POST/PATCH/DELETE /projects/:id/nodes[/:nid]`
- `GET /projects/:id/links` (cached results; `?mode=bare|clutter|both`), `POST /projects/:id/links/recompute`
- `POST /projects/:id/jobs` `{kind, params}` → job; `GET /jobs/:id`; `DELETE /jobs/:id`
- `GET /projects/:id/events` (SSE: node changes, job progress)
- `POST /projects/:id/versions`, `GET …/versions`, `POST …/versions/:n/restore`
- `GET /projects/:id/export?format=csv|kml|geojson`
- Terrain/coverage tiles served as PMTiles (static range reads, auth via signed URLs for project-private coverage).

## 11. Frontend

- MapLibre GL: `raster-dem` terrain + hillshade layer; toggleable 3D tilt/exaggeration.
- Layers: nodes (symbol/circle, draggable), links (line colored by class, width by margin), coverage rasters, target
  areas/candidates, placement results.
- Profile panel (uPlot or visx/d3): terrain, clutter stacked, direct ray, Fresnel ellipse (with k-curved earth), loss and margin
  readouts, bare vs. clutter toggle/side-by-side.
- State: TanStack Query (server state) + a small store (Zustand) for map/editing state; WASM link engine wrapped as a Worker
  with a typed async API (Comlink).
- Jobs UI: progress bar per job from SSE; results appear as layers when finished.

## 12. Security

- Magic links: single-use, 15-min expiry, token hashed in DB, rate-limited per email/IP; OAuth via PKCE.
- Sessions: server-side, `HttpOnly; Secure; SameSite=Lax`; CSRF token for state-changing requests.
- Authorization centralized by project role; every query scoped by `project_id`; tests per endpoint × role.
- Signed, short-lived URLs for private artifacts; request size/rate limits; `cargo audit`/`cargo deny` in CI; structured logs.

## 13. Deployment and operations

- `docker compose`: `postgres` (postgis image), `api`, `worker` (same image, different entrypoint), `caddy` (TLS, static web build, range-friendly),
  optional `minio`. Volumes: `pgdata`, `packs`, `artifacts`.
- Multi-stage Dockerfile (cargo-chef cached build → distroless/slim runtime); `wasm-pack` + Vite build baked into the image.
- Migrations with `sqlx migrate` run at api startup (or a one-shot job).
- `meshmap-etl build-state CO` is run offline (needs GDAL/PDAL; separate `etl` image) and output copied/uploaded to the packs store;
  api/worker need only the pack files, never GDAL.
- Observability: `tracing` + OpenTelemetry-ready, `/healthz`, job metrics. Backups: `pg_dump` of the DB; packs are reproducible from ETL.

## 14. Risks and open questions

1. **ITM port**: NTIA's reference is C++ (public domain). Plan: pure-Rust port, validated against the reference vectors (vs. FFI,
   which blocks WASM). Largest correctness risk; schedule early.
2. **Canopy height**: TCC alone gives no height (§5). Need to choose the height source for non-lidar areas.
3. **ETL scale**: lidar → DSM for a whole state is heavy (TB-scale). Proposal: ETL lidar only for user-selected
   AOIs/counties first; 10 m baseline for the rest of the state.
4. **Datum/vertical consistency** between 3DEP DEM, lidar projects, and buildings: normalize in ETL; record in tile `meta`.
5. **Model validity**: ITM is good for terrain-dominated paths; at 915 MHz in dense clutter it will be optimistic. We show both bare and clutter,
   state assumptions in the UI, and plan a calibration path (user-logged real link measurements per project) later.
6. **Browser memory/bandwidth** on state-sized projects: tile LRU cache, fetch only along drag neighbourhood.
7. Is the Meshtastic vs. MeshCore difference purely preset/sensitivity data? (Proposed: yes; hop/routing behaviour is out of scope for v1.)
8. Teams/orgs: v1 shares per-project with explicit members; org-level groups deferred.

## 15. Milestones (your order; each ends with "how to run / what to verify")

| | Milestone | Delivers | You verify |
|---|---|---|---|
| a | DEM + clutter pipeline, elevation lookup | `meshmap-etl`, `meshmap-terrain`, one state pack, terrain-RGB tiles, `elevation` CLI + endpoint | Known peaks/benchmarks match published elevations within DEM error; clutter band non-zero over known forests/buildings; pack size/build time |
| b | Link math library | `core` + `itm`, presets, WASM build | Unit tests (§17), ITM reference vectors, WASM-vs-native parity, SPLAT!/Radio Mobile spot checks |
| c | Map UI + node editing | React/MapLibre, 3D terrain, node CRUD (local/anonymous project), WASM drag feedback, profile chart | Drag a node, links recolor instantly; chart shows terrain, clutter, ray, Fresnel; bare vs clutter side by side |
| d | Project-wide analysis with jobs | Pruned pair search, job queue, worker, SSE progress, result caching | 100+ synthetic nodes: pair count ≪ N², progress bar, second run is cache hits, edit one node recomputes only its links |
| e | Accounts and sharing | Magic links/OAuth, roles, invites, versions, exports | Role matrix tests; viewer cannot edit; version restore; CSV/KML/GeoJSON open in QGIS/Google Earth |
| f | Heatmaps | Radial coverage jobs, tile artifacts, network layer | Per-node raster vs. SPLAT!; network layer composited without recompute |
| g | Placement suggestions | Candidates, greedy coverage, relay search, explanations | Known synthetic scenarios with a provably best site; explanation text matches map |
| h | Later phases | §16 | per feature |

## 16. Later phases (design hooks now, build later)

- **Mesh health**: link graph (links with margin ≥ threshold, both directions) in the worker. Hop counts via BFS from chosen
  gateway nodes; **articulation points** and bridges (Tarjan) = single points of failure; connected components = isolated groups;
  "what if node X dies" is a cached recompute. No schema change beyond job kinds.
- **Calibration**: `observations(project, node_a, node_b, rssi, snr, observed_at, source)` from CSV import or a Meshtastic MQTT
  subscriber (worker role, opt-in per project). Compare predicted vs. observed per link; fit a per-project clutter-loss offset
  and/or foliage coefficient (least squares) stored in project `settings`, applied through the input hash. Report residuals; never
  silently change the model.
- **Field mode**: PWA route of the same React app; phone GPS → WASM `analyze_link` against nearby nodes and a local radial coverage for a
  hypothetical node at X m AGL, with tiles prefetched for the area (service worker cache). Works offline once region tiles are cached.
- **Antenna patterns**: `antenna_patterns(id, name, gain table by azimuth (and optional elevation))`; node gets `pattern_id` +
  `azimuth_deg` (+ tilt). The core takes gain as a function `gain(bearing)`; link budget uses each end's gain toward the other.
  Omni stays the default, and the core API is designed for this from M(b) to avoid a later breaking change.
- **Comments and site report**: `comments(id, project_id, node_id?, author, body, created_at)`. One-page report rendered
  server-side from an HTML template to PDF (headless Chromium or `typst`) with static map image, profile, expected links, assumptions.

## 17. Correctness and validation plan

- **Unit/property tests** in `core`: distance/bearing (known city pairs; antipodal and pole edge cases), FSPL (e.g. 1 km @ 915 MHz ≈ 91.7 dB),
  Fresnel radius (analytic cases), curvature bulge (`d1·d2/(2kR)` for several k), and a synthetic known profile with a single knife-edge
  obstruction checking clearance % and classification.
- **ITM**: run NTIA's published reference test vectors against `meshmap-itm`; additionally cross-check against the reference C++
  implementation on a few hundred random profiles in CI (tolerance ~0.1 dB) with differences documented.
- **Spot checks** against SPLAT! and Radio Mobile on a handful of real links (clear, marginal, obstructed). Expect differences from DEM
  resolution, interpolation, ITM version/variability settings and k handling; we record them in `docs/validation.md` with the inputs, so
  they're reproducible rather than anecdotal.
- **Assumptions are always shown**: each result carries the model version, DEM source/resolution/year, clutter origin, k, ITM environment
  and reliability, receiver sensitivity and NF, and the UI labels outputs "estimate". Exports include the same block.

## 18. Expected hosting needs (estimates, to be confirmed at milestone a)

**Terrain storage** (compressed packs; bands: int16 bare + uint8 clutter):
- 10 m grid: ≈ 10 M samples per 1000 km² per... i.e. 10⁴ samples/km² → ~30 KB/km² raw, ~10-15 KB/km² compressed.
  Colorado (270k km²) ≈ 3-4 GB; Texas (700k km²) ≈ 8-10 GB; a small state ≈ < 1 GB; CONUS ≈ 80-120 GB.
- 1 m lidar: ~3 MB/km² raw, ~1 MB/km² compressed; a 2,000 km² county ≈ 2 GB. So lidar is loaded per area of interest, not statewide.
- Terrain-RGB visual tiles: ≈ 0.5-1× the 10 m pack size per state.
- ETL scratch: 3-5× the final pack size while building (more for lidar); one-off, can run on a laptop/big VM and upload the result.

**Runtime sizing**
| Tier | Fits | Spec |
|---|---|---|
| Small (1-3 states, few groups) | api + worker + db on one box | 4 vCPU, 8-16 GB RAM, 100-250 GB SSD |
| Medium (heavy heatmaps/placement, several concurrent users) | separate worker | api 2 vCPU/4 GB; worker 8-16 vCPU/16-32 GB; Postgres 2 vCPU/4-8 GB; 500 GB SSD or S3 for packs |
| ETL (offline/occasional) | one-off | 16 cores, 32-64 GB RAM, 0.5-1 TB scratch, GDAL/PDAL image |

- Postgres is small (projects/nodes are kilobytes; links ≈ N·k rows per project); a few GB for years of use.
- Per-node coverage raster ≈ 100 km × 100 km at 90 m ≈ 1.2 M cells ≈ 0.3-0.5 MB compressed; ~100 nodes ≈ tens of MB per project version, cached by hash with LRU/TTL cleanup.
- Memory is dominated by hot terrain tiles (mmap/OS page cache on the pack file); give the box RAM ≈ the hot working set (a few GB) and fast SSD.
- Compute is bursty: whole-project recompute of ~100 nodes × ~10 candidates each is seconds-minutes on 8 cores; a 50 km-radius coverage raster is
  roughly seconds to tens of seconds per node. Workers scale horizontally if needed.
- Bandwidth: browser reads tile ranges along a link (KBs) and visual tiles; put packs behind Caddy/CDN with range support.

## 19. Next step

Please review §14 (open questions) and §18 (sizing). On your OK I start milestone (a), beginning with a Cargo workspace skeleton, the pack
format spec, and the ETL for one state (suggest Colorado: big relief, good 3DEP lidar coverage, ~3-4 GB).
