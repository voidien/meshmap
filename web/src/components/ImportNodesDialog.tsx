import { useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import { parseNodesCsv, planImport, type ImportPlan } from "../nodesImport";
import { resolvePresetText } from "../engine/analysis";
import type { MeshNode, Settings } from "../types";

interface Props {
  existing: MeshNode[];
  settings: Settings;
  onImport: (plan: ImportPlan, fileName: string) => void;
  onClose: () => void;
}

/** Add nodes from a CSV file: pick the file, see what it holds and what would happen, then confirm. */
export function ImportNodesDialog({ existing, settings, onImport, onClose }: Props) {
  const [name, setName] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [mode, setMode] = useState<"add" | "update">("add");
  const parsed = useMemo(() => (text === null ? null : parseNodesCsv(text, resolvePresetText)), [text]);
  const plan = useMemo(() => (parsed ? planImport(parsed.nodes, existing, settings, mode) : null), [parsed, existing, settings, mode]);
  const matches = parsed ? planImport(parsed.nodes, existing, settings, "update").update.length : 0;

  return (
    <Modal label="Import nodes from a CSV file" onClose={onClose}>
      <div className="modal-head">
        <h2>Import nodes from CSV</h2>
        <button onClick={onClose}>Close</button>
      </div>
      <p className="hint">
        A header row with <b>name</b>, <b>lat</b> and <b>lon</b>; optional columns: height_agl_m, client_height_m, tx_dbm, gain_dbi, cable_loss_db, preset, status, notes, tags (separated by semicolons). The “Nodes CSV” export is a valid file.
      </p>
      <input
        id="import-nodes-file"
        type="file"
        accept=".csv,text/csv,text/plain"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setName(f.name);
          setText(await f.text());
        }}
      />
      {parsed ? (
        <div id="import-preview">
          <p>
            <b>{parsed.nodes.length}</b> node{parsed.nodes.length === 1 ? "" : "s"} found in {name}
            {parsed.errors.length ? `, ${parsed.errors.length} row${parsed.errors.length === 1 ? "" : "s"} skipped` : ""}.
          </p>
          {parsed.errors.length ? (
            <ul className="err small">
              {parsed.errors.slice(0, 6).map((e) => (
                <li key={e}>{e}</li>
              ))}
              {parsed.errors.length > 6 ? <li>…and {parsed.errors.length - 6} more</li> : null}
            </ul>
          ) : null}
          {parsed.warnings.length ? (
            <ul className="small">
              {parsed.warnings.slice(0, 6).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
          {parsed.nodes.length > 0 ? (
            <>
              <table className="budget">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Latitude</th>
                    <th>Longitude</th>
                    <th>Height</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.nodes.slice(0, 8).map((n) => (
                    <tr key={n.row}>
                      <td>{n.name}</td>
                      <td>{n.lat}</td>
                      <td>{n.lon}</td>
                      <td>{n.fields.heightM ?? "default"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.nodes.length > 8 ? <p className="lmeta">…and {parsed.nodes.length - 8} more</p> : null}
              <fieldset className="plain">
                <label className="check">
                  <input type="radio" name="import-mode" checked={mode === "add"} onChange={() => setMode("add")} />
                  Add them all as new nodes (a name already used gets “ 2”, “ 3”…)
                </label>
                <label className="check">
                  <input type="radio" name="import-mode" checked={mode === "update"} onChange={() => setMode("update")} />
                  Update nodes that have the same name ({matches} match{matches === 1 ? "" : "es"}) and add the rest
                </label>
              </fieldset>
              <div className="btnrow end">
                <button onClick={onClose}>Cancel</button>
                <button
                  className="on"
                  id="import-nodes-go"
                  onClick={() => plan && onImport(plan, name)}
                >
                  {plan ? `Add ${plan.add.length}${plan.update.length ? `, update ${plan.update.length}` : ""}` : "Import"}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
