/** Map cursors: the usual hand, the browser's crosshair, or a thin precision crosshair drawn for clicking on exact spots. */
export type CursorKind = "default" | "crosshair" | "precise";

const SIZE = 33; // odd, so the hotspot is one exact pixel
const MID = (SIZE - 1) / 2;

function crosshairSvg(color: string): string {
  const arms = `M0 ${MID + 0.5}H${MID - 3}M${MID + 4}  ${MID + 0.5}H${SIZE}M${MID + 0.5} 0V${MID - 3}M${MID + 0.5} ${MID + 4}V${SIZE}`.replace(/\s+/g, " ");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    // a white halo under the dark line keeps it visible on dark and light maps
    `<path d="${arms}" stroke="white" stroke-width="3" fill="none"/>` +
    `<path d="${arms}" stroke="${color}" stroke-width="1" fill="none"/>` +
    `<circle cx="${MID + 0.5}" cy="${MID + 0.5}" r="2" fill="white"/><circle cx="${MID + 0.5}" cy="${MID + 0.5}" r="1" fill="#d92d20"/>` +
    `</svg>`
  );
}

/**
 * CSS `cursor` value. `placing` is true while a click will do something (add a node, choose an area): the precision
 * crosshair turns red then, and the "hand" setting becomes the browser crosshair so there is always a visible cue.
 */
export function cursorCss(kind: CursorKind, placing: boolean): string {
  if (kind === "default") return placing ? "crosshair" : "";
  if (kind === "crosshair") return "crosshair";
  const svg = crosshairSvg(placing ? "#d92d20" : "#111827");
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${MID} ${MID}, crosshair`;
}
