/** A touch screen (no mouse to hover or click with): the wording says "tap" and leaves out mouse and keyboard tips. */
export const coarsePointer = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

/** "click" with a mouse, "tap" on a touch screen (`Click` / `Tap` with `capital`). */
export function clickWord(capital = false): string {
  const w = coarsePointer() ? "tap" : "click";
  return capital ? w[0].toUpperCase() + w.slice(1) : w;
}
