import type { Settings } from "../types";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

function Row(props: { label: string; value: number; step: number; min: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        value={props.value}
        step={props.step}
        min={props.min}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v >= props.min) props.onChange(v);
        }}
      />
    </label>
  );
}

export function SettingsPanel({ settings: s, onChange }: Props) {
  return (
    <details className="card">
      <summary>Project settings &amp; assumptions</summary>
      <div className="grid2">
        <Row label="Frequency (MHz)" value={s.freqMhz} step={1} min={100} onChange={(v) => onChange({ freqMhz: v })} />
        <Row label="k-factor" value={Number(s.k.toFixed(3))} step={0.05} min={0.5} onChange={(v) => onChange({ k: v })} />
        <Row label="Max link range (km)" value={s.maxRangeKm} step={5} min={1} onChange={(v) => onChange({ maxRangeKm: v })} />
        <Row label="Marginal below (dB margin)" value={s.marginalMarginDb} step={1} min={0} onChange={(v) => onChange({ marginalMarginDb: v })} />
        <Row label="Receiver noise figure (dB)" value={s.noiseFigureDb} step={0.5} min={0} onChange={(v) => onChange({ noiseFigureDb: v })} />
      </div>
      <label className="check">
        <input type="checkbox" checked={s.showNone} onChange={(e) => onChange({ showNone: e.target.checked })} />
        Show out-of-range ("none") links
      </label>
      <p className="hint">
        <strong>All results are rough estimates.</strong> Bare-earth terrain only (no trees or buildings) from public ~30&nbsp;m
        Terrarium tiles. Path loss = free space + single knife-edge diffraction on the worst obstruction (not Longley-Rice yet).
        Margin = received power − receiver sensitivity (thermal noise + noise figure + SNR limit for the preset). Link class uses
        the worse of the two directions: <em>clear</em> ≥60&nbsp;% first-Fresnel clearance and margin ≥ threshold;{" "}
        <em>marginal</em> otherwise but margin ≥ 0; <em>obstructed</em> ray blocked or margin &lt; 0; <em>none</em> out of range even in free
        space or mismatched presets.
      </p>
    </details>
  );
}
