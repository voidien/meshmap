import { useRef, useState, type ReactNode } from "react";
import { nearestSnap, nextSnap, snapHeights, type Snap } from "./sheet";

interface Props {
  snap: Snap;
  onSnap: (s: Snap) => void;
  /** a line shown when the sheet is small */
  summary?: ReactNode;
  /** show the summary line at every height, not only at peek */
  summaryAlways?: boolean;
  label: string;
  children: ReactNode;
}

/** A panel that rises from the bottom of the screen: drag the handle (or tap it) between peek, half and full height. */
export function BottomSheet({ snap, onSnap, summary, summaryAlways = false, label, children }: Props) {
  const box = useRef<HTMLElement>(null);
  const start = useRef<{ y: number; h: number; last: number; v: number } | null>(null);
  const [dragH, setDragH] = useState<number | null>(null);
  const container = () => box.current?.parentElement?.clientHeight ?? 700;

  const down = (e: React.PointerEvent) => {
    const h = box.current?.getBoundingClientRect().height ?? 0;
    start.current = { y: e.clientY, h, last: e.clientY, v: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    s.v = s.last - e.clientY; // up is positive
    s.last = e.clientY;
    const h = snapHeights(container());
    setDragH(Math.max(h.peek, Math.min(h.full, s.h + (s.y - e.clientY))));
  };
  const up = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const moved = Math.abs(e.clientY - s.y);
    setDragH(null);
    if (moved < 6) onSnap(nextSnap(snap));
    else onSnap(nearestSnap(s.h + (s.y - e.clientY), container(), s.v));
  };

  return (
    <section ref={box} className={`sheet ${snap}`} style={dragH !== null ? { height: dragH } : undefined} aria-label={label}>
      <div
        className="sheet-handle"
        role="button"
        tabIndex={0}
        aria-label={`${label}: drag to resize, or press to change size`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => (start.current = null, setDragH(null))}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSnap(nextSnap(snap)))}
      >
        <i />
      </div>
      {summary && (snap === "peek" || summaryAlways) ? <div className="sheet-summary">{summary}</div> : null}
      <div className="sheet-body">{children}</div>
    </section>
  );
}
