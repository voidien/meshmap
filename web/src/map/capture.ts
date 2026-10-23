/** A picture of the map centred on a point, for printed reports. Returns null if the map cannot be read (cross-origin tiles, no WebGL...). */
export async function captureMap(lat: number, lon: number, zoom = 14): Promise<string | null> {
  const map = (window as unknown as { __meshmap?: import("maplibre-gl").Map }).__meshmap;
  if (!map) return null;
  const prev = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
  try {
    map.jumpTo({ center: [lon, lat], zoom, pitch: 0, bearing: 0 });
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 8000);
      map.once("idle", () => {
        clearTimeout(t);
        resolve();
      });
    });
    return await new Promise<string | null>((resolve) => {
      const t = setTimeout(() => resolve(null), 3000);
      map.once("render", () => {
        clearTimeout(t);
        try {
          resolve(map.getCanvas().toDataURL("image/jpeg", 0.85));
        } catch {
          resolve(null);
        }
      });
      map.triggerRepaint();
    });
  } catch {
    return null;
  } finally {
    map.jumpTo(prev);
  }
}
