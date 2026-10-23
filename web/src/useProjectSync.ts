import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { DEFAULT_SETTINGS, type Member, type Project } from "./types";
import { parseProject } from "./workspace";

interface ServerProject {
  id: string;
  name: string;
  role: NonNullable<Project["role"]>;
  owner: NonNullable<Project["owner"]>;
  revision: number;
  updatedAt: number;
  updatedBy: string | null;
  members: Member[];
  data: Record<string, unknown>;
}

export interface Conflict {
  revision: number;
  updatedBy: string | null;
}

export type SaveState = "saved" | "saving" | "error";

const POLL_MS = 15000;
const SAVE_DELAY_MS = 900;

/** What gets stored on the server: everything except the id, role and sharing metadata. */
const content = (p: Project) => JSON.stringify([p.name, p.nodes, p.settings, p.overlays ?? null]);
const dataOf = (p: Project) => ({ nodes: p.nodes, settings: p.settings, overlays: p.overlays });

function fromServer(sp: ServerProject): Project {
  const parsed = parseProject({ ...sp.data, id: sp.id, name: sp.name }) ?? { id: sp.id, name: sp.name, nodes: [], settings: { ...DEFAULT_SETTINGS } };
  return { ...parsed, id: sp.id, name: sp.name, role: sp.role, revision: sp.revision, owner: sp.owner, members: sp.members, updatedBy: sp.updatedBy };
}

/**
 * The user's projects, kept in memory for instant editing and synced with the server: edits are saved a moment after the
 * last change, other people's changes arrive by polling, and a save that races someone else's is reported as a conflict.
 */
export function useProjectSync(enabled: boolean) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Record<string, Conflict>>({});

  const ref = useRef(projects);
  ref.current = projects;
  const conflictsRef = useRef(conflicts);
  conflictsRef.current = conflicts;
  /** content signature of each project as last known to match the server */
  const saved = useRef(new Map<string, string>());
  const inflight = useRef(new Set<string>());

  const adopt = useCallback((sp: ServerProject): Project => {
    const p = fromServer(sp);
    saved.current.set(p.id, content(p));
    return p;
  }, []);

  const load = useCallback(async () => {
    const list = await api.get<ServerProject[]>("/api/projects");
    let ps = list.map(adopt);
    if (ps.length === 0) {
      const created = await api.post<ServerProject>("/api/projects", { name: "Untitled project", data: { nodes: [] } });
      ps = [adopt(created)];
    }
    setProjects(ps);
    setReady(true);
  }, [adopt]);

  useEffect(() => {
    if (!enabled) return;
    load().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [enabled, load]);

  // ---- save edited projects ------------------------------------------------
  const flush = useCallback(async () => {
    for (const p of ref.current) {
      if (p.role === "viewer" || conflictsRef.current[p.id] || inflight.current.has(p.id)) continue;
      const sig = content(p);
      if (saved.current.get(p.id) === sig) continue;
      inflight.current.add(p.id);
      setSaveState("saving");
      try {
        const r = await api.put<{ revision: number }>(`/api/projects/${p.id}`, { baseRevision: p.revision, name: p.name, data: dataOf(p) });
        saved.current.set(p.id, sig);
        setProjects((ps) => ps.map((x) => (x.id === p.id ? { ...x, revision: r.revision } : x)));
        setError(null);
        setSaveState("saved");
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const d = e.details as { revision?: number; updatedBy?: string | null } | undefined;
          setConflicts((c) => ({ ...c, [p.id]: { revision: d?.revision ?? 0, updatedBy: d?.updatedBy ?? null } }));
          setSaveState("saved");
        } else {
          setError(e instanceof Error ? e.message : String(e));
          setSaveState("error");
        }
      } finally {
        inflight.current.delete(p.id);
      }
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => void flush(), SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [projects, ready, flush]);

  // retry after an error, and save straight away when the tab is hidden or closed
  useEffect(() => {
    if (!ready) return;
    const hide = () => document.visibilityState === "hidden" && void flush();
    document.addEventListener("visibilitychange", hide);
    const retry = setInterval(() => saveState === "error" && void flush(), 10000);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      clearInterval(retry);
    };
  }, [ready, flush, saveState]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (ref.current.some((p) => p.role !== "viewer" && saved.current.get(p.id) !== content(p))) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // ---- pick up other people's changes -----------------------------------------
  const poll = useCallback(async () => {
    if (inflight.current.size > 0) return;
    let list: ServerProject[];
    try {
      list = await api.get<ServerProject[]>("/api/projects");
    } catch {
      return; // offline or signed out: the next save or reload will say so
    }
    const remote = new Map(list.map((p) => [p.id, p]));
    setProjects((local) => {
      const out: Project[] = [];
      const newConflicts: Record<string, Conflict> = {};
      for (const p of local) {
        const r = remote.get(p.id);
        remote.delete(p.id);
        if (!r) {
          // deleted or no longer shared: drop it unless it has edits that never reached the server
          if (saved.current.get(p.id) !== content(p) && p.revision === undefined) out.push(p);
          else saved.current.delete(p.id);
          continue;
        }
        const clean = saved.current.get(p.id) === content(p);
        if (r.revision > (p.revision ?? 0)) {
          if (clean) {
            out.push(adopt(r));
          } else {
            newConflicts[p.id] = { revision: r.revision, updatedBy: r.updatedBy };
            out.push(p);
          }
        } else {
          // sharing can change without a new revision
          out.push({ ...p, role: r.role, members: r.members, owner: r.owner });
        }
      }
      for (const r of remote.values()) out.push(adopt(r));
      if (Object.keys(newConflicts).length) setConflicts((c) => ({ ...c, ...newConflicts }));
      return out;
    });
  }, [adopt]);

  useEffect(() => {
    if (!ready) return;
    const t = setInterval(() => document.visibilityState === "visible" && void poll(), POLL_MS);
    const focus = () => void poll();
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", focus);
    };
  }, [ready, poll]);

  // ---- operations ---------------------------------------------------------
  const update = useCallback((id: string, fn: (p: Project) => Project) => {
    setProjects((ps) => ps.map((p) => (p.id === id && p.role !== "viewer" ? fn(p) : p)));
  }, []);

  const create = useCallback(
    async (name: string, from?: Pick<Project, "nodes" | "settings" | "overlays">): Promise<Project> => {
      const data = from ? { nodes: from.nodes, settings: from.settings, overlays: from.overlays } : { nodes: [] };
      const sp = await api.post<ServerProject>("/api/projects", { name, data });
      const p = adopt(sp);
      setProjects((ps) => [...ps, p]);
      return p;
    },
    [adopt],
  );

  const remove = useCallback(async (id: string) => {
    await api.del(`/api/projects/${id}`);
    saved.current.delete(id);
    setProjects((ps) => ps.filter((p) => p.id !== id));
  }, []);

  const leave = useCallback(async (id: string, userId: string) => {
    await api.del(`/api/projects/${id}/members/${userId}`);
    saved.current.delete(id);
    setProjects((ps) => ps.filter((p) => p.id !== id));
  }, []);

  const setMembers = useCallback((id: string, members: Member[]) => {
    setProjects((ps) => ps.map((p) => (p.id === id ? { ...p, members } : p)));
  }, []);

  /** After a conflict: take the other person's version (dropping local edits) or overwrite it with ours. */
  const resolve = useCallback(
    async (id: string, choice: "theirs" | "mine") => {
      const c = conflictsRef.current[id];
      const clear = () =>
        setConflicts((cs) => {
          const { [id]: _drop, ...rest } = cs;
          return rest;
        });
      if (choice === "theirs") {
        const list = await api.get<ServerProject[]>("/api/projects");
        const r = list.find((p) => p.id === id);
        if (r) setProjects((ps) => ps.map((p) => (p.id === id ? adopt(r) : p)));
        clear();
        return;
      }
      const p = ref.current.find((x) => x.id === id);
      if (!p) return clear();
      const res = await api.put<{ revision: number }>(`/api/projects/${id}`, { baseRevision: c?.revision ?? p.revision, force: true, name: p.name, data: dataOf(p) });
      saved.current.set(id, content(p));
      setProjects((ps) => ps.map((x) => (x.id === id ? { ...x, revision: res.revision } : x)));
      clear();
    },
    [adopt],
  );

  /** Put an earlier version back. Edits not yet saved are sent first, so the restore applies to what is on screen. */
  const restoreVersion = useCallback(
    async (id: string, number: number) => {
      await flush();
      const p = ref.current.find((x) => x.id === id);
      if (!p) return;
      if (saved.current.get(id) !== content(p) || conflictsRef.current[id]) throw new Error("Your latest edits have not finished saving. Try again in a moment.");
      const list = await api.get<ServerProject[]>("/api/projects");
      const server = list.find((x) => x.id === id);
      if (!server) throw new Error("This project is no longer available.");
      const r = await api.post<{ revision: number; data: Record<string, unknown> }>(`/api/projects/${id}/versions/${number}/restore`, { baseRevision: server.revision });
      const next = fromServer({ ...server, revision: r.revision, data: r.data });
      saved.current.set(id, content(next));
      setProjects((ps) => ps.map((x) => (x.id === id ? { ...next, role: x.role } : x)));
    },
    [flush],
  );

  return { projects, ready, saveState, error, conflicts, update, create, remove, leave, setMembers, resolve, restoreVersion, reload: load };
}
