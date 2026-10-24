import { useState } from "react";
import { RadioPicker } from "./RadioPicker";
import { allTags } from "../listFilters";
import type { Network } from "../networks";
import type { MeshNode, NodeStatus } from "../types";

interface Props {
  nodes: MeshNode[];
  /** the ticked nodes */
  ids: string[];
  network: Network;
  onBulk: (ids: string[], patch: Partial<MeshNode>) => void;
  onTags: (ids: string[], add: string | null, remove: string | null) => void;
  onSetChecked: (ids: string[]) => void;
  onDelete: (ids: string[]) => void;
  readOnly: boolean;
}

type Draft = { heightM: string; clientHeightM: string; txDbm: string; gainDbi: string; cableLossDb: string; presetId: string; status: string };
const EMPTY: Draft = { heightM: "", clientHeightM: "", txDbm: "", gainDbi: "", cableLossDb: "", presetId: "", status: "" };
const NUMERIC = [["heightM", "Height (m)"], ["clientHeightM", "Client h. (m)"], ["txDbm", "TX (dBm)"], ["gainDbi", "Gain (dBi)"], ["cableLossDb", "Cable (dB)"]] as const;

/** The patch a draft stands for (only the fields that are filled in), and a sentence saying what it would do. */
export function draftPatch(d: Draft): { patch: Partial<MeshNode>; summary: string } {
  const patch: Partial<MeshNode> = {};
  const parts: string[] = [];
  for (const [k, label] of NUMERIC) {
    const raw = d[k].trim();
    const v = Number(raw);
    if (raw !== "" && Number.isFinite(v)) {
      patch[k] = v;
      parts.push(`${label.replace(/ \(.*\)/, "").toLowerCase()} → ${v}`);
    }
  }
  if (d.presetId) {
    patch.presetId = d.presetId;
    parts.push("radio settings changed");
  }
  if (d.status) {
    patch.status = d.status as NodeStatus;
    parts.push(`status → ${d.status}`);
  }
  return { patch, summary: parts.join(", ") };
}

/** Edit all ticked nodes at once: only filled-in fields change, with a line that says what will happen before you press Apply. */
export function SelectionTray({ nodes, ids, network, onBulk, onTags, onSetChecked, onDelete, readOnly }: Props) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [tag, setTag] = useState("");
  const { patch, summary } = draftPatch(draft);
  const tags = allTags(nodes.filter((n) => ids.includes(n.id)));
  return (
    <section className="card flat selection-tray" id="selection-tray">
      <h3 className="flat-title">{ids.length} node{ids.length === 1 ? "" : "s"} selected</h3>
      <fieldset className="plain" disabled={readOnly}>
        <p className="hint">Only the fields you fill in are changed.</p>
        <div className="grid3">
          {NUMERIC.map(([k, label]) => (
            <label key={k} className="field">
              <span>{label}</span>
              <input inputMode="decimal" placeholder="–" value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} aria-label={label} />
            </label>
          ))}
        </div>
        <div className="grid2">
          <div>
            <RadioPicker value={draft.presetId} onChange={(presetId) => setDraft({ ...draft, presetId })} network={network} label="Radio settings" blank="(unchanged)" />
          </div>
          <label className="field">
            <span>Status</span>
            <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
              <option value="">(unchanged)</option>
              <option value="planned">planned</option>
              <option value="installed">installed</option>
            </select>
          </label>
        </div>
        {summary ? <p className="preview" id="tray-preview">{ids.length} node{ids.length === 1 ? "" : "s"} will change: {summary}.</p> : null}
        <div className="row-actions">
          <button
            className="on"
            id="tray-apply"
            disabled={Object.keys(patch).length === 0}
            onClick={() => {
              onBulk(ids, patch);
              setDraft(EMPTY);
            }}
          >
            Apply
          </button>
          <button onClick={() => onSetChecked([])}>Clear selection</button>
          <button className="danger" onClick={() => onDelete(ids)}>
            Delete {ids.length}
          </button>
        </div>
        <div className="tagrow">
          <label className="field">
            <span>Tag these nodes</span>
            <input id="tray-tag" value={tag} placeholder="phase 1" maxLength={40} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => e.key === "Enter" && tag.trim() && (onTags(ids, tag, null), setTag(""))} />
          </label>
          <button disabled={!tag.trim()} onClick={() => (onTags(ids, tag, null), setTag(""))}>
            Add tag
          </button>
        </div>
        {tags.length > 0 ? (
          <div className="chips-row">
            {tags.map((t) => (
              <button key={t.tag} className="chip" title={`Remove “${t.tag}” from the selected nodes`} onClick={() => onTags(ids, null, t.tag)}>
                {t.tag} ({t.count}) ×
              </button>
            ))}
          </div>
        ) : null}
      </fieldset>
    </section>
  );
}
