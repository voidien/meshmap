import { isOmni, relGainDb } from "../antenna";
import type { MeshNode } from "../types";

const BEAM_KM = 3;

/** For each node with a directional antenna, its pattern drawn on the ground (radius follows the field strength, 3 km at the peak). */
export function beamGeoJSON(nodes: MeshNode[]) {
  const features = nodes
    .filter((n) => !isOmni(n.antenna))
    .map((n) => {
      const dLat = BEAM_KM / 111.32;
      const dLon = BEAM_KM / (111.32 * Math.cos((n.lat * Math.PI) / 180));
      const ring: [number, number][] = [];
      for (let b = 0; b <= 360; b += 4) {
        const r = 10 ** (relGainDb(n.antenna, b) / 20);
        const t = (b * Math.PI) / 180;
        ring.push([n.lon + dLon * r * Math.sin(t), n.lat + dLat * r * Math.cos(t)]);
      }
      return { type: "Feature" as const, properties: { id: n.id }, geometry: { type: "Polygon" as const, coordinates: [ring] } };
    });
  return { type: "FeatureCollection" as const, features };
}
