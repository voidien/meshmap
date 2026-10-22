import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { coverageRequest, requestSig, type CoverageResult, type JobInfo, type JobState } from "./coverage";
import type { MeshNode, Settings } from "./types";

export interface CoverageLayer {
  /** "network" or `node:<id>` */
  key: string;
  kind: "node" | "network";
  nodeId?: string;
  label: string;
  jobId?: string;
  state: JobState | "idle";
  progress: number;
  message: string;
  error?: string;
  result?: CoverageResult;
  /** inputs the shown result was computed for */
  sig: string;
  visible: boolean;
  opacity: number;
  /** which image of a network result to show */
  mode: "margin" | "count";
}

interface Saved {
  key: string;
  kind: "node" | "network";
  nodeId?: string;
  visible: boolean;
  opacity: number;
  mode: "margin" | "count";
}

const storeKey = (projectId: string) => `meshmap.coverage.${projectId}`;
const POLL_MS = 600;

function loadSaved(projectId: string): Saved[] {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(projectId)) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Coverage layers for the open project: start server jobs, follow their progress, and show their results.
 * Layers are remembered per project; on return they are restored from the server's cache when the inputs are unchanged.
 */
export function useCoverage(projectId: string, nodes: MeshNode[], settings: Settings, enabled: boolean) {
  const [layers, setLayers] = useState<CoverageLayer[]>([]);
  const loadedFor = useRef<string | null>(null);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const request = useCallback((l: Pick<CoverageLayer, "kind" | "nodeId">) => {
    const ns = l.kind === "network" ? nodesRef.current : nodesRef.current.filter((n) => n.id === l.nodeId);
    return ns.length ? coverageRequest(l.kind === "network" ? "coverage_network" : "coverage_node", ns, settingsRef.current) : null;
  }, []);

  const labelOf = useCallback((kind: "node" | "network", nodeId?: string) => (kind === "network" ? "Whole network" : nodesRef.current.find((n) => n.id === nodeId)?.name.trim() || "Node"), []);

  const patch = useCallback((key: string, p: Partial<CoverageLayer>) => setLayers((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l))), []);

  const applyJob = useCallback(
    (key: string, j: JobInfo) => {
      patch(key, {
        jobId: j.id,
        state: j.state,
        progress: j.progress,
        message: j.message,
        error: j.error ?? undefined,
        ...(j.state === "done" && j.result ? { result: j.result } : {}),
      });
    },
    [patch],
  );

  // ---- restore what this project had on screen last time ----
  useEffect(() => {
    if (!enabled || !projectId || loadedFor.current === projectId) return;
    loadedFor.current = projectId;
    setLayers([]);
    let cancelled = false;
    (async () => {
      const restored: CoverageLayer[] = [];
      for (const s of loadSaved(projectId)) {
        const req = request(s);
        if (!req) continue;
        const base: CoverageLayer = { key: s.key, kind: s.kind, nodeId: s.nodeId, label: labelOf(s.kind, s.nodeId), state: "idle", progress: 0, message: "Not computed for the current settings", sig: requestSig(req), visible: s.visible, opacity: s.opacity, mode: s.mode };
        try {
          const r = await fetch(`/api/projects/${projectId}/jobs?cachedOnly=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req), credentials: "same-origin" });
          if (r.status === 200) {
            const j = (await r.json()) as JobInfo;
            restored.push({ ...base, jobId: j.id, state: "done", progress: 1, message: "Done", result: j.result ?? undefined });
            continue;
          }
        } catch {
          /* offline: show the placeholder */
        }
        restored.push(base);
      }
      if (!cancelled) setLayers(restored);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, projectId, request, labelOf]);

  // ---- remember the layer list ----
  useEffect(() => {
    if (!projectId || loadedFor.current !== projectId) return;
    const saved: Saved[] = layers.map(({ key, kind, nodeId, visible, opacity, mode }) => ({ key, kind, nodeId, visible, opacity, mode }));
    try {
      localStorage.setItem(storeKey(projectId), JSON.stringify(saved));
    } catch {
      /* ignore */
    }
  }, [layers, projectId]);

  // ---- follow running jobs ----
  const busy = layers.some((l) => l.state === "queued" || l.state === "running");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(async () => {
      for (const l of layersRef.current) {
        if (!l.jobId || (l.state !== "queued" && l.state !== "running")) continue;
        try {
          applyJob(l.key, await api.get<JobInfo>(`/api/jobs/${l.jobId}`));
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) patch(l.key, { state: "failed", error: "The job is gone." });
        }
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [busy, applyJob, patch]);

  /** Start (or re-run) a layer. A cached result comes back finished at once. */
  const run = useCallback(
    async (kind: "node" | "network", nodeId?: string) => {
      const key = kind === "network" ? "network" : `node:${nodeId}`;
      const req = request({ kind, nodeId });
      if (!req) return;
      const sig = requestSig(req);
      const existing = layersRef.current.find((l) => l.key === key);
      const layer: CoverageLayer = { key, kind, nodeId, label: labelOf(kind, nodeId), state: "queued", progress: 0, message: "Queued", sig, visible: true, opacity: existing?.opacity ?? 0.7, mode: existing?.mode ?? "margin", result: existing?.result };
      setLayers((ls) => (ls.some((l) => l.key === key) ? ls.map((l) => (l.key === key ? layer : l)) : [...ls, layer]));
      try {
        applyJob(key, await api.post<JobInfo>(`/api/projects/${projectId}/jobs`, req));
      } catch (e) {
        patch(key, { state: "failed", error: e instanceof Error ? e.message : String(e) });
      }
    },
    [projectId, request, labelOf, applyJob, patch],
  );

  const cancel = useCallback(
    async (key: string) => {
      const l = layersRef.current.find((x) => x.key === key);
      if (!l?.jobId) return;
      try {
        applyJob(key, await api.del<JobInfo>(`/api/jobs/${l.jobId}`));
      } catch (e) {
        patch(key, { error: e instanceof Error ? e.message : String(e) });
      }
    },
    [applyJob, patch],
  );

  const remove = useCallback((key: string) => setLayers((ls) => ls.filter((l) => l.key !== key)), []);

  /** True when the project has changed since the layer's result was computed. */
  const staleKeys = useMemo(() => {
    const out = new Set<string>();
    for (const l of layers) {
      const req = request(l);
      if (!req || requestSig(req) !== l.sig) out.add(l.key);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, nodes, settings, request]);

  return { layers, run, cancel, remove, patch, staleKeys };
}
