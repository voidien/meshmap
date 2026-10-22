import { useEffect, useRef, useState } from "react";
import { computeLinks, SPACING_FAST_M, SPACING_FULL_M } from "./engine/analysis";
import type { Link, MeshNode, Settings } from "./types";

export interface LinkStatus {
  busy: boolean;
  done: number;
  total: number;
  error?: string;
}

/** Recompute project links whenever nodes/settings change; coarse profiles while `dragging`. */
export function useLinks(nodes: MeshNode[], settings: Settings, dragging: boolean, ready: boolean) {
  const [links, setLinks] = useState<Link[]>([]);
  const [status, setStatus] = useState<LinkStatus>({ busy: false, done: 0, total: 0 });
  const run = useRef(0);

  useEffect(() => {
    if (!ready) return;
    const id = ++run.current;
    const timer = setTimeout(
      async () => {
        setStatus((s) => ({ ...s, busy: true, error: undefined }));
        try {
          const result = await computeLinks(nodes, settings, {
            spacingM: dragging ? SPACING_FAST_M : SPACING_FULL_M,
            isCancelled: () => id !== run.current,
            onProgress: (done, total) => id === run.current && setStatus({ busy: true, done, total }),
          });
          if (id === run.current) {
            setLinks(result);
            setStatus({ busy: false, done: result.length, total: result.length });
          }
        } catch (e) {
          if (id === run.current) setStatus({ busy: false, done: 0, total: 0, error: e instanceof Error ? e.message : String(e) });
        }
      },
      dragging ? 0 : 120,
    );
    return () => clearTimeout(timer);
  }, [nodes, settings, dragging, ready]);

  return { links, status };
}
