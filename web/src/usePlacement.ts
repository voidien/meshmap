import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { PlacementJob } from "./placement";

const storeKey = (projectId: string) => `meshmap.placement.${projectId}`;
const POLL_MS = 600;

/** One placement job at a time per project: start it, follow its progress, keep the last result across reloads. */
export function usePlacement(projectId: string) {
  const [job, setJob] = useState<PlacementJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobRef = useRef(job);
  jobRef.current = job;

  useEffect(() => {
    setJob(null);
    setError(null);
    let live = true;
    let id: string | null = null;
    try {
      id = localStorage.getItem(storeKey(projectId));
    } catch {
      /* ignore */
    }
    if (!id) return;
    api
      .get<PlacementJob>(`/api/jobs/${id}`)
      .then((j) => live && j && setJob(j))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId]);

  const running = job?.state === "queued" || job?.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const cur = jobRef.current;
      if (!cur) return;
      try {
        setJob(await api.get<PlacementJob>(`/api/jobs/${cur.id}`));
      } catch {
        setError("The job is gone.");
        setJob(null);
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [running]);

  const start = useCallback(
    async (req: unknown) => {
      setError(null);
      try {
        const j = await api.post<PlacementJob>(`/api/projects/${projectId}/jobs`, req);
        setJob(j);
        try {
          localStorage.setItem(storeKey(projectId), j.id);
        } catch {
          /* ignore */
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [projectId],
  );

  const cancel = useCallback(async () => {
    const cur = jobRef.current;
    if (cur) setJob(await api.del<PlacementJob>(`/api/jobs/${cur.id}`));
  }, []);

  const clear = useCallback(() => {
    setJob(null);
    try {
      localStorage.removeItem(storeKey(projectId));
    } catch {
      /* ignore */
    }
  }, [projectId]);

  return { job, error, running, start, cancel, clear };
}
