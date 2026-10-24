import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre 6 ships an ES-module worker; let Vite bundle it (with its shared chunk) and hand over the URL.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

maplibregl.setWorkerUrl(workerUrl);
import { TERRAIN_TILE_URL } from "../engine/terrain";
import { circleRing, type Area } from "../placement";
import { beamGeoJSON } from "./beams";
import { buildContours } from "./contours";
import { cursorCss } from "./cursors";
import { DEFAULT_LAYERS, ElevationReadout, LayersControl, loadLayers, MapContextMenu, RELIEF_STOPS, saveLayers, type MapLayers, type MenuState } from "./MapOverlays";
import { terrain, type SpotInfo } from "../engine/terrain";
import type { Link, MeshNode } from "../types";

export const LINK_COLORS = { clear: "#1a9850", marginal: "#e0a800", obstructed: "#d73027", none: "#8a8a8a" } as const;

interface Props {
  nodes: MeshNode[];
  links: Link[];
  /** Another project drawn faintly underneath for comparison. */
  ghostNodes: MeshNode[];
  ghostLinks: Link[];
  /** When this changes the view zooms to fit the nodes (open + comparison project). */
  fitKey: string;
  selectedNodeId: string | null;
  /** Nodes ticked in the Nodes list (bulk actions). */
  checkedIds: ReadonlySet<string>;
  showLabels: boolean;
  /** Coverage heatmap images drawn between the terrain and the links. */
  coverageImages: { id: string; url: string; bounds: { west: number; south: number; east: number; north: number }; opacity: number }[];
  /** Viewers can look but not move nodes. */
  readOnly: boolean;
  /** Ask the map to centre on a point; a new `key` triggers a move. */
  focus: { lat: number; lon: number; key: number } | null;
  selectedLinkKey: string | null;
  /** The area being planned for and the sites suggested for it. */
  placement: { area: Area | null; sites: { rank: number; lat: number; lon: number }[] };
  /** A spot on a link's profile (hovered or picked), shown on the map. */
  profilePoint?: { lat: number; lon: number } | null;
  /** Mesh health marks per node id (CSS classes such as `h-spof`). */
  health?: Record<string, string>;
  /** Field mode: where the phone is, and the readings taken so far. */
  field?: { me: { lat: number; lon: number; accuracyM: number } | null; readings: { id: string; lat: number; lon: number; color: string }[] };
  addMode: boolean;
  /** Next click chooses the planning area instead. */
  pickMode: boolean;
  terrain3d: boolean;
  onMapClick: (lat: number, lon: number) => void;
  onNodeSelect: (id: string | null) => void;
  /** Shift/Ctrl-click on a node: add it to or remove it from the ticked nodes. */
  onNodeToggle?: (id: string) => void;
  /** Shift-drag a box on the map: the nodes inside it (`additive` with Ctrl/Cmd). */
  onBoxSelect?: (ids: string[], additive: boolean) => void;
  onNodeMove: (id: string, lat: number, lon: number, dragging: boolean) => void;
  onLinkSelect: (key: string | null) => void;
  /** Right-click menu actions (omitted = not offered). */
  onAddNodeAt?: (lat: number, lon: number) => void;
  onPlanAround?: (lat: number, lon: number) => void;
}

const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
    dem: {
      type: "raster-dem",
      tiles: [TERRAIN_TILE_URL],
      encoding: "terrarium",
      tileSize: 256,
      maxzoom: 15,
      attribution: "Terrain: Mapzen / AWS Terrain Tiles (USGS 3DEP, SRTM and others)",
    },
  },
  layers: [
    { id: "osm", type: "raster", source: "osm", paint: { "raster-opacity": 0.8 } },
    {
      id: "relief",
      type: "color-relief",
      source: "dem",
      layout: { visibility: "none" },
      paint: { "color-relief-opacity": 0.5, "color-relief-color": ["interpolate", ["linear"], ["elevation"], ...RELIEF_STOPS.flat()] },
    },
    {
      id: "hillshade",
      type: "hillshade",
      source: "dem",
      paint: { "hillshade-exaggeration": 0.55, "hillshade-shadow-color": "#2b2b2b" },
    },
  ],
};

function linksGeoJSON(nodes: MeshNode[], links: Link[]): GeoJSON.FeatureCollection {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const features: GeoJSON.Feature[] = [];
  for (const l of links) {
    const a = byId.get(l.a);
    const b = byId.get(l.b);
    if (!a || !b) continue;
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
      properties: { key: l.key, class: l.class },
    });
  }
  return { type: "FeatureCollection", features };
}

function pointsGeoJSON(nodes: MeshNode[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: nodes.map((n) => ({ type: "Feature", geometry: { type: "Point", coordinates: [n.lon, n.lat] }, properties: { name: n.name } })),
  };
}

const CLASS_COLOR: maplibregl.ExpressionSpecification = ["match", ["get", "class"], "clear", LINK_COLORS.clear, "marginal", LINK_COLORS.marginal, "obstructed", LINK_COLORS.obstructed, LINK_COLORS.none];

const coarsePointer = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
const nodeLabel = (n: MeshNode) => `${n.letter ? n.letter + " · " : ""}${n.name.trim() || "node"}`;

/** The nodes as map features: what the circle and label layers read (status, ticked, health marks, label, drawing priority). */
function nodesGeoJSON(c: Pick<Props, "nodes" | "selectedNodeId" | "checkedIds" | "health">): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: c.nodes.map((n) => {
      const health = c.health?.[n.id] ?? "";
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [n.lon, n.lat] },
        properties: {
          id: n.id,
          name: n.name,
          label: nodeLabel(n),
          status: n.status,
          sel: c.selectedNodeId === n.id ? 1 : 0,
          chk: c.checkedIds.has(n.id) ? 1 : 0,
          gateway: n.gateway ? 1 : 0,
          health,
          // labels of weak and important nodes win when names collide
          priority: health.includes("h-spof") ? 1 : n.gateway ? 2 : c.checkedIds.has(n.id) ? 3 : 5,
        },
      };
    }),
  };
}

export function MapView(p: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loaded = useRef(false);
  const markers = useRef(new Map<string, maplibregl.Marker>());
  const siteMarkers = useRef<maplibregl.Marker[]>([]);
  const [layers, setLayers] = useState<MapLayers>(loadLayers);
  const layersRef = useRef<MapLayers>(DEFAULT_LAYERS);
  layersRef.current = layers;
  const [spot, setSpot] = useState<SpotInfo | null>(null);
  const [spotBusy, setSpotBusy] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const contourTimer = useRef<number | undefined>(undefined);
  const contourSeq = useRef(0);
  /** the cursor to show when the pointer is not over something clickable */
  const baseCursor = useRef("");
  const latest = useRef(p);
  latest.current = p;

  // map creation
  useEffect(() => {
    const map = new maplibregl.Map({
      container: container.current!,
      style: STYLE,
      center: [-105.5, 39.0],
      zoom: 6.5,
      maxPitch: 80,
      canvasContextAttributes: { antialias: true },
    });
    mapRef.current = map;
    // the map's box changes when the link drawer opens or the menu hides: follow it
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(container.current!);
    let probeTimer: number | undefined;
    let probeSeq = 0;
    map.on("mousemove", (e) => {
      window.clearTimeout(probeTimer);
      probeTimer = window.setTimeout(async () => {
        const mine = ++probeSeq;
        setSpotBusy(true);
        try {
          const s = await terrain.probe(e.lngLat.lat, e.lngLat.lng);
          if (mine === probeSeq) setSpot(s);
        } catch {
          /* terrain not available yet */
        } finally {
          if (mine === probeSeq) setSpotBusy(false);
        }
      }, 120);
    });
    map.on("contextmenu", (e) => {
      e.originalEvent.preventDefault();
      const { lat, lng: lon } = e.lngLat;
      setMenu({ x: e.point.x, y: e.point.y, lat, lon, info: null });
      terrain.probe(lat, lon).then((info) => setMenu((m) => (m && m.lat === lat && m.lon === lon ? { ...m, info } : m)), () => undefined);
    });
    map.on("movestart", () => setMenu(null));
    map.on("moveend", () => refreshContours());
    (window as unknown as { __meshmap?: maplibregl.Map }).__meshmap = map; // handy for debugging and browser tests
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

    map.on("load", () => {
      map.addSource("contours", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "contour-minor", type: "line", source: "contours", filter: ["!", ["get", "major"]], layout: { visibility: "none" }, paint: { "line-color": "#7c5a2a", "line-width": 0.6, "line-opacity": 0.55 } });
      map.addLayer({ id: "contour-major", type: "line", source: "contours", filter: ["get", "major"], layout: { visibility: "none" }, paint: { "line-color": "#6b4a1f", "line-width": 1.3, "line-opacity": 0.8 } });
      map.addLayer({
        id: "contour-labels",
        type: "symbol",
        source: "contours",
        filter: ["get", "major"],
        layout: { visibility: "none", "symbol-placement": "line", "text-field": ["to-string", ["get", "ele"]], "text-size": 11, "text-font": ["Noto Sans Regular"], "text-max-angle": 30 },
        paint: { "text-color": "#4a3412", "text-halo-color": "rgba(255,255,255,0.85)", "text-halo-width": 1.5 },
      });
      map.addSource("placement-area", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "placement-fill", type: "fill", source: "placement-area", paint: { "fill-color": "#7c3aed", "fill-opacity": 0.06 } });
      map.addLayer({ id: "placement-line", type: "line", source: "placement-area", paint: { "line-color": "#7c3aed", "line-width": 2, "line-dasharray": [3, 2] } });
      map.addSource("field-me-area", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("field-readings", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("field-me", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "field-me-area", type: "fill", source: "field-me-area", paint: { "fill-color": "#2563eb", "fill-opacity": 0.12 } });
      map.addLayer({ id: "field-readings", type: "circle", source: "field-readings", paint: { "circle-radius": 6, "circle-color": ["get", "color"], "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
      map.addLayer({ id: "field-me", type: "circle", source: "field-me", paint: { "circle-radius": 8, "circle-color": "#2563eb", "circle-stroke-color": "#fff", "circle-stroke-width": 3 } });
      map.addSource("profile-point", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "profile-point-ring", type: "circle", source: "profile-point", paint: { "circle-radius": 13, "circle-color": "#7c3aed", "circle-opacity": 0.18, "circle-stroke-color": "#7c3aed", "circle-stroke-width": 2 } });
      map.addLayer({ id: "profile-point-dot", type: "circle", source: "profile-point", paint: { "circle-radius": 4, "circle-color": "#7c3aed", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
      map.addSource("beams", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "beams-fill", type: "fill", source: "beams", paint: { "fill-color": "#2457d6", "fill-opacity": 0.14 } });
      map.addLayer({ id: "beams-line", type: "line", source: "beams", paint: { "line-color": "#2457d6", "line-width": 1.2, "line-opacity": 0.7 } });
      map.addSource("links", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("ghost-links", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("ghost-nodes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "ghost-links",
        type: "line",
        source: "ghost-links",
        paint: { "line-color": CLASS_COLOR, "line-width": 2, "line-opacity": 0.55, "line-dasharray": [1, 2] },
      });
      map.addLayer({
        id: "ghost-nodes",
        type: "circle",
        source: "ghost-nodes",
        paint: { "circle-radius": 6, "circle-color": "#6b7280", "circle-opacity": 0.55, "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
      });
      map.addLayer({
        id: "links-line",
        type: "line",
        source: "links",
        layout: { "line-cap": "round" },
        paint: {
          "line-color": CLASS_COLOR,
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1.5, 12, 4],
          "line-opacity": 0.9,
          "line-dasharray": ["case", ["==", ["get", "class"], "none"], ["literal", [2, 2]], ["literal", [1, 0]]],
        },
      });
      map.addLayer({
        id: "links-selected",
        type: "line",
        source: "links",
        filter: ["==", ["get", "key"], ""],
        paint: { "line-color": "#111", "line-width": 8, "line-opacity": 0.35, "line-blur": 1 },
      }, "links-line");
      map.addLayer({
        id: "links-hit",
        type: "line",
        source: "links",
        paint: { "line-color": "#000", "line-width": 14, "line-opacity": 0 },
      });
      // nodes: circles and labels on the map itself (cheap for hundreds of nodes), clustered when zoomed far out.
      // Only the selected node is a real, draggable marker (see syncNodes).
      map.addSource("nodes", { type: "geojson", data: { type: "FeatureCollection", features: [] }, cluster: true, clusterMaxZoom: 8, clusterRadius: 36 });
      map.addLayer({ id: "node-clusters", type: "circle", source: "nodes", filter: ["has", "point_count"], paint: { "circle-color": "#2457d6", "circle-opacity": 0.85, "circle-radius": ["step", ["get", "point_count"], 14, 10, 18, 50, 24], "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
      map.addLayer({ id: "node-cluster-count", type: "symbol", source: "nodes", filter: ["has", "point_count"], layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12, "text-font": ["Noto Sans Regular"], "text-allow-overlap": true }, paint: { "text-color": "#fff" } });
      const single: maplibregl.FilterSpecification = ["all", ["!", ["has", "point_count"]], ["!=", ["get", "sel"], 1]];
      map.addLayer({ id: "nodes-halo", type: "circle", source: "nodes", filter: ["all", single, ["any", ["==", ["get", "chk"], 1], ["in", "h-spof", ["get", "health"]]]], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 8, 12, 14], "circle-color": ["case", ["==", ["get", "chk"], 1], "#2457d6", "#d73027"], "circle-opacity": 0.35 } });
      map.addLayer({
        id: "nodes-circle",
        type: "circle",
        source: "nodes",
        filter: single,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 4, 12, 8],
          "circle-color": ["case", ["in", "h-cut", ["get", "health"]], "#fecaca", ["in", "h-isolated", ["get", "health"]], "#d1d5db", ["in", "h-failed", ["get", "health"]], "#111", ["==", ["get", "status"], "installed"], "#16a34a", "#ffffff"],
          "circle-stroke-color": ["case", ["in", "h-cut", ["get", "health"]], "#b91c1c", ["in", "h-isolated", ["get", "health"]], "#6b7280", ["in", "h-far", ["get", "health"]], "#7c3aed", ["in", "h-failed", ["get", "health"]], "#111", ["==", ["get", "status"], "installed"], "#065f46", "#d97706"],
          "circle-stroke-width": ["case", ["==", ["get", "gateway"], 1], 5, 3],
        },
      });
      map.addLayer({ id: "nodes-hit", type: "circle", source: "nodes", filter: single, paint: { "circle-radius": coarsePointer() ? 22 : 13, "circle-opacity": 0 } });
      map.addLayer({
        id: "nodes-label",
        type: "symbol",
        source: "nodes",
        filter: single,
        minzoom: 7,
        layout: {
          "text-field": ["get", "label"],
          "text-size": 11,
          "text-font": ["Noto Sans Regular"],
          "text-anchor": "left",
          "text-offset": [1.1, 0],
          "text-optional": true,
          "symbol-sort-key": ["get", "priority"],
          visibility: latest.current.showLabels ? "visible" : "none",
        },
        paint: { "text-color": "#111", "text-halo-color": "rgba(255,255,255,0.95)", "text-halo-width": 1.6 },
      });
      loaded.current = true;
      applyLayers();
      refreshContours();
      syncAll();
      syncPlacement();
      syncProfilePoint();
      syncField();
    });

    // Shift + drag draws a box and ticks the nodes inside it (Ctrl/Cmd adds to what is ticked)
    map.boxZoom.disable();
    let suppressClick = false;
    const cont = map.getCanvasContainer();
    cont.addEventListener("mousedown", (e: MouseEvent) => {
      if (!e.shiftKey || e.button !== 0 || !latest.current.onBoxSelect) return;
      const rect = cont.getBoundingClientRect();
      const x0 = e.clientX - rect.left;
      const y0 = e.clientY - rect.top;
      const box = document.createElement("div");
      box.className = "boxsel";
      cont.appendChild(box);
      map.dragPan.disable();
      const draw = (ev: MouseEvent) => {
        const x = ev.clientX - rect.left;
        const y = ev.clientY - rect.top;
        Object.assign(box.style, { left: `${Math.min(x, x0)}px`, top: `${Math.min(y, y0)}px`, width: `${Math.abs(x - x0)}px`, height: `${Math.abs(y - y0)}px` });
      };
      const done = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", draw);
        window.removeEventListener("mouseup", done);
        box.remove();
        map.dragPan.enable();
        const x1 = ev.clientX - rect.left;
        const y1 = ev.clientY - rect.top;
        if (Math.hypot(x1 - x0, y1 - y0) < 5) return;
        suppressClick = true;
        setTimeout(() => (suppressClick = false), 50);
        const [lo, hi] = [[Math.min(x0, x1), Math.min(y0, y1)], [Math.max(x0, x1), Math.max(y0, y1)]];
        const ids = latest.current.nodes.filter((n) => {
          const pt = map.project([n.lon, n.lat]);
          return pt.x >= lo[0] && pt.x <= hi[0] && pt.y >= lo[1] && pt.y <= hi[1];
        }).map((n) => n.id);
        latest.current.onBoxSelect?.(ids, ev.ctrlKey || ev.metaKey);
      };
      window.addEventListener("mousemove", draw);
      window.addEventListener("mouseup", done);
      e.preventDefault();
    });

    map.on("click", (e) => {
      if (suppressClick) return;
      setMenu(null);
      const c = latest.current;
      if (c.pickMode || (c.addMode && !c.readOnly)) {
        c.onMapClick(e.lngLat.lat, e.lngLat.lng);
        return;
      }
      const cluster = map.queryRenderedFeatures(e.point, { layers: ["node-clusters"] })[0];
      if (cluster) {
        const src = map.getSource("nodes") as maplibregl.GeoJSONSource;
        const center = (cluster.geometry as GeoJSON.Point).coordinates as [number, number];
        void src.getClusterExpansionZoom(cluster.properties.cluster_id as number).then((z) => map.easeTo({ center, zoom: z + 0.5 }));
        return;
      }
      const nodeHit = map.queryRenderedFeatures(e.point, { layers: ["nodes-hit"] })[0];
      if (nodeHit) {
        const id = nodeHit.properties.id as string;
        const oe = e.originalEvent as MouseEvent;
        if ((oe.shiftKey || oe.ctrlKey || oe.metaKey) && c.onNodeToggle) c.onNodeToggle(id);
        else c.onNodeSelect(id);
        return;
      }
      const hit = map.queryRenderedFeatures(e.point, { layers: ["links-hit"] })[0];
      if (hit) {
        c.onLinkSelect(hit.properties.key as string);
      } else {
        c.onNodeSelect(null);
        c.onLinkSelect(null);
      }
    });
    map.on("mousemove", (e) => {
      if (latest.current.addMode) return;
      const over = map.queryRenderedFeatures(e.point, { layers: ["nodes-hit", "node-clusters", "links-hit"] }).length > 0;
      map.getCanvas().style.cursor = over ? "pointer" : baseCursor.current;
    });

    return () => {
      ro.disconnect();
      markers.current.forEach((m) => m.remove());
      markers.current.clear();
      map.remove();
      mapRef.current = null;
      loaded.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function syncAll() {
    const map = mapRef.current;
    if (!map) return;
    const c = latest.current;
    syncNodes(map, c);
    if (loaded.current) {
      (map.getSource("links") as maplibregl.GeoJSONSource | undefined)?.setData(linksGeoJSON(c.nodes, c.links));
      (map.getSource("beams") as maplibregl.GeoJSONSource | undefined)?.setData(beamGeoJSON(c.nodes));
      (map.getSource("ghost-links") as maplibregl.GeoJSONSource | undefined)?.setData(linksGeoJSON(c.ghostNodes, c.ghostLinks));
      (map.getSource("ghost-nodes") as maplibregl.GeoJSONSource | undefined)?.setData(pointsGeoJSON(c.ghostNodes));
      map.setFilter("links-selected", ["==", ["get", "key"], c.selectedLinkKey ?? ""]);
    }
  }

  /** The nodes source (circles, labels, clusters) and the one real marker: the selected node, which can be dragged. */
  function syncNodes(map: maplibregl.Map, c: Props) {
    if (loaded.current) (map.getSource("nodes") as maplibregl.GeoJSONSource | undefined)?.setData(nodesGeoJSON(c));
    const sel = c.selectedNodeId ? c.nodes.find((n) => n.id === c.selectedNodeId) : undefined;
    for (const [id, m] of markers.current) {
      if (!sel || id !== sel.id) {
        m.remove();
        markers.current.delete(id);
      }
    }
    if (!sel) return;
    let m = markers.current.get(sel.id);
    if (!m) {
      const el = document.createElement("div");
      el.className = "node-marker";
      let moved = false;
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!moved) latest.current.onNodeSelect(sel.id);
        moved = false;
      });
      m = new maplibregl.Marker({ element: el, draggable: !c.readOnly }).setLngLat([sel.lon, sel.lat]).addTo(map);
      let raf = 0;
      const report = (dragging: boolean) => {
        const ll = m!.getLngLat();
        latest.current.onNodeMove(sel.id, ll.lat, ll.lng, dragging);
      };
      m.on("dragstart", () => (moved = true));
      m.on("drag", () => {
        if (!raf) {
          raf = requestAnimationFrame(() => {
            raf = 0;
            report(true);
          });
        }
      });
      m.on("dragend", () => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        report(false);
      });
      markers.current.set(sel.id, m);
    }
    m.setDraggable(!c.readOnly);
    const ll = m.getLngLat();
    if (Math.abs(ll.lat - sel.lat) > 1e-9 || Math.abs(ll.lng - sel.lon) > 1e-9) m.setLngLat([sel.lon, sel.lat]);
    const el = m.getElement();
    el.className = `maplibregl-marker node-marker ${sel.status} selected${c.checkedIds.has(sel.id) ? " checked" : ""}${c.health?.[sel.id] ? ` ${c.health[sel.id]}` : ""}`;
    el.title = `${sel.name} (${sel.status})`;
    let label = el.querySelector<HTMLSpanElement>(".node-label");
    if (!label) {
      label = document.createElement("span");
      label.className = "node-label";
      el.appendChild(label);
    }
    const text = nodeLabel(sel);
    if (label.textContent !== text) label.textContent = text;
  }

  useEffect(syncAll, [p.nodes, p.links, p.ghostNodes, p.ghostLinks, p.selectedNodeId, p.selectedLinkKey, p.checkedIds, p.readOnly, p.health]);

  function applyLayers() {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    const l = layersRef.current;
    const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    vis("hillshade", l.hillshade);
    vis("relief", l.relief);
    vis("contour-minor", l.contours);
    vis("contour-major", l.contours);
    vis("contour-labels", l.contours);
  }

  function refreshContours() {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    const l = layersRef.current;
    const set = (fc: GeoJSON.FeatureCollection) => (map.getSource("contours") as maplibregl.GeoJSONSource | undefined)?.setData(fc);
    window.clearTimeout(contourTimer.current);
    if (!l.contours) {
      contourSeq.current++;
      set({ type: "FeatureCollection", features: [] });
      return;
    }
    contourTimer.current = window.setTimeout(async () => {
      const mine = ++contourSeq.current;
      const b = map.getBounds();
      try {
        const fc = await buildContours({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }, map.getZoom(), l.units, async (la, lo) => (await terrain.profile(la, lo)).bare);
        if (mine === contourSeq.current) set(fc);
      } catch {
        /* terrain tiles not available: leave the old lines */
      }
    }, 250);
  }

  useEffect(() => {
    saveLayers(layers);
    applyLayers();
    refreshContours();
  }, [layers]); // eslint-disable-line react-hooks/exhaustive-deps

  // the planning area and suggested sites
  function syncPlacement() {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    const pl = latest.current.placement;
    const a = pl.area;
    (map.getSource("placement-area") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: a ? [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [circleRing(a.lat, a.lon, a.radiusKm)] } }] : [],
    });
    for (const m of siteMarkers.current) m.remove();
    siteMarkers.current = pl.sites.map((s) => {
      const el = document.createElement("div");
      el.className = "site-marker";
      el.textContent = String(s.rank);
      el.title = `Suggested site ${s.rank}`;
      return new maplibregl.Marker({ element: el }).setLngLat([s.lon, s.lat]).addTo(map);
    });
  }
  useEffect(syncPlacement, [p.placement]);

  function syncProfilePoint() {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    const pt = latest.current.profilePoint;
    (map.getSource("profile-point") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: pt ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [pt.lon, pt.lat] } }] : [],
    });
  }
  useEffect(syncProfilePoint, [p.profilePoint]);

  function syncField() {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    const f = latest.current.field;
    const set = (id: string, features: unknown[]) => (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features } as never);
    set("field-readings", (f?.readings ?? []).map((r) => ({ type: "Feature", properties: { color: r.color }, geometry: { type: "Point", coordinates: [r.lon, r.lat] } })));
    set("field-me", f?.me ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [f.me.lon, f.me.lat] } }] : []);
    set("field-me-area", f?.me && f.me.accuracyM > 0 ? [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [circleRing(f.me.lat, f.me.lon, Math.min(f.me.accuracyM, 2000) / 1000, 48)] } }] : []);
  }
  useEffect(syncField, [p.field]);

  // coverage heatmaps: one image source + raster layer each, kept in step with the list
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    const want = new Map(p.coverageImages.map((c) => [`cov-${c.id}`, c]));
    for (const l of map.getStyle().layers ?? []) {
      if (l.id.startsWith("cov-") && !want.has(l.id)) {
        map.removeLayer(l.id);
        if (map.getSource(l.id)) map.removeSource(l.id);
      }
    }
    for (const [id, c] of want) {
      const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
        [c.bounds.west, c.bounds.north],
        [c.bounds.east, c.bounds.north],
        [c.bounds.east, c.bounds.south],
        [c.bounds.west, c.bounds.south],
      ];
      const src = map.getSource(id) as maplibregl.ImageSource | undefined;
      if (!src) {
        map.addSource(id, { type: "image", url: c.url, coordinates });
        map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": c.opacity, "raster-fade-duration": 0, "raster-resampling": "linear" } }, "ghost-links");
      } else {
        src.updateImage({ url: c.url, coordinates });
        map.setPaintProperty(id, "raster-opacity", c.opacity);
      }
    }
  }, [p.coverageImages]);

  useEffect(() => {
    const m = mapRef.current;
    m?.getContainer().classList.toggle("show-labels", p.showLabels);
    if (m && loaded.current && m.getLayer("nodes-label")) m.setLayoutProperty("nodes-label", "visibility", p.showLabels ? "visible" : "none");
  }, [p.showLabels]);

  useEffect(() => {
    const map = mapRef.current;
    const f = latest.current.focus;
    if (map && f) map.easeTo({ center: [f.lon, f.lat], zoom: Math.max(map.getZoom(), 11), duration: 500 });
  }, [p.focus?.key]);

  // zoom to the nodes when the open project / comparison changes (and on first load)
  useEffect(() => {
    const map = mapRef.current;
    const c = latest.current;
    const pts = [...c.nodes, ...c.ghostNodes];
    if (!map || pts.length === 0) return;
    const b = new maplibregl.LngLatBounds([pts[0].lon, pts[0].lat], [pts[0].lon, pts[0].lat]);
    for (const n of pts) b.extend([n.lon, n.lat]);
    map.fitBounds(b, { padding: 90, maxZoom: 11, duration: 600, pitch: map.getPitch() });
  }, [p.fitKey]);

  useEffect(() => {
    const map = mapRef.current;
    baseCursor.current = cursorCss(layers.cursor, p.addMode || p.pickMode);
    if (map) map.getCanvas().style.cursor = baseCursor.current;
  }, [p.addMode, p.pickMode, layers.cursor]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      if (p.terrain3d) {
        map.setTerrain({ source: "dem", exaggeration: 1.4 });
        map.easeTo({ pitch: 60, duration: 600 });
      } else {
        map.setTerrain(null);
        map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
      }
    };
    // isStyleLoaded() is false while tiles are loading (after any pan), and "load" fires only once, so wait for the style itself
    if (map.getSource("dem")) apply();
    else map.once("load", apply);

    // Rotating and tilting only in 3D: two fingers on touch, middle-button drag with a mouse
    const canvas = map.getCanvas();
    if (p.terrain3d) {
      map.touchPitch.enable();
      map.touchZoomRotate.enableRotation();
    } else {
      map.touchPitch.disable();
      map.touchZoomRotate.disableRotation();
    }
    let last: { x: number; y: number } | null = null;
    const down = (e: MouseEvent) => {
      if (!p.terrain3d || e.button !== 1) return;
      e.preventDefault();
      last = { x: e.clientX, y: e.clientY };
    };
    const move = (e: MouseEvent) => {
      if (!last) return;
      map.jumpTo({
        bearing: map.getBearing() + (e.clientX - last.x) * 0.4,
        pitch: Math.max(0, Math.min(80, map.getPitch() - (e.clientY - last.y) * 0.3)),
      });
      last = { x: e.clientX, y: e.clientY };
    };
    const up = () => {
      last = null;
    };
    canvas.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      canvas.removeEventListener("mousedown", down);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [p.terrain3d]);

  const width = container.current?.clientWidth ?? 9999;
  return (
    <>
      <div ref={container} className="map" />
      <LayersControl value={layers} onChange={setLayers} />
      <ElevationReadout spot={spot} busy={spotBusy} />
      {menu ? (
        <MapContextMenu
          menu={{ ...menu, x: Math.max(4, Math.min(menu.x, width - 250)), y: menu.y }}
          nodes={p.nodes}
          readOnly={p.readOnly}
          onClose={() => setMenu(null)}
          onAddNode={p.onAddNodeAt}
          onPlanAround={p.onPlanAround}
        />
      ) : null}
    </>
  );
}
