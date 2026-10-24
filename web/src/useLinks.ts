import { useEffect, useRef, useState } from "react";
import { SPACING_FAST_M, SPACING_FULL_M } from "./engine/analysis";
import { computeLinksOffThread } from "./engine/linkClient";
import type { Link, MeshNode, Settings } from "./types";

const NO_LINKS: Link[] = [];

export interface LinkStatus {
  busy: boolean;
  done: number;
  total: number;
  error?: string;
}

/**
 * Recompute project links whenever nodes/settings change; coarse profiles while `dragging`.
 * Results are remembered per `key` (project id) so switching back to a project shows its last
 * links immediately while a fresh analysis (served mostly from the pair cache) runs.
 */
export function useLinks(nodes: MeshNode[], settings: Settings, dragging: boolean, ready: boolean, key: string) {
  const results = useRef(new Map<string, Link[]>());
  const [, bump] = useState(0);
  const [status, setStatus] = useState<LinkStatus>({ busy: false, done: 0, total: 0 });
  const run = useRef(0);
  const lastKey = useRef(key);

  useEffect(() => {
    if (!ready) return;
    const id = ++run.current;
    const switched = lastKey.current !== key;
    lastKey.current = key;
    const timer = setTimeout(
      async () => {
        setStatus((s) => ({ ...s, busy: true, error: undefined }));
        try {
          const result = await computeLinksOffThread(nodes, settings, {
            spacingM: dragging ? SPACING_FAST_M : SPACING_FULL_M,
            isCancelled: () => id !== run.current,
            onProgress: (done, total) => id === run.current && setStatus({ busy: true, done, total }),
          });
          if (id === run.current) {
            results.current.set(key, result);
            bump((n) => n + 1);
            setStatus({ busy: false, done: result.length, total: result.length });
          }
        } catch (e) {
          if (id === run.current) setStatus({ busy: false, done: 0, total: 0, error: e instanceof Error ? e.message : String(e) });
        }
      },
      dragging || switched ? 0 : 120,
    );
    return () => clearTimeout(timer);
  }, [nodes, settings, dragging, ready, key]);

  return { links: results.current.get(key) ?? NO_LINKS, status };
}
