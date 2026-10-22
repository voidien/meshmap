# meshmap

Planner for large LoRa mesh networks (Meshtastic / MeshCore style) in the US, 915 MHz.
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full plan and the v0-v5 delivery ladder.

**Current release: v3** - accounts, shared projects, and **coverage heatmaps** computed on the server as background jobs. Estimates only: bare-earth terrain from
public ~30 m tiles and the Longley-Rice (ITM) propagation model (a Rust port validated against NTIA's reference code, see
[`docs/validation.md`](docs/validation.md)). No clutter (trees, buildings) yet.

## Layout

```
crates/meshmap-core   pure RF/terrain math (geodesy, FSPL, Fresnel, curvature, link analysis, pair pruning)
crates/meshmap-itm    Longley-Rice / ITM point-to-point model (port of the NTIA reference)
tools/itm_reference   builds the NTIA C++ reference and regenerates the validation vectors
crates/meshmap-wasm   wasm-bindgen wrapper
crates/meshmap-coverage coverage heatmaps: radial Longley-Rice predictions rasterized for the web map
crates/meshmap-server accounts, passkeys, project storage (SQLite) and the static web app (Axum)
web/                  React + TypeScript + MapLibre app
scripts/build-wasm.sh builds the WASM module into web/src/wasm/pkg
```

## Run it

Prerequisites: Rust (stable) with `rustup target add wasm32-unknown-unknown`,
`cargo install wasm-bindgen-cli --version 0.2.100`, Node 20+.

```bash
cargo test --workspace            # math tests (including ITM vs the NTIA reference) and the server API tests
./scripts/build-wasm.sh           # WASM bindings (re-run after changing Rust)
cd web && npm install
npm test                          # terrain decoding/sampling tests
npm run build                     # the web app in web/dist

# run the server (serves web/dist and the API; data goes to ./data)
cd .. && MESHMAP_STATIC_DIR=web/dist cargo run -p meshmap-server     # http://localhost:8080
# or, for front-end work with hot reload, run the server as above and then:  cd web && npm run dev   (http://localhost:5173)
```
The first visit asks you to create the first (admin) account.

Needs internet access for map tiles (OpenStreetMap raster basemap and AWS Terrarium terrain tiles).
The OSM tile server is for light/dev use only; switch the basemap in `web/src/map/MapView.tsx` before public hosting.

## Accounts, sign-in and sharing

- **First run:** the first person to open the site creates the **admin** account (this is refused through Tailscale Funnel, so a
  stranger can't claim it). After that nobody can sign up on their own.
- **Adding people (admin):** *Admin → Add an account* creates the account and a **one-time invite link** (valid 7 days). Send it
  to them; they choose their own password, so you never see it. Admins can also change roles (admin / member), disable or
  re-enable an account, **reset sign-in** (forgets the password, passkeys and sessions and gives a new invite link; use it
  for a forgotten password) and delete an account (their projects move to you). The last active admin can't be removed.
- **Passkeys (Face ID, fingerprint, Windows Hello, a phone or a security key):** after the first password sign-in the app offers
  *Set up a passkey* (also under *Account*). Next time, type your username and choose **Sign in with a passkey**. Passwords keep
  working as a fallback. Passkeys need a secure web address with a name: your Tailscale `https://` address or
  `http://localhost`, **not** `http://<ip-address>:9091`. They are tied to that host name, so changing the address means adding
  them again.
- **Projects** are saved to your account a moment after each change ("Saved" at the top of the sidebar) and are there on every
  device. Projects that were saved in this browser before accounts existed are offered for import on first sign-in.
- **Sharing:** the owner can share a project with other accounts as **editor** (can change it) or **viewer** (read-only) from
  the *Share* button. Changes from other people appear within about 15 seconds; if two people save at the same time you
  are asked whether to load their version or keep yours. Only the owner can rename, share or delete a project.
- **Security notes:** passwords are stored as Argon2id hashes; sessions are random tokens in an HttpOnly cookie (30 days,
  sign-out ends them); five wrong passwords lock a username for 10 minutes; writes from other websites are refused.
  There is no email: lost access is fixed by an admin's *Reset sign-in*.
- **Backups:** everything (accounts, passkeys, projects) is in `data/meshmap.db`. Make a consistent copy while it runs with
  `docker compose exec meshmap /app/meshmap-server backup /app/data/backups/meshmap-$(date +%F).db`
  (lands in `./data/backups/`), and copy that file somewhere safe.

## Coverage heatmaps (background jobs)

- **Coverage heatmaps** panel: *Predict selected node* draws signal margin around one node; *Predict whole network* combines all
  nodes into the best margin per spot and a second view showing how many nodes reach each spot ("Nodes covering").
  Margin is the predicted signal at a client device minus the receiver sensitivity of the node's preset, so anything drawn
  is a place where a client of that height and gain should reach the node (nothing is drawn below 0 dB).
  The client's height is each node's *Client height* (MeshCore's antenna B height); client gain/cable loss, the radius
  (1-100 km) and the resolution (60-500 m) are in *Project settings*.
- Jobs run on the **server** in the background (one at a time; each uses all CPU cores, roughly 1 s for a 30 km node at 100 m).
  The panel shows progress ("downloading terrain 12/42 tiles", "Node 3/9: predicting coverage"), a **Cancel** button, and
  survives closing the tab: the job keeps running and the result is there when you come back.
- **Cached and incremental:** results are stored under a hash of everything that affects them. Asking again for the same inputs
  is instant (in any project, by anyone); a network prediction after moving one node recomputes only that node. A layer whose
  nodes or settings changed is marked *out of date* with a *Recompute* button. Layers are remembered per project and
  restored from the cache on return.
- The first prediction in an area downloads the public terrain tiles from the server (cached in `data/terrain/`), so the
  server needs outbound internet; set `MESHMAP_TERRAIN_URL=file:///.../{z}/{x}/{y}.png` to use your own tiles offline.
  Results live in `data/cache/` and are trimmed to `MESHMAP_CACHE_MB` (default 2000).
- The terrain is the same ~30 m bare-earth data as the links use, and the same Longley-Rice model, but a heatmap samples the
  ground every 100 m by default (a link profile every 40 m), so a cell can differ a little from the same spot analysed as a link.
  As everywhere: estimates, no trees or buildings yet.

## Terrain packs (trees and buildings)

By default the app uses public ~30 m bare-earth tiles. For better results build a **terrain pack** (3DEP elevation plus the
height of trees and buildings from lidar, or canopy-height and building-footprint data) with `tools/etl` and put it in
`data/packs/` (see [tools/etl/README.md](tools/etl/README.md); the server notices new packs without a restart):

```bash
docker compose --profile etl run --rm etl build --id nashville --bbox=-86.80,36.15,-86.765,36.185 --lidar TN_DavidsonCo_1_2022
```

Where a pack covers a path, a link's profile shows **bare earth and terrain + clutter side by side**, and *Project settings →
Terrain model* picks which one colors links and heatmaps. Heatmap cards say how much of the area had clutter data. Clutter is
treated as solid obstacles: there is no foliage loss, and both antennas stay on the ground (heights are above ground).

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
9. **Heatmaps**: open a project with a few nodes, *Predict whole network*, watch the progress, then switch between *Best signal margin* and
   *Nodes covering*; move a node and see the layer marked out of date; *Recompute* only redoes that node.
10. **Node management**: the Nodes panel lists every node (status dot, MeshCore letter, link count, best margin) with search and
   sorting; click a row to select and zoom to it, tick several for bulk edits (height, client height, TX power, gain,
   cable loss, preset, status; only filled-in fields change) or bulk delete, or add a node by typing coordinates.
   A selected node shows its connections (click one to open its terrain profile), plus Zoom to / Duplicate / Delete.
   The "Names" button toggles name labels on the map.
11. **Clutter** (needs a pack): open a link across wooded or built-up ground; the profile shows the tree/building layer and a table
   with bare earth vs terrain + clutter. Flip *Terrain model* in settings and watch link colors and heatmaps change.
12. **Sanity checks**: raise antenna heights on a long flat path and watch clearance and margin improve;
   raise k (e.g. 4/3 to 2) and watch clearance increase; use presets with different SF/BW and the link becomes "none".

## Docker

```bash
cp .env.example .env              # optional: change MESHMAP_PORT (default 9091)
docker compose up --build -d     # http://localhost:9091
# or
docker build -t meshmap:v0 . && docker run --rm -p 9091:8080 meshmap:v0
```

Multi-stage build: Rust tests + WASM build, then web tests + production build, then the server tests and release build, into
a small Debian image with a single process that serves the app and the API on port 8080 (`/healthz` for health checks) and
runs as an unprivileged user. Accounts and projects live in the `./data` folder next to `docker-compose.yml`, so keep that
folder (see Backups above). For passkeys you need an `https://` address; see the Tailscale sections below. For public hosting put
TLS in front (Caddy, Traefik, a cloud load balancer) and replace the OSM basemap first.

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
internet through Funnel as well (needs the `funnel` attribute above). Everyone has to sign in, but a public address is still more exposed: use strong passwords or passkeys.

If you used `tailscale serve` on the server before, turn it off there (`tailscale serve reset`): the address is now the new
machine's. To go back, comment out the two lines and `docker compose up -d`.
