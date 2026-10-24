export type Tool = "select" | "add" | "link" | "plan";

interface Props {
  tool: Tool;
  onTool: (t: Tool) => void;
  disabled: boolean;
  terrain3d: boolean;
  onToggle3d: () => void;
  showLabels: boolean;
  onToggleLabels: () => void;
}

const BUTTONS: { tool: Tool; icon: string; label: string; key: string }[] = [
  { tool: "select", icon: "↖", label: "Select", key: "V" },
  { tool: "add", icon: "＋", label: "Add nodes", key: "N" },
  { tool: "link", icon: "⇄", label: "Inspect a link between two nodes", key: "L" },
  { tool: "plan", icon: "◎", label: "Suggest sites in an area", key: "P" },
];

/** The tool rail at the left of the map: what a click on the map does. */
export function ToolRail({ tool, onTool, disabled, terrain3d, onToggle3d, showLabels, onToggleLabels }: Props) {
  return (
    <nav className="toolrail" aria-label="Map tools">
      {BUTTONS.map((b) => (
        <button key={b.tool} id={`tool-${b.tool}`} className={tool === b.tool ? "on" : ""} aria-pressed={tool === b.tool} disabled={disabled && b.tool !== "select"} title={`${b.label} (${b.key})`} aria-label={`${b.label} (${b.key})`} onClick={() => onTool(b.tool)}>
          {b.icon}
        </button>
      ))}
      <span className="railsep" />
      <button id="tool-3d" className={terrain3d ? "on" : ""} aria-pressed={terrain3d} title="Tilted 3D terrain" aria-label="3D terrain" onClick={onToggle3d}>
        3D
      </button>
      <button id="tool-names" className={showLabels ? "on" : ""} aria-pressed={showLabels} title="Show node names" aria-label="Node names" onClick={onToggleLabels}>
        Aa
      </button>
    </nav>
  );
}
