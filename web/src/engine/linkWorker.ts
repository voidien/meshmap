/// <reference lib="webworker" />
/** Runs the link analysis (WASM maths plus terrain lookups) off the main thread, so the map stays responsive. */
import { computeLinks } from "./analysis";
import { loadCore } from "./wasm";
import type { Link, MeshNode, Settings } from "../types";

export interface ComputeRequest {
  type: "compute";
  id: number;
  nodes: MeshNode[];
  settings: Settings;
  spacingM: number;
}
export type WorkerReply = { type: "progress"; id: number; done: number; total: number } | { type: "done"; id: number; links: Link[] } | { type: "error"; id: number; message: string };

let current = -1;
const reply = (m: WorkerReply) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<ComputeRequest>) => {
  const m = e.data;
  if (m.type !== "compute") return;
  current = m.id; // a newer request replaces whatever is running
  try {
    await loadCore();
    const links = await computeLinks(m.nodes, m.settings, {
      spacingM: m.spacingM,
      isCancelled: () => current !== m.id,
      onProgress: (done, total) => current === m.id && reply({ type: "progress", id: m.id, done, total }),
    });
    if (current === m.id) reply({ type: "done", id: m.id, links });
  } catch (err) {
    if (current === m.id) reply({ type: "error", id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};
