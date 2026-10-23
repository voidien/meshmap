/** Registers the service worker (production builds only) and tells it which app files this page is using, so they are kept for offline use. */
export function registerOffline(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => window.setTimeout(() => keepAppFiles(reg), 4000))
      .catch(() => undefined);
  });
}

export function keepAppFiles(reg?: ServiceWorkerRegistration | null): void {
  const urls = performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .filter((u) => {
      try {
        return new URL(u).origin === location.origin && !u.includes("/api/");
      } catch {
        return false;
      }
    });
  (reg?.active ?? navigator.serviceWorker.controller)?.postMessage({ type: "cache-urls", urls });
}

/** True once a service worker controls this page, i.e. things the page fetches are being kept. */
export const offlineReady = (): boolean => "serviceWorker" in navigator && !!navigator.serviceWorker.controller;
