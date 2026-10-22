# meshmap

Planner for large LoRa mesh networks (Meshtastic / MeshCore style) in the US, 915 MHz.
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full plan and the v0-v5 delivery ladder.

**Current release: v0** - a static web app (no backend). Estimates only: bare-earth terrain from public ~30 m
tiles, free-space loss plus single knife-edge diffraction. No clutter, no Longley-Rice yet.

## Layout

```
crates/meshmap-core   pure RF/terrain math (geodesy, FSPL, Fresnel, curvature, link analysis, pair pruning)
crates/meshmap-wasm   wasm-bindgen wrapper
web/                  React + TypeScript + MapLibre app
scripts/build-wasm.sh builds the WASM module into web/src/wasm/pkg
```

## Run it

Prerequisites: Rust (stable) with `rustup target add wasm32-unknown-unknown`,
`cargo install wasm-bindgen-cli --version 0.2.100`, Node 20+.

```bash
cargo test --workspace            # math tests
./scripts/build-wasm.sh           # WASM bindings (re-run after changing Rust)
cd web && npm install
npm test                          # terrain decoding/sampling tests
npm run dev                       # http://localhost:5173
npm run build                     # static site in web/dist (host anywhere)
```

Needs internet access for map tiles (OpenStreetMap raster basemap and AWS Terrarium terrain tiles).
The OSM tile server is for light/dev use only; switch the basemap in `web/src/map/MapView.tsx` before public hosting.

## What to verify

1. **Add nodes**: "+ Add node", click the map; edit height, TX power, gain, cable loss, preset, status, notes.
2. **Links**: nodes within *max range* (default 50 km) get colored links: green clear, yellow marginal, red obstructed.
   Out-of-range ("none") links are hidden unless enabled in settings.
3. **Drag a node**: links update live (coarser terrain sampling while dragging, full resolution on release).
4. **Click a link** (map or list): terrain profile with earth curvature (k-factor), direct ray, first Fresnel zone
   (inner band = 60 %), loss/margin numbers in both directions.
5. **3D terrain** toggle: tilted MapLibre terrain.
6. **Save/Open JSON**, Nodes/Links CSV, GeoJSON, KML exports, and **MeshCore** `coverage_layers_*.json` import/export
   (Open JSON / MeshCore auto-detects the format; `antenna_height_a` = node antenna height, `antenna_height_b` = client height; letters and `overlays` are preserved). The project also autosaves in the browser.
7. **Sanity checks**: raise antenna heights on a long flat path and watch clearance and margin improve;
   raise k (e.g. 4/3 to 2) and watch clearance increase; use presets with different SF/BW and the link becomes "none".

## Docker

```bash
docker compose up --build        # http://localhost:9091
# or
docker build -t meshmap:v0 . && docker run --rm -p 9091:8080 meshmap:v0
```

Multi-stage build: Rust tests + WASM build, then web tests + production build, then a small non-root nginx image
(~50 MB) serving static files on port 8080 (`/healthz` for health checks). The container needs no database or secrets.
For public hosting put TLS in front (Caddy, Traefik, a cloud load balancer) and replace the OSM basemap first.
Any static host (Netlify, S3 + CDN, GitHub Pages) also works with just the contents of `web/dist`.
