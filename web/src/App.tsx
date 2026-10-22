import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadCore } from "./engine/wasm";
import { useLinks } from "./useLinks";
import { MapView } from "./map/MapView";
import { NodePanel } from "./components/NodePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { LinkList } from "./components/LinkList";
import { ProfileChart } from "./components/ProfileChart";
import { uid } from "./id";
import { exportMeshcore, importMeshcore, isMeshcoreFile } from "./meshcore";
import { download, geojson, kml, linksCsv, nodesCsv } from "./export";
import { DEFAULT_SETTINGS, type MeshNode, type Project, type Settings } from "./types";

const STORAGE_KEY = "meshmap.project.v0";


function emptyProject(): Project {
  return { name: "Untitled project", nodes: [], settings: { ...DEFAULT_SETTINGS } };
}

/** Tolerant parse for saved/imported projects: unknown fields dropped, missing ones defaulted. */
function parseProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.nodes)) return null;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const nodes: MeshNode[] = [];
  for (const n of o.nodes as Record<string, unknown>[]) {
    if (!n || typeof n.lat !== "number" || typeof n.lon !== "number") continue;
    nodes.push({
      id: typeof n.id === "string" ? n.id : uid(),
      letter: typeof n.letter === "string" ? n.letter : undefined,
      name: typeof n.name === "string" ? n.name : "Node",
      lat: n.lat,
      lon: n.lon,
      heightM: num(n.heightM, 5),
      clientHeightM: num(n.clientHeightM, 1),
      txDbm: num(n.txDbm, 22),
      gainDbi: num(n.gainDbi, 3),
      cableLossDb: num(n.cableLossDb, 0.5),
      presetId: typeof n.presetId === "string" ? n.presetId : "long_fast",
      status: n.status === "installed" ? "installed" : "planned",
      notes: typeof n.notes === "string" ? n.notes : "",
    });
  }
  const s = (o.settings ?? {}) as Record<string, unknown>;
  const settings: Settings = {
    freqMhz: num(s.freqMhz, DEFAULT_SETTINGS.freqMhz),
    k: num(s.k, DEFAULT_SETTINGS.k),
    maxRangeKm: num(s.maxRangeKm, DEFAULT_SETTINGS.maxRangeKm),
    marginalMarginDb: num(s.marginalMarginDb, DEFAULT_SETTINGS.marginalMarginDb),
    noiseFigureDb: num(s.noiseFigureDb, DEFAULT_SETTINGS.noiseFigureDb),
    showNone: s.showNone === true,
  };
  return { name: typeof o.name === "string" ? o.name : "Untitled project", nodes, settings, overlays: Array.isArray(o.overlays) ? o.overlays : undefined };
}

function loadSaved(): Project {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return parseProject(JSON.parse(raw)) ?? emptyProject();
  } catch {
    /* storage unavailable or corrupt: start empty */
  }
  return emptyProject();
}

export function App() {
  const [project, setProject] = useState<Project>(loadSaved);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [terrain3d, setTerrain3d] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadCore().then(() => setReady(true), (e) => setLoadError(String(e)));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    } catch {
      /* ignore quota/private-mode errors */
    }
  }, [project]);

  const { links: allLinks, status } = useLinks(project.nodes, project.settings, dragging, ready);
  const links = useMemo(() => (project.settings.showNone ? allLinks : allLinks.filter((l) => l.class !== "none")), [allLinks, project.settings.showNone]);

  const nodeById = useMemo(() => new Map(project.nodes.map((n) => [n.id, n])), [project.nodes]);
  const sel = selectedNode ? nodeById.get(selectedNode) ?? null : null;
  const selLink = selectedLink ? links.find((l) => l.key === selectedLink) ?? null : null;
  const counts = useMemo(() => {
    const c = { clear: 0, marginal: 0, obstructed: 0, none: 0 };
    for (const l of allLinks) c[l.class]++;
    return c;
  }, [allLinks]);

  const patchNode = useCallback((id: string, patch: Partial<MeshNode>) => {
    setProject((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
  }, []);

  const onMapClick = useCallback((lat: number, lon: number) => {
    const id = uid();
    setProject((p) => ({
      ...p,
      nodes: [
        ...p.nodes,
        { id, name: `Node ${p.nodes.length + 1}`, lat, lon, heightM: 5, clientHeightM: 1, txDbm: 22, gainDbi: 3, cableLossDb: 0.5, presetId: "long_fast", status: "planned", notes: "" },
      ],
    }));
    setSelectedNode(id);
    setSelectedLink(null);
    setAddMode(false);
  }, []);

  const onNodeMove = useCallback(
    (id: string, lat: number, lon: number, isDragging: boolean) => {
      patchNode(id, { lat, lon });
      setDragging(isDragging);
    },
    [patchNode],
  );

  const onNodeSelect = useCallback((id: string | null) => {
    setSelectedNode(id);
    if (id) setSelectedLink(null);
  }, []);

  const deleteNode = (id: string) => {
    setProject((p) => ({ ...p, nodes: p.nodes.filter((n) => n.id !== id) }));
    setSelectedNode(null);
  };

  const importFile = async (file: File) => {
    try {
      const raw: unknown = JSON.parse(await file.text());
      if (isMeshcoreFile(raw)) {
        const mc = importMeshcore(raw)!;
        if (mc.nodes.length === 0) throw new Error("no valid points in this MeshCore file");
        if (project.nodes.length > 0 && !confirm(`Replace the ${project.nodes.length} nodes in this project with the ${mc.nodes.length} MeshCore points from this file? (Cancel keeps your project.)`)) return;
        setProject((p) => ({ ...p, nodes: mc.nodes, overlays: mc.overlays }));
        if (mc.skipped) alert(`${mc.skipped} entries without a valid latitude/longitude were skipped.`);
      } else {
        const parsed = parseProject(raw);
        if (!parsed) throw new Error("not a meshmap or MeshCore file");
        setProject(parsed);
      }
      setSelectedNode(null);
      setSelectedLink(null);
    } catch (e) {
      alert(`Could not open file: ${e instanceof Error ? e.message : e}`);
    }
  };

  const slug = project.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "meshmap";

  if (loadError) return <div className="boot err">Failed to load the link engine (WASM): {loadError}</div>;

  return (
    <div className="app">
      <aside className="side">
        <header>
          <h1>meshmap</h1>
          <span className="ver">v0 · estimates only</span>
        </header>
        <input className="pname" value={project.name} onChange={(e) => setProject((p) => ({ ...p, name: e.target.value }))} aria-label="Project name" />
        <div className="toolbar">
          <button className={addMode ? "on" : ""} onClick={() => setAddMode((v) => !v)} disabled={!ready}>
            {addMode ? "Click the map…" : "+ Add node"}
          </button>
          <button className={terrain3d ? "on" : ""} onClick={() => setTerrain3d((v) => !v)}>
            3D terrain
          </button>
        </div>
        <div className="status">
          {!ready ? "Loading engine…" : status.error ? <span className="err">{status.error}</span> : status.busy ? `Analysing links ${status.done}/${status.total}…` : `${project.nodes.length} nodes · ${allLinks.length - counts.none} links`}
          <span className="chips">
            <b className="c clear">{counts.clear}</b>
            <b className="c marginal">{counts.marginal}</b>
            <b className="c obstructed">{counts.obstructed}</b>
          </span>
        </div>

        {sel ? <NodePanel node={sel} onChange={(patch) => patchNode(sel.id, patch)} onDelete={() => deleteNode(sel.id)} /> : <p className="hint card">Click “Add node”, then click the map. Drag nodes to see links update. Click a link for its terrain profile.</p>}

        <SettingsPanel settings={project.settings} onChange={(patch) => setProject((p) => ({ ...p, settings: { ...p.settings, ...patch } }))} />
        <LinkList nodes={project.nodes} links={links} selectedKey={selectedLink} onSelect={(k) => { setSelectedLink(k); setSelectedNode(null); }} />

        <section className="card">
          <h3>Project</h3>
          <div className="btnrow">
            <button onClick={() => download(`${slug}.meshmap.json`, JSON.stringify(project, null, 2), "application/json")}>Save JSON</button>
            <button onClick={() => fileInput.current?.click()}>Open JSON / MeshCore</button>
            <button onClick={() => { if (confirm("Clear all nodes and start a new project?")) { setProject(emptyProject()); setSelectedNode(null); setSelectedLink(null); } }}>New</button>
          </div>
          <div className="btnrow">
            <button onClick={() => download(`${slug}-nodes.csv`, nodesCsv(project.nodes), "text/csv")}>Nodes CSV</button>
            <button onClick={() => download(`${slug}-links.csv`, linksCsv(project.nodes, allLinks), "text/csv")}>Links CSV</button>
            <button onClick={() => download(`${slug}.geojson`, geojson(project, links), "application/geo+json")}>GeoJSON</button>
            <button onClick={() => download(`${slug}-coverage_layers.json`, exportMeshcore(project.nodes, project.overlays), "application/json")}>MeshCore JSON</button>
            <button onClick={() => download(`${slug}.kml`, kml(project, links), "application/vnd.google-earth.kml+xml")}>KML</button>
          </div>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} />
          <p className="hint">Saved automatically in this browser. Use Save JSON to keep or share a copy.</p>
        </section>
        <section className="legend card">
          <span><i style={{ background: "#1a9850" }} />clear</span>
          <span><i style={{ background: "#e0a800" }} />marginal</span>
          <span><i style={{ background: "#d73027" }} />obstructed</span>
          <span><i className="dashed" />none</span>
        </section>
      </aside>
      <main className="mapwrap">
        <MapView
          nodes={project.nodes}
          links={links}
          selectedNodeId={selectedNode}
          selectedLinkKey={selectedLink}
          addMode={addMode}
          terrain3d={terrain3d}
          onMapClick={onMapClick}
          onNodeSelect={onNodeSelect}
          onNodeMove={onNodeMove}
          onLinkSelect={(k) => { setSelectedLink(k); if (k) setSelectedNode(null); }}
        />
        {selLink && nodeById.get(selLink.a) && nodeById.get(selLink.b) ? (
          selLink.result ? (
            <ProfileChart a={nodeById.get(selLink.a)!} b={nodeById.get(selLink.b)!} settings={project.settings} onClose={() => setSelectedLink(null)} />
          ) : (
            <div className="chart-panel"><div className="chart-head"><strong>{selLink.warning}</strong><span className="spacer" /><button onClick={() => setSelectedLink(null)}>✕</button></div></div>
          )
        ) : null}
      </main>
    </div>
  );
}
