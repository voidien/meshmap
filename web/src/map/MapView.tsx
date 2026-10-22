import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre 6 ships an ES-module worker; let Vite bundle it (with its shared chunk) and hand over the URL.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

maplibregl.setWorkerUrl(workerUrl);
import { TERRAIN_TILE_URL } from "../engine/terrain";
import type { Link, MeshNode } from "../types";

export const LINK_COLORS = { clear: "#1a9850", marginal: "#e0a800", obstructed: "#d73027", none: "#8a8a8a" } as const;

interface Props {
  nodes: MeshNode[];
  links: Link[];
  selectedNodeId: string | null;
  selectedLinkKey: string | null;
  addMode: boolean;
  terrain3d: boolean;
  onMapClick: (lat: number, lon: number) => void;
  onNodeSelect: (id: string | null) => void;
  onNodeMove: (id: string, lat: number, lon: number, dragging: boolean) => void;
  onLinkSelect: (key: string | null) => void;
}

const STYLE: maplibregl.StyleSpecification = {
  version: 8,
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

export function MapView(p: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loaded = useRef(false);
  const markers = useRef(new Map<string, maplibregl.Marker>());
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
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

    map.on("load", () => {
      map.addSource("links", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "links-line",
        type: "line",
        source: "links",
        layout: { "line-cap": "round" },
        paint: {
          "line-color": ["match", ["get", "class"], "clear", LINK_COLORS.clear, "marginal", LINK_COLORS.marginal, "obstructed", LINK_COLORS.obstructed, LINK_COLORS.none],
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
      syncAll();
    });

    map.on("click", (e) => {
      const c = latest.current;
      if (c.addMode) {
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
      if (!m) {
        const el = document.createElement("div");
        el.className = "node-marker";
        let moved = false;
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (!moved) latest.current.onNodeSelect(n.id);
          moved = false;
        });
        m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([n.lon, n.lat]).addTo(map);
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
      el.className = `maplibregl-marker node-marker ${n.status}${c.selectedNodeId === n.id ? " selected" : ""}`;
      el.title = `${n.name} (${n.status})`;
    }
  }

  useEffect(syncAll, [p.nodes, p.links, p.selectedNodeId, p.selectedLinkKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = p.addMode ? "crosshair" : "";
  }, [p.addMode]);

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

  return <div ref={container} className="map" />;
}
