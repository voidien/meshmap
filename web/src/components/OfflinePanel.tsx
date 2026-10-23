import { useRef, useState } from "react";
import { api } from "../api";
import { downloadAll, type Progress } from "../offline/download";
import { bboxOfPoints, padBBox, planOffline, type BBox, type OfflinePlan, type PackIndex } from "../offline/plan";
import { keepAppFiles, offlineReady } from "../offline/register";
import type { PackInfo } from "../engine/packs";
import type { MeshNode } from "../types";

interface Props {
  nodes: MeshNode[];
  pos: { lat: number; lon: number } | null;
}

type Area = "near15" | "near40" | "project";
const AREAS: Record<Area, string> = { near15: "Around me, 15 km", near40: "Around me, 40 km", project: "All project nodes, +5 km" };
const LAST = "meshmap.offline.last";

function lastSaved(): string | null {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
}

/** Keep the map, terrain and tree data of an area on this phone, so predictions and the map keep working without signal. */
export function OfflinePanel({ nodes, pos }: Props) {
  const [area, setArea] = useState<Area>(pos ? "near15" : "project");
  const [plan, setPlan] = useState<OfflinePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<Progress | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saved, setSaved] = useState(lastSaved);
  const abort = useRef<AbortController | null>(null);

  const boxFor = (): BBox | null => {
    if (area === "project") {
      const b = bboxOfPoints(nodes);
      return b ? padBBox(b, 5) : null;
    }
    return pos ? padBBox([pos.lon, pos.lat, pos.lon, pos.lat], area === "near15" ? 15 : 40) : null;
  };

  const prepare = async () => {
    setMsg(null);
    setPlan(null);
    const box = boxFor();
    if (!box) return setMsg(area === "project" ? "This project has no nodes yet." : "No GPS position yet.");
    setBusy(true);
    try {
      const packs = await api.get<PackInfo[]>("/api/packs").catch(() => [] as PackInfo[]);
      const idx: PackIndex[] = [];
      for (const p of packs) {
        const t = await api.get<{ zoom: number; tiles: [number, number, 0 | 1][] }>(`/api/packs/${encodeURIComponent(p.id)}/tiles`);
        idx.push({ id: p.id, zoom: t.zoom, tiles: t.tiles });
      }
      setPlan(planOffline(box, idx));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!plan) return;
    if (!offlineReady()) return setMsg("Offline support is not active yet. Reload the page once (with a connection) and try again.");
    keepAppFiles();
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    const urls = [...plan.terrain, ...plan.pack, ...plan.map];
    const end = await downloadAll(urls, setProg, ctl.signal);
    setBusy(false);
    abort.current = null;
    if (ctl.signal.aborted) return setMsg(`Stopped after ${end.done} of ${end.total} tiles; what was saved stays.`);
    const text = `${end.done} tiles saved ${new Date().toLocaleString()} (${AREAS[area]})${end.failed ? `, ${end.failed} failed` : ""}`;
    setMsg(end.failed ? `${text}. Run it again to fetch the missing ones.` : "Saved. This area now works without a connection.");
    try {
      localStorage.setItem(LAST, text);
    } catch {
      /* private mode: nothing to remember */
    }
    setSaved(text);
  };

  return (
    <div className="offline-panel" id="offline-panel">
      <h4>Work offline</h4>
      <p className="hint">
        {offlineReady() ? "The app itself is kept on this phone." : "Reload once to keep the app on this phone."} Save an area before you leave signal: the map, terrain for predictions and tree data. Readings you record without signal upload later. Editing the project needs a connection.
      </p>
      <div className="btnrow">
        <select id="offline-area" value={area} disabled={busy} onChange={(e) => (setArea(e.target.value as Area), setPlan(null))} aria-label="Area to save">
          {(Object.keys(AREAS) as Area[]).map((a) => (
            <option key={a} value={a}>
              {AREAS[a]}
            </option>
          ))}
        </select>
        <button id="offline-prepare" disabled={busy} onClick={() => void prepare()}>
          Check size
        </button>
      </div>
      {plan ? (
        <p className="hint" id="offline-plan">
          {plan.terrain.length} terrain + {plan.pack.length} tree/building + {plan.map.length} map tiles, about {Math.max(1, Math.round(plan.estimateMb))} MB. Best on Wi-Fi.
        </p>
      ) : null}
      {plan ? (
        <div className="btnrow">
          <button id="offline-save" className="on" disabled={busy} onClick={() => void start()}>
            Save this area
          </button>
          {busy ? <button onClick={() => abort.current?.abort()}>Stop</button> : null}
        </div>
      ) : null}
      {prog && busy ? (
        <progress value={prog.done + prog.failed} max={prog.total} aria-label="Saving tiles">
          {prog.done}/{prog.total}
        </progress>
      ) : null}
      {msg ? <p className="hint">{msg}</p> : null}
      {saved ? <p className="hint">Last saved: {saved}</p> : null}
    </div>
  );
}
