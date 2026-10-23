import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { download } from "../export";
import type { FieldReading } from "../collab";
import { predictAt } from "../engine/fieldPredict";
import { compass, DELTA_COLORS, deltaClass, fmtDistance, nearestNodes, readingsCsv, type ReadingRow } from "../fieldMath";
import { flushQueue, loadQueue, newReadingId, saveQueue, type NewReading } from "../fieldQueue";
import { parseReadingsCsv } from "../readingsImport";
import { OfflinePanel } from "./OfflinePanel";
import { RadioPanel } from "./RadioPanel";
import { MapView } from "../map/MapView";
import type { Link, MeshNode, Project } from "../types";
import { useGeolocation } from "../useGeolocation";

interface Props {
  project: Project;
  links: Link[];
  readOnly: boolean;
  onClose: () => void;
  onMoveNode: (id: string, lat: number, lon: number) => void;
  onPatchNode: (id: string, patch: Partial<MeshNode>) => void;
}

const NO_NODES: MeshNode[] = [];
const NO_LINKS: Link[] = [];

/** Phone-friendly mode for standing at a site: where am I, what should the signal be, and record what it really is. */
export function FieldMode({ project, links, readOnly, onClose, onMoveNode, onPatchNode }: Props) {
  const { fix, error: gpsError } = useGeolocation(true);
  const [manual, setManual] = useState<{ lat: number; lon: number } | null>(null);
  const pos = manual ? { lat: manual.lat, lon: manual.lon, accuracyM: 0, heading: null as number | null } : fix;
  const [tab, setTab] = useState<"here" | "record" | "readings">("here");
  const [serverReadings, setServerReadings] = useState<FieldReading[]>([]);
  const [queue, setQueue] = useState<NewReading[]>(() => loadQueue(project.id));
  const [online, setOnline] = useState(() => navigator.onLine);
  const [nodeId, setNodeId] = useState("");
  const [rssi, setRssi] = useState("");
  const [snr, setSnr] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [predicted, setPredicted] = useState<Map<string, { rssi: number; margin: number; cls: string }>>(new Map());
  const [readingPred, setReadingPred] = useState<Map<string, number>>(new Map());
  const nodeById = useMemo(() => new Map(project.nodes.map((n) => [n.id, n])), [project.nodes]);
  const canWrite = !readOnly;
  const importInput = useRef<HTMLInputElement>(null);

  // keep the screen on while working outside (not supported everywhere; fine if it fails)
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen").then((l) => (lock = l), () => undefined);
    return () => void lock?.release().catch(() => undefined);
  }, []);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const loadReadings = useCallback(async () => {
    try {
      setServerReadings(await api.get<FieldReading[]>(`/api/projects/${project.id}/readings`));
    } catch {
      /* offline: show what we have */
    }
  }, [project.id]);

  const sync = useCallback(async () => {
    if (!navigator.onLine) return;
    const left = await flushQueue(project.id);
    setQueue(left);
    await loadReadings();
  }, [project.id, loadReadings]);

  useEffect(() => {
    void sync();
    const t = setInterval(() => void sync(), 15000);
    return () => clearInterval(t);
  }, [sync, online]);

  const near = useMemo(() => (pos ? nearestNodes(project.nodes, pos.lat, pos.lon, 4) : []), [project.nodes, pos?.lat, pos?.lon]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!nodeId && near[0]) setNodeId(near[0].node.id);
  }, [near, nodeId]);

  // predicted signal from the nearest nodes where I stand (recomputed when I have moved about 10 m)
  const spot = pos ? `${pos.lat.toFixed(4)},${pos.lon.toFixed(4)}` : "";
  useEffect(() => {
    if (!pos) return;
    let live = true;
    (async () => {
      const next = new Map<string, { rssi: number; margin: number; cls: string }>();
      for (const n of near) {
        try {
          const p = await predictAt(n.node, pos.lat, pos.lon, project.settings);
          next.set(n.node.id, p);
        } catch {
          /* terrain not available */
        }
        if (!live) return;
      }
      setPredicted(next);
    })();
    return () => {
      live = false;
    };
  }, [spot, project.settings, near.map((n) => n.node.id).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const all: NewReading[] = useMemo(() => {
    const seen = new Set(serverReadings.map((r) => r.id));
    return [...serverReadings, ...queue.filter((q) => !seen.has(q.id))];
  }, [serverReadings, queue]);

  // predicted vs measured for every reading (computed once each)
  useEffect(() => {
    let live = true;
    (async () => {
      for (const r of all) {
        if (!live) return;
        const n = r.nodeRef ? nodeById.get(r.nodeRef) : null;
        if (!n || r.rssiDbm === null || readingPred.has(r.id)) continue;
        try {
          const p = await predictAt(n, r.lat, r.lon, project.settings);
          if (!live) return;
          setReadingPred((m) => new Map(m).set(r.id, p.rssi));
        } catch {
          /* ignore */
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [all, nodeById, project.settings]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows: ReadingRow[] = useMemo(
    () =>
      all.map((r) => {
        const p = readingPred.get(r.id) ?? null;
        return { ...r, by: (r as FieldReading).by ?? null, nodeName: (r.nodeRef && nodeById.get(r.nodeRef)?.name.trim()) || "(no node)", predictedRssiDbm: p, deltaDb: p !== null && r.rssiDbm !== null ? r.rssiDbm - p : null };
      }),
    [all, readingPred, nodeById],
  );

  const save = async () => {
    if (!pos) return setMsg("No position yet.");
    const rs = rssi.trim() === "" ? null : Number(rssi);
    const sn = snr.trim() === "" ? null : Number(snr);
    if ((rs !== null && !(rs <= 0 && rs >= -200)) || (sn !== null && !(Math.abs(sn) <= 50))) return setMsg("RSSI is a negative number of dBm (for example -104); SNR is in dB.");
    if (rs === null && sn === null && !note.trim()) return setMsg("Enter a signal value or a note.");
    const reading: NewReading = { id: newReadingId(), nodeRef: nodeId || null, lat: pos.lat, lon: pos.lon, accuracyM: pos.accuracyM || null, rssiDbm: rs, snrDb: sn, note: note.trim(), takenAt: Math.round(Date.now() / 1000) };
    const q = [...queue, reading];
    setQueue(q);
    saveQueue(project.id, q);
    setRssi("");
    setSnr("");
    setNote("");
    setMsg("Saved" + (navigator.onLine ? "." : " on this phone; it will upload when you have signal."));
    void sync();
  };

  const saveHeard = (node: string, rs: number, sn: number, text: string) => {
    if (!pos) return;
    const reading: NewReading = { id: newReadingId(), nodeRef: node || null, lat: pos.lat, lon: pos.lon, accuracyM: pos.accuracyM || null, rssiDbm: rs, snrDb: sn, note: text, takenAt: Math.round(Date.now() / 1000) };
    setQueue((q) => {
      const next = [...q, reading];
      saveQueue(project.id, next);
      return next;
    });
    void sync();
  };

  const remove = async (r: ReadingRow) => {
    if (queue.some((q) => q.id === r.id)) {
      const q = queue.filter((x) => x.id !== r.id);
      setQueue(q);
      saveQueue(project.id, q);
      return;
    }
    try {
      await api.del(`/api/projects/${project.id}/readings/${r.id}`);
      await loadReadings();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const chosen = nodeId ? nodeById.get(nodeId) ?? null : null;
  const mapField = useMemo(
    () => ({
      me: pos ? { lat: pos.lat, lon: pos.lon, accuracyM: pos.accuracyM } : null,
      readings: rows.map((r) => ({ id: r.id, lat: r.lat, lon: r.lon, color: DELTA_COLORS[deltaClass(r.deltaDb)] })),
    }),
    [pos?.lat, pos?.lon, pos?.accuracyM, rows], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [focus, setFocus] = useState<{ lat: number; lon: number; key: number } | null>(null);
  const centered = useRef(false);
  useEffect(() => {
    if (pos && !centered.current) {
      centered.current = true;
      setFocus({ lat: pos.lat, lon: pos.lon, key: Date.now() });
    }
  }, [pos]);

  const nodeLinks = links.filter((l) => l.class !== "none");

  return (
    <div className="field-mode" id="field-mode">
      <div className="fbar">
        <strong>Field mode</strong>
        <span className="lmeta">{project.name}</span>
        <span className="spacer" />
        <span className={`pill ${online ? "ok" : "off"}`}>{online ? "online" : "offline"}</span>
        {queue.length ? <span className="pill warn">{queue.length} to upload</span> : null}
        <button onClick={onClose}>Exit</button>
      </div>
      <div className="fmap">
        <MapView
          nodes={project.nodes}
          links={nodeLinks}
          ghostNodes={NO_NODES}
          ghostLinks={NO_LINKS}
          fitKey={`field-${project.id}`}
          selectedNodeId={nodeId || null}
          checkedIds={new Set()}
          showLabels
          coverageImages={[]}
          readOnly
          focus={focus}
          selectedLinkKey={null}
          placement={{ area: null, sites: [] }}
          field={mapField}
          addMode={false}
          pickMode={!!manual}
          terrain3d={false}
          onMapClick={(lat, lon) => {
            setManual({ lat, lon });
            setMsg("Position set by hand. Tap “Use GPS” to go back to the phone's location.");
          }}
          onNodeSelect={(id) => id && setNodeId(id)}
          onNodeMove={() => undefined}
          onLinkSelect={() => undefined}
        />
        <div className="fmapbtns">
          <button onClick={() => pos && setFocus({ lat: pos.lat, lon: pos.lon, key: Date.now() })} disabled={!pos}>
            Centre on me
          </button>
          {manual ? (
            <button onClick={() => setManual(null)}>Use GPS</button>
          ) : (
            <button onClick={() => { setManual({ lat: pos?.lat ?? project.nodes[0]?.lat ?? 0, lon: pos?.lon ?? project.nodes[0]?.lon ?? 0 }); setMsg("Tap the map to set where you are."); }}>Set position by hand</button>
          )}
        </div>
      </div>
      <div className="fsheet">
        <div className="tabs" role="tablist">
          {(["here", "record", "readings"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t === "here" ? "Here" : t === "record" ? "Record" : `Readings (${all.length})`}
            </button>
          ))}
        </div>
        {msg ? <p className="banner">{msg}</p> : null}
        {!pos ? <p className="banner warn">{gpsError ?? "Waiting for a GPS position…"}</p> : null}
        {pos && !manual ? <p className="lmeta">GPS accuracy ±{Math.round(pos.accuracyM)} m{pos.accuracyM > 25 ? " (poor: move to open sky before recording or moving a node)" : ""}</p> : null}

        {tab === "here" ? (
          <ul className="fnear">
            {near.length === 0 ? <li className="hint">No nodes in this project yet.</li> : null}
            {near.map((n) => {
              const p = predicted.get(n.node.id);
              return (
                <li key={n.node.id} className={n.node.id === nodeId ? "sel" : ""} onClick={() => setNodeId(n.node.id)}>
                  <div className="lrow">
                    <b>{n.node.name.trim() || "(unnamed)"}</b>
                    <span className="spacer" />
                    <span>
                      {fmtDistance(n.distanceM)} {compass(n.bearing)} ({Math.round(n.bearing)}°)
                    </span>
                  </div>
                  <div className="lmeta">
                    {p ? `Predicted here: ${p.rssi.toFixed(0)} dBm, ${p.margin >= 0 ? "+" : ""}${p.margin.toFixed(0)} dB margin (${p.cls})` : "Predicting…"} · {n.node.heightM} m mast, {n.node.status}
                  </div>
                </li>
              );
            })}
            {chosen && canWrite && pos ? (
              <li className="factions">
                <button
                  onClick={() => {
                    if (confirm(`Move “${chosen.name}” to your position (${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}, ±${Math.round(pos.accuracyM)} m)?`)) onMoveNode(chosen.id, pos.lat, pos.lon);
                  }}
                >
                  Move “{chosen.name.trim() || "node"}” here
                </button>
                <button onClick={() => onPatchNode(chosen.id, { status: chosen.status === "installed" ? "planned" : "installed" })}>
                  Mark {chosen.status === "installed" ? "planned" : "installed"}
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
        {tab === "here" ? <OfflinePanel nodes={project.nodes} pos={pos ? { lat: pos.lat, lon: pos.lon } : null} /> : null}

        {tab === "record" ? (
          <fieldset className="plain" disabled={!canWrite}>
            {!canWrite ? <p className="hint">Viewers can look but not record readings.</p> : null}
            <RadioPanel
              nodes={project.nodes}
              canWrite={canWrite}
              hasPosition={!!pos}
              onUse={(id, rs, sn) => {
                setNodeId(id);
                setRssi(String(rs));
                setSnr(String(sn));
                setNote("from radio");
              }}
              onAutoSave={saveHeard}
            />
            <label className="field">
              <span>Heard from node</span>
              <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
                <option value="">(none)</option>
                {near.map((n) => (
                  <option key={n.node.id} value={n.node.id}>
                    {n.node.name.trim() || "(unnamed)"} · {fmtDistance(n.distanceM)}
                  </option>
                ))}
                {project.nodes.filter((n) => !near.some((x) => x.node.id === n.id)).map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name.trim() || "(unnamed)"}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid2">
              <label className="field">
                <span>
                  RSSI <em>(dBm, e.g. -104)</em>
                </span>
                <input id="f-rssi" inputMode="decimal" value={rssi} onChange={(e) => setRssi(e.target.value)} />
              </label>
              <label className="field">
                <span>
                  SNR <em>(dB)</em>
                </span>
                <input id="f-snr" inputMode="decimal" value={snr} onChange={(e) => setSnr(e.target.value)} />
              </label>
            </div>
            <label className="field">
              <span>Note</span>
              <input id="f-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="behind the barn, 2 bars…" />
            </label>
            <button className="on big" id="f-save" disabled={!pos} onClick={() => void save()}>
              Save reading here
            </button>
            {chosen && pos && predicted.get(chosen.id) ? <p className="hint">The model expects about {predicted.get(chosen.id)!.rssi.toFixed(0)} dBm from {chosen.name.trim() || "this node"} here.</p> : null}
          </fieldset>
        ) : null}

        {tab === "readings" ? (
          <>
            <div className="btnrow">
              <button disabled={rows.length === 0} onClick={() => download(`${project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "meshmap"}-field-readings.csv`, readingsCsv(rows), "text/csv")}>
                Export CSV
              </button>
              <button onClick={() => void sync()}>Sync now</button>
              <button disabled={!canWrite} onClick={() => importInput.current?.click()} title="Add readings from a CSV file: lat, lon, rssi, snr, node, note, time">
                Import CSV
              </button>
              <input
                ref={importInput}
                type="file"
                accept=".csv,text/csv,text/plain"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  const r = parseReadingsCsv(await f.text(), project.nodes);
                  if (r.readings.length) {
                    const q = [...queue, ...r.readings];
                    setQueue(q);
                    saveQueue(project.id, q);
                    void sync();
                  }
                  setMsg(`Imported ${r.readings.length} reading${r.readings.length === 1 ? "" : "s"}${r.errors.length ? `; ${r.errors.length} row${r.errors.length === 1 ? "" : "s"} skipped (${r.errors[0]})` : ""}${r.unmatchedNodes ? `; ${r.unmatchedNodes} with a node name that matches no node` : ""}.`);
                }}
              />
            </div>
            <p className="hint">Dots on the map: green = within 3 dB of the prediction (or better), amber = 3 to 10 dB weaker, red = more than 10 dB weaker, grey = no signal value or no prediction.</p>
            <ul className="freadings">
              {[...rows].reverse().map((r) => (
                <li key={r.id}>
                  <div className="lrow">
                    <i className="dotc" style={{ background: DELTA_COLORS[deltaClass(r.deltaDb)] }} />
                    <b>{r.nodeName}</b>
                    <span className="spacer" />
                    <span className="lmeta">{new Date(r.takenAt * 1000).toLocaleString()}</span>
                  </div>
                  <div>
                    {r.rssiDbm !== null ? `${r.rssiDbm} dBm` : "no RSSI"}
                    {r.snrDb !== null ? ` · SNR ${r.snrDb} dB` : ""}
                    {r.predictedRssiDbm !== null ? ` · predicted ${r.predictedRssiDbm.toFixed(0)} dBm (${r.deltaDb! >= 0 ? "+" : ""}${r.deltaDb!.toFixed(1)} dB)` : ""}
                  </div>
                  {r.note ? <div className="lmeta">{r.note}</div> : null}
                  <div className="lmeta">
                    {queue.some((q) => q.id === r.id) ? "waiting to upload · " : ""}
                    {r.by ? `${r.by} · ` : ""}±{r.accuracyM ? Math.round(r.accuracyM) : "?"} m
                    {queue.some((q) => q.id === r.id) || (r as FieldReading).canDelete ? (
                      <>
                        {" · "}
                        <button className="linkbtn" onClick={() => void remove(r)}>
                          delete
                        </button>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            {rows.length === 0 ? <p className="hint">No readings yet. Record one from the Record tab.</p> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
