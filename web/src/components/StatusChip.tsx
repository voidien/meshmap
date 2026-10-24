import type { SaveState } from "../useProjectSync";

interface Props {
  saveState: SaveState;
  readOnly: boolean;
  online: boolean;
  conflict: boolean;
  onConflict: () => void;
  analysis: { busy: boolean; done: number; total: number; error?: string | null };
  jobsRunning: number;
  id?: string;
}

/** What the app is doing, always visible on the map (even with the menu hidden): saved, offline, analysing, jobs, conflict. */
export function StatusChip({ saveState, readOnly, online, conflict, onConflict, analysis, jobsRunning, id = "status-chip" }: Props) {
  const parts: { key: string; text: string; tone?: "warn" | "bad" | "busy" }[] = [];
  if (conflict) parts.push({ key: "conflict", text: "Edit conflict", tone: "bad" });
  if (!online) parts.push({ key: "offline", text: "Offline", tone: "warn" });
  if (readOnly) parts.push({ key: "save", text: "View only" });
  else if (saveState === "saving") parts.push({ key: "save", text: "Saving…", tone: "busy" });
  else if (saveState === "error") parts.push({ key: "save", text: online ? "Not saved, retrying" : "Not saved (offline)", tone: "bad" });
  else parts.push({ key: "save", text: "✓ Saved" });
  if (analysis.busy) parts.push({ key: "links", text: `Analysing links ${analysis.done}/${analysis.total}`, tone: "busy" });
  if (jobsRunning > 0) parts.push({ key: "jobs", text: `${jobsRunning} heatmap job${jobsRunning === 1 ? "" : "s"} running`, tone: "busy" });
  return (
    <div className="status-chip" id={id} aria-live="polite" role="status">
      {parts.map((p) =>
        p.key === "conflict" ? (
          <button key={p.key} className={`part ${p.tone ?? ""}`} onClick={onConflict} title="Open the menu to choose which version to keep">
            ⚠ {p.text}
          </button>
        ) : (
          <span key={p.key} className={`part ${p.tone ?? ""}`}>
            {p.text}
          </span>
        ),
      )}
    </div>
  );
}
