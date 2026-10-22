import type { Project } from "../types";

interface Props {
  projects: Project[];
  activeId: string;
  canFlip: boolean;
  onSelect: (id: string) => void;
  onFlip: () => void;
  onNew: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

/** Quick switching between setups. Keyboard: `[` previous, `]` next, `` ` `` flip to the last one. */
export function ProjectSwitcher({ projects, activeId, canFlip, onSelect, onFlip, onNew, onDuplicate, onDelete }: Props) {
  return (
    <section className="card switcher">
      <div className="switchrow">
        <select value={activeId} onChange={(e) => onSelect(e.target.value)} aria-label="Switch project">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.nodes.length})
            </option>
          ))}
        </select>
        <button onClick={onFlip} disabled={!canFlip} title="Flip to the previously open project (`)">
          ⇄
        </button>
      </div>
      <div className="btnrow">
        <button onClick={onNew}>New</button>
        <button onClick={onDuplicate} title="Copy this setup to try a what-if">
          Duplicate
        </button>
        <button onClick={onDelete} className="danger" disabled={projects.length < 2}>
          Delete
        </button>
      </div>
      <p className="hint">
        Keys: <kbd>[</kbd> previous · <kbd>]</kbd> next · <kbd>`</kbd> flip back
      </p>
    </section>
  );
}
