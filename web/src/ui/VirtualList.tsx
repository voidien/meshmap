import { useEffect, useRef, useState, type ReactNode } from "react";
import { windowRange } from "./windowing";

interface Props<T> {
  items: T[];
  /** every row has this height (px), so only the visible ones need drawing */
  rowHeight: number;
  /** the list scrolls inside this height */
  maxHeight?: number;
  /** take the room the panel has (the new layout's lists) */
  fill?: boolean;
  className?: string;
  ariaLabel: string;
  keyOf: (item: T) => string;
  rowClass?: (item: T) => string;
  onRowClick?: (item: T) => void;
  row: (item: T, index: number) => ReactNode;
}

/** A long list that draws only the rows in view (plus a few), so hundreds of rows cost the same as a dozen. */
export function VirtualList<T>({ items, rowHeight, maxHeight = 280, fill = false, className = "", ariaLabel, keyOf, rowClass, onRowClick, row }: Props<T>) {
  const box = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(fill ? 480 : maxHeight);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight || (fill ? 480 : maxHeight));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill, maxHeight]);

  const { start, end } = windowRange(scrollTop, viewport, rowHeight, items.length);
  return (
    <div ref={box} className={`vlist${fill ? " fill" : ""}`} style={fill ? undefined : { maxHeight }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <ul className={className} aria-label={ariaLabel} style={{ paddingTop: start * rowHeight, paddingBottom: (items.length - end) * rowHeight }}>
        {items.slice(start, end).map((it, k) => (
          <li key={keyOf(it)} className={rowClass?.(it)} style={{ height: rowHeight }} onClick={onRowClick ? () => onRowClick(it) : undefined} data-index={start + k}>
            {row(it, start + k)}
          </li>
        ))}
      </ul>
    </div>
  );
}
