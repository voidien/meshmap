import { useEffect, useRef } from "react";

/**
 * While something covers the screen (`layer` is not null), keep one history entry for it, so the browser's or
 * the phone's Back button closes it (`close`) instead of leaving the app. When it closes some other way the
 * entry is taken back off, so no extra history is left behind. A new `layer` value after a Back (the sheet
 * showing again once the link view under it closed) gets an entry of its own.
 */
export function useBackToClose(layer: string | null, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  const pushed = useRef(false);
  /** our own history.back() is on its way: its popstate is not the user's Back */
  const ignore = useRef(0);

  useEffect(() => {
    const onPop = () => {
      if (ignore.current > 0) {
        ignore.current--;
        return;
      }
      if (!pushed.current) return;
      pushed.current = false;
      closeRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (layer !== null && !pushed.current) {
      history.pushState({ meshmapLayer: layer }, "");
      pushed.current = true;
    } else if (layer === null && pushed.current) {
      pushed.current = false;
      ignore.current++;
      history.back();
    }
  }, [layer]);

  // leaving the phone layout (or the app) with an entry still pushed: take it back off
  useEffect(
    () => () => {
      if (pushed.current) {
        pushed.current = false;
        history.back();
      }
    },
    [],
  );
}
