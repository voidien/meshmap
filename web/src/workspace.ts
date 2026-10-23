import { cleanAntenna } from "./antenna";
import { inferNetwork, isNetwork, NETWORKS } from "./networks";
import { uid } from "./id";
import { DEFAULT_SETTINGS, type MeshNode, type Project, type Settings } from "./types";

/** All projects ("setups") the user has, plus which one is open and which was open before it. */
export interface Workspace {
  activeId: string;
  previousId: string | null;
  projects: Project[];
}

export const WORKSPACE_KEY = "meshmap.workspace.v1";
const LEGACY_KEY = "meshmap.project.v0";

export function emptyProject(name = "Untitled project"): Project {
  return { id: uid(), name, nodes: [], settings: { ...DEFAULT_SETTINGS } };
}

/** Tolerant parse for saved/imported projects: unknown fields dropped, missing ones defaulted. */
export function parseProject(raw: unknown): Project | null {
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
      antenna: cleanAntenna(n.antenna),
      gateway: n.gateway === true ? true : undefined,
      presetId: typeof n.presetId === "string" && n.presetId !== "" ? n.presetId : NETWORKS.meshcore.presetId,
      status: n.status === "installed" ? "installed" : "planned",
      notes: typeof n.notes === "string" ? n.notes : "",
    });
  }
  const s = (o.settings ?? {}) as Record<string, unknown>;
  const settings: Settings = {
    network: isNetwork(s.network) ? s.network : inferNetwork(nodes.map((n) => n.presetId)),
    freqMhz: num(s.freqMhz, DEFAULT_SETTINGS.freqMhz),
    k: num(s.k, DEFAULT_SETTINGS.k),
    maxRangeKm: num(s.maxRangeKm, DEFAULT_SETTINGS.maxRangeKm),
    marginalMarginDb: num(s.marginalMarginDb, DEFAULT_SETTINGS.marginalMarginDb),
    noiseFigureDb: num(s.noiseFigureDb, DEFAULT_SETTINGS.noiseFigureDb),
    showNone: s.showNone === true,
    itmClimate: Number.isInteger(s.itmClimate) && (s.itmClimate as number) >= 1 && (s.itmClimate as number) <= 7 ? (s.itmClimate as number) : DEFAULT_SETTINGS.itmClimate,
    itmN0: num(s.itmN0, DEFAULT_SETTINGS.itmN0),
    groundEpsilon: num(s.groundEpsilon, DEFAULT_SETTINGS.groundEpsilon),
    groundSigma: num(s.groundSigma, DEFAULT_SETTINGS.groundSigma),
    verticalPolarization: typeof s.verticalPolarization === "boolean" ? s.verticalPolarization : DEFAULT_SETTINGS.verticalPolarization,
    confidencePct: num(s.confidencePct, DEFAULT_SETTINGS.confidencePct),
    reliabilityPct: num(s.reliabilityPct, DEFAULT_SETTINGS.reliabilityPct),
    coverageRadiusKm: num(s.coverageRadiusKm, DEFAULT_SETTINGS.coverageRadiusKm),
    coverageResolutionM: num(s.coverageResolutionM, DEFAULT_SETTINGS.coverageResolutionM),
    terrainMode: s.terrainMode === "bare" || s.terrainMode === "clutter" || s.terrainMode === "foliage" ? s.terrainMode : DEFAULT_SETTINGS.terrainMode,
    foliageScale: num(s.foliageScale, DEFAULT_SETTINGS.foliageScale),
    foliageLeafOn: typeof s.foliageLeafOn === "boolean" ? s.foliageLeafOn : DEFAULT_SETTINGS.foliageLeafOn,
    clientGainDbi: num(s.clientGainDbi, DEFAULT_SETTINGS.clientGainDbi),
    clientCableLossDb: num(s.clientCableLossDb, DEFAULT_SETTINGS.clientCableLossDb),
  };
  return {
    id: typeof o.id === "string" ? o.id : uid(),
    name: typeof o.name === "string" ? o.name : "Untitled project",
    nodes,
    settings,
    overlays: Array.isArray(o.overlays) ? o.overlays : undefined,
  };
}

export function loadWorkspace(): Workspace {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (raw) {
      const o = JSON.parse(raw) as { activeId?: unknown; previousId?: unknown; projects?: unknown[] };
      const projects = (o.projects ?? []).map(parseProject).filter((p): p is Project => !!p);
      if (projects.length) {
        const has = (id: unknown) => projects.some((p) => p.id === id);
        return {
          projects,
          activeId: has(o.activeId) ? (o.activeId as string) : projects[0].id,
          previousId: has(o.previousId) ? (o.previousId as string) : null,
        };
      }
    }
    // migrate the single-project storage used before multi-project support
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const p = parseProject(JSON.parse(legacy));
      if (p) return { projects: [p], activeId: p.id, previousId: null };
    }
  } catch {
    /* storage unavailable or corrupt: start empty */
  }
  const p = emptyProject();
  return { projects: [p], activeId: p.id, previousId: null };
}

export function saveWorkspace(w: Workspace): void {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(w));
  } catch {
    /* ignore quota/private-mode errors */
  }
}

/** "coverage_layers_2026-07-02-121256.json" -> "coverage_layers_2026-07-02-121256" */
export function baseName(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, "") || filename;
}

/** Return `name`, or "name (2)", "name (3)", ... if the name is already used. */
export function uniqueName(name: string, existing: string[]): string {
  if (!existing.includes(name)) return name;
  for (let i = 2; ; i++) if (!existing.includes(`${name} (${i})`)) return `${name} (${i})`;
}
