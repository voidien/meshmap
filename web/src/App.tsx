import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjectSync } from "./useProjectSync";
import { useCoverage } from "./useCoverage";
import { CoveragePanel } from "./components/CoveragePanel";
import { PlacementPanel } from "./components/PlacementPanel";
import { NETWORKS, fitsNetwork } from "./networks";
import { buildSiteReport } from "./siteReport";
import { captureMap } from "./map/capture";
import type { Comment, FieldReading } from "./collab";
import { CalibrationPanel } from "./components/CalibrationPanel";
import { MeshHealthPanel, type HealthOptions } from "./components/MeshHealthPanel";
import { analyzeHealth, edgesFromLinks, simulateFailure } from "./meshHealth";
import { linkKey } from "./engine/analysis";
import { Card, openPanel, setAllPanels } from "./components/Card";
import { HelpDialog } from "./components/HelpDialog";
import { FieldMode } from "./components/FieldMode";
import { CommentsPanel } from "./components/CommentsPanel";
import { PublishDialog } from "./components/PublishDialog";
import { PublishedGallery } from "./components/PublishedGallery";
import { api } from "./api";
import type { Publication } from "./collab";
import { usePlacement } from "./usePlacement";
import { DEFAULT_PLACEMENT, placementRequest, type Area, type PlacementOptions, type Suggestion } from "./placement";
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
  const [placementArea, setPlacementArea] = useState<Area | null>(null);
  const [pickingArea, setPickingArea] = useState(false);
  const [placementOpts, setPlacementOpts] = useState<PlacementOptions>(DEFAULT_PLACEMENT);
  const [templateId, setTemplateId] = useState("");
  const [terrain3d, setTerrain3d] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<"account" | "admin" | "share" | "publish" | "help" | null>(null);
  const [menuOpen, setMenuOpen] = useState(() => store.get("meshmap.menu") !== "0");
  const toggleMenu = useCallback(() => {
    setMenuOpen((v) => {
      store.set("meshmap.menu", v ? "0" : "1");
      return !v;
    });
  }, []);
  // let the map take the new width
  useEffect(() => {
    const t = setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
      (window as unknown as { __meshmap?: { resize: () => void } }).__meshmap?.resize();
    }, 30);
    return () => clearTimeout(t);
  }, [menuOpen]);
  const sideRef = useRef<HTMLElement>(null);
  const [profilePoint, setProfilePoint] = useState<{ lat: number; lon: number } | null>(null);
  const [radioBannerOff, setRadioBannerOff] = useState<string | null>(null);
  const [fieldMode, setFieldMode] = useState(false);
  const [healthOpts, setHealthOpts] = useState<HealthOptions>({ minMarginDb: 6, hopLimit: NETWORKS.meshcore.hopLimit, highlight: true, failedId: "" });
  const [reportBusy, setReportBusy] = useState(false);
  const [section, setSection] = useState<"mine" | "published">("mine");
  const [viewPub, setViewPub] = useState<Publication | null>(null);
  const [pubReload, setPubReload] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(() => store.get(`meshmap.active.${auth.user.id}`));
  const [previousId, setPreviousId] = useState<string | null>(null);
  const [localProjects, setLocalProjects] = useState<Project[]>([]);
  const [passkeyDismissed, setPasskeyDismissed] = useState(() => store.get(`meshmap.passkeyPrompt.${auth.user.id}`) === "dismissed");
  const fileInput = useRef<HTMLInputElement>(null);

  const projects = sync.projects;
  const ownProject: Project = projects.find((p) => p.id === activeId) ?? projects[0] ?? { id: "", name: "Loading…", nodes: [], settings: { ...DEFAULT_SETTINGS }, role: "viewer" };
  /** A published copy being looked at: shown like a project the user can only view. */
  const pubProject = useMemo<Project | null>(
    () => {
      if (section !== "published") return null;
      if (!viewPub?.data) return { id: "", name: "", nodes: [], settings: { ...DEFAULT_SETTINGS }, role: "viewer" };
      return { id: `pub:${viewPub.id}`, name: viewPub.title, nodes: viewPub.data.nodes, settings: { ...DEFAULT_SETTINGS, ...viewPub.data.settings }, overlays: viewPub.data.overlays, role: "viewer" };
    },
    [section, viewPub],
  );
  const project: Project = pubProject ?? ownProject;
  const readOnly = project.role === "viewer";
  const other = compareId && compareId !== project.id ? projects.find((p) => p.id === compareId) ?? null : null;
  const conflict = sync.conflicts[project.id];

  useEffect(() => {
    if (project.id) store.set(`meshmap.active.${auth.user.id}`, project.id);
  }, [project.id, auth.user.id]);

  /** Update the open project (same signature as a useState setter). */
  const setProject = useCallback(
    (update: Project | ((p: Project) => Project)) => {
      if (!project.id || pubProject) return;
      sync.update(project.id, (p) => (typeof update === "function" ? update(p) : update));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project.id, sync.update, pubProject],
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

  // the hop count worth planning for depends on the software
  useEffect(() => {
    setHealthOpts((o) => ({ ...o, hopLimit: NETWORKS[project.settings.network].hopLimit }));
  }, [project.settings.network, project.id]);
  const healthInput = useMemo(
    () => ({ nodeIds: project.nodes.map((n) => n.id), edges: edgesFromLinks(allLinks, healthOpts.minMarginDb), gateways: project.nodes.filter((n) => n.gateway).map((n) => n.id), hopLimit: healthOpts.hopLimit }),
    [project.nodes, allLinks, healthOpts.minMarginDb, healthOpts.hopLimit],
  );
  const health = useMemo(() => analyzeHealth(healthInput), [healthInput]);
  const failure = useMemo(() => (healthOpts.failedId && healthInput.nodeIds.includes(healthOpts.failedId) ? simulateFailure(healthInput, healthOpts.failedId) : null), [healthInput, healthOpts.failedId]);
  const healthMarks = useMemo(() => {
    if (!healthOpts.highlight && !failure) return undefined;
    const m: Record<string, string> = {};
    const add = (id: string, c: string) => (m[id] = m[id] ? `${m[id]} ${c}` : c);
    for (const n of project.nodes) if (n.gateway) add(n.id, "h-gateway");
    if (healthOpts.highlight) {
      for (const id of health.isolated) add(id, "h-isolated");
      for (const s of health.spofs) add(s.id, "h-spof");
      for (const id of health.beyondHopLimit) add(id, "h-far");
      if (health.fromGateways) for (const id of health.noGateway) if (!health.isolated.includes(id)) add(id, "h-cut");
    }
    if (failure) {
      add(failure.failedId, "h-failed");
      for (const id of failure.cutOff) add(id, "h-cut");
    }
    return m;
  }, [healthOpts.highlight, failure, health, project.nodes]);

  const nodeById = useMemo(() => new Map(project.nodes.map((n) => [n.id, n])), [project.nodes]);

  const cov = useCoverage(project.id, project.nodes, project.settings, dataReady && !pubProject);
  const coverageImages = useMemo(
    () =>
      (pubProject ? [] : cov.layers)
        .filter((l) => l.visible && l.result)
        .map((l) => ({
          id: l.key.replace(":", "-"),
          url: l.mode === "count" && l.result!.images.count ? l.result!.images.count : l.result!.images.margin,
          bounds: l.result!.bounds,
          opacity: l.opacity,
        })),
    [cov.layers, pubProject],
  );
  const sel = selectedNode ? nodeById.get(selectedNode) ?? null : null;
  // the selected node's panel is at the top of the menu: show it
  useEffect(() => {
    if (selectedNode) sideRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [selectedNode]);
  const placement = usePlacement(project.id);
  const placementTemplate = project.nodes.find((n) => n.id === templateId) ?? null;
  const placementReq = useMemo(
    () => (placementArea ? placementRequest(placementArea, placementTemplate, project.nodes, project.settings, placementOpts) : null),
    [placementArea, placementTemplate, project.nodes, project.settings, placementOpts],
  );
  const ranSig = useRef<string | null>(null);
  const placementResult = placement.job?.state === "done" ? placement.job.result : null;
  const placementSites = useMemo(() => (placementResult?.suggestions ?? []).map((x) => ({ rank: x.rank, lat: x.lat, lon: x.lon })), [placementResult]);
  const placementOnMap = useMemo(() => ({ area: placementArea, sites: placementSites }), [placementArea, placementSites]);
  const addSuggestion = (x: Suggestion) => {
    const t = placementTemplate;
    const n = newNode(project.nodes, x.lat, x.lon, `Site ${x.rank}`);
    const node = t ? { ...n, heightM: t.heightM, clientHeightM: t.clientHeightM, txDbm: t.txDbm, gainDbi: t.gainDbi, cableLossDb: t.cableLossDb, presetId: t.presetId } : n;
    setProject((p) => ({ ...p, nodes: [...p.nodes, node] }));
    setSelectedNode(node.id);
    setSelectedLink(null);
    setFocus({ lat: x.lat, lon: x.lon, key: Date.now() });
  };
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
      else if (e.key === "m" || e.key === "M") toggleMenu();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, flip, toggleMenu]);

  const fail = (e: unknown) => alert(e instanceof Error ? e.message : String(e));

  /** Build the printable site report for a node and open it in a new tab. */
  const makeReport = async (node: MeshNode) => {
    // open the tab now (while the click still counts as a user action); fill it when the report is ready
    const win = window.open("", "_blank");
    setReportBusy(true);
    try {
      const scope = pubProject && viewPub ? `/api/published/${viewPub.id}/comments` : `/api/projects/${project.id}/comments`;
      const [comments, readings, mapImage] = await Promise.all([
        api.get<Comment[]>(scope).catch(() => [] as Comment[]),
        pubProject ? Promise.resolve([] as FieldReading[]) : api.get<FieldReading[]>(`/api/projects/${project.id}/readings`).catch(() => [] as FieldReading[]),
        captureMap(node.lat, node.lon, 14),
      ]);
      const layer = pubProject ? undefined : cov.layers.find((l) => l.key === `node:${node.id}` && l.result);
      const html = await buildSiteReport({
        project,
        node,
        links: allLinks,
        comments,
        readings,
        mapImage,
        generatedBy: auth.user.displayName,
        coverage: layer?.result ? { coveredKm2: layer.result.stats.coveredKm2, predictedKm2: layer.result.stats.predictedKm2, radiusKm: project.settings.coverageRadiusKm, terrain: layer.result.terrain } : null,
      });
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      if (win) win.location.href = url;
      else download(`${slug}-${node.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "node"}-site-report.html`, html, "text/html");
      setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
    } catch (e) {
      win?.close();
      fail(e);
    } finally {
      setReportBusy(false);
    }
  };

  const openPublication = async (p: Publication) => {
    try {
      const full = await api.get<Publication>(`/api/published/${p.id}`);
      setViewPub(full);
      setSelectedNode(null);
      setSelectedLink(null);
      setCompareId(null);
    } catch (e) {
      fail(e);
    }
  };
  const copyPublication = async () => {
    if (!viewPub?.data) return;
    const d = viewPub.data;
    await addProject(`${viewPub.title} (copy)`, { nodes: structuredClone(d.nodes), settings: { ...DEFAULT_SETTINGS, ...d.settings }, overlays: d.overlays });
    setSection("mine");
    setViewPub(null);
  };

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
      if (pickingArea) {
        setPlacementArea((a) => ({ lat, lon, radiusKm: a?.radiusKm ?? 20 }));
        setPickingArea(false);
        return;
      }
      const id = uid();
      setProject((p) => ({
        ...p,
        nodes: [
          ...p.nodes,
          { id, name: `Node ${p.nodes.length + 1}`, lat, lon, heightM: 5, clientHeightM: 1, txDbm: 22, gainDbi: 3, cableLossDb: 0.5, presetId: NETWORKS[p.settings.network].presetId, status: "planned", notes: "" },
        ],
      }));
      setSelectedNode(id);
      setSelectedLink(null);
      setAddMode(false);
    },
    [setProject, pickingArea],
  );

  const dragOrigin = useRef<{ id: string; lat: number; lon: number } | null>(null);
  const undoTimer = useRef(0);
  const [undoMoves, setUndoMoves] = useState<{ id: string; lat: number; lon: number }[]>([]);
  const undoMove = undoMoves[undoMoves.length - 1] ?? null;

  const onNodeMove = useCallback(
    (id: string, lat: number, lon: number, isDragging: boolean) => {
      if (isDragging && !dragOrigin.current) {
        const n = nodeById.get(id);
        if (n) dragOrigin.current = { id, lat: n.lat, lon: n.lon };
      }
      patchNode(id, { lat, lon });
      setDragging(isDragging);
      if (!isDragging && dragOrigin.current) {
        const o = dragOrigin.current;
        dragOrigin.current = null;
        if (Math.abs(o.lat - lat) > 1e-7 || Math.abs(o.lon - lon) > 1e-7) {
          window.clearTimeout(undoTimer.current);
          setUndoMoves((u) => [...u, o].slice(-4));
          undoTimer.current = window.setTimeout(() => setUndoMoves([]), 10000);
        }
      }
    },
    [patchNode, nodeById],
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
    cableLossDb: 0.5, presetId: NETWORKS[project.settings.network].presetId, status: "planned", notes: "",
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

  if (fieldMode && ready && ownProject.id && !pubProject) {
    return (
      <FieldMode
        project={ownProject}
        links={allLinks}
        readOnly={ownProject.role === "viewer"}
        onClose={() => setFieldMode(false)}
        onMoveNode={(id, lat, lon) => patchNode(id, { lat, lon })}
        onPatchNode={patchNode}
      />
    );
  }

  return (
    <div className={`app${menuOpen ? "" : " menu-hidden"}`}>
      <aside className="side" aria-hidden={!menuOpen} ref={sideRef}>
        <div className="userbar">
          <h1>meshmap</h1>
          <span className="ver" title="estimates only">v8</span>
          <span className="who" title={auth.user.username}>
            {auth.user.displayName}
          </span>
          <span className="sync" aria-live="polite">
            {sync.saveState === "saving" ? "Saving…" : sync.saveState === "error" ? "Not saved" : readOnly ? "View only" : "Saved"}
          </span>
          {auth.user.role === "admin" ? <button onClick={() => setDialog("admin")}>Admin</button> : null}
          <button onClick={() => setDialog("help")} id="help-btn">Help</button>
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
        <div className="tabs" role="tablist" aria-label="Section">
          <button role="tab" aria-selected={section === "mine"} className={section === "mine" ? "on" : ""} onClick={() => { setSection("mine"); setSelectedNode(null); setSelectedLink(null); }}>
            My projects
          </button>
          <button role="tab" id="tab-published" aria-selected={section === "published"} className={section === "published" ? "on" : ""} onClick={() => { setSection("published"); setSelectedNode(null); setSelectedLink(null); }}>
            Published
          </button>
        </div>
        <div className="panelbar">
          <span className="lmeta">Panels</span>
          <button className="linkbtn" onClick={() => setAllPanels(true)}>Expand all</button>
          <button className="linkbtn" onClick={() => setAllPanels(false)}>Collapse all</button>
        </div>
        {section === "published" ? (
          <>
            <PublishedGallery openId={viewPub?.id ?? null} onOpen={(p) => void openPublication(p)} reloadKey={pubReload} />
            {viewPub && pubProject ? (
              <section className="card" id="published-open">
                <h3>{viewPub.title}</h3>
                <div className="lmeta">
                  by {viewPub.owner.displayName} · {viewPub.nodeCount} nodes · read only
                </div>
                {viewPub.description ? <p className="pdesc-full">{viewPub.description}</p> : null}
                <div className="btnrow">
                  <button className="on" onClick={() => void copyPublication()}>Copy to my projects</button>
                  <button onClick={() => setViewPub(null)}>Close</button>
                </div>
              </section>
            ) : (
              <p className="hint card">Open a published project to look at its map and links.</p>
            )}
          </>
        ) : null}
        {sel ? (
          <fieldset className="plain" disabled={readOnly} id="selected-node">
            <NodePanel node={sel} network={project.settings.network} connections={connections} others={project.nodes.filter((n) => n.id !== sel.id)} onChange={(patch) => patchNode(sel.id, patch)} onDelete={() => deleteNode(sel.id)} onDuplicate={() => duplicateNode(sel.id)} onZoom={() => focusNode(sel.id)} onOpenLink={(k) => { setSelectedLink(k); setSelectedNode(null); }} onSelectNode={focusNode} onReport={() => void makeReport(sel)} reportBusy={reportBusy} />
          </fieldset>
        ) : null}
        {section === "mine" ? (
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
          onPublish={() => setDialog("publish")}
        />
        ) : null}
        {section === "mine" ? <input className="pname" value={project.name} readOnly={readOnly || project.role !== "owner"} onChange={(e) => setProject((p) => ({ ...p, name: e.target.value }))} aria-label="Project name" title={project.role === "owner" ? "" : "Only the owner can rename"} /> : null}
        {(() => {
          const net = project.settings.network;
          const odd = project.nodes.filter((n) => !fitsNetwork(n.presetId, net));
          const key = `${project.id}|${net}`;
          if (section !== "mine" || readOnly || odd.length === 0 || radioBannerOff === key) return null;
          return (
            <div className="banner" id="radio-mismatch">
              {odd.length} node{odd.length === 1 ? " uses" : "s use"} radio settings from another network, but this project is planned for {NETWORKS[net].label}.
              <div className="row-actions">
                <button className="on" onClick={() => patchMany(odd.map((n) => n.id), { presetId: NETWORKS[net].presetId })}>Set {odd.length === 1 ? "it" : "them"} to {NETWORKS[net].label}</button>
                <button onClick={() => setRadioBannerOff(key)}>Keep as is</button>
              </div>
            </div>
          );
        })()}
        <div className="toolbar">
          <button className={addMode ? "on" : ""} onClick={() => setAddMode((v) => !v)} disabled={!ready || readOnly} hidden={!!pubProject}>
            {addMode ? "Click the map…" : "+ Node"}
          </button>
          <button className={terrain3d ? "on" : ""} onClick={() => setTerrain3d((v) => !v)} title="Tilted 3D terrain">
            3D
          </button>
          <button className={showLabels ? "on" : ""} onClick={() => setShowLabels((v) => !v)} title="Show node names on the map">
            Names
          </button>
          <button id="field-mode-btn" onClick={() => setFieldMode(true)} disabled={!ready || !!pubProject || !project.id} title="Phone-friendly view for standing at a site: GPS, predicted signal here, record readings">
            Field
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

        {sel ? null : <p className="hint tight">{readOnly ? "View only." : "“+ Node”, then click the map. Click a link for its profile."}</p>}

        {ready ? (
        <fieldset className="plain" disabled={readOnly}>
        <NodeList
            network={project.settings.network}
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

        {project.id && (pubProject || section === "mine") ? (
          <CommentsPanel
            key={project.id}
            scope={pubProject ? { kind: "publication", id: viewPub!.id } : { kind: "project", id: project.id }}
            nodes={project.nodes}
            selectedNode={sel}
            selectedLink={selLink ? { key: selLink.key, label: `${nodeById.get(selLink.a)?.name.trim() || "?"} – ${nodeById.get(selLink.b)?.name.trim() || "?"}` } : null}
            title={pubProject ? "Comments on this published project" : "Comments"}
          />
        ) : null}
        {pubProject ? null : <CoveragePanel
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
        />}
        <MeshHealthPanel
          nodes={project.nodes}
          network={project.settings.network}
          health={health}
          failure={failure}
          options={healthOpts}
          onOptions={setHealthOpts}
          readOnly={readOnly}
          onFocus={focusNode}
          onLink={(a, b) => { setSelectedLink(linkKey(a, b)); setSelectedNode(null); }}
          onGateway={(id, on) => patchNode(id, { gateway: on ? true : undefined })}
        />
        {pubProject || !project.id ? null : (
          <CalibrationPanel
            projectId={project.id}
            nodes={project.nodes}
            settings={project.settings}
            readOnly={readOnly}
            onApply={(scale, leafOn) => setProject((p) => ({ ...p, settings: { ...p.settings, foliageScale: scale, foliageLeafOn: leafOn, terrainMode: "foliage" } }))}
          />
        )}
        {pubProject ? null : <PlacementPanel
          nodes={project.nodes}
          area={placementArea}
          onArea={setPlacementArea}
          picking={pickingArea}
          onPick={(on) => {
            setPickingArea(on);
            if (on) setAddMode(false);
          }}
          options={placementOpts}
          onOptions={setPlacementOpts}
          templateId={templateId}
          onTemplate={setTemplateId}
          job={placement.job}
          error={placement.error}
          running={placement.running}
          readOnly={readOnly}
          hasStale={!!placementReq && !!ranSig.current && ranSig.current !== JSON.stringify(placementReq)}
          onRun={() => {
            if (!placementReq) return;
            ranSig.current = JSON.stringify(placementReq);
            void placement.start(placementReq);
          }}
          onCancel={() => void placement.cancel()}
          onClear={placement.clear}
          onZoom={(x) => setFocus({ lat: x.lat, lon: x.lon, key: Date.now() })}
          onAdd={addSuggestion}
        />}
        {pubProject ? null : <ComparePanel
          current={project}
          currentLinks={allLinks}
          projects={projects}
          otherId={other?.id ?? null}
          otherLinks={otherAllLinks}
          busy={otherStatus.busy}
          onChange={setCompareId}
        />}
        <fieldset className="plain" disabled={readOnly}>
        <SettingsPanel settings={project.settings} onChange={(patch) => setProject((p) => ({ ...p, settings: { ...p.settings, ...patch } }))} nodes={project.nodes} readOnly={readOnly} onApplyRadio={() => patchMany(project.nodes.filter((n) => !fitsNetwork(n.presetId, project.settings.network)).map((n) => n.id), { presetId: NETWORKS[project.settings.network].presetId })} />
        </fieldset>
        <Card id="export" title="Import / export">
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
        </Card>
        <section className="legend card">
          <span><i style={{ background: "#1a9850" }} />clear</span>
          <span><i style={{ background: "#e0a800" }} />marginal</span>
          <span><i style={{ background: "#d73027" }} />obstructed</span>
          <span><i className="dashed" />none</span>
          {other ? <span><i className="dashed" />dashed colour = "{other.name}"</span> : null}
        </section>
      </aside>
      <main className="mapwrap">
        <button className="sidetoggle" id="menu-toggle" onClick={toggleMenu} aria-expanded={menuOpen} title="Hide or show the menu (M)">
          {menuOpen ? "◀ Hide menu" : "☰ Menu"}
        </button>
        {undoMove && nodeById.get(undoMove.id) ? (
          <div className="undo-toast" role="status">
            Moved “{nodeById.get(undoMove.id)!.name}”
            <button
              id="undo-move"
              onClick={() => {
                patchNode(undoMove.id, { lat: undoMove.lat, lon: undoMove.lon });
                window.clearTimeout(undoTimer.current);
                if (undoMoves.length > 1) undoTimer.current = window.setTimeout(() => setUndoMoves([]), 10000);
                setUndoMoves((u) => u.slice(0, -1));
              }}
            >
              Undo{undoMoves.length > 1 ? ` (${undoMoves.length})` : ""}
            </button>
          </div>
        ) : null}
        <MapView
          nodes={project.nodes}
          links={healthOpts.failedId ? links.filter((l) => l.a !== healthOpts.failedId && l.b !== healthOpts.failedId) : links}
          health={healthMarks}
          profilePoint={profilePoint}
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
          pickMode={pickingArea}
          placement={placementOnMap}
          terrain3d={terrain3d}
          onMapClick={onMapClick}
          onNodeSelect={onNodeSelect}
          onNodeMove={onNodeMove}
          onLinkSelect={(k) => { setSelectedLink(k); if (k) setSelectedNode(null); }}
          onAddNodeAt={pubProject ? undefined : (lat, lon) => addNodeAt(lat, lon, `Node ${project.nodes.length + 1}`)}
          onPlanAround={pubProject ? undefined : (lat, lon) => {
            setPlacementArea((a) => ({ lat, lon, radiusKm: a?.radiusKm ?? 20 }));
            openPanel("placement");
            setTimeout(() => document.getElementById("placement-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
          }}
        />
        {selLink && nodeById.get(selLink.a) && nodeById.get(selLink.b) ? (
          selLink.result ? (
            <ProfileChart a={nodeById.get(selLink.a)!} b={nodeById.get(selLink.b)!} settings={project.settings} onClose={() => setSelectedLink(null)} readOnly={readOnly || !!pubProject} onCursor={setProfilePoint} onPlaceNode={(lat, lon) => addNodeAt(lat, lon, `Node ${project.nodes.length + 1}`)} />
          ) : (
            <div className="chart-panel"><div className="chart-head"><strong>{selLink.warning}</strong><span className="spacer" /><button onClick={() => setSelectedLink(null)}>✕</button></div></div>
          )
        ) : null}
      </main>
      {dialog === "help" ? <HelpDialog onClose={() => setDialog(null)} /> : null}
      {dialog === "account" ? <AccountMenu auth={auth} onClose={() => setDialog(null)} /> : null}
      {dialog === "admin" ? <AdminPanel meId={auth.user.id} onClose={() => setDialog(null)} /> : null}
      {dialog === "publish" && ownProject.id ? <PublishDialog project={ownProject} onClose={() => setDialog(null)} onChanged={() => setPubReload((n) => n + 1)} /> : null}
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
