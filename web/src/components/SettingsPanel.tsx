import type { Settings } from "../types";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
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
      <input
        type="number"
        value={props.value}
        step={props.step}
        min={props.min}
        max={props.max}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v >= props.min && (props.max === undefined || v <= props.max)) props.onChange(v);
        }}
      />
    </label>
  );
}

export function SettingsPanel({ settings: s, onChange }: Props) {
  const ground = GROUNDS.find((g) => g.eps === s.groundEpsilon && g.sigma === s.groundSigma)?.id ?? "custom";
  return (
    <details className="card">
      <summary>Project settings &amp; assumptions</summary>
      <div className="grid2">
        <Row label="Frequency (MHz)" value={s.freqMhz} step={1} min={20} max={20000} onChange={(v) => onChange({ freqMhz: v })} />
        <Row label="k-factor (clearance)" value={Number(s.k.toFixed(3))} step={0.05} min={0.5} onChange={(v) => onChange({ k: v })} />
        <Row label="Max link range (km)" value={s.maxRangeKm} step={5} min={1} onChange={(v) => onChange({ maxRangeKm: v })} />
        <Row label="Marginal below (dB margin)" value={s.marginalMarginDb} step={1} min={0} onChange={(v) => onChange({ marginalMarginDb: v })} />
        <Row label="Receiver noise figure (dB)" value={s.noiseFigureDb} step={0.5} min={0} onChange={(v) => onChange({ noiseFigureDb: v })} />
      </div>
      <label className="check">
        <input type="checkbox" checked={s.showNone} onChange={(e) => onChange({ showNone: e.target.checked })} />
        Show out-of-range ("none") links
      </label>

      <h4 className="subhead">Longley-Rice (ITM) environment</h4>
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
    </details>
  );
}
