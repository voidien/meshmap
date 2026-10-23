//! How fragile a mesh is: the same definitions as the browser's mesh health (web/src/meshHealth.ts), without gateways.
//! The network is what is connected to the largest group; a node is a single point of failure when losing it cuts other
//! nodes off from that group, a link is a bridge when losing it does. Brute-force removal keeps the definitions exact.

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Fragility {
    /// lower is stronger: nodes cut off by each single point of failure and bridge, plus five per node outside the main group (more than the three cut-offs a chain through it costs, so joining a stray node always counts as progress)
    pub score: usize,
    /// nodes whose loss cuts others off
    pub spofs: Vec<usize>,
    /// links whose loss cuts nodes off
    pub bridges: Vec<(usize, usize)>,
    /// nodes outside the largest group
    pub stranded: Vec<usize>,
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

pub fn fragility(n: usize, edges: &[(usize, usize)]) -> Fragility {
    let adj = adjacency(n, edges, None, None);
    let reach = largest_group(&adj, &|_| true);
    let cut_off = |skip_node: Option<usize>, skip_edge: Option<usize>| -> usize {
        let after = largest_group(&adjacency(n, edges, skip_node, skip_edge), &|v| Some(v) != skip_node);
        (0..n).filter(|&v| reach[v] && Some(v) != skip_node && !after[v]).count()
    };
    let mut out = Fragility::default();
    for v in 0..n {
        if reach[v] {
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
mod chain_tests {
    use super::*;

    #[test]
    fn joining_two_unlinked_nodes_through_a_third_is_progress() {
        let apart = fragility(2, &[]).score;
        let chain = fragility(3, &[(0, 2), (1, 2)]).score;
        assert!(chain < apart, "{chain} vs {apart}");
    }
}
