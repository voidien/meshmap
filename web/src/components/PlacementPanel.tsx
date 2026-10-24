import { useState } from "react";
import { Card } from "./Card";
import { NumberField } from "../ui/NumberField";
import { DEFAULT_BACKHAUL, describeStop, type Area, type PlacementJob, type PlacementOptions, type Suggestion } from "../placement";
import type { MeshNode } from "../types";

interface Props {
  nodes: MeshNode[];
  area: Area | null;
  onArea: (a: Area | null) => void;
  picking: boolean;
  onPick: (on: boolean) => void;
  options: PlacementOptions;
  onOptions: (o: PlacementOptions) => void;
  /** hops the network usually needs at most (used when the person has not set one) */
  defaultHopLimit: number;
  /** The project's "usable link" threshold, shared with mesh health (Settings → Link quality). */
  usableMarginDb: number;
  onUsableMargin: (v: number) => void;
  templateId: string;
  onTemplate: (id: string) => void;
  job: PlacementJob | null;
  error: string | null;
  running: boolean;
  readOnly: boolean;
  hasStale: boolean;
  onRun: () => void;
  onCancel: () => void;
  onClear: () => void;
  onZoom: (s: Suggestion) => void;
  onAdd: (s: Suggestion) => void;
}

const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : fallback);
const f1 = (v: number) => v.toFixed(1);

/** Suggest where new nodes would add the most coverage, and why. */
export function PlacementPanel(p: Props) {
  const [advanced, setAdvanced] = useState(false);
  const o = p.options;
  const set = (patch: Partial<PlacementOptions>) => p.onOptions({ ...o, ...patch });
  const r = p.job?.state === "done" ? p.job.result : null;
  const gateways = p.nodes.filter((n) => n.gateway).length;
  return (
    <Card id="placement" domId="placement-panel" title="Suggest new sites">
      <label className="field wide">
        <span>Goal</span>
        <select
          id="placement-goal"
          value={o.goal}
          onChange={(e) => {
            const goal = e.target.value as PlacementOptions["goal"];
            set({ goal, ...(goal === "redundancy" && !o.backhaul ? { backhaul: { ...DEFAULT_BACKHAUL } } : {}) });
          }}
        >
          <option value="coverage">Cover more area</option>
          <option value="redundancy">Strengthen the network (remove single points of failure)</option>
        </select>
      </label>
      {o.goal === "redundancy" ? (
        <p className="hint">Finds high ground in the area and picks the sites that make your network sturdier: ones that link two parts of it, so losing one node or link no longer cuts nodes off. Uses the link rules below to decide what counts as a link, and needs at least two nodes.</p>
      ) : (
        <p className="hint">Finds high ground in an area and picks the sites that newly cover the most of it, one after another, counting what your nodes already cover.</p>
      )}

      <div className="btnrow">
        <button className={p.picking ? "on" : ""} onClick={() => p.onPick(!p.picking)}>
          {p.picking ? "Click the map…" : p.area ? "Move area" : "Pick area on map"}
        </button>
        {p.nodes.length ? (
          <button
            onClick={() => {
              const lat = p.nodes.reduce((s, n) => s + n.lat, 0) / p.nodes.length;
              const lon = p.nodes.reduce((s, n) => s + n.lon, 0) / p.nodes.length;
              p.onArea({ lat, lon, radiusKm: p.area?.radiusKm ?? 20 });
            }}
          >
            Around my nodes
          </button>
        ) : null}
        {p.area ? <button onClick={() => p.onArea(null)}>Clear</button> : null}
      </div>
      {p.area ? (
        <div className="grid2">
          <label className="field">
            <span>Area radius (km)</span>
            <input type="number" min={1} max={50} step={1} value={p.area.radiusKm} onChange={(e) => p.onArea({ ...p.area!, radiusKm: Math.min(50, Math.max(1, num(e.target.value, 20))) })} />
          </label>
          <label className="field">
            <span>New sites</span>
            <input type="number" min={1} max={10} step={1} value={o.count} onChange={(e) => set({ count: Math.min(10, Math.max(1, Math.round(num(e.target.value, 3)))) })} />
          </label>
          <label className="field wide">
            <span>New nodes are like</span>
            <select value={p.templateId} onChange={(e) => p.onTemplate(e.target.value)}>
              <option value="">Defaults (10 m mast, 22 dBm, 3 dBi, the project's default radio)</option>
              {p.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name.trim() || "Node"} ({n.heightM} m, {n.txDbm} dBm)
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <p className="hint">Pick the area you want covered: click the map, or use the middle of your nodes.</p>
      )}

      {o.goal === "redundancy" ? (
        gateways > 0 ? (
          <div className="grid2">
            <p className="hint wide">
              {gateways} gateway{gateways === 1 ? "" : "s"} marked (Mesh health card). The network is what reaches a gateway, losing a lone gateway counts as a weak spot, and nodes beyond the hop limit count as weak.
            </p>
            <label className="field">
              <span>Hop limit</span>
              <input id="placement-hops" type="number" min={1} max={30} step={1} value={o.hopLimit > 0 ? o.hopLimit : p.defaultHopLimit} onChange={(e) => set({ hopLimit: Math.min(30, Math.max(1, Math.round(num(e.target.value, p.defaultHopLimit)))) })} />
            </label>
          </div>
        ) : (
          <p className="hint">No gateway is marked, so the network is the largest connected group. Mark nodes that connect to the outside as gateways (Mesh health card) to also count gateway loss and hops.</p>
        )
      ) : null}
      <label className="check">
        <input type="checkbox" checked={o.backhaul !== null} disabled={o.goal === "redundancy"} onChange={(e) => set({ backhaul: e.target.checked ? { ...DEFAULT_BACKHAUL } : null })} />
        {o.goal === "redundancy" ? "Link rules (what counts as a link)" : "Each new site must link back to the network"}
      </label>
      {o.backhaul ? (
        <>
        <label className="check">
          <input type="checkbox" checked={o.backhaul.avoidObstructed} onChange={(e) => set({ backhaul: { ...o.backhaul!, avoidObstructed: e.target.checked } })} />
          Ignore blocked paths (a link must have a clear enough line of sight, not just enough margin)
        </label>
        {o.goal === "redundancy" ? null : <label className="check">
          <input type="checkbox" checked={o.backhaul.connectSuggestions} onChange={(e) => set({ backhaul: { ...o.backhaul!, connectSuggestions: e.target.checked } })} />
          Link the new sites to each other (each one after the first must reach an earlier suggestion)
        </label>}
        <div className="grid2">
          <label className="field">
            <span>Minimum link margin (dB)</span>
            <NumberField value={p.usableMarginDb} step={1} min={-20} max={60} onCommit={p.onUsableMargin} />
          </label>
          <label className="field">
            <span>Longest link (km)</span>
            <input type="number" min={1} max={100} step={1} value={o.backhaul.maxKm} onChange={(e) => set({ backhaul: { ...o.backhaul!, maxKm: Math.min(100, Math.max(1, num(e.target.value, 30))) } })} />
          </label>
        </div>
        </>
      ) : null}
      <button className="linkbtn" onClick={() => setAdvanced((v) => !v)}>
        {advanced ? "Hide options" : "More options"}
      </button>
      {advanced ? (
        <div className="grid2">
          <label className="field">
            <span>Coverage radius per site (km)</span>
            <input type="number" min={3} max={30} step={1} value={o.coverageRadiusKm} onChange={(e) => set({ coverageRadiusKm: Math.min(30, Math.max(3, num(e.target.value, 15))) })} />
          </label>
          <label className="field">
            <span>Sites at least apart (km)</span>
            <input type="number" min={0.5} max={50} step={0.5} value={o.minSpacingKm} onChange={(e) => set({ minSpacingKm: Math.min(50, Math.max(0.5, num(e.target.value, 3))) })} />
          </label>
          <label className="field">
            <span>Minimum high-ground relief (m)</span>
            <input type="number" min={0} max={2000} step={5} value={o.minReliefM} onChange={(e) => set({ minReliefM: Math.max(0, num(e.target.value, 30)) })} />
          </label>
          <label className="field">
            <span>Ignore sites adding under (km²)</span>
            <input type="number" min={0} step={1} value={o.minGainKm2} onChange={(e) => set({ minGainKm2: Math.max(0, num(e.target.value, 1)) })} />
          </label>
        </div>
      ) : null}

      <div className="btnrow">
        <button className="on" id="placement-run" disabled={!p.area || p.running || (o.goal === "redundancy" && p.nodes.length < 2)} onClick={p.onRun}>
          Suggest sites
        </button>
        {p.running ? <button onClick={p.onCancel}>Cancel</button> : null}
        {p.job && !p.running ? <button onClick={p.onClear}>Remove results</button> : null}
      </div>

      {p.running && p.job ? (
        <>
          <div className="bar" role="progressbar" aria-valuenow={Math.round(p.job.progress * 100)}>
            <i style={{ width: `${Math.round(p.job.progress * 100)}%` }} />
          </div>
          <div className="lmeta">{p.job.message}</div>
        </>
      ) : null}
      {p.error ? <div className="err">{p.error}</div> : null}
      {p.job?.state === "failed" ? <div className="err">{p.job.error ?? "Failed"}</div> : null}
      {p.job?.state === "cancelled" ? <div className="lmeta">Cancelled</div> : null}

      {r ? (
        <div className="suggestions">
          {p.hasStale ? <div className="lmeta warn">Out of date: nodes or settings changed since these were computed.</div> : null}
          <div className="lmeta">
            {r.goal === "redundancy" ? `${r.candidates} high points considered` : `${f1(r.targetKm2)} km² target · ${r.baselinePct < 0.05 ? "nothing covered yet" : `${f1(r.baselinePct)} % already covered`} · ${r.candidates} high points considered`}
            {r.terrain !== "bare" && typeof r.clutterShare === "number" ? ` · ${Math.round(r.clutterShare * 100)} % has clutter data` : ""}
          </div>
          {describeStop(r) ? <div className="lmeta">{describeStop(r)}</div> : null}
          <ol className="sites">
            {r.suggestions.map((s) => (
              <li key={s.rank}>
                <div className="lrow">
                  <b className="rank">{s.rank}</b>
                  {s.redundancy ? (
                    <span>
                      {s.redundancy.fixed.length ? `Takes the strain off ${s.redundancy.fixed.join(", ")}` : "Adds a second route"} (weakness score {s.redundancy.weaknessBefore} → {s.redundancy.weaknessAfter}, lower is stronger
                      {s.redundancy.beyondHopLimitBefore ? `; nodes beyond the hop limit ${s.redundancy.beyondHopLimitBefore} → ${s.redundancy.beyondHopLimitAfter ?? 0}` : ""})
                    </span>
                  ) : (
                    <span>
                      +{f1(s.newKm2)} km² ({f1(s.newPct)} % of the area) → {f1(s.cumulativePct)} % covered
                    </span>
                  )}
                </div>
                <div className="lmeta">
                  {s.lat.toFixed(5)}, {s.lon.toFixed(5)} · {Math.round(s.elevM)} m elevation, {Math.round(s.reliefM)} m above its surroundings{s.redundancy ? "" : ` · covers ${f1(s.soloKm2)} km² on its own`}
                </div>
                {s.backhaul.length ? (
                  <ul className="lmeta backhaul">
                    {s.backhaul.map((b, i) => (
                      <li key={i}>
                        links to {b.name}: {f1(b.distanceKm)} km, {b.marginDb >= 0 ? "+" : ""}
                        {f1(b.marginDb)} dB margin, {Math.round(b.clearancePct)} % Fresnel clear ({b.class})
                      </li>
                    ))}
                  </ul>
                ) : s.backhaulChecked ? (
                  <div className="lmeta">no link to the network was checked</div>
                ) : null}
                <div className="btnrow">
                  <button onClick={() => p.onZoom(s)}>Zoom to</button>
                  <button disabled={p.readOnly} onClick={() => p.onAdd(s)}>
                    Add as node
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </Card>
  );
}
