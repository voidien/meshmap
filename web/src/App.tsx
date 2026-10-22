import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadCore } from "./engine/wasm";
import { useLinks } from "./useLinks";
import { MapView } from "./map/MapView";
import { NodePanel } from "./components/NodePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { LinkList } from "./components/LinkList";
import { ProfileChart } from "./components/ProfileChart";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { ComparePanel } from "./components/ComparePanel";
import { uid } from "./id";
import { exportMeshcore, importMeshcore, isMeshcoreFile } from "./meshcore";
import { baseName, emptyProject, loadWorkspace, parseProject, saveWorkspace, uniqueName, type Workspace } from "./workspace";
import { download, geojson, kml, linksCsv, nodesCsv } from "./export";
import type { MeshNode, Project } from "./types";

const NO_NODES: MeshNode[] = [];

export function App() {
  const [ws, setWs] = useState<Workspace>(loadWorkspace);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [terrain3d, setTerrain3d] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const project = ws.projects.find((p) => p.id === ws.activeId) ?? ws.projects[0];
  const other = compareId && compareId !== project.id ? ws.projects.find((p) => p.id === compareId) ?? null : null;

  /** Update the open project (same signature as a useState setter). */
  const setProject = useCallback((update: Project | ((p: Project) => Project)) => {
    setWs((w) => ({
      ...w,
      projects: w.projects.map((p) => (p.id === w.activeId ? (typeof update === "function" ? update(p) : update) : p)),
    }));
  }, []);

  useEffect(() => {
    loadCore().then(() => setReady(true), (e) => setLoadError(String(e)));
  }, []);
  useEffect(() => saveWorkspace(ws), [ws]);

  const { links: allLinks, status } = useLinks(project.nodes, project.settings, dragging, ready, project.id);
  const { links: otherAllLinks, status: otherStatus } = useLinks(other?.nodes ?? NO_NODES, other?.settings ?? project.settings, false, ready && !!other, other?.id ?? "none");
  const links = useMemo(() => (project.settings.showNone ? allLinks : allLinks.filter((l) => l.class !== "none")), [allLinks, project.settings.showNone]);
  const ghostLinks = useMemo(() => (other ? otherAllLinks.filter((l) => l.class !== "none") : []), [other, otherAllLinks]);

  const nodeById = useMemo(() => new Map(project.nodes.map((n) => [n.id, n])), [project.nodes]);
  const sel = selectedNode ? nodeById.get(selectedNode) ?? null : null;
  const selLink = selectedLink ? links.find((l) => l.key === selectedLink) ?? null : null;
  const counts = useMemo(() => {
    const c = { clear: 0, marginal: 0, obstructed: 0, none: 0 };
    for (const l of allLinks) c[l.class]++;
    return c;
  }, [allLinks]);

  // ---- project switching -------------------------------------------------
  const switchTo = useCallback((id: string) => {
    setWs((w) => (id === w.activeId || !w.projects.some((p) => p.id === id) ? w : { ...w, activeId: id, previousId: w.activeId }));
    setSelectedNode(null);
    setSelectedLink(null);
    setDragging(false);
  }, []);

  const step = useCallback(
    (dir: 1 | -1) => {
      const i = ws.projects.findIndex((p) => p.id === ws.activeId);
      switchTo(ws.projects[(i + dir + ws.projects.length) % ws.projects.length].id);
    },
    [ws.projects, ws.activeId, switchTo],
  );
  const flip = useCallback(() => ws.previousId && switchTo(ws.previousId), [ws.previousId, switchTo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "]") step(1);
      else if (e.key === "[") step(-1);
      else if (e.key === "`") flip();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, flip]);

  const addProject = (p: Project) => setWs((w) => ({ ...w, projects: [...w.projects, p], activeId: p.id, previousId: w.activeId }));

  const newProject = () => {
    addProject(emptyProject(uniqueName("Untitled project", ws.projects.map((p) => p.name))));
    setSelectedNode(null);
    setSelectedLink(null);
  };

  const duplicateProject = () => {
    const copy: Project = {
      ...structuredClone(project),
      id: uid(),
      name: uniqueName(`${project.name} (copy)`, ws.projects.map((p) => p.name)),
      nodes: project.nodes.map((n) => ({ ...n, id: uid() })),
    };
    addProject(copy);
    setSelectedNode(null);
    setSelectedLink(null);
  };

  const deleteProject = () => {
    if (ws.projects.length < 2 || !confirm(`Delete "${project.name}" and its ${project.nodes.length} nodes? This cannot be undone.`)) return;
    setWs((w) => {
      const projects = w.projects.filter((p) => p.id !== w.activeId);
      const prev = w.previousId && projects.some((p) => p.id === w.previousId) ? w.previousId : projects[0].id;
      return { projects, activeId: prev, previousId: null };
    });
    setSelectedNode(null);
    setSelectedLink(null);
  };

  // ---- node editing ------------------------------------------------------
  const patchNode = useCallback(
    (id: string, patch: Partial<MeshNode>) => setProject((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) })),
    [setProject],
  );

  const onMapClick = useCallback(
    (lat: number, lon: number) => {
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
    },
    [setProject],
  );

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

  // ---- import ------------------------------------------------------------
  /** Each file becomes its own project so setups can be flipped between and compared. */
  const importFiles = async (files: File[]) => {
    const added: Project[] = [];
    const errors: string[] = [];
    const taken = ws.projects.map((p) => p.name);
    for (const file of files) {
      try {
        const raw: unknown = JSON.parse(await file.text());
        let p: Project | null = null;
        if (isMeshcoreFile(raw)) {
          const mc = importMeshcore(raw)!;
          if (mc.nodes.length === 0) throw new Error("no valid points");
          p = { ...emptyProject(), name: baseName(file.name), nodes: mc.nodes, overlays: mc.overlays };
          if (mc.skipped) errors.push(`${file.name}: ${mc.skipped} entries without a valid latitude/longitude were skipped`);
        } else {
          const parsed = parseProject(raw);
          if (!parsed) throw new Error("not a meshmap or MeshCore file");
          p = { ...parsed, id: uid() };
        }
        p.name = uniqueName(p.name, [...taken, ...added.map((a) => a.name)]);
        added.push(p);
      } catch (e) {
        errors.push(`${file.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (added.length) {
      setWs((w) => {
        // drop the untouched starter project instead of leaving an empty one in the list
        const keep = w.projects.filter((p) => !(w.projects.length === 1 && p.nodes.length === 0 && p.name === "Untitled project"));
        return { projects: [...keep, ...added], activeId: added[0].id, previousId: keep.some((p) => p.id === w.activeId) ? w.activeId : null };
      });
      setSelectedNode(null);
      setSelectedLink(null);
    }
    if (errors.length) alert(errors.join("\n"));
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
        <ProjectSwitcher
          projects={ws.projects}
          activeId={project.id}
          canFlip={!!ws.previousId}
          onSelect={switchTo}
          onFlip={flip}
          onNew={newProject}
          onDuplicate={duplicateProject}
          onDelete={deleteProject}
        />
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

        <ComparePanel
          current={project}
          currentLinks={allLinks}
          projects={ws.projects}
          otherId={other?.id ?? null}
          otherLinks={otherAllLinks}
          busy={otherStatus.busy}
          onChange={setCompareId}
        />
        <SettingsPanel settings={project.settings} onChange={(patch) => setProject((p) => ({ ...p, settings: { ...p.settings, ...patch } }))} />
        <LinkList nodes={project.nodes} links={links} selectedKey={selectedLink} onSelect={(k) => { setSelectedLink(k); setSelectedNode(null); }} />

        <section className="card">
          <h3>Import / export</h3>
          <div className="btnrow">
            <button onClick={() => fileInput.current?.click()}>Import files…</button>
            <button onClick={() => download(`${slug}.meshmap.json`, JSON.stringify(project, null, 2), "application/json")}>Save JSON</button>
          </div>
          <div className="btnrow">
            <button onClick={() => download(`${slug}-coverage_layers.json`, exportMeshcore(project.nodes, project.overlays), "application/json")}>MeshCore JSON</button>
            <button onClick={() => download(`${slug}-nodes.csv`, nodesCsv(project.nodes), "text/csv")}>Nodes CSV</button>
            <button onClick={() => download(`${slug}-links.csv`, linksCsv(project.nodes, allLinks), "text/csv")}>Links CSV</button>
            <button onClick={() => download(`${slug}.geojson`, geojson(project, links), "application/geo+json")}>GeoJSON</button>
            <button onClick={() => download(`${slug}.kml`, kml(project, links), "application/vnd.google-earth.kml+xml")}>KML</button>
          </div>
          <input ref={fileInput} type="file" multiple accept=".json,application/json" hidden onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) void importFiles(fs); e.target.value = ""; }} />
          <p className="hint">Import accepts meshmap JSON and MeshCore coverage_layers JSON; select several files to load each as its own project. Everything is saved automatically in this browser.</p>
        </section>
        <section className="legend card">
          <span><i style={{ background: "#1a9850" }} />clear</span>
          <span><i style={{ background: "#e0a800" }} />marginal</span>
          <span><i style={{ background: "#d73027" }} />obstructed</span>
          <span><i className="dashed" />none</span>
          {other ? <span><i className="dashed" />dashed colour = "{other.name}"</span> : null}
        </section>
      </aside>
      <main className="mapwrap">
        <MapView
          nodes={project.nodes}
          links={links}
          ghostNodes={other?.nodes ?? NO_NODES}
          ghostLinks={ghostLinks}
          fitKey={`${project.id}|${other?.id ?? ""}`}
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
