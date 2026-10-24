/** Which rows of a long list to draw: the ones in view plus a few above and below. */
export function windowRange(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 6): { start: number; end: number } {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewport)) / rowHeight);
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan) };
}
