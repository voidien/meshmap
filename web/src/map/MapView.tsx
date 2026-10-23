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
      loaded.current = true;
      applyLayers();
      refreshContours();
      syncAll();
      syncPlacement();
      syncField();
    });

    map.on("click", (e) => {
      setMenu(null);
      const c = latest.current;
      if (c.pickMode || (c.addMode && !c.readOnly)) {
        c.onMapClick(e.lngLat.lat, e.lngLat.lng);
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
      const over = map.queryRenderedFeatures(e.point, { layers: ["links-hit"] }).length > 0;
      map.getCanvas().style.cursor = over ? "pointer" : "";
    });

    return () => {
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
    syncMarkers(map, c);
    if (loaded.current) {
      (map.getSource("links") as maplibregl.GeoJSONSource | undefined)?.setData(linksGeoJSON(c.nodes, c.links));
      (map.getSource("beams") as maplibregl.GeoJSONSource | undefined)?.setData(beamGeoJSON(c.nodes));
      (map.getSource("ghost-links") as maplibregl.GeoJSONSource | undefined)?.setData(linksGeoJSON(c.ghostNodes, c.ghostLinks));
      (map.getSource("ghost-nodes") as maplibregl.GeoJSONSource | undefined)?.setData(pointsGeoJSON(c.ghostNodes));
      map.setFilter("links-selected", ["==", ["get", "key"], c.selectedLinkKey ?? ""]);
    }
  }

  function syncMarkers(map: maplibregl.Map, c: Props) {
    const live = new Set(c.nodes.map((n) => n.id));
    for (const [id, m] of markers.current) {
      if (!live.has(id)) {
        m.remove();
        markers.current.delete(id);
      }
    }
    for (const n of c.nodes) {
      let m = markers.current.get(n.id);
      if (m) m.setDraggable(!c.readOnly);
      if (!m) {
        const el = document.createElement("div");
        el.className = "node-marker";
        let moved = false;
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (!moved) latest.current.onNodeSelect(n.id);
          moved = false;
        });
        m = new maplibregl.Marker({ element: el, draggable: !c.readOnly }).setLngLat([n.lon, n.lat]).addTo(map);
        let raf = 0;
        const report = (dragging: boolean) => {
          const ll = m!.getLngLat();
          latest.current.onNodeMove(n.id, ll.lat, ll.lng, dragging);
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
        markers.current.set(n.id, m);
      }
      const ll = m.getLngLat();
      if (Math.abs(ll.lat - n.lat) > 1e-9 || Math.abs(ll.lng - n.lon) > 1e-9) m.setLngLat([n.lon, n.lat]);
      const el = m.getElement();
      el.className = `maplibregl-marker node-marker ${n.status}${c.selectedNodeId === n.id ? " selected" : ""}${c.checkedIds.has(n.id) ? " checked" : ""}${c.health?.[n.id] ? ` ${c.health[n.id]}` : ""}`;
      el.title = `${n.name} (${n.status})`;
      let label = el.querySelector<HTMLSpanElement>(".node-label");
      if (!label) {
        label = document.createElement("span");
        label.className = "node-label";
        el.appendChild(label);
      }
      const text = `${n.letter ? n.letter + " · " : ""}${n.name.trim() || "node"}`;
      if (label.textContent !== text) label.textContent = text;
    }
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
    mapRef.current?.getContainer().classList.toggle("show-labels", p.showLabels);
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
    if (map) map.getCanvas().style.cursor = p.addMode || p.pickMode ? "crosshair" : "";
  }, [p.addMode, p.pickMode]);

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
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
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
