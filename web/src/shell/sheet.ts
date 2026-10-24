export type Snap = "peek" | "half" | "full";

export const PEEK_PX = 96;
/** the map strip left above a full-height sheet */
export const FULL_GAP_PX = 110;

/** Height of each snap point for a container of the given height. */
export function snapHeights(container: number): Record<Snap, number> {
  const full = Math.max(PEEK_PX + 40, container - FULL_GAP_PX);
  return { peek: PEEK_PX, half: Math.min(full, Math.round(container * 0.5)), full };
}

/** The snap point nearest to a height (while dragging), nudged by the direction of the last movement. */
export function nearestSnap(height: number, container: number, velocity = 0): Snap {
  const h = snapHeights(container);
  const target = height + velocity * 8; // a quick flick goes a step further
  return (Object.keys(h) as Snap[]).sort((a, b) => Math.abs(h[a] - target) - Math.abs(h[b] - target))[0];
}

export const nextSnap = (s: Snap): Snap => (s === "peek" ? "half" : s === "half" ? "full" : "peek");
