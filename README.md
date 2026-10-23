# meshmap

Planner for large LoRa mesh networks (MeshCore, Reticulum or Meshtastic) in the US 902-928 MHz band.
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full plan and the v0-v5 delivery ladder.

**Current release: v3** - accounts, shared projects, and **coverage heatmaps** computed on the server as background jobs. Estimates only: bare-earth terrain from
public ~30 m tiles and the Longley-Rice (ITM) propagation model (a Rust port validated against NTIA's reference code, see
[`docs/validation.md`](docs/validation.md)). No clutter (trees, buildings) yet.

The selected node's panel is always the first thing in the menu (the menu scrolls back to the top when you select a node), followed by Nodes, Links, Comments, Coverage heatmaps, Mesh health, Suggest new sites, Compare setups, Project settings and Import/export. The side panels (comments, mesh health, coverage, suggestions, settings, nodes, links, import/export) start **collapsed** to save scrolling: click a heading to open or close it, or use *Expand all* / *Collapse all* above them. Your choice is remembered, and selecting a node opens its panel. The whole menu can be hidden with **◀ Hide menu** (top left of the map, or press **M**) so the map fills the window; **☰ Menu** brings it back, and the choice is remembered. The map cursor is a thin **precision crosshair** by default (red while a click will place something); change it under *Layers* → *Cursor on the map* (precision crosshair, standard crosshair, or the hand).

Everything in this guide, the architecture and plan, the validation notes and the terrain-pack guide is also available inside the app under **Help** (top of the left panel).

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

## Which network (MeshCore, Reticulum, Meshtastic)

*Project settings → Network* says what you are planning for; new projects start as **MeshCore**. It sets the radio new nodes start with, the
frequency, and the hop count used by Mesh health. MeshCore starts at the US/Canada recommended setting (910.525 MHz, 62.5 kHz, SF7). Reticulum
(RNode) has no fixed standard, so it starts from a common example (125 kHz, SF8) and you choose your own; Meshtastic keeps its modem presets.
Each node's *Radio settings* list the presets of all three (the project's own first) and a **Custom LoRa** choice for any spreading factor
(SF5-SF12) and bandwidth. Only spreading factor and bandwidth change what a node can hear; coding rate and the exact frequency do not matter to
the link maths. Nodes on different spreading factor or bandwidth cannot hear each other (shown as no link). Projects saved before this keep the
network they were planned with (Meshtastic if their nodes use Meshtastic presets), and a banner offers to move nodes that do not fit the
project's network.

## Terrain packs (trees and buildings)

By default the app uses public ~30 m bare-earth tiles. For better results build a **terrain pack** (3DEP elevation plus the
height of trees and buildings from lidar, or canopy-height and building-footprint data) with `tools/etl` and put it in
`data/packs/` (see [tools/etl/README.md](tools/etl/README.md); the server notices new packs without a restart):

```bash
docker compose --profile etl run --rm etl build --id nashville --bbox=-86.80,36.15,-86.765,36.185 --lidar TN_DavidsonCo_1_2022
```

Packs can overlap: where a finer pack (a town at zoom 14) sits on a coarser regional one (zoom 13), the finest data wins. Where a pack covers a path, a link's profile shows **bare earth and terrain + clutter side by side**, and *Project settings →
Terrain model* picks which one colors links and heatmaps. Heatmap cards say how much of the area had clutter data. Clutter can be
treated as solid obstacles or as **foliage loss** (Weissberger, per metre of ray inside the canopy; with a *leaf on/off* switch and a *scale*
you calibrate). Both antennas stay on the ground (heights are above ground).

### Working without signal (installable app)
The app can be installed to the home screen (browser menu → *Install app* / *Add to Home screen*; needs HTTPS) and keeps itself, the project
you last opened and everything the map fetched on the phone. In Field mode, **Work offline** saves an area (around you, or all project
nodes) before you leave signal: terrain for predictions, trees and buildings, and a small set of map tiles (capped, because the
OpenStreetMap servers ask users not to bulk-download). Offline you can open the app, see the map and nodes, get predictions, and record
readings, which upload when you are back online. You cannot edit the project, sign in or run heatmap jobs offline. Signing out clears the
kept account data. The first load must be online, and iPhone browsers may discard stored data after a few weeks of not using the app.

### Calibrating foliage from field readings
Take readings (Field mode: tap a reading at your location with the node you can hear, or *Import CSV*: columns
`lat,lon,rssi[,snr,node,note,time,accuracy]`), some in the open near a node (these check antenna/power settings) and some through trees at
different depths and distances. Then open **Calibrate foliage** and *Use the best scale*. Readings can come from the app typed by hand, from a
radio's app (note RSSI/SNR with location), CSV, or **straight from a MeshCore radio** (below).

### Connecting a MeshCore radio (Field mode → Record)
*Connect with Bluetooth* or *Connect with USB* pairs a MeshCore **companion** radio with the page (Web Bluetooth: Chrome on Android or
desktop, not iPhone/Safari; Web Serial: Chrome/Edge on desktop). The radio reports the RSSI/SNR of every packet it hears; the page uses only
**adverts heard directly from a node (no repeater in between)**, because only those tell about one path. Put a project node's name on the
fixed radio (the page matches adverts to project nodes by name, or pick the node in the list), send an advert from it, and walk. *Use* fills the
form; *Save a reading automatically* records one per node every 10 s at your GPS position. Close the MeshCore phone app first: a radio talks
to one app at a time. This follows the official meshcore.js protocol and is tested with simulated packets, **not yet with real hardware**.

## Placement suggestions

*Suggest new sites* (left panel) answers "where should the next nodes go?". Pick an area (click the map, or "Around my nodes"),
choose how many sites, and optionally require each to link back to the network with a minimum margin (blocked paths do not count even if diffraction leaves some margin) and to link to the sites already chosen, so the new sites form one connected group. The server finds the
high points in the area, predicts coverage from each, and picks sites one at a time, each the one that newly covers the most
of the area, counting what your nodes and the earlier picks already cover. Each result lists the new area covered, the running
total, elevation and relief, and the links back to your network; "Add as node" turns a site into a node. Results are cached
like heatmaps.

**Goal: strengthen the network.** Switch *Goal* to *Strengthen the network* to place sites for sturdiness instead of area. The server
builds the graph of your nodes (a link counts when it meets the link rules), finds its single points of failure and bridges the same way
the Mesh health card does, and picks the site whose links to two or more existing nodes lowers a *weakness score* the most: the number of
nodes cut off by each single node or link failure, plus five for each node not connected to the main group. A stray node joined by a chain
counts as progress; the next pick can close the ring. It needs at least two nodes and skips the heatmaps, so it runs faster. It stops when
nothing is weak any more ("Nothing to fix") or no site in the area helps.

**Gateways and hops.** If you have marked nodes as gateways (Mesh health card), the network becomes *what can reach a gateway*: a node
that cannot is stranded, losing a lone gateway counts as a weak spot (a second gateway, or a site that reaches one, fixes it), and every
node more than the **hop limit** from all gateways adds two points. The hop limit defaults to the network's planning figure (MeshCore and
Reticulum 8, Meshtastic 3) and can be changed in the card. The new sites themselves are relays, not gateways. Traffic is not part of the
score.

## History

The **History** card keeps earlier states of a project. The app saves the state *before* your edits automatically (at most once every
10 minutes, the last 40 are kept), and **Save version** keeps a named one (up to 100) such as "Before moving Hinch". **Restore** lists what
would change (nodes coming back or disappearing, moves, settings) and asks first; what you have now is kept as a new version, so a restore
can itself be undone. Viewers can see the list; editors and the owner can save, restore and delete named versions. Heatmaps, readings and
comments are not part of a version, only the nodes, settings and overlays.

## Publishing, comments, antenna patterns, field mode, site reports

- **Publish** (project switcher): puts a frozen, read-only copy in the **Published** section, which every signed-in user can browse, open, comment on and *Copy to my projects*. Node notes stay private unless you tick the box. Your own project stays private and editable; use *Update published copy* to share newer changes, or *Unpublish*. An administrator can remove any publication. Heatmaps and suggestions are not shared (they run on your own project).
- **Comments**: on a project (everyone it is shared with, viewers included) or on a published copy (everyone). Comment on the project, a selected node or a selected link; the owner (or the author) can resolve or delete.
- **Antenna patterns** (node panel): omnidirectional, directional (beamwidth, front-to-back, pointing direction, "aim at node") or an imported MSI Planet / CSV pattern file. Links and heatmaps use the gain in the direction of each link. Horizontal plane only.
- **Field mode** (the *Field* button in the toolbar; made for a phone): GPS position, nearest nodes with distance and bearing, the predicted signal where you stand, recording RSSI/SNR readings (kept on the phone until uploaded, so a reading without signal is not lost), moving a node to your position, marking it installed, and a comparison of measured against predicted signal, with CSV export. The app must be loaded already; map tiles are not cached for offline use.
- **Elevation on the map**: the **Layers** button (top left of the map) switches shaded relief, **elevation colours** and **contour lines** (metres or feet; spacing follows the zoom, zoom in past about level 10 to see them). A readout at the bottom left shows the ground elevation under the pointer (and, where a terrain pack has clutter data, the height of trees/buildings and the surface height). **Right-click** anywhere for the same numbers, the data source, the nearest node with distance and direction, copy coordinates, add a node there, or start a site search around it. Elevations come from the same terrain data as the predictions (a pack where you have one, otherwise public ~30 m tiles), so they match the profiles; they are not survey-grade.
- **Mesh health** (left panel): from the usable links (margin at or above a threshold in both directions) it shows how many nodes are connected, the separate groups, **single points of failure** (nodes whose loss cuts others off), **links that are the only way**, hop counts from your **gateways** (mark a node as Gateway in its panel; hop limit defaults to Meshtastic's 3), nodes that cannot reach a gateway, and a **what-if** that removes any node and shows who loses contact. Problems are marked on the map. Without a gateway, "connected" means part of the largest group; a lone gateway counts as a single point of failure.
- **Site report** (node panel): a printable page with the location, a map picture, equipment, antenna pattern, expected links with terrain profiles, coverage numbers if computed, field readings, comments and the assumptions. Use *Print or save as PDF*.

## What to verify

1. **Add nodes**: "+ Node", click the map (or right-click the map and choose "Add a node here"); edit height, TX power, gain, cable loss, preset, status, notes.
2. **Links**: nodes within *max range* (default 50 km) get colored links: green clear, yellow marginal, red obstructed.
   Out-of-range ("none") links are hidden unless enabled in settings.
3. **Drag a node**: links update live (coarser terrain sampling while dragging, full resolution on release).
4. **Click a link** (map or list): terrain profile with earth curvature (k-factor), direct ray, first Fresnel zone
   (inner band = 60 %), loss/margin numbers in both directions.
4b. **Pick a spot on the profile**: in a link's profile click anywhere (or use *Highest ridge between* / *Worst obstruction*) to mark it; it shows on the map, with its distance, ground height and how far it is above or below the line of sight. *Place a node here* adds a node at exactly that spot, and its links appear straight away. The highest ridge skips the first and last 5 % of the path, because a node usually already sits on a summit.
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
12. **Placement**: in *Suggest new sites* click "Around my nodes" (or pick an area on the map), set 2 sites and click
    *Suggest sites*; numbered markers appear with the km² each adds and its links; "Add as node" adds one. Turning the backhaul
    requirement off, or raising its margin, changes the result.
13. **v6 features**: select a node and set a directional antenna aimed away from a neighbour (its margin drops); post a comment; click *Site report*; click *Publish*, then sign in as another user and open *Published*; in *Field mode* (allow location) record a reading and see it listed with the prediction.
14. **Mesh health**: in *Mesh health* mark a node as gateway, read the tiles and lists, then pick a node under *What if a node fails?*; its links vanish from the map and the nodes that lose contact turn pink.
15. **Elevation**: open *Layers*, tick elevation colours and contour lines and zoom in; move the pointer for the readout; right-click for the menu.
16. **Sanity checks**: raise antenna heights on a long flat path and watch clearance and margin improve;
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
