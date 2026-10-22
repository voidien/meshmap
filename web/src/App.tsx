import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjectSync } from "./useProjectSync";
import { useCoverage } from "./useCoverage";
import { CoveragePanel } from "./components/CoveragePanel";
import type { AuthContext } from "./auth/AuthGate";
import { AccountMenu } from "./components/AccountMenu";
import { AdminPanel } from "./components/AdminPanel";
import { ShareDialog } from "./components/ShareDialog";
import { passkeysSupported } from "./auth/webauthn";
import { loadCore } from "./engine/wasm";
import { useLinks } from "./useLinks";
import { MapView } from "./map/MapView";
import { NodePanel, type Connection } from "./components/NodePanel";
import { NodeList } from "./components/NodeList";
import { SettingsPanel } from "./components/SettingsPanel";
import { LinkList } from "./components/LinkList";
import { ProfileChart } from "./components/ProfileChart";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { ComparePanel } from "./components/ComparePanel";
import { uid } from "./id";
import { exportMeshcore, importMeshcore, isMeshcoreFile } from "./meshcore";
import { baseName, loadWorkspace, parseProject, uniqueName } from "./workspace";
import { download, geojson, kml, linksCsv, nodesCsv } from "./export";
import { DEFAULT_SETTINGS, type MeshNode, type Project } from "./types";

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

const NO_NODES: MeshNode[] = [];

export function App({ auth }: { auth: AuthContext }) {
  const sync = useProjectSync(true);
  const { ready: dataReady } = sync;
  const [wasmReady, setReady] = useState(false);
  const ready = wasmReady && dataReady;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<{ lat: number; lon: number; key: number } | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [addMode, setAddMode] = useState(false);
  const [terrain3d, setTerrain3d] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<"account" | "admin" | "share" | null>(null);
  const [activeId, setActiveId] = useState<string | null>(() => store.get(`meshmap.active.${auth.user.id}`));
  const [previousId, setPreviousId] = useState<string | null>(null);
  const [localProjects, setLocalProjects] = useState<Project[]>([]);
  const [passkeyDismissed, setPasskeyDismissed] = useState(() => store.get(`meshmap.passkeyPrompt.${auth.user.id}`) === "dismissed");
  const fileInput = useRef<HTMLInputElement>(null);

  const projects = sync.projects;
  const project: Project = projects.find((p) => p.id === activeId) ?? projects[0] ?? { id: "", name: "Loading…", nodes: [], settings: { ...DEFAULT_SETTINGS }, role: "viewer" };
  const readOnly = project.role === "viewer";
  const other = compareId && compareId !== project.id ? projects.find((p) => p.id === compareId) ?? null : null;
  const conflict = sync.conflicts[project.id];

  useEffect(() => {
    if (project.id) store.set(`meshmap.active.${auth.user.id}`, project.id);
  }, [project.id, auth.user.id]);

  /** Update the open project (same signature as a useState setter). */
  const setProject = useCallback(
    (update: Project | ((p: Project) => Project)) => {
      if (!project.id) return;
      sync.update(project.id, (p) => (typeof update === "function" ? update(p) : update));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project.id, sync.update],
  );

  useEffect(() => {
    loadCore().then(() => setReady(true), (e) => setLoadError(String(e)));
  }, []);

  // offer to move projects that were saved in this browser before accounts existed
  useEffect(() => {
    if (!dataReady || store.get(`meshmap.imported.${auth.user.id}`)) return;
    const local = loadWorkspace().projects.filter((p) => p.nodes.length > 0);
    setLocalProjects(local);
  }, [dataReady, auth.user.id]);

  const { links: allLinks, status } = useLinks(project.nodes, project.settings, dragging, ready, project.id);
  const { links: otherAllLinks, status: otherStatus } = useLinks(other?.nodes ?? NO_NODES, other?.settings ?? project.settings, false, ready && !!other, other?.id ?? "none");
  const links = useMemo(() => (project.settings.showNone ? allLinks : allLinks.filter((l) => l.class !== "none")), [allLinks, project.settings.showNone]);
  const ghostLinks = useMemo(() => (other ? otherAllLinks.filter((l) => l.class !== "none") : []), [other, otherAllLinks]);

  const nodeById = useMemo(() => new Map(project.nodes.map((n) => [n.id, n])), [project.nodes]);

  const cov = useCoverage(project.id, project.nodes, project.settings, dataReady);
  const coverageImages = useMemo(
    () =>
      cov.layers
        .filter((l) => l.visible && l.result)
        .map((l) => ({
          id: l.key.replace(":", "-"),
          url: l.mode === "count" && l.result!.images.count ? l.result!.images.count : l.result!.images.margin,
          bounds: l.result!.bounds,
          opacity: l.opacity,
        })),
    [cov.layers],
  );
  const sel = selectedNode ? nodeById.get(selectedNode) ?? null : null;
  const selLink = selectedLink ? links.find((l) => l.key === selectedLink) ?? null : null;
  const counts = useMemo(() => {
    const c = { clear: 0, marginal: 0, obstructed: 0, none: 0 };
    for (const l of allLinks) c[l.class]++;
    return c;
  }, [allLinks]);

  // ---- project switching -------------------------------------------------
  const switchTo = useCallback(
    (id: string) => {
      if (id === project.id || !projects.some((p) => p.id === id)) return;
      setPreviousId(project.id);
      setActiveId(id);
      setSelectedNode(null);
      setSelectedLink(null);
      setChecked(new Set());
      setDragging(false);
    },
    [project.id, projects],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      const i = projects.findIndex((p) => p.id === project.id);
      if (projects.length > 1) switchTo(projects[(i + dir + projects.length) % projects.length].id);
    },
    [projects, project.id, switchTo],
  );
  const flip = useCallback(() => {
    if (previousId) switchTo(previousId);
  }, [previousId, switchTo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (document.querySelector(".modal-back")) return;
      if (e.key === "]") step(1);
      else if (e.key === "[") step(-1);
      else if (e.key === "`") flip();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, flip]);

  const fail = (e: unknown) => alert(e instanceof Error ? e.message : String(e));

  const addProject = async (name: string, from?: Pick<Project, "nodes" | "settings" | "overlays">) => {
    try {
      const p = await sync.create(uniqueName(name, projects.map((x) => x.name)), from);
      setPreviousId(project.id);
      setActiveId(p.id);
      setSelectedNode(null);
      setSelectedLink(null);
    } catch (e) {
      fail(e);
    }
  };

  const newProject = () => void addProject("Untitled project");
  const duplicateProject = () => void addProject(`${project.name} (copy)`, { ...structuredClone({ nodes: project.nodes, settings: project.settings, overlays: project.overlays }), nodes: project.nodes.map((n) => ({ ...n, id: uid() })) });

  const deleteProject = async () => {
    if (projects.length < 2 || project.role !== "owner" || !confirm(`Delete "${project.name}" and its ${project.nodes.length} nodes for everyone it is shared with? This cannot be undone.`)) return;
    try {
      const prev = previousId && projects.some((p) => p.id === previousId && p.id !== project.id) ? previousId : projects.find((p) => p.id !== project.id)!.id;
      await sync.remove(project.id);
      setActiveId(prev);
      setPreviousId(null);
      setSelectedNode(null);
      setSelectedLink(null);
    } catch (e) {
      fail(e);
    }
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
    setChecked((c) => new Set([...c].filter((x) => x !== id)));
    setSelectedNode(null);
  };

  const newNode = (nodes: MeshNode[], lat: number, lon: number, name: string): MeshNode => ({
    id: uid(), name: name || `Node ${nodes.length + 1}`, lat, lon, heightM: 5, clientHeightM: 1, txDbm: 22, gainDbi: 3,
    cableLossDb: 0.5, presetId: "long_fast", status: "planned", notes: "",
  });

  const focusNode = (id: string) => {
    const n = nodeById.get(id);
    setSelectedNode(id);
    setSelectedLink(null);
    if (n) setFocus({ lat: n.lat, lon: n.lon, key: Date.now() });
  };

  const addNodeAt = (lat: number, lon: number, name: string) => {
    const n = newNode(project.nodes, lat, lon, name);
    setProject((p) => ({ ...p, nodes: [...p.nodes, n] }));
    setSelectedNode(n.id);
    setSelectedLink(null);
    setFocus({ lat, lon, key: Date.now() });
  };

  const duplicateNode = (id: string) => {
    const src = nodeById.get(id);
    if (!src) return;
    const copy: MeshNode = { ...src, id: uid(), letter: undefined, name: `${src.name.trim()} (copy)`, lat: src.lat + 0.0009, lon: src.lon + 0.0009 };
    setProject((p) => ({ ...p, nodes: [...p.nodes, copy] }));
    setSelectedNode(copy.id);
  };

  const patchMany = (ids: string[], patch: Partial<MeshNode>) => {
    const set = new Set(ids);
    setProject((p) => ({ ...p, nodes: p.nodes.map((n) => (set.has(n.id) ? { ...n, ...patch } : n)) }));
  };

  const deleteMany = (ids: string[]) => {
    if (!confirm(`Delete ${ids.length} node${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
    const set = new Set(ids);
    setProject((p) => ({ ...p, nodes: p.nodes.filter((n) => !set.has(n.id)) }));
    setChecked(new Set());
    if (selectedNode && set.has(selectedNode)) setSelectedNode(null);
  };

  const toggleChecked = (id: string) =>
    setChecked((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const connections: Connection[] = useMemo(() => {
    if (!sel) return [];
    const out: Connection[] = [];
    for (const l of links) {
      if (l.a !== sel.id && l.b !== sel.id) continue;
      const other = nodeById.get(l.a === sel.id ? l.b : l.a);
      if (other) out.push({ link: l, other });
    }
    const rank = { clear: 0, marginal: 1, obstructed: 2, none: 3 } as const;
    return out.sort((x, y) => rank[x.link.class] - rank[y.link.class] || (y.link.result?.margin_db ?? 0) - (x.link.result?.margin_db ?? 0));
  }, [sel, links, nodeById]);

  // ---- import ------------------------------------------------------------
  /** Each file becomes its own project so setups can be flipped between and compared. */
  const importFiles = async (files: File[]) => {
    const errors: string[] = [];
    const taken = projects.map((p) => p.name);
    let first: string | null = null;
    for (const file of files) {
      try {
        const raw: unknown = JSON.parse(await file.text());
        let parsed: Project | null = null;
        if (isMeshcoreFile(raw)) {
          const mc = importMeshcore(raw)!;
          if (mc.nodes.length === 0) throw new Error("no valid points");
          parsed = { id: "", name: baseName(file.name), nodes: mc.nodes, settings: { ...DEFAULT_SETTINGS }, overlays: mc.overlays };
          if (mc.skipped) errors.push(`${file.name}: ${mc.skipped} entries without a valid latitude/longitude were skipped`);
        } else {
          parsed = parseProject(raw);
          if (!parsed) throw new Error("not a meshmap or MeshCore file");
        }
        const name = uniqueName(parsed.name, taken);
        taken.push(name);
        const p = await sync.create(name, parsed);
        first ??= p.id;
      } catch (e) {
        errors.push(`${file.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (first) {
      // drop the untouched starter project instead of leaving an empty one in the list
      const starter = projects.find((p) => p.name === "Untitled project" && p.nodes.length === 0 && p.role === "owner");
      if (starter && projects.length === 1) void sync.remove(starter.id).catch(() => undefined);
      setPreviousId(project.id);
      setActiveId(first);
      setSelectedNode(null);
      setSelectedLink(null);
    }
    if (errors.length) alert(errors.join("\n"));
  };

  const importLocal = async () => {
    try {
      const taken = projects.map((p) => p.name);
      for (const lp of localProjects) {
        const name = uniqueName(lp.name, taken);
        taken.push(name);
        await sync.create(name, lp);
      }
      store.set(`meshmap.imported.${auth.user.id}`, "done");
      setLocalProjects([]);
    } catch (e) {
      fail(e);
    }
  };

  const slug = project.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "meshmap";

  if (loadError) return <div className="boot err">Failed to load the link engine (WASM): {loadError}</div>;

  return (
    <div className="app">
      <aside className="side">
        <header>
          <h1>meshmap</h1>
          <span className="ver">v3 · estimates only</span>
        </header>
        <div className="userbar">
          <span className="who" title={auth.user.username}>
            {auth.user.displayName}
          </span>
          <span className="sync" aria-live="polite">
            {sync.saveState === "saving" ? "Saving…" : sync.saveState === "error" ? "Not saved" : readOnly ? "View only" : "Saved"}
          </span>
          {auth.user.role === "admin" ? <button onClick={() => setDialog("admin")}>Admin</button> : null}
          <button onClick={() => setDialog("account")}>Account</button>
        </div>
        {sync.error ? <p className="banner warn">Can't save right now: {sync.error}. Your changes stay in this tab and are retried.</p> : null}
        {conflict ? (
          <div className="banner warn">
            <b>{conflict.updatedBy ?? "Someone"}</b> saved a newer version of “{project.name}” while you were editing.
            <div className="row-actions">
              <button onClick={() => void sync.resolve(project.id, "theirs").catch(fail)}>Load their version</button>
              <button onClick={() => void sync.resolve(project.id, "mine").catch(fail)}>Keep mine</button>
            </div>
          </div>
        ) : null}
        {localProjects.length > 0 ? (
          <div className="banner">
            This browser has {localProjects.length} project{localProjects.length === 1 ? "" : "s"} saved from before accounts ({localProjects.map((p) => p.name).join(", ")}). Move {localProjects.length === 1 ? "it" : "them"} into your account?
            <div className="row-actions">
              <button className="on" onClick={() => void importLocal()}>Move into my account</button>
              <button onClick={() => { store.set(`meshmap.imported.${auth.user.id}`, "done"); setLocalProjects([]); }}>No thanks</button>
            </div>
          </div>
        ) : null}
        {passkeysSupported() && auth.passkeyCount === 0 && !passkeyDismissed ? (
          <div className="banner">
            Sign in faster next time with your fingerprint, face or device PIN.
            <div className="row-actions">
              <button className="on" onClick={() => setDialog("account")}>Set up a passkey</button>
              <button onClick={() => { store.set(`meshmap.passkeyPrompt.${auth.user.id}`, "dismissed"); setPasskeyDismissed(true); }}>Not now</button>
            </div>
          </div>
        ) : null}
        <ProjectSwitcher
          projects={projects}
          activeId={project.id}
          canFlip={!!previousId}
          onSelect={switchTo}
          onFlip={flip}
          onNew={newProject}
          onDuplicate={duplicateProject}
          onDelete={() => void deleteProject()}
          onShare={() => setDialog("share")}
        />
        <input className="pname" value={project.name} readOnly={readOnly || project.role !== "owner"} onChange={(e) => setProject((p) => ({ ...p, name: e.target.value }))} aria-label="Project name" title={project.role === "owner" ? "" : "Only the owner can rename"} />
        <div className="toolbar">
          <button className={addMode ? "on" : ""} onClick={() => setAddMode((v) => !v)} disabled={!ready || readOnly}>
            {addMode ? "Click the map…" : "+ Add node"}
          </button>
          <button className={terrain3d ? "on" : ""} onClick={() => setTerrain3d((v) => !v)}>
            3D terrain
          </button>
          <button className={showLabels ? "on" : ""} onClick={() => setShowLabels((v) => !v)} title="Show node names on the map">
            Names
          </button>
        </div>
        <div className="status">
          {!ready ? "Loading…" : status.error ? <span className="err">{status.error}</span> : status.busy ? `Analysing links ${status.done}/${status.total}…` : `${project.nodes.length} nodes · ${allLinks.length - counts.none} links`}
          <span className="chips">
            <b className="c clear">{counts.clear}</b>
            <b className="c marginal">{counts.marginal}</b>
            <b className="c obstructed">{counts.obstructed}</b>
          </span>
        </div>

        <fieldset className="plain" disabled={readOnly}>
        {sel ? <NodePanel node={sel} connections={connections} onChange={(patch) => patchNode(sel.id, patch)} onDelete={() => deleteNode(sel.id)} onDuplicate={() => duplicateNode(sel.id)} onZoom={() => focusNode(sel.id)} onOpenLink={(k) => { setSelectedLink(k); setSelectedNode(null); }} onSelectNode={focusNode} /> : <p className="hint card">{readOnly ? "You can look at this project but not change it." : "Click “Add node”, then click the map. Drag nodes to see links update. Click a link for its terrain profile."}</p>}
        </fieldset>

        <ComparePanel
          current={project}
          currentLinks={allLinks}
          projects={projects}
          otherId={other?.id ?? null}
          otherLinks={otherAllLinks}
          busy={otherStatus.busy}
          onChange={setCompareId}
        />
        <CoveragePanel
          layers={cov.layers}
          staleKeys={cov.staleKeys}
          selectedNode={sel}
          nodeCount={project.nodes.length}
          radiusKm={project.settings.coverageRadiusKm}
          resolutionM={project.settings.coverageResolutionM}
          onRun={(kind, nodeId) => void cov.run(kind, nodeId)}
          onCancel={(k) => void cov.cancel(k)}
          onRemove={cov.remove}
          onChange={cov.patch}
        />
        <fieldset className="plain" disabled={readOnly}>
        <SettingsPanel settings={project.settings} onChange={(patch) => setProject((p) => ({ ...p, settings: { ...p.settings, ...patch } }))} />
        </fieldset>
        {ready ? (
        <fieldset className="plain" disabled={readOnly}>
        <NodeList
            nodes={project.nodes}
            links={allLinks}
            focusId={selectedNode}
            checked={checked}
            onFocus={focusNode}
            onToggle={toggleChecked}
            onSetChecked={(ids) => setChecked(new Set(ids))}
            onBulk={patchMany}
            onDeleteMany={deleteMany}
            onAddAt={addNodeAt}
          />
        </fieldset>
        ) : null}
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
          <p className="hint">Import accepts meshmap JSON and MeshCore coverage_layers JSON; select several files to load each as its own project. Your projects are saved to your account automatically.</p>
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
          checkedIds={checked}
          showLabels={showLabels}
          coverageImages={coverageImages}
          readOnly={readOnly}
          focus={focus}
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
      {dialog === "account" ? <AccountMenu auth={auth} onClose={() => setDialog(null)} /> : null}
      {dialog === "admin" ? <AdminPanel meId={auth.user.id} onClose={() => setDialog(null)} /> : null}
      {dialog === "share" && project.id ? (
        <ShareDialog
          project={project}
          onMembers={(m) => sync.setMembers(project.id, m)}
          onLeave={() => {
            const next = projects.find((p) => p.id !== project.id);
            void sync.leave(project.id, auth.user.id).then(() => next && setActiveId(next.id), fail);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
