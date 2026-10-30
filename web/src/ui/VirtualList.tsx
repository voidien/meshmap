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
  /** the row that is open (selected node or link): marked for screen readers, and where Tab lands first */
  isCurrent?: (item: T) => boolean;
  onRowClick?: (item: T) => void;
  row: (item: T, index: number) => ReactNode;
}

/**
 * A long list that draws only the rows in view (plus a few), so hundreds of rows cost the same as a dozen.
 * With `onRowClick` the rows work from the keyboard: one row is a Tab stop, the arrow keys (and Home / End)
 * move between rows, scrolling as needed, and Enter or Space opens a row.
 */
export function VirtualList<T>({ items, rowHeight, maxHeight = 280, fill = false, className = "", ariaLabel, keyOf, rowClass, isCurrent, onRowClick, row }: Props<T>) {
  const box = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(fill ? 480 : maxHeight);
  /** the row that holds the Tab stop (null: the open row, or the first) */
  const [active, setActive] = useState<number | null>(null);
  const focusNext = useRef<number | null>(null);

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
  const keyboard = !!onRowClick;
  const current = isCurrent ? items.findIndex(isCurrent) : -1;
  const wanted = Math.min(items.length - 1, active ?? (current >= 0 ? current : 0));
  // the Tab stop must be a row that is drawn
  const tabStop = wanted >= start && wanted < end ? wanted : start;
  // a newly opened row (from the map, or Enter here) takes the Tab stop
  useEffect(() => setActive(null), [current]);

  // after the arrow keys scrolled a row into view, give it the focus
  useEffect(() => {
    const i = focusNext.current;
    if (i === null) return;
    const li = box.current?.querySelector<HTMLElement>(`li[data-index="${i}"]`);
    if (li) {
      focusNext.current = null;
      li.focus({ preventScroll: true });
    }
  });

  const moveTo = (i: number) => {
    const el = box.current;
    if (!el || items.length === 0) return;
    const to = Math.max(0, Math.min(items.length - 1, i));
    let top = el.scrollTop;
    if (to * rowHeight < top) top = to * rowHeight;
    else if ((to + 1) * rowHeight > top + el.clientHeight) top = (to + 1) * rowHeight - el.clientHeight;
    if (top !== el.scrollTop) {
      // the focused row may scroll out and be dropped, and the browser then moves the scroll on its own: hold the focus on the list meanwhile
      if (el.contains(document.activeElement)) el.focus({ preventScroll: true });
      el.scrollTop = top;
      setScrollTop(top);
    }
    setActive(to);
    focusNext.current = to;
  };

  const onKey = (e: React.KeyboardEvent<HTMLLIElement>, it: T, i: number) => {
    if (e.target !== e.currentTarget) return; // a checkbox inside the row keeps its own keys
    const page = Math.max(1, Math.floor(viewport / rowHeight) - 1);
    if (e.key === "Enter" || e.key === " ") onRowClick?.(it);
    else if (e.key === "ArrowDown") moveTo(i + 1);
    else if (e.key === "ArrowUp") moveTo(i - 1);
    else if (e.key === "PageDown") moveTo(i + page);
    else if (e.key === "PageUp") moveTo(i - page);
    else if (e.key === "Home") moveTo(0);
    else if (e.key === "End") moveTo(items.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={box} className={`vlist${fill ? " fill" : ""}`} tabIndex={keyboard ? -1 : undefined} style={fill ? undefined : { maxHeight }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <ul className={className} aria-label={ariaLabel} style={{ paddingTop: start * rowHeight, paddingBottom: (items.length - end) * rowHeight }}>
        {items.slice(start, end).map((it, k) => {
          const i = start + k;
          return (
            <li
              key={keyOf(it)}
              className={rowClass?.(it)}
              style={{ height: rowHeight }}
              onClick={onRowClick ? () => onRowClick(it) : undefined}
              data-index={i}
              aria-posinset={i + 1}
              aria-setsize={items.length}
              aria-current={i === current ? "true" : undefined}
              tabIndex={keyboard ? (i === tabStop ? 0 : -1) : undefined}
              onFocus={keyboard ? () => setActive(i) : undefined}
              onKeyDown={keyboard ? (e) => onKey(e, it, i) : undefined}
            >
              {row(it, i)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
