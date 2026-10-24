# UI redesign: plan, decisions and progress

Source: the UI/UX redesign report (map-first workspace). Built in phases; each phase ships on its own and is reviewed before the next starts.

## Decisions (from the project owner)

- Scope: the full redesign, one phase at a time, with a review after each.
- Colours: keep red / amber / green as the default; the colour-blind-safe set (blue / amber / red with line styles and glyphs) is an **option**.
- Offline editing: wanted (Phase 5 builds the local-first edit queue, not only read-only offline).
- iOS Safari: not a priority (nothing is built for it at the expense of other browsers).
- Units: a **per-user** metric / imperial choice (Phase 6).
- Rollout: the new layout was first behind a switch; **it is now the only layout** (the switch and the classic layout are removed).

## Phases

| Phase | Content | State |
|---|---|---|
| 0 | Quick wins and bug fixes | done, awaiting review |
| 1 | Independent node / link selection, docked link drawer with live height controls, inspect any pair | done, awaiting review |
| 2 | App shell: top bar, tool rail, Browser, Inspector; project menu, command palette; settings dialog; unified link-quality thresholds | done, awaiting review |
| 3 | 100+ nodes: map layers instead of DOM markers, clustering, worker-based link analysis, virtualised lists, tags, bulk-edit tray, node CSV import | done, awaiting review |
| 4 | Phone shell: bottom sheet, reticle placement, long-press menu, Field mode inside the shell | done, awaiting review |
| 5 | Offline areas manager, connectivity probe, offline editing with sync, node-level merge | |
| 6 | Themes, accessible colour option, per-user units, reports, onboarding, comment badges, wording pass | |

## Phase 0 (done)

- Toasts replace every `alert()`; in-app dialogs (`ui/confirm.tsx`) replace every `confirm()`; all dialogs share `ui/Modal.tsx` (Esc closes, Tab stays inside, focus returns, `aria-modal`).
- Deleting nodes no longer asks first: it is undone from a toast. (Deleting a project, resetting or deleting a user, removing a passkey and leaving a project still ask.)
- Status chip on the map (saved / saving / offline / analysing links / heatmap jobs / edit conflict), visible even with the menu hidden. The link legend moved onto the map.
- Add-node mode is sticky: press `N` or *+ Node* once, click the map for each node, `Esc` or *Done* ends it.
- Project defaults for new nodes (Settings), used when placing nodes on the map.
- `NumberField`: clear and retype a value; it is applied on Enter or leaving the field, with a message if it is out of range. Used in node and settings panels.
- Link profile keeps showing while a changed node is re-analysed.
- Touch and contrast: 16 px inputs and 44 px targets on touch screens, `100dvh`, safe-area padding, readable text on the amber chips, undo-toast colours fixed, reduced-motion respected.
- Field mode RSSI: type `104` for -104.
- Offline: the app asks the browser to keep saved areas (`navigator.storage.persist()`) and shows how much is stored; a new app version now shows "A new version is ready" with an *Update now* button instead of switching silently.

## Phase 1 (done)

- A node and a link can be selected at the same time: opening a link (from the map, the link list, a node's connections or the health card) no longer closes the node panel, and selecting a node no longer closes the link.
- The link profile is a **docked drawer** under the map (not an overlay), so the map keeps its size; the map follows the change of size (`ResizeObserver`).
- Drawer: one-sentence verdict, four key numbers, the profile, live height sliders and number fields for both ends, a "raise A by N m" suggestion with Apply (worked out on the loaded profile, no new download), and the budget / terrain comparison / assumptions folded under one heading.
- *Inspect the path to any node* in the node panel: works for pairs that have no drawn link; says why (beyond the search range, different radio settings, out of range even in free space) and offers a fix (*Look this far*, *Give B A's radio settings*).
- `Esc` closes the drawer. Heights typed in the drawer and the node panel go through the same editing path (and are saved and recomputed like any other edit).
- Tests: `engine/pairInfo.test.ts` (reasons and the suggestion, using the real WASM) and a browser run of the whole loop.

## Phase 2 (done)

This layout was first behind a switch (`?ui=v2`); the switch and the classic layout have since been removed, and this is the app.

- **Top bar**: project menu (switch, rename, new, duplicate, settings, history, compare, import / export, share, publish, delete), search / command palette, status chip (saved, offline, analysing, jobs, conflict), Plan | Field switch, account menu, buttons to show or hide the lists and the details panel.
- **Tool rail** (left of the map): Select `V`, Add nodes `N` (stays on), Inspect a link between two nodes `L` (click two nodes), Suggest sites `P`, 3D, node names.
- **Lists** (left, `B`): Nodes, Links, Issues (mesh health), Published. Full height, no collapsing.
- **Details** (right, `I`): *Selection* (the node's panel and comments; opens by itself when a node is picked), *Plan* (heatmaps and suggested sites), *Project* (counts, settings / history / export shortcuts, banners, foliage calibration, comments).
- **Command palette** (`Ctrl/Cmd+K` or `/`, in both layouts): jump to a node, switch project, run an action, export, or type a position (`36.15, -85.43`) to go there or add a node there. Works offline.
- **Settings dialog** with sections (Network & radio, Link quality, Terrain & trees, Propagation, Coverage heatmaps) and one-click *Quick estimate (50 / 50)* and *Design margin (90 / 90)*. The classic sidebar shows the same sections in its card.
- **One "usable link" threshold**: new project setting `usableMarginDb` (default 6 dB, the old default of both) is used by mesh health and by suggested sites; the "good" threshold (`marginalMarginDb`, default 10 dB) keeps its job for link colours. Mesh health and the suggestion panel edit the same figure.
- On narrow screens the lists and details become overlays over the map (the phone layout proper is Phase 4).
- `App.tsx` now names the sidebar sections and the map as elements (`nodeListEl`, `healthEl`, `mapEl`...), so both layouts use the same pieces; both layouts were checked with browser tests.

Not in this phase (still to do): a global undo / redo, the Layers panel moved off the map, per-project tags, and the full set of Browser filters (Phase 3), and the issues list as an actionable list rather than the health card (Phase 3 / 6).

## Phase 3 (done)

Tried with generated networks (developer commands `?dev=1`, then the palette: 100 / 300 / 600 test nodes) and with a 300-node, 4,761-link project in a browser test.

- **Map**: nodes are map layers (circle, ring for ticked and weak nodes, label), clustered when zoomed out (cluster click zooms in). Only the selected node is a real marker, and the only draggable one. Shift/Ctrl-click ticks a node; Shift-drag draws a box and ticks the nodes inside it (Ctrl/Cmd adds). Gateways have a thicker ring (map layers cannot draw squares without extra sprites).
- **Link analysis in a worker** (`engine/linkWorker.ts`): the map and lists stay responsive; a newer request replaces an older one; if workers are unavailable it runs on the main thread. The pair cache no longer depends on the profile spacing, so dragging a node reuses every unchanged pair (before, the switch to coarse spacing missed the cache for all of them).
- **Mesh health** no longer tests every link by removing it: articulation points and bridges come from one depth-first pass, and only those (and gateways) are checked exactly. A randomised test compares it with the exact method on 400 graphs (with and without gateways, with ties); at 300 nodes / 4,761 links it went from a 1.8 s pause to under 0.3 s.
- **Lists**: Nodes and Links draw only the rows in view (26 of 300 rows in the test). Nodes: search (name, notes, tags), chips for planned / installed / problems (no link, or best link below the "good link" figure), tag filter, sort including *weakest first*. Links: search by node name, class chips, sort (weakest / longest / name), and a hint on links whose two directions differ by more than 6 dB.
- **Tags** on nodes (node panel, selection tray, export to CSV and GeoJSON, import from CSV).
- **Selection tray**: ticked nodes are edited together in one place (the details panel in the new layout, under the list in the classic one): only filled fields change, a line says what will happen before *Apply*, add or remove a tag on all of them, delete.
- **Nodes CSV import** (`Import nodes (CSV)…` in the import / export card and the palette): preview of what the file holds and what was skipped, then *add all as new nodes* or *update nodes with the same name and add the rest*; the toast offers Undo. The "Nodes CSV" export is a valid file to import.

Measured in the browser test (headless, software rendering): 300 nodes and 4,761 links analysed and shown in about 4.6 s from page load; during that time the page's longest blocked stretch was 0.2 s.

Not done: pausing or prioritising the link analysis by what is on screen; clustering with a worst-link ring; the Issues tab as an actionable list; per-project label priority settings; map text for node names needs a font from a public server (self-hosted fonts come with Phase 5).

## The switch is gone

The new layout is the main app: `?ui=v1` / `?ui=v2`, *Try the new layout* / *Use the classic layout*, the classic sidebar (user bar, toolbar, project switcher, collapsible cards, Expand all / Collapse all, hide-menu button and `M` key) and the card-style Settings panel are removed. The radio-mismatch banner now sits in the Project tab with the other banners. `?dev=1` (developer commands for generating test networks) is kept.

## Phase 4 (done)

On a screen up to 700 px wide (`usePhone`) the layout changes; wider screens are unchanged.

- **Bottom bar** with five places: Map, Lists, Add, Details, Field.
- **Bottom sheet** for the lists and the details panel, with three heights: peek (96 px), half and full. Drag the handle (a quick flick goes a step further), or tap it to cycle. The map sits above the sheet and shrinks with it, so it never hides behind it and the map controls stay in reach. Tapping a node on the map raises a peek with a one-line summary (name, status, number of links) and an *Edit* button. The sheet steps aside while a link's profile is open.
- **Placing nodes with a cross**: *Add* shows a cross in the middle of the map and a strip with the position, the ground height and *Place here* / *Done*. Tapping the map only moves it, so a fingertip never covers the spot; the tool stays on for the next node.
- **Long press** (about half a second) on the map opens the same menu as a right-click (position, ground height, add a node here, suggest sites here). The elevation readout (hover only) is hidden on touch screens.
- **Profile**: a finger drags along the terrain profile and the readout follows it; a tap still picks a spot. The profile has keyboard control (arrow keys move along it, Enter picks) and a text description for screen readers.
- **Field mode** is now a mode of the same screen: the top bar and the bottom bar stay, and Map in the bottom bar goes back to planning (on desktop, the Plan | Field switch does). Its map, readings queue and offline behaviour are unchanged.
- The tool rail floats over the map on a phone; the legend starts folded.

Not done: the map keeps its own selected / placed state while Field mode is open only because the two maps are separate (a node picked in Field mode is not selected when you return); the full map overlay sheet with map padding; haptics other than the long-press buzz.
