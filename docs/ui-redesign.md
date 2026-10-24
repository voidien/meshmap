# UI redesign: plan, decisions and progress

Source: the UI/UX redesign report (map-first workspace). Built in phases; each phase ships on its own and is reviewed before the next starts.

## Decisions (from the project owner)

- Scope: the full redesign, one phase at a time, with a review after each.
- Colours: keep red / amber / green as the default; the colour-blind-safe set (blue / amber / red with line styles and glyphs) is an **option**.
- Offline editing: wanted (Phase 5 builds the local-first edit queue, not only read-only offline).
- iOS Safari: not a priority (nothing is built for it at the expense of other browsers).
- Units: a **per-user** metric / imperial choice (Phase 6).
- Rollout: the new layout (Phases 2-4) ships behind a flag (`localStorage meshmap.ui = v2`) next to the old one.

## Phases

| Phase | Content | State |
|---|---|---|
| 0 | Quick wins and bug fixes | done, awaiting review |
| 1 | Independent node / link selection, docked link drawer with live height controls, inspect any pair | |
| 2 | App shell: top bar, tool rail, Browser, Inspector; project menu, command palette; settings dialog; unified link-quality thresholds | |
| 3 | 100+ nodes: map layers instead of DOM markers, clustering, worker-based link analysis, virtualised lists, tags, bulk-edit tray, node CSV import | |
| 4 | Phone shell: bottom sheet, reticle placement, long-press menu, Field mode inside the shell | |
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
