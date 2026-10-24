import { useCallback, useState } from "react";

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
