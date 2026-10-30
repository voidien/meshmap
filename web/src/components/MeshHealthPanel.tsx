import { useMemo } from "react";
import { Card } from "./Card";
import { NumberField } from "../ui/NumberField";
import type { Health, FailureImpact } from "../meshHealth";
import { NETWORKS, type Network } from "../networks";
import type { MeshNode } from "../types";

export interface HealthOptions {
  hopLimit: number;
  highlight: boolean;
  failedId: string;
}

interface Props {
  nodes: MeshNode[];
  network: Network;
  health: Health;
  /** no links worked out yet: the counts would all say "isolated" */
  analysing?: boolean;
  failure: FailureImpact | null;
  options: HealthOptions;
  onOptions: (o: HealthOptions) => void;
  /** The project's "usable link" threshold (Settings → Link quality); edited here too. */
  usableMarginDb: number;
  onUsableMargin: (v: number) => void;
  readOnly: boolean;
  onFocus: (id: string) => void;
  onLink: (a: string, b: string) => void;
  onGateway: (id: string, on: boolean) => void;
}

const num = (v: string, d: number) => (v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

/** Which nodes and links hold the network together, and what happens when one fails. */
export function MeshHealthPanel({ nodes, network, health: h, analysing = false, failure, options: o, onOptions, usableMarginDb, onUsableMargin, readOnly, onFocus, onLink, onGateway }: Props) {
  const name = useMemo(() => new Map(nodes.map((n) => [n.id, n.name.trim() || "(unnamed)"])), [nodes]);
  const nm = (id: string) => name.get(id) ?? "?";
  const set = (patch: Partial<HealthOptions>) => onOptions({ ...o, ...patch });
  const gateways = nodes.filter((n) => n.gateway);
  const names = (ids: string[], max = 6) => (ids.length <= max ? ids.map(nm).join(", ") : `${ids.slice(0, max).map(nm).join(", ")} and ${ids.length - max} more`);
  const connected = h.reach.size;
  const tile = (label: string, value: number | string, bad: boolean) => (
    <div className={bad ? "bad" : "ok"}>
      <b>{value}</b>
      <span className="lmeta">{label}</span>
    </div>
  );

  if (analysing && nodes.length >= 2) {
    return (
      <Card id="health" domId="mesh-health" title="Mesh health">
        <p className="hint" role="status">Analysing…</p>
      </Card>
    );
  }
  return (
    <Card id="health" domId="mesh-health" title="Mesh health">
      {nodes.length < 2 ? (
        <p className="hint">Add at least two nodes to see how well they hold together.</p>
      ) : (
        <>
          <p className="hint">
            Uses the links that meet the margin below in both directions. {h.fromGateways ? `Connected means able to reach a gateway.` : "No gateway is marked, so connected means part of the largest group."}
          </p>
          <div className="grid2">
            <label className="field">
              <span title="The same figure as Settings → Link quality → usable">Link counts if margin ≥ (dB)</span>
              <NumberField value={usableMarginDb} step={1} min={-20} max={60} onCommit={onUsableMargin} />
            </label>
            <label className="field">
              <span title={NETWORKS[network].hopNote}>Hops to plan for</span>
              <input type="number" min={1} max={64} step={1} value={o.hopLimit} onChange={(e) => set({ hopLimit: Math.min(64, Math.max(1, Math.round(num(e.target.value, NETWORKS[network].hopLimit)))) })} />
            </label>
          </div>
          <p className="hint tight">{NETWORKS[network].hopNote}.</p>
          <label className="check">
            <input type="checkbox" checked={o.highlight} onChange={(e) => set({ highlight: e.target.checked })} />
            Mark problems on the map (red halo = single point of failure, dashed purple = beyond hop limit, pink = cut off, square = gateway)
          </label>

          <div className="health-sum">
            {tile("connected", `${connected}/${nodes.length}`, connected < nodes.length)}
            {tile("separate groups", h.groups.length, h.groups.length > 1)}
            {tile("single points of failure", h.spofs.length, h.spofs.length > 0)}
            {tile("links that are the only way", h.bridges.length, h.bridges.length > 0)}
            {h.fromGateways ? tile(`beyond ${o.hopLimit} hops`, h.beyondHopLimit.length, h.beyondHopLimit.length > 0) : tile("nodes with one link", h.singleLinked.length, h.singleLinked.length > 0)}
            {h.fromGateways ? tile("cannot reach a gateway", h.noGateway.length, h.noGateway.length > 0) : tile("isolated nodes", h.isolated.length, h.isolated.length > 0)}
          </div>

          <h4 className="subhead">Gateways ({gateways.length})</h4>
          {gateways.length === 0 ? <p className="hint">None chosen. Mark the nodes that connect to the internet or MQTT to see hop counts and whether everything can reach one.</p> : null}
          <ul className="hlist">
            {gateways.map((g) => (
              <li key={g.id} onClick={() => onFocus(g.id)}>
                <b>{nm(g.id)}</b>
                {h.maxHops !== null ? <span className="lmeta"> · farthest node is {h.maxHops} hop{h.maxHops === 1 ? "" : "s"} away</span> : null}
                {!readOnly ? (
                  <button className="linkbtn" onClick={(e) => { e.stopPropagation(); onGateway(g.id, false); }}>
                    {" "}remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {!readOnly ? (
            <label className="field">
              <span>Add a gateway</span>
              <select value="" onChange={(e) => e.target.value && onGateway(e.target.value, true)}>
                <option value="">choose a node…</option>
                {nodes.filter((n) => !n.gateway).map((n) => (
                  <option key={n.id} value={n.id}>{nm(n.id)}</option>
                ))}
              </select>
            </label>
          ) : null}

          {h.groups.length > 1 ? (
            <>
              <h4 className="subhead">Separate groups</h4>
              <ul className="hlist">
                {h.groups.map((g, i) => (
                  <li key={i} onClick={() => onFocus(g[0])}>
                    <b>{g.length === 1 ? "Alone" : `${g.length} nodes`}</b>: <span className="lmeta">{names(g)}</span>
                    {i === 0 ? <span className="lmeta"> (largest)</span> : null}
                  </li>
                ))}
              </ul>
              <p className="hint">Nodes in different groups cannot hear each other at the chosen margin. A site between the groups would join them (try “Suggest new sites” with the link-back requirement).</p>
            </>
          ) : null}

          {h.noGateway.length > 0 ? (
            <>
              <h4 className="subhead">Cannot reach a gateway</h4>
              <p className="lmeta">{names(h.noGateway, 12)}</p>
            </>
          ) : null}
          {h.beyondHopLimit.length > 0 ? (
            <>
              <h4 className="subhead">More than {o.hopLimit} hops from a gateway</h4>
              <ul className="hlist">
                {h.beyondHopLimit.map((id) => (
                  <li key={id} onClick={() => onFocus(id)}>
                    <b>{nm(id)}</b> <span className="lmeta">{h.hops!.get(id)} hops</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <h4 className="subhead">Single points of failure ({h.spofs.length})</h4>
          {h.spofs.length === 0 ? <p className="hint">Losing any one node does not cut another off. </p> : null}
          <ul className="hlist">
            {h.spofs.map((s) => (
              <li key={s.id} onClick={() => set({ failedId: s.id })} title="Click to simulate losing it">
                <b>{nm(s.id)}</b> <span className="lmeta">cuts off {s.cutOff.length}: {names(s.cutOff, 4)}</span>
              </li>
            ))}
          </ul>

          {h.bridges.length > 0 ? (
            <>
              <h4 className="subhead">Links that are the only way ({h.bridges.length})</h4>
              <ul className="hlist">
                {h.bridges.slice(0, 12).map((b) => (
                  <li key={`${b.a}|${b.b}`} onClick={() => onLink(b.a, b.b)}>
                    <b>{nm(b.a)} – {nm(b.b)}</b> <span className="lmeta">margin {b.marginDb.toFixed(1)} dB · loses {b.cutOff.length} node{b.cutOff.length === 1 ? "" : "s"} if it fails</span>
                  </li>
                ))}
              </ul>
              <p className="hint">Adding a node that can hear both ends, or raising an antenna on a weak link, gives these a second route.</p>
            </>
          ) : null}

          <h4 className="subhead">What if a node fails?</h4>
          <div className="btnrow">
            <select value={o.failedId} onChange={(e) => set({ failedId: e.target.value })} aria-label="Node to remove">
              <option value="">choose a node…</option>
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>{nm(n.id)}</option>
              ))}
            </select>
            {o.failedId ? <button onClick={() => set({ failedId: "" })}>Restore</button> : null}
          </div>
          {failure ? (
            <div className="banner" id="failure-result">
              Without <b>{nm(failure.failedId)}</b>:{" "}
              {failure.cutOff.length === 0 ? "everyone else stays connected" : <><b>{failure.cutOff.length}</b> node{failure.cutOff.length === 1 ? "" : "s"} lose{failure.cutOff.length === 1 ? "s" : ""} their connection ({names(failure.cutOff, 8)})</>}
              {failure.nowBeyondHopLimit.length > 0 ? `; ${failure.nowBeyondHopLimit.length} more end up beyond the hop limit (${names(failure.nowBeyondHopLimit, 6)})` : ""}.
              {failure.groupsAfter > failure.groupsBefore ? ` The mesh splits into ${failure.groupsAfter} groups.` : ""}
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
