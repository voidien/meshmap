import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { parseCoordinates, search, type Command } from "./palette";

interface Props {
  commands: Command[];
  onClose: () => void;
  onGoto: (lat: number, lon: number) => void;
  onAddAt?: (lat: number, lon: number) => void;
}

/** Ctrl/Cmd+K: jump to a node, switch project, run an action or type a position. Everything is local, so it works offline. */
export function CommandPalette({ commands, onClose, onGoto, onAddAt }: Props) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const results = useMemo(() => {
    const pos = parseCoordinates(q);
    const fromPos: Command[] = pos
      ? [
          { id: "goto-pos", label: `Go to ${pos.lat}, ${pos.lon}`, group: "Go to", run: () => onGoto(pos.lat, pos.lon) },
          ...(onAddAt ? [{ id: "add-pos", label: `Add a node at ${pos.lat}, ${pos.lon}`, group: "Actions" as const, run: () => onAddAt(pos.lat, pos.lon) }] : []),
        ]
      : [];
    return [...fromPos, ...search(commands, q)];
  }, [q, commands, onGoto, onAddAt]);

  useEffect(() => setI(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  }, [i]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    // after the dialog has closed and given focus back, so the action's own focus changes stick
    setTimeout(c.run, 0);
  };

  return (
    <Modal onClose={onClose} label="Command palette" className="palette">
      <input
        className="palette-input"
        placeholder="Go to a node, run an action, or type a position (36.15, -85.43)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setI((v) => Math.min(results.length - 1, v + 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setI((v) => Math.max(0, v - 1)));
          else if (e.key === "Enter") (e.preventDefault(), run(results[i]));
        }}
      />
      <ul className="palette-list" ref={list} role="listbox">
        {results.length === 0 ? <li className="hint">Nothing matches “{q}”.</li> : null}
        {results.map((c, k) => (
          <li key={c.id} data-i={k} role="option" aria-selected={k === i} className={k === i ? "sel" : ""} onMouseMove={() => setI(k)} onClick={() => run(c)}>
            <span className="grp">{c.group}</span>
            <span className="lbl">
              {c.label}
              {c.hint ? <small>{c.hint}</small> : null}
            </span>
            {c.shortcut ? <kbd>{c.shortcut}</kbd> : null}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
