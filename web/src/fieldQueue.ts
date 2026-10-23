/** Field readings waiting to be uploaded. They are kept in the browser so a reading taken without signal is not lost. */
import { api } from "./api";
import type { FieldReading } from "./collab";

export interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export type NewReading = Omit<FieldReading, "by" | "canDelete">;

const key = (projectId: string) => `meshmap.field.queue.${projectId}`;
const BATCH = 50;

export function loadQueue(projectId: string, store: Store = localStorage): NewReading[] {
  try {
    const v = JSON.parse(store.getItem(key(projectId)) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveQueue(projectId: string, q: NewReading[], store: Store = localStorage) {
  try {
    store.setItem(key(projectId), JSON.stringify(q));
  } catch {
    /* storage full or blocked: the readings stay in memory for this session */
  }
}

/** Upload queued readings in batches; whatever could not be sent stays queued. Returns what is still waiting. */
export async function flushQueue(projectId: string, post: (path: string, body: unknown) => Promise<unknown> = (p, b) => api.post(p, b), store: Store = localStorage): Promise<NewReading[]> {
  let q = loadQueue(projectId, store);
  while (q.length > 0) {
    const batch = q.slice(0, BATCH);
    try {
      await post(`/api/projects/${projectId}/readings`, batch);
    } catch (e) {
      // the server refuses the whole batch if one reading is invalid: send them one by one so only that one is dropped
      if (isBadRequest(e)) {
        for (const one of batch) {
          try {
            await post(`/api/projects/${projectId}/readings`, [one]);
          } catch (e2) {
            if (!isBadRequest(e2)) {
              q = q.slice(batch.indexOf(one));
              saveQueue(projectId, q, store);
              return q;
            }
          }
        }
        q = q.slice(batch.length);
        saveQueue(projectId, q, store);
        continue;
      }
      break;
    }
    q = q.slice(batch.length);
    saveQueue(projectId, q, store);
  }
  return q;
}

const isBadRequest = (e: unknown) => !!e && typeof e === "object" && "status" in e && (e as { status: number }).status === 400;

export const newReadingId = () => `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
