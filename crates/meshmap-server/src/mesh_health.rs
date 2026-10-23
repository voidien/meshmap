//! How fragile a mesh is: the same definitions as the browser's mesh health (web/src/meshHealth.ts), without gateways.
//! The network is what is connected to the largest group (or, with gateways, what reaches one); a node is a single point of failure when losing it cuts other
//! nodes off from that group, a link is a bridge when losing it does. Brute-force removal keeps the definitions exact.

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Fragility {
    /// lower is stronger: nodes cut off by each single point of failure and bridge, plus two per node beyond the hop limit and five per node outside the main group (more than the three cut-offs a chain through it costs, so joining a stray node always counts as progress)
    pub score: usize,
    /// nodes whose loss cuts others off
    pub spofs: Vec<usize>,
    /// links whose loss cuts nodes off
    pub bridges: Vec<(usize, usize)>,
    /// nodes outside the network (the largest group, or what reaches a gateway)
    pub stranded: Vec<usize>,
    /// connected nodes farther than the hop limit from every gateway (two points each)
    pub beyond: Vec<usize>,
}

fn adjacency(n: usize, edges: &[(usize, usize)], skip_node: Option<usize>, skip_edge: Option<usize>) -> Vec<Vec<usize>> {
    let mut adj = vec![Vec::new(); n];
    for (k, &(a, b)) in edges.iter().enumerate() {
        if Some(k) == skip_edge || Some(a) == skip_node || Some(b) == skip_node || a >= n || b >= n || a == b {
            continue;
        }
        adj[a].push(b);
        adj[b].push(a);
    }
    adj
}

/// The largest connected group among the nodes that are present (the first largest wins a tie).
fn largest_group(adj: &[Vec<usize>], present: &dyn Fn(usize) -> bool) -> Vec<bool> {
    let n = adj.len();
    let mut seen = vec![false; n];
    let mut best: Vec<usize> = Vec::new();
    for s in 0..n {
        if seen[s] || !present(s) {
            continue;
        }
        let mut comp = vec![s];
        seen[s] = true;
        let mut i = 0;
        while i < comp.len() {
            for &w in &adj[comp[i]] {
                if !seen[w] {
                    seen[w] = true;
                    comp.push(w);
                }
            }
            i += 1;
        }
        if comp.len() > best.len() {
            best = comp;
        }
    }
    let mut mask = vec![false; n];
    for v in best {
        mask[v] = true;
    }
    mask
}

/// Gateways and hop limit, when the network has them (the same idea as the browser's mesh health).
#[derive(Debug, Default, Clone)]
pub struct Context {
    /// nodes that connect the mesh to the outside; the network is then what can reach one of them
    pub gateways: Vec<usize>,
    /// a node farther than this many hops from every gateway is degraded (needs gateways)
    pub hop_limit: Option<usize>,
}

/// Hops from the nearest of `starts` over the nodes that are present; `None` where unreachable.
fn hops_from(adj: &[Vec<usize>], starts: &[usize], present: &dyn Fn(usize) -> bool) -> Vec<Option<usize>> {
    let mut dist = vec![None; adj.len()];
    let mut queue = Vec::new();
    for &s in starts {
        if s < adj.len() && present(s) && dist[s].is_none() {
            dist[s] = Some(0);
            queue.push(s);
        }
    }
    let mut i = 0;
    while i < queue.len() {
        let v = queue[i];
        for &w in &adj[v] {
            if dist[w].is_none() {
                dist[w] = Some(dist[v].unwrap_or(0) + 1);
                queue.push(w);
            }
        }
        i += 1;
    }
    dist
}

/// The nodes that count as connected: reachable from a gateway, or the largest group when there is none.
fn reach_of(adj: &[Vec<usize>], ctx: &Context, present: &dyn Fn(usize) -> bool) -> Vec<bool> {
    if ctx.gateways.is_empty() {
        largest_group(adj, present)
    } else {
        hops_from(adj, &ctx.gateways, present).iter().map(|d| d.is_some()).collect()
    }
}

pub fn fragility(n: usize, edges: &[(usize, usize)]) -> Fragility {
    fragility_with(n, edges, &Context::default())
}

pub fn fragility_with(n: usize, edges: &[(usize, usize)], ctx: &Context) -> Fragility {
    let ctx = Context { gateways: ctx.gateways.iter().copied().filter(|&g| g < n).collect(), hop_limit: ctx.hop_limit };
    let adj = adjacency(n, edges, None, None);
    let reach = reach_of(&adj, &ctx, &|_| true);
    let cut_off = |skip_node: Option<usize>, skip_edge: Option<usize>| -> usize {
        let after = reach_of(&adjacency(n, edges, skip_node, skip_edge), &ctx, &|v| Some(v) != skip_node);
        (0..n).filter(|&v| reach[v] && Some(v) != skip_node && !after[v]).count()
    };
    let mut out = Fragility::default();
    for (v, &in_reach) in reach.iter().enumerate() {
        if in_reach {
            let c = cut_off(Some(v), None);
            if c > 0 {
                out.spofs.push(v);
                out.score += c;
            }
        } else {
            out.stranded.push(v);
        }
    }
    for (k, &(a, b)) in edges.iter().enumerate() {
        if a >= n || b >= n || a == b || (!reach[a] && !reach[b]) {
            continue;
        }
        let c = cut_off(None, Some(k));
        if c > 0 {
            out.bridges.push((a, b));
            out.score += c;
        }
    }
    out.score += 5 * out.stranded.len();
    if let (false, Some(limit)) = (ctx.gateways.is_empty(), ctx.hop_limit) {
        let hops = hops_from(&adj, &ctx.gateways, &|_| true);
        out.beyond = (0..n).filter(|&v| hops[v].is_some_and(|h| h > limit)).collect();
        out.score += 2 * out.beyond.len();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ring_has_no_weak_spots() {
        let f = fragility(3, &[(0, 1), (1, 2), (0, 2)]);
        assert_eq!(f, Fragility::default());
    }

    #[test]
    fn a_chain_has_a_single_point_of_failure_and_two_bridges() {
        let f = fragility(3, &[(0, 1), (1, 2)]);
        assert_eq!(f.spofs, vec![1]);
        assert_eq!(f.bridges.len(), 2);
        assert!(f.score > 0);
    }

    #[test]
    fn closing_the_chain_into_a_ring_fixes_it() {
        let before = fragility(3, &[(0, 1), (1, 2)]).score;
        let after = fragility(3, &[(0, 1), (1, 2), (0, 2)]).score;
        assert!(after < before && after == 0);
    }

    #[test]
    fn nodes_outside_the_main_group_are_stranded_and_cost_more() {
        let f = fragility(4, &[(0, 1), (1, 2), (0, 2)]);
        assert_eq!(f.stranded, vec![3]);
        assert_eq!(f.score, 5);
        // linking the stray node to two members joins it without creating a weak spot
        assert_eq!(fragility(4, &[(0, 1), (1, 2), (0, 2), (3, 0), (3, 1)]).score, 0);
    }

    #[test]
    fn edges_to_unknown_nodes_and_self_loops_are_ignored() {
        assert_eq!(fragility(2, &[(0, 1), (0, 9), (1, 1)]).spofs.len(), 0);
    }
}

#[cfg(test)]
mod gateway_tests {
    use super::*;

    fn gw(gateways: &[usize], hop_limit: Option<usize>) -> Context {
        Context { gateways: gateways.to_vec(), hop_limit }
    }

    #[test]
    fn a_lone_gateway_is_a_single_point_of_failure_even_in_a_ring() {
        // triangle with one gateway: losing the gateway cuts everyone off from the outside
        let f = fragility_with(3, &[(0, 1), (1, 2), (0, 2)], &gw(&[0], None));
        assert_eq!(f.spofs, vec![0]);
        assert!(f.score > 0);
        // two gateways remove that weakness
        assert_eq!(fragility_with(3, &[(0, 1), (1, 2), (0, 2)], &gw(&[0, 1], None)).score, 0);
    }

    #[test]
    fn nodes_that_cannot_reach_a_gateway_are_stranded_even_when_linked_to_each_other() {
        let f = fragility_with(4, &[(0, 1), (2, 3)], &gw(&[0], None));
        assert_eq!(f.stranded, vec![2, 3]);
    }

    #[test]
    fn hops_beyond_the_limit_cost_two_points_each() {
        // a chain 0-1-2-3 with the gateway at 0: node 3 is three hops out
        let chain = [(0, 1), (1, 2), (2, 3)];
        let near = fragility_with(4, &chain, &gw(&[0], Some(3)));
        let far = fragility_with(4, &chain, &gw(&[0], Some(2)));
        assert!(near.beyond.is_empty());
        assert_eq!(far.beyond, vec![3]);
        assert_eq!(far.score, near.score + 2);
        // without gateways a hop limit means nothing
        assert!(fragility_with(4, &chain, &gw(&[], Some(1))).beyond.is_empty());
    }

    #[test]
    fn a_shortcut_that_brings_a_node_within_the_limit_lowers_the_score() {
        let before = fragility_with(5, &[(0, 1), (1, 2), (2, 3), (3, 4)], &gw(&[0], Some(2)));
        let after = fragility_with(5, &[(0, 1), (1, 2), (2, 3), (3, 4), (0, 3)], &gw(&[0], Some(2)));
        assert!(after.beyond.len() < before.beyond.len());
    }
}

#[cfg(test)]
mod chain_tests {
    use super::*;

    #[test]
    fn joining_two_unlinked_nodes_through_a_third_is_progress() {
        let apart = fragility(2, &[]).score;
        let chain = fragility(3, &[(0, 2), (1, 2)]).score;
        assert!(chain < apart, "{chain} vs {apart}");
    }
}
