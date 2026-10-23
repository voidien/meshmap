import { LEGEND } from "../coverage";
import { Card } from "./Card";
import type { CoverageLayer } from "../useCoverage";
import type { MeshNode } from "../types";

interface Props {
  layers: CoverageLayer[];
  staleKeys: ReadonlySet<string>;
  selectedNode: MeshNode | null;
  nodeCount: number;
  radiusKm: number;
  resolutionM: number;
  onRun: (kind: "node" | "network", nodeId?: string) => void;
  onCancel: (key: string) => void;
  onRemove: (key: string) => void;
  onChange: (key: string, patch: Partial<CoverageLayer>) => void;
}

const km2 = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));

/** Coverage heatmaps: start server jobs, watch their progress, tune how the results are drawn. */
export function CoveragePanel({ layers, staleKeys, selectedNode, nodeCount, radiusKm, resolutionM, onRun, onCancel, onRemove, onChange }: Props) {
  return (
    <Card id="coverage" title="Coverage heatmaps">
      <div className="btnrow">
        <button disabled={!selectedNode} onClick={() => selectedNode && onRun("node", selectedNode.id)} title={selectedNode ? "" : "Select a node first"}>
          {selectedNode ? `Predict “${selectedNode.name.trim() || "node"}”` : "Predict selected node"}
        </button>
        <button className="on" disabled={nodeCount === 0} onClick={() => onRun("network")}>
          Predict whole network
        </button>
      </div>
      <p className="hint">
        Signal margin around each node out to {radiusKm} km at {resolutionM} m resolution (change in settings). Runs on the server in the background; results are kept, so asking again for unchanged inputs is instant.
      </p>

      <ul className="layers">
        {layers.map((l) => {
          const working = l.state === "queued" || l.state === "running";
          const stale = staleKeys.has(l.key);
          return (
            <li key={l.key} className={stale ? "stale" : ""}>
              <div className="lrow">
                <label className="check" title="Show on the map">
                  <input type="checkbox" checked={l.visible} disabled={!l.result} onChange={(e) => onChange(l.key, { visible: e.target.checked })} />
                  <b>{l.label}</b>
                </label>
                <span className="spacer" />
                {working ? <button onClick={() => onCancel(l.key)}>Cancel</button> : null}
                {!working && (stale || l.state !== "done") ? <button onClick={() => onRun(l.kind, l.nodeId)}>{l.state === "done" ? "Recompute" : "Compute"}</button> : null}
                {!working ? <button onClick={() => onRemove(l.key)} aria-label={`Remove ${l.label}`}>✕</button> : null}
              </div>
              {working ? (
                <>
                  <div className="bar" role="progressbar" aria-valuenow={Math.round(l.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                    <i style={{ width: `${Math.round(l.progress * 100)}%` }} />
                  </div>
                  <div className="lmeta">{l.message}</div>
                </>
              ) : null}
              {l.state === "failed" ? <div className="err">{l.error ?? "Failed"}</div> : null}
              {l.state === "cancelled" ? <div className="lmeta">Cancelled</div> : null}
              {l.state === "idle" ? <div className="lmeta">{l.message}</div> : null}
              {l.result && !working ? (
                <>
                  <div className="lmeta">
                    Covers {km2(l.result.stats.coveredKm2)} km² of {km2(l.result.stats.predictedKm2)} km² predicted
                    {l.kind === "network" ? ` · ${km2(l.result.stats.redundantKm2)} km² reached by 2+ nodes` : ""}
                  </div>
                  {l.result.terrain !== "bare" && typeof l.result.clutterShare === "number" ? (
                    <div className={`lmeta ${(l.result.clutterShare as number) < 0.95 ? "warn" : ""}`}>
                      Trees and buildings: {Math.round((l.result.clutterShare as number) * 100)} % of the area has clutter data
                      {(l.result.clutterShare as number) < 0.95 ? "; the rest (grey hatching on the map) is predicted over bare earth, so it is optimistic there" : ""}
                    </div>
                  ) : l.result.terrain === "bare" ? (
                    <div className="lmeta">Bare-earth model</div>
                  ) : null}
                  {stale ? <div className="lmeta warn">Out of date: nodes or settings changed since this was computed.</div> : null}
                  <div className="lrow wrap">
                    <span className="lmeta">Opacity</span>
                    <input type="range" min={0.1} max={1} step={0.05} value={l.opacity} onChange={(e) => onChange(l.key, { opacity: Number(e.target.value) })} aria-label={`Opacity of ${l.label}`} />
                    {l.result.images.count ? (
                      <select value={l.mode} onChange={(e) => onChange(l.key, { mode: e.target.value as "margin" | "count" })} aria-label="What to show">
                        <option value="margin">Best signal margin</option>
                        <option value="count">Nodes covering</option>
                      </select>
                    ) : null}
                  </div>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>

      {layers.some((l) => l.result && l.mode === "margin") ? (
        <div className="legend-row">
          {LEGEND.map((e) => (
            <span key={e.label}>
              <i style={{ background: e.color }} />
              {e.label}
            </span>
          ))}
        </div>
      ) : null}
      {layers.some((l) => l.result && l.mode === "count") ? (
        <div className="legend-row">
          <span><i style={{ background: "rgb(254,224,139)" }} />1 node</span>
          <span><i style={{ background: "rgb(145,207,96)" }} />2 nodes</span>
          <span><i style={{ background: "rgb(26,152,80)" }} />3+ nodes</span>
        </div>
      ) : null}
      <p className="hint">
        Margin = predicted signal at a client device minus the receiver sensitivity (Longley-Rice, with trees and buildings as set in the terrain model; grey hatching marks places with no tree or building data, predicted over bare earth). Nothing is drawn where the margin is below 0 dB. An estimate, like everything here.
      </p>
    </Card>
  );
}
