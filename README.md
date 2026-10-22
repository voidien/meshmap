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
   (Open JSON / MeshCore auto-detects the format; `antenna_height_a` = node antenna height, `antenna_height_b` = client height; letters and `overlays` are preserved). All projects autosave in this browser.
7. **Several setups**: the dropdown at the top switches projects; `[` / `]` step through them and `` ` `` flips to the last
   one. "Import files…" accepts several files at once (each becomes its own project). "Duplicate" copies a setup for a what-if.
   "Compare setups" draws a second project faintly on the map (grey dots, dashed links) and lists node and link-class
   differences (nodes matched by MeshCore letter, else name).
8. **Sanity checks**: raise antenna heights on a long flat path and watch clearance and margin improve;
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

### Tailscale (optional, separate compose project)

`deploy/tailscale/` is its own compose project that publishes meshmap on your tailnet over HTTPS, with no ports opened.
It joins meshmap's Docker network (`meshmap-net`), so start meshmap first.

```bash
docker compose up --build -d              # in the repo root: meshmap
cd deploy/tailscale
cp .env.example .env                      # set TS_AUTHKEY (and optionally TS_HOSTNAME, TS_MODE)
docker compose up -d
docker compose logs -f                    # the HTTPS cert takes ~30-60 s on first start
```

Then open `https://<TS_HOSTNAME>.<your-tailnet>.ts.net`. The container runs in userspace mode (no `NET_ADMIN`/TUN) and keeps its
identity in the `tailscale-state` volume. The local port 9091 keeps working; drop the `ports:` mapping in the root
`docker-compose.yml` for tailnet-only access.

- Prerequisites: HTTPS certificates enabled in the Tailscale admin console (DNS page).
- `TS_MODE=serve` (default): reachable only from your tailnet.
- `TS_MODE=funnel`: reachable from the **public internet** via Tailscale Funnel (needs the `funnel` node attribute in your
  tailnet policy). meshmap has no login, so anyone with the URL can use it; prefer `serve`.

Stop them independently: `docker compose down` in `deploy/tailscale`, then in the repo root (stop the sidecar first,
otherwise the network is still in use).

Troubleshooting (run in `deploy/tailscale`):

```bash
docker compose exec tailscale tailscale serve status                      # https://<host>.ts.net -> http://meshmap-web:8080
docker compose exec tailscale wget -qO- http://meshmap-web:8080/healthz   # should print "ok"
```

Upgrading from the earlier profile-based setup: run `docker compose down --remove-orphans` in the repo root and
`docker volume rm meshmap_tailscale-state`, delete the old `meshmap` machine in the Tailscale admin console, then follow the steps above.
