/**
 * Mesh health: which nodes and links hold the network together.
 *
 * The graph has a node per mesh node and an edge per usable link (both directions work, so the edge carries the worse
 * direction's margin). "Reach" is what the network is for: everything connected to a gateway, or, with no gateway
 * chosen, everything in the largest group. A node is a single point of failure when losing it cuts other nodes off from
 * that reach; a link is a bridge when losing it does. Brute-force removal keeps the definitions obvious and exact;
 * the graphs here (up to a few hundred nodes) are small.
 */

export interface Edge {
  a: string;
  b: string;
  marginDb: number;
}

export interface HealthInput {
  nodeIds: string[];
  edges: Edge[];
  /** Nodes that connect the mesh to the outside (for example MQTT uplink nodes). */
  gateways: string[];
  /** Meshtastic forwards a packet at most this many times (default 3; the maximum is 7). */
  hopLimit: number;
}

export interface Spof {
  id: string;
  /** nodes that lose their connection to the network if this one is lost */
  cutOff: string[];
}

export interface BridgeLink extends Edge {
  cutOff: string[];
}

export interface Health {
  /** groups of connected nodes, largest first */
  groups: string[][];
  /** nodes with no usable link at all */
  isolated: string[];
  /** nodes with exactly one link (cut off if that neighbour or link fails) */
  singleLinked: string[];
  reach: Set<string>;
  /** whether reach is measured from gateways (true) or is just the largest group (false) */
  fromGateways: boolean;
  /** hops from the nearest gateway; -1 when unreachable. Null without gateways. */
  hops: Map<string, number> | null;
  /** beyond the hop limit from every gateway (reachable, but too many hops) */
  beyondHopLimit: string[];
  /** not connected to any gateway (only with gateways) */
  noGateway: string[];
  maxHops: number | null;
  spofs: Spof[];
  bridges: BridgeLink[];
}

type Adj = Map<string, Set<string>>;

function adjacency(nodeIds: string[], edges: Edge[], skipNode?: string, skipEdge?: Edge): Adj {
  const adj: Adj = new Map(nodeIds.filter((id) => id !== skipNode).map((id) => [id, new Set<string>()]));
  for (const e of edges) {
    if (e.a === skipNode || e.b === skipNode || e === skipEdge) continue;
    adj.get(e.a)?.add(e.b);
    adj.get(e.b)?.add(e.a);
  }
  return adj;
}

function bfs(adj: Adj, starts: string[]): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const s of starts) if (adj.has(s) && !dist.has(s)) (dist.set(s, 0), queue.push(s));
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i];
    for (const w of adj.get(v)!) if (!dist.has(w)) (dist.set(w, dist.get(v)! + 1), queue.push(w));
  }
  return dist;
}

function components(adj: Adj): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const id of adj.keys()) {
    if (seen.has(id)) continue;
    const comp = [...bfs(adj, [id]).keys()];
    comp.forEach((c) => seen.add(c));
    out.push(comp);
  }
  return out.sort((x, y) => y.length - x.length);
}

/** The nodes that count as connected: reachable from a gateway, or the largest group when there is none. */
function reachOf(adj: Adj, gateways: string[]): Set<string> {
  const gws = gateways.filter((g) => adj.has(g));
  if (gateways.length > 0) return new Set(bfs(adj, gws).keys());
  const groups = components(adj);
  return new Set(groups[0] ?? []);
}

/**
 * Nodes of `reach` that lose their connection when `node` (or `edge`) is removed. With gateways: not reachable from any
 * remaining gateway (so a lone gateway is itself a single point of failure). Without: split off from the largest
 * remaining group.
 */
function cutOffBy(input: HealthInput, reach: Set<string>, node?: string, edge?: Edge): string[] {
  const after = reachOf(adjacency(input.nodeIds, input.edges, node, edge), input.gateways.filter((g) => input.nodeIds.includes(g)).length > 0 ? input.gateways : []);
  return [...reach].filter((id) => id !== node && !after.has(id));
}

export function analyzeHealth(input: HealthInput): Health {
  const { nodeIds, edges, hopLimit } = input;
  const gateways = input.gateways.filter((g) => nodeIds.includes(g));
  const adj = adjacency(nodeIds, edges);
  const groups = components(adj);
  const reach = reachOf(adj, gateways);
  const fromGateways = gateways.length > 0;

  let hops: Map<string, number> | null = null;
  let beyondHopLimit: string[] = [];
  let noGateway: string[] = [];
  let maxHops: number | null = null;
  if (fromGateways) {
    const d = bfs(adj, gateways);
    hops = new Map(nodeIds.map((id) => [id, d.get(id) ?? -1]));
    beyondHopLimit = nodeIds.filter((id) => (hops!.get(id) ?? -1) > hopLimit);
    noGateway = nodeIds.filter((id) => hops!.get(id) === -1);
    const reached = [...hops.values()].filter((v) => v >= 0);
    maxHops = reached.length ? Math.max(...reached) : null;
  }

  const spofs: Spof[] = [];
  for (const id of nodeIds) {
    if (!reach.has(id)) continue;
    const cutOff = cutOffBy(input, reach, id);
    if (cutOff.length > 0) spofs.push({ id, cutOff });
  }
  spofs.sort((x, y) => y.cutOff.length - x.cutOff.length || x.id.localeCompare(y.id));

  const bridges: BridgeLink[] = [];
  for (const e of edges) {
    if (!reach.has(e.a) && !reach.has(e.b)) continue;
    const cutOff = cutOffBy(input, reach, undefined, e);
    if (cutOff.length > 0) bridges.push({ ...e, cutOff });
  }
  bridges.sort((x, y) => y.cutOff.length - x.cutOff.length || x.marginDb - y.marginDb);

  return {
    groups,
    isolated: nodeIds.filter((id) => adj.get(id)!.size === 0),
    singleLinked: nodeIds.filter((id) => adj.get(id)!.size === 1),
    reach,
    fromGateways,
    hops,
    beyondHopLimit,
    noGateway,
    maxHops,
    spofs,
    bridges,
  };
}

export interface FailureImpact {
  failedId: string;
  /** nodes that lose their connection to the network */
  cutOff: string[];
  /** nodes still connected but now beyond the hop limit (only with gateways) */
  nowBeyondHopLimit: string[];
  groupsBefore: number;
  groupsAfter: number;
}

/** What happens if one node is lost. */
export function simulateFailure(input: HealthInput, failedId: string): FailureImpact {
  const before = analyzeHealth(input);
  const cutOff = cutOffBy(input, before.reach, failedId);
  const after = analyzeHealth({ ...input, nodeIds: input.nodeIds.filter((id) => id !== failedId), edges: input.edges.filter((e) => e.a !== failedId && e.b !== failedId) });
  const wasBeyond = new Set(before.beyondHopLimit);
  const nowBeyondHopLimit = after.beyondHopLimit.filter((id) => !wasBeyond.has(id));
  return { failedId, cutOff, nowBeyondHopLimit, groupsBefore: before.groups.length, groupsAfter: after.groups.length };
}

/** Usable links as graph edges: both directions meet the margin (the link's worst-direction margin is what is compared). */
export function edgesFromLinks(links: { a: string; b: string; class: string; result?: { margin_db: number } }[], minMarginDb: number): Edge[] {
  return links.filter((l) => l.class !== "none" && l.result && l.result.margin_db >= minMarginDb).map((l) => ({ a: l.a, b: l.b, marginDb: l.result!.margin_db }));
}
