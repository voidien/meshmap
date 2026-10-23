export interface Progress {
  done: number;
  failed: number;
  total: number;
}

/** Fetch every URL (the service worker keeps what comes back). Returns the final counts; stops early when the signal aborts. */
export async function downloadAll(urls: string[], onProgress: (p: Progress) => void, signal?: AbortSignal, concurrency = 6): Promise<Progress> {
  const p: Progress = { done: 0, failed: 0, total: urls.length };
  let next = 0;
  const worker = async () => {
    while (next < urls.length && !signal?.aborted) {
      const url = urls[next++];
      try {
        const r = await fetch(url, { credentials: "same-origin", signal });
        await r.arrayBuffer();
        if (r.ok || r.status === 404) p.done++;
        else p.failed++;
      } catch {
        p.failed++;
      }
      onProgress({ ...p });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return p;
}
