import { notify } from "../ui/toasts";

/** Registers the service worker (production builds only), tells it which app files this page is using, and offers new versions. */
export function registerOffline(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => {
        offerUpdates(reg);
        return navigator.serviceWorker.ready;
      })
      .then((reg) => window.setTimeout(() => keepAppFiles(reg), 4000))
      .catch(() => undefined);
  });
}

let offered = false;
/** A new version has been downloaded and is waiting: say so, and switch when the person agrees. */
function offerUpdates(reg: ServiceWorkerRegistration) {
  const offer = (worker: ServiceWorker) => {
    if (offered || !navigator.serviceWorker.controller) return;
    offered = true;
    notify("A new version of meshmap is ready.", {
      action: "Update now",
      ms: 0,
      onAction: () => {
        navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
        worker.postMessage({ type: "skip-waiting" });
      },
    });
  };
  if (reg.waiting) offer(reg.waiting);
  reg.addEventListener("updatefound", () => {
    const w = reg.installing;
    w?.addEventListener("statechange", () => {
      if (w.state === "installed") offer(w);
    });
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
