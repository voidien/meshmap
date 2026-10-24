import { fitsNetwork, NETWORK_LIST, NETWORKS, type Network } from "../networks";
import type { MeshNode, NodeDefaults, Settings, TerrainMode } from "../types";
import { FACTORY_NODE_DEFAULTS } from "../workspace";
import { useState, type ReactNode } from "react";
import { Card } from "./Card";
import { Modal } from "../ui/Modal";
import { NumberField } from "../ui/NumberField";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  nodes: MeshNode[];
  /** Give every node that does not fit the network its default radio settings. */
  onApplyRadio: () => void;
  readOnly: boolean;
}

const CLIMATES: [number, string][] = [
  [1, "Equatorial"],
  [2, "Continental subtropical"],
  [3, "Maritime subtropical"],
  [4, "Desert"],
  [5, "Continental temperate"],
  [6, "Maritime temperate, over land"],
  [7, "Maritime temperate, over sea"],
];

/** Typical ground constants (ITU-R P.527 / the ITM documentation). */
const GROUNDS: { id: string; name: string; eps: number; sigma: number }[] = [
  { id: "average", name: "Average ground", eps: 15, sigma: 0.005 },
  { id: "poor", name: "Poor ground (dry, rocky)", eps: 4, sigma: 0.001 },
  { id: "good", name: "Good ground (moist)", eps: 25, sigma: 0.02 },
  { id: "fresh", name: "Fresh water", eps: 81, sigma: 0.01 },
  { id: "sea", name: "Sea water", eps: 81, sigma: 5 },
];

function Row(props: { label: string; value: number; step: number; min: number; max?: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <NumberField value={props.value} step={props.step} min={props.min} max={props.max} onCommit={props.onChange} />
    </label>
  );
}

export interface SettingsSection {
  id: string;
  title: string;
  node: ReactNode;
}

function sectionsOf({ settings: s, onChange, nodes, onApplyRadio, readOnly }: Props): SettingsSection[] {
  const nd = s.nodeDefaults ?? FACTORY_NODE_DEFAULTS;
  const setNd = (patch: Partial<NodeDefaults>) => onChange({ nodeDefaults: { ...nd, ...patch } });
  const ground = GROUNDS.find((g) => g.eps === s.groundEpsilon && g.sigma === s.groundSigma)?.id ?? "custom";
  return [
    {
      id: "network",
      title: "Network & radio",
      node: (
        <>
      <label className="field">
        <span>Planning for</span>
        <select
          id="network-select"
          value={s.network}
          onChange={(e) => {
            const network = e.target.value as Network;
            onChange({ network, freqMhz: NETWORKS[network].freqMhz });
          }}
        >
          {NETWORK_LIST.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">{NETWORKS[s.network].note}</p>
      {(() => {
        const other = nodes.filter((n) => !fitsNetwork(n.presetId, s.network));
        return other.length > 0 ? (
          <button className="on" id="apply-radio" disabled={readOnly} onClick={onApplyRadio}>
            Set {other.length} node{other.length === 1 ? "" : "s"} to the {NETWORKS[s.network].label} default radio
          </button>
        ) : null;
      })()}
          <div className="grid2">
            <Row label="Frequency (MHz)" value={s.freqMhz} step={1} min={20} max={20000} onChange={(v) => onChange({ freqMhz: v })} />
            <Row label="Receiver noise figure (dB)" value={s.noiseFigureDb} step={0.5} min={0} onChange={(v) => onChange({ noiseFigureDb: v })} />
          </div>
      <p className="hint">What a node starts with when you place it on the map (the radio comes from the network above).</p>
      <fieldset className="plain" disabled={readOnly}>
        <div className="grid2">
          <Row label="Antenna height (m above ground)" value={nd.heightM} step={1} min={0} max={500} onChange={(v) => setNd({ heightM: v })} />
          <Row label="Receiving device height (m)" value={nd.clientHeightM} step={0.5} min={0} max={100} onChange={(v) => setNd({ clientHeightM: v })} />
          <Row label="TX power (dBm)" value={nd.txDbm} step={1} min={-10} max={36} onChange={(v) => setNd({ txDbm: v })} />
          <Row label="Antenna gain (dBi)" value={nd.gainDbi} step={0.5} min={-10} max={40} onChange={(v) => setNd({ gainDbi: v })} />
          <Row label="Cable loss (dB)" value={nd.cableLossDb} step={0.1} min={0} max={30} onChange={(v) => setNd({ cableLossDb: v })} />
        </div>
        {s.nodeDefaults ? (
          <button onClick={() => onChange({ nodeDefaults: undefined })}>Back to factory defaults</button>
        ) : null}
      </fieldset>

        </>
      ),
    },
    {
      id: "quality",
      title: "Link quality",
      node: (
        <>
          <p className="hint">One set of thresholds, used for link colours, mesh health and suggested sites. Spare signal (margin) is received power minus receiver sensitivity, in the worse direction.</p>
          <div className="grid2">
            <Row label="Good link: spare signal at least (dB)" value={s.marginalMarginDb} step={1} min={0} onChange={(v) => onChange({ marginalMarginDb: v })} />
            <Row label="Usable link: spare signal at least (dB)" value={s.usableMarginDb} step={1} min={-20} max={60} onChange={(v) => onChange({ usableMarginDb: v })} />
            <Row label="Look for links up to (km)" value={s.maxRangeKm} step={5} min={1} onChange={(v) => onChange({ maxRangeKm: v })} />
          </div>
          <p className="hint tight">Below the <em>good</em> figure a link is drawn as marginal; from the <em>usable</em> figure a link counts as connected in mesh health and when placing new sites; below 0 dB it fails.</p>
          <label className="check">
            <input type="checkbox" checked={s.showNone} onChange={(e) => onChange({ showNone: e.target.checked })} />
            Show out-of-range ("none") links
          </label>
        </>
      ),
    },
    {
      id: "terrain",
      title: "Terrain & trees",
      node: (
        <>
      <label className="field">
        <span>Ground used for links and heatmaps</span>
        <select id="terrain-select" value={s.terrainMode} onChange={(e) => onChange({ terrainMode: e.target.value as TerrainMode })}>
          <option value="foliage">Bare earth + foliage loss through trees (recommended)</option>
          <option value="clutter">Trees and buildings as solid obstacles</option>
          <option value="bare">Bare earth only</option>
        </select>
      </label>
      {s.terrainMode === "foliage" ? (
        <div className="grid2">
          <label className="field">
            <span>Trees</span>
            <select value={s.foliageLeafOn ? "on" : "off"} onChange={(e) => onChange({ foliageLeafOn: e.target.value === "on" })}>
              <option value="on">In leaf</option>
              <option value="off">Bare (leaves off)</option>
            </select>
          </label>
          <Row label="Foliage loss scale (1 = published model)" value={s.foliageScale} step={0.1} min={0} max={10} onChange={(v) => onChange({ foliageScale: v })} />
        </div>
      ) : null}
      <p className="hint">
        {s.terrainMode === "foliage"
          ? "Trees do not block the path; instead the part of the straight path that runs inside trees loses signal (Weissberger's model: about 6 dB for the first 14 m, about 20 dB through 100 m in leaf, at 915 MHz). It is an average with a large spread: measure your own and set the scale (Calibrate foliage, below)."
          : s.terrainMode === "clutter"
            ? "Trees and buildings act like a solid ridge: a path whose ray runs below the treetops is treated as blocked. There is no foliage attenuation."
            : "Trees and buildings are ignored."}{" "}
        Clutter comes from terrain data packs installed on the server (see Help). Where none covers a path, bare earth is used and the profile says so. Open a link's profile to see the models side by side.
      </p>
        </>
      ),
    },
    {
      id: "propagation",
      title: "Propagation (advanced)",
      node: (
        <>
          <div className="btnrow">
            <button disabled={readOnly} className={s.reliabilityPct === 50 && s.confidencePct === 50 ? "on" : ""} onClick={() => onChange({ reliabilityPct: 50, confidencePct: 50 })} title="The median prediction">
              Quick estimate (50 / 50)
            </button>
            <button disabled={readOnly} className={s.reliabilityPct === 90 && s.confidencePct === 90 ? "on" : ""} onClick={() => onChange({ reliabilityPct: 90, confidencePct: 90 })} title="A design margin: links need a stronger signal">
              Design margin (90 / 90)
            </button>
          </div>
          <div className="grid2">
            <Row label="k-factor (clearance)" value={Number(s.k.toFixed(3))} step={0.05} min={0.5} onChange={(v) => onChange({ k: v })} />
          </div>
      <label className="field">
        <span>Radio climate</span>
        <select value={s.itmClimate} onChange={(e) => onChange({ itmClimate: Number(e.target.value) })}>
          {CLIMATES.map(([id, name]) => (
            <option key={id} value={id}>
              {id} · {name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Ground</span>
        <select
          value={ground}
          onChange={(e) => {
            const g = GROUNDS.find((x) => x.id === e.target.value);
            if (g) onChange({ groundEpsilon: g.eps, groundSigma: g.sigma });
          }}
        >
          {GROUNDS.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} (ε {g.eps}, σ {g.sigma})
            </option>
          ))}
          {ground === "custom" ? <option value="custom">Custom (ε {s.groundEpsilon}, σ {s.groundSigma})</option> : null}
        </select>
      </label>
      <div className="grid2">
        <Row label="Surface refractivity N₀" value={s.itmN0} step={1} min={250} max={400} onChange={(v) => onChange({ itmN0: v })} />
        <label className="field">
          <span>Polarization</span>
          <select value={s.verticalPolarization ? "v" : "h"} onChange={(e) => onChange({ verticalPolarization: e.target.value === "v" })}>
            <option value="v">Vertical (typical LoRa antennas)</option>
            <option value="h">Horizontal</option>
          </select>
        </label>
        <Row label="Reliability % (time)" value={s.reliabilityPct} step={1} min={1} max={99} onChange={(v) => onChange({ reliabilityPct: v })} />
        <Row label="Confidence % (situation)" value={s.confidencePct} step={1} min={1} max={99} onChange={(v) => onChange({ confidencePct: v })} />
      </div>
        </>
      ),
    },
    {
      id: "heatmaps",
      title: "Coverage heatmaps",
      node: (
        <>
      <div className="grid2">
        <Row label="Radius (km, 1-100)" value={s.coverageRadiusKm} step={5} min={1} max={100} onChange={(v) => onChange({ coverageRadiusKm: v })} />
        <label className="field">
          <span>Resolution</span>
          <select value={s.coverageResolutionM} onChange={(e) => onChange({ coverageResolutionM: Number(e.target.value) })}>
            {[60, 100, 150, 250, 500].map((m) => (
              <option key={m} value={m}>
                {m} m cells
              </option>
            ))}
          </select>
        </label>
        <Row label="Client antenna gain (dBi)" value={s.clientGainDbi} step={0.5} min={-10} max={20} onChange={(v) => onChange({ clientGainDbi: v })} />
        <Row label="Client cable loss (dB)" value={s.clientCableLossDb} step={0.5} min={0} max={20} onChange={(v) => onChange({ clientCableLossDb: v })} />
      </div>
      <p className="hint">The client device's height is each node's “Client height” field.</p>

        </>
      ),
    },
  ];
}

const ABOUT = (
  <>
      <p className="hint">
        50 / 50 is the median prediction. 90 / 90 is a design margin: the loss is only that high or lower 90 % of the time, with 90 %
        confidence in the model, so links need a stronger signal.
      </p>

      <p className="hint">
        <strong>All results are estimates.</strong> Path loss is Longley-Rice (ITM, point-to-point, validated against the NTIA reference code)
        over bare-earth terrain from public ~30&nbsp;m Terrarium tiles. It does not see trees or buildings. If ITM cannot run (for example a
        path under a few samples) the link falls back to free space + single knife-edge diffraction and says so. Margin = received power −
        receiver sensitivity (thermal noise + noise figure + SNR limit for the preset). Link class uses the worse of the two directions:{" "}
        <em>clear</em> ≥60&nbsp;% first-Fresnel clearance and margin ≥ threshold; <em>marginal</em> otherwise but margin ≥ 0;{" "}
        <em>obstructed</em> ray blocked or margin &lt; 0; <em>none</em> out of range even in free space or mismatched presets.
      </p>
  </>
);

/** The settings as a collapsible card in the sidebar (classic layout). */
export function SettingsPanel(props: Props) {
  return (
    <Card id="settings" title="Project settings & assumptions">
      {sectionsOf(props).map((sec) => (
        <div key={sec.id}>
          <h4 className="subhead">{sec.title}</h4>
          {sec.node}
        </div>
      ))}
      {ABOUT}
    </Card>
  );
}

/** The settings as a dialog with a section list on the left (new layout). */
export function SettingsDialog(props: Props & { onClose: () => void; initial?: string }) {
  const secs = sectionsOf(props);
  const [current, setCurrent] = useState(secs.find((x) => x.id === props.initial)?.id ?? secs[0].id);
  const sec = secs.find((x) => x.id === current) ?? secs[0];
  return (
    <Modal onClose={props.onClose} label="Project settings" className="settings-dialog">
      <div className="modal-head">
        <h2>Project settings</h2>
        <button onClick={props.onClose}>Close</button>
      </div>
      <p className="hint">These apply to everyone who works on this project, and change every result.</p>
      <div className="settings-layout">
        <nav aria-label="Settings sections">
          {secs.map((x) => (
            <button key={x.id} className={x.id === current ? "on" : ""} aria-current={x.id === current} onClick={() => setCurrent(x.id)}>
              {x.title}
            </button>
          ))}
        </nav>
        <div className="settings-page">
          <h3>{sec.title}</h3>
          <fieldset className="plain" disabled={props.readOnly}>
            {sec.node}
          </fieldset>
          {sec.id === "quality" || sec.id === "propagation" ? ABOUT : null}
        </div>
      </div>
    </Modal>
  );
}
