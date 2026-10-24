import { computeLinks, type ComputeOptions } from "./analysis";
import type { ComputeRequest, WorkerReply } from "./linkWorker";
import type { Link, MeshNode, Settings } from "../types";

interface Pending {
  resolve: (l: Link[]) => void;
  reject: (e: Error) => void;
  onProgress?: (done: number, total: number) => void;
}

let worker: Worker | null | undefined;
let seq = 0;
const pending = new Map<number, Pending>();

function start(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined") return (worker = null);
  try {
    const w = new Worker(new URL("./linkWorker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<WorkerReply>) => {
      const m = e.data;
      const p = pending.get(m.id);
      if (!p) return;
      if (m.type === "progress") p.onProgress?.(m.done, m.total);
      else {
        pending.delete(m.id);
        if (m.type === "done") p.resolve(m.links);
        else p.reject(new Error(m.message));
      }
    };
    // a worker that cannot start (blocked, unsupported): fall back to the main thread from now on
    w.onerror = () => {
      worker = null;
      w.terminate();
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(new Error("worker failed"));
      }
    };
    return (worker = w);
  } catch {
    return (worker = null);
  }
}

/**
 * Analyse all candidate pairs in a worker. A newer call replaces an older one: the older promise resolves empty
 * (callers drop results of superseded runs anyway). Without a worker it runs on the main thread.
 */
export async function computeLinksOffThread(nodes: MeshNode[], settings: Settings, opt: ComputeOptions): Promise<Link[]> {
  const w = start();
  if (!w) return computeLinks(nodes, settings, opt);
  for (const [id, p] of pending) {
    pending.delete(id);
    p.resolve([]);
  }
  const id = ++seq;
  const run = new Promise<Link[]>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress: opt.onProgress });
  });
  const req: ComputeRequest = { type: "compute", id, nodes, settings, spacingM: opt.spacingM };
  w.postMessage(req);
  try {
    return await run;
  } catch (e) {
    if (worker === null) return computeLinks(nodes, settings, opt); // the worker died: do it here
    throw e;
  }
}
