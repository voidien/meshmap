import { useCallback, useEffect, useRef, useState } from "react";
import { connectRadio, supports, type RadioLink, type Transport } from "../radio/link";
import type { HeardAdvert } from "../radio/meshcore";
import type { MeshNode } from "../types";

interface Heard {
  key: string;
  name: string;
  rssiDbm: number;
  snrDb: number;
  at: number;
  count: number;
}

interface Props {
  nodes: MeshNode[];
  canWrite: boolean;
  hasPosition: boolean;
  /** put a heard signal in the form below */
  onUse: (nodeId: string, rssiDbm: number, snrDb: number) => void;
  /** record a heard signal at the current position */
  onAutoSave: (nodeId: string, rssiDbm: number, snrDb: number, note: string) => void;
}

const AUTO_MIN_GAP_MS = 10_000;
const norm = (s: string) => s.trim().toLowerCase();

/** Hear a MeshCore radio's received packets directly: adverts that arrive straight from a node (no repeater) give that path's RSSI/SNR. */
export function RadioPanel({ nodes, canWrite, hasPosition, onUse, onAutoSave }: Props) {
  const [link, setLink] = useState<RadioLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [packets, setPackets] = useState(0);
  const [heard, setHeard] = useState<Map<string, Heard>>(new Map());
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [auto, setAuto] = useState(false);
  const [, tick] = useState(0);
  const latest = useRef({ nodes, mapping, auto, hasPosition, canWrite, onAutoSave });
  latest.current = { nodes, mapping, auto, hasPosition, canWrite, onAutoSave };
  const lastAuto = useRef(new Map<string, number>());
  const linkRef = useRef<RadioLink | null>(null);

  const nodeFor = useCallback((key: string, name: string): string => {
    const m = latest.current.mapping[key];
    if (m !== undefined) return m;
    return latest.current.nodes.find((n) => norm(n.name) === norm(name))?.id ?? "";
  }, []);

  const onHeard = useCallback(
    (h: HeardAdvert) => {
      const key = h.advert.publicKeyHex;
      const name = h.advert.name ?? key.slice(0, 8);
      setHeard((prev) => {
        const next = new Map(prev);
        next.set(key, { key, name, rssiDbm: h.rssiDbm, snrDb: h.snrDb, at: Date.now(), count: (prev.get(key)?.count ?? 0) + 1 });
        return next;
      });
      const c = latest.current;
      const nodeId = nodeFor(key, name);
      if (c.auto && c.hasPosition && c.canWrite && nodeId && Date.now() - (lastAuto.current.get(key) ?? 0) > AUTO_MIN_GAP_MS) {
        lastAuto.current.set(key, Date.now());
        c.onAutoSave(nodeId, h.rssiDbm, h.snrDb, "from radio");
      }
    },
    [nodeFor],
  );

  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => () => void linkRef.current?.close(), []);

  const connect = async (t: Transport) => {
    setBusy(true);
    setError(null);
    try {
      const l = await connectRadio(t, {
        onHeard,
        onPacket: () => setPackets((n) => n + 1),
        onClosed: () => {
          linkRef.current = null;
          setLink(null);
        },
      });
      linkRef.current = l;
      setLink(l);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (!/cancel|chosen|No port selected/i.test(m)) setError(m);
    } finally {
      setBusy(false);
    }
  };

  const rows = [...heard.values()].sort((a, b) => b.at - a.at);
  return (
    <div className="radio-panel" id="radio-panel">
      <h4>Radio</h4>
      {link ? (
        <div className="btnrow">
          <span>
            Connected to <b>{link.name}</b> ({link.transport === "bluetooth" ? "Bluetooth" : "USB"}) · {packets} packets
          </span>
          <button id="radio-disconnect" onClick={() => void link.close()}>
            Disconnect
          </button>
        </div>
      ) : (
        <div className="btnrow">
          <button id="radio-ble" disabled={busy || !supports("bluetooth")} onClick={() => void connect("bluetooth")} title={supports("bluetooth") ? "" : "This browser has no Web Bluetooth (use Chrome on Android or desktop)"}>
            Connect with Bluetooth
          </button>
          <button id="radio-usb" disabled={busy || !supports("usb")} onClick={() => void connect("usb")} title={supports("usb") ? "" : "This browser has no Web Serial (use Chrome or Edge)"}>
            Connect with USB
          </button>
        </div>
      )}
      {error ? <p className="hint warn">{error}</p> : null}
      {!link && !error ? (
        <p className="hint">
          Pair a MeshCore companion radio (firmware with the Bluetooth or USB companion interface). The page then listens to the signal of every packet the radio hears. Close the MeshCore phone app first: a radio talks to one app at a time.
        </p>
      ) : null}
      {link ? (
        <>
          <p className="hint">
            Only a node's <b>advert heard directly</b> (no repeater in between) counts, because only that tells about one path. Send an advert from the fixed node now and then, or wait for its scheduled one.
          </p>
          <label className="check">
            <input id="radio-auto" type="checkbox" checked={auto} disabled={!canWrite} onChange={(e) => setAuto(e.target.checked)} />
            Save a reading automatically when a project node is heard (at most one per node every 10 s, at your position)
          </label>
          {auto && !hasPosition ? <p className="hint warn">No GPS position yet, so nothing is saved.</p> : null}
          {rows.length === 0 ? <p className="hint">Nothing heard directly yet.</p> : null}
          <ul className="heard">
            {rows.map((r) => {
              const nodeId = nodeFor(r.key, r.name);
              return (
                <li key={r.key}>
                  <b>{r.name}</b> · {r.rssiDbm} dBm · SNR {r.snrDb} dB · {Math.max(0, Math.round((Date.now() - r.at) / 1000))} s ago{r.count > 1 ? ` · ×${r.count}` : ""}
                  <div className="btnrow">
                    <select aria-label={`Project node for ${r.name}`} value={nodeId} onChange={(e) => setMapping((m) => ({ ...m, [r.key]: e.target.value }))}>
                      <option value="">(not a project node)</option>
                      {nodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.name.trim() || "(unnamed)"}
                        </option>
                      ))}
                    </select>
                    <button disabled={!canWrite} onClick={() => onUse(nodeId, r.rssiDbm, r.snrDb)}>
                      Use
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}
