# meshmap

Planner for large LoRa mesh networks (Meshtastic / MeshCore style) in the US, 915 MHz.
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full plan and the v0-v5 delivery ladder.

**Current release: v1** - a static web app (no backend). Estimates only: bare-earth terrain from public ~30 m tiles and
the Longley-Rice (ITM) propagation model (a Rust port validated against NTIA's reference code, see [`docs/validation.md`](docs/validation.md)).
No clutter (trees, buildings) yet.

## Layout

```
crates/meshmap-core   pure RF/terrain math (geodesy, FSPL, Fresnel, curvature, link analysis, pair pruning)
crates/meshmap-itm    Longley-Rice / ITM point-to-point model (port of the NTIA reference)
tools/itm_reference   builds the NTIA C++ reference and regenerates the validation vectors
crates/meshmap-wasm   wasm-bindgen wrapper
web/                  React + TypeScript + MapLibre app
scripts/build-wasm.sh builds the WASM module into web/src/wasm/pkg
```

## Run it

Prerequisites: Rust (stable) with `rustup target add wasm32-unknown-unknown`,
`cargo install wasm-bindgen-cli --version 0.2.100`, Node 20+.

```bash
cargo test --workspace            # math tests, including ITM vs the NTIA reference vectors
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
8. **ITM**: click a link: the table shows the Longley-Rice loss and regime, the knife-edge cross-check and the model used. Project settings
   has the ITM environment (climate, ground, refractivity, polarization) and reliability / confidence; 90 / 90 is a design margin.
9. **Node management**: the Nodes panel lists every node (status dot, MeshCore letter, link count, best margin) with search and
   sorting; click a row to select and zoom to it, tick several for bulk edits (height, client height, TX power, gain,
   cable loss, preset, status; only filled-in fields change) or bulk delete, or add a node by typing coordinates.
   A selected node shows its connections (click one to open its terrain profile), plus Zoom to / Duplicate / Delete.
   The "Names" button toggles name labels on the map.
10. **Sanity checks**: raise antenna heights on a long flat path and watch clearance and margin improve;
   raise k (e.g. 4/3 to 2) and watch clearance increase; use presets with different SF/BW and the link becomes "none".

## Docker

```bash
cp .env.example .env              # optional: change MESHMAP_PORT (default 9091)
docker compose up --build -d     # http://localhost:9091
# or
docker build -t meshmap:v0 . && docker run --rm -p 9091:8080 meshmap:v0
```

Multi-stage build: Rust tests + WASM build, then web tests + production build, then a small non-root nginx image
(~50 MB) serving static files on port 8080 (`/healthz` for health checks). The container needs no database or secrets.
For public hosting put TLS in front (Caddy, Traefik, a cloud load balancer) and replace the OSM basemap first.
Any static host (Netlify, S3 + CDN, GitHub Pages) also works with just the contents of `web/dist`.

### HTTPS through Tailscale (optional)

```bash
tailscale serve --bg 9091          # use your MESHMAP_PORT if you changed it
```

Then open `https://<machine>.<tailnet>.ts.net` from any device on your tailnet (HTTPS certificates must be enabled in the
Tailscale admin console, DNS page). `tailscale serve status` shows what is published and `tailscale serve reset` removes it.

### Tailscale from a container (optional)

Instead of Tailscale on the server, meshmap can bring its own: `docker-compose.tailscale.yml` adds a Tailscale container
beside it that joins your tailnet as a machine of its own (`meshmap` unless you set `TS_HOSTNAME`) and serves
`https://meshmap.<tailnet>.ts.net` with a certificate. meshmap shares that container's network, so nothing listens on the
server's port 9091 any more.

1. In the Tailscale admin console:
   - **DNS:** turn on MagicDNS and **HTTPS Certificates**.
   - **Access controls:** only needed for Funnel (below). Tagging the machine is simplest (a tagged machine's key never expires):
     ```json
     "tagOwners": { "tag:meshmap": ["autogroup:admin"] },
     "nodeAttrs": [ { "target": ["tag:meshmap"], "attr": ["funnel"] } ]
     ```
   - **Settings → Keys → Generate auth key**, with the tag `tag:meshmap` if you made one.
2. In `.env`, uncomment and fill in:
   ```
   COMPOSE_FILE=docker-compose.yml:docker-compose.tailscale.yml
   TS_AUTHKEY=tskey-auth-...
   ```
3. `docker compose up -d`, then `docker compose logs tailscale` shows it joining (the certificate takes up to a minute the
   first time). Its identity is kept in `data/tailscale/`, so it keeps its name and address across restarts and updates (the
   key is used only the first time). Needs Docker Compose 2.24 or later.
4. Open `https://meshmap.<tailnet>.ts.net` from a device signed in to Tailscale.

By default (`TS_MODE=serve`) only devices on your tailnet can reach it. Set `TS_MODE=funnel` in `.env` to put it on the public
internet through Funnel as well (needs the `funnel` attribute above). meshmap has no login, so anyone with the URL could use it.

If you used `tailscale serve` on the server before, turn it off there (`tailscale serve reset`): the address is now the new
machine's. To go back, comment out the two lines and `docker compose up -d`.
