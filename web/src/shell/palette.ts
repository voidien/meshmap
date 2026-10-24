/** The command palette: what can be typed, how it is matched, and how a coordinate is recognised. */

export interface Command {
  id: string;
  label: string;
  /** a second line: what it does, or where it is */
  hint?: string;
  /** shown as a section label and used to order results */
  group: "Go to" | "Actions" | "Projects" | "Settings";
  /** extra words that should find it */
  keywords?: string;
  /** shortcut shown on the right */
  shortcut?: string;
  run: () => void;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** How well a query fits a command (higher is better); -1 when any word of the query is missing. */
export function score(query: string, c: Pick<Command, "label" | "keywords" | "hint">): number {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const label = norm(c.label);
  const rest = norm(`${c.keywords ?? ""} ${c.hint ?? ""}`);
  let total = 0;
  for (const w of words) {
    if (label.startsWith(w)) total += 100;
    else if (label.includes(` ${w}`)) total += 70;
    else if (label.includes(w)) total += 40;
    else if (rest.includes(w)) total += 10;
    else return -1;
  }
  return total - label.length * 0.01;
}

/** Commands matching the query, best first (keeping the given order among equals). */
export function search(commands: Command[], query: string, limit = 40): Command[] {
  if (!query.trim()) return commands.slice(0, limit);
  return commands
    .map((c, i) => ({ c, i, s: score(query, c) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}

/** "36.15, -85.43" or "36.15 -85.43" (decimal degrees) as a position; null for anything else or out-of-range numbers. */
export function parseCoordinates(text: string): { lat: number; lon: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const [lat, lon] = [Number(m[1]), Number(m[2])];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}
