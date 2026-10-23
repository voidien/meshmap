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
  onShare: () => void;
  onPublish: () => void;
}

/** Quick switching between setups. Keyboard: `[` previous, `]` next, `` ` `` flip to the last one. */
export function ProjectSwitcher({ projects, activeId, canFlip, onSelect, onFlip, onNew, onDuplicate, onDelete, onShare, onPublish }: Props) {
  return (
    <section className="card switcher">
      <div className="switchrow">
        <select value={activeId} onChange={(e) => onSelect(e.target.value)} aria-label="Switch project" title="Keys: [ previous · ] next · ` flip back">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.nodes.length}){p.role && p.role !== "owner" ? ` · ${p.owner?.displayName ?? "shared"} (${p.role})` : ""}
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
        <button onClick={onShare} title="Who can see and edit this project">
          Share{projects.find((p) => p.id === activeId)?.members?.length ? ` (${projects.find((p) => p.id === activeId)?.members?.length})` : ""}
        </button>
        <button onClick={onPublish} title="Put a read-only copy in the Published section for everyone on this site">
          Publish
        </button>
        <button onClick={onDelete} className="danger" disabled={projects.length < 2 || projects.find((p) => p.id === activeId)?.role !== "owner"} title="Only the owner can delete a project">
          Delete
        </button>
      </div>
    </section>
  );
}
