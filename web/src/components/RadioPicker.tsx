import { useMemo } from "react";
import { presetById } from "../engine/analysis";
import { getPresets } from "../engine/wasm";
import { familyOfPreset, NETWORKS, type Network } from "../networks";

const BANDWIDTHS = [7.8, 10.4, 15.6, 20.8, 31.25, 41.7, 62.5, 125, 250, 500];
const FAMILY_LABEL: Record<string, string> = { meshcore: "MeshCore", reticulum: "Reticulum (RNode)", meshtastic: "Meshtastic" };

interface Props {
  value: string;
  onChange: (presetId: string) => void;
  /** The project's network: its settings are listed first. */
  network: Network;
  label?: string;
  /** Offer an empty "(unchanged)" choice (bulk editing); custom settings are not offered there. */
  blank?: string;
}

/** Choose a radio setting: a preset of MeshCore, Reticulum or Meshtastic, or any spreading factor and bandwidth. */
export function RadioPicker({ value, onChange, network, label = "Radio settings", blank }: Props) {
  const groups = useMemo(() => {
    const all = getPresets();
    const order = [network, ...(["meshcore", "reticulum", "meshtastic"] as const).filter((f) => f !== network)];
    return order.map((f) => ({ family: f, presets: all.filter((p) => p.family === f) }));
  }, [network]);
  const isCustom = value !== "" && familyOfPreset(value) === "custom";
  const cur = value !== "" ? presetById(value) : null;
  const setCustom = (sf: number, bw: number) => onChange(`lora:${sf}:${bw}`);
  return (
    <>
      <label className="field">
        <span>{label}</span>
        <select
          value={isCustom ? "custom" : value}
          onChange={(e) => {
            if (e.target.value === "custom") setCustom(cur?.sf ?? 8, cur?.bw_khz ?? 125);
            else onChange(e.target.value);
          }}
        >
          {blank !== undefined ? <option value="">{blank}</option> : null}
          {groups.map((g) => (
            <optgroup key={g.family} label={FAMILY_LABEL[g.family] + (g.family === network ? " (this project)" : "")}>
              {g.presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          ))}
          {blank === undefined ? <option value="custom">Custom LoRa (choose SF and bandwidth)…</option> : null}
        </select>
      </label>
      {isCustom && cur ? (
        <div className="grid2">
          <label className="field">
            <span>Spreading factor</span>
            <select value={cur.sf} onChange={(e) => setCustom(Number(e.target.value), cur.bw_khz)}>
              {[5, 6, 7, 8, 9, 10, 11, 12].map((sf) => (
                <option key={sf} value={sf}>
                  SF{sf}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Bandwidth (kHz)</span>
            <select value={cur.bw_khz} onChange={(e) => setCustom(cur.sf, Number(e.target.value))}>
              {(BANDWIDTHS.includes(cur.bw_khz) ? BANDWIDTHS : [...BANDWIDTHS, cur.bw_khz].sort((a, b) => a - b)).map((bw) => (
                <option key={bw} value={bw}>
                  {bw}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {cur ? (
        <p className="hint tight">
          SF{cur.sf} at {cur.bw_khz} kHz. Only spreading factor and bandwidth change what a node can hear; coding rate and the exact frequency do not.
          {familyOfPreset(value) !== "custom" && familyOfPreset(value) !== network ? ` This is a ${FAMILY_LABEL[familyOfPreset(value)]} setting in a ${NETWORKS[network].label} project.` : ""}
        </p>
      ) : null}
    </>
  );
}
