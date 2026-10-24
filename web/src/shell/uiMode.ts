import { useCallback, useState } from "react";

export type UiMode = "v1" | "v2";
const KEY = "meshmap.ui";

/** Which layout to show: `?ui=v2` or `?ui=v1` in the address picks (and is remembered); otherwise the remembered choice; classic by default. */
export function getUiMode(): UiMode {
  try {
    const q = new URLSearchParams(location.search).get("ui");
    if (q === "v1" || q === "v2") {
      localStorage.setItem(KEY, q);
      return q;
    }
    return localStorage.getItem(KEY) === "v2" ? "v2" : "v1";
  } catch {
    return "v1";
  }
}

export function storeUiMode(m: UiMode) {
  try {
    localStorage.setItem(KEY, m);
  } catch {
    /* private mode: the choice lasts until reload */
  }
}

/** Developer commands (generate test networks): `?dev=1` turns them on (remembered), `?dev=0` off. */
export function devMode(): boolean {
  try {
    const q = new URLSearchParams(location.search).get("dev");
    if (q === "1" || q === "0") localStorage.setItem("meshmap.dev", q);
    return localStorage.getItem("meshmap.dev") === "1";
  } catch {
    return false;
  }
}

/** A true/false that is remembered in the browser. */
export function useStoredFlag(key: string, initial: () => boolean): [boolean, (v: boolean | ((x: boolean) => boolean)) => void] {
  const [v, setV] = useState<boolean>(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial() : s === "1";
    } catch {
      return initial();
    }
  });
  const set = useCallback(
    (next: boolean | ((x: boolean) => boolean)) => {
      setV((cur) => {
        const n = typeof next === "function" ? next(cur) : next;
        try {
          localStorage.setItem(key, n ? "1" : "0");
        } catch {
          /* ignore */
        }
        return n;
      });
    },
    [key],
  );
  return [v, set];
}
