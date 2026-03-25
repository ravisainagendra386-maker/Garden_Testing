/**
 * Merkle-style binary funding tree: N unique assets from the API, each parent funds ≤2 children.
 * Heap layout on indices 0..N-1: parent i has children 2i+1, 2i+2 when < N.
 * N is the number of asset ids passed in (fetched from Garden, not a fixed constant).
 */

function depthFromRoot(index) {
  let d = 0;
  let i = index;
  while (i > 0) {
    i = Math.floor((i - 1) / 2);
    d++;
  }
  return d;
}

/**
 * @param {string[]} assetIds — length N ≥ 1, all unique (Garden asset ids)
 */
function buildBinaryFundingTree(assetIds) {
  const n = Array.isArray(assetIds) ? assetIds.length : 0;
  if (n < 1) {
    throw new Error("fundingTree: need at least one asset id from the catalog");
  }
  const set = new Set(assetIds.map(String));
  if (set.size !== n) {
    throw new Error("fundingTree: asset ids must be unique (no duplicates)");
  }
  const nodes = assetIds.map((assetId, index) => ({
    index,
    assetId: String(assetId),
    parent: index === 0 ? null : Math.floor((index - 1) / 2),
    left: index * 2 + 1 < n ? index * 2 + 1 : null,
    right: index * 2 + 2 < n ? index * 2 + 2 : null,
  }));
  return { rootIndex: 0, nodes, size: n };
}

function listFundingEdges(tree) {
  const out = [];
  for (let i = 0; i < tree.size; i++) {
    const n = tree.nodes[i];
    if (n.left !== null) {
      out.push({
        parent: i,
        child: n.left,
        parentAssetId: n.assetId,
        childAssetId: tree.nodes[n.left].assetId,
      });
    }
    if (n.right !== null) {
      out.push({
        parent: i,
        child: n.right,
        parentAssetId: n.assetId,
        childAssetId: tree.nodes[n.right].assetId,
      });
    }
  }
  return out;
}

/** Group parent→child edges by depth of the child (funding wave). */
function groupEdgesByChildDepth(tree) {
  const edges = listFundingEdges(tree);
  const byLevel = new Map();
  for (const e of edges) {
    const lv = depthFromRoot(e.child);
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(e);
  }
  return [...byLevel.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, es]) => ({ level, edges: es }));
}

function validateFundingTreeStructure(tree) {
  const errors = [];
  const seen = new Set();
  for (const n of tree.nodes) {
    if (seen.has(n.assetId)) errors.push(`duplicate asset in tree: ${n.assetId}`);
    seen.add(n.assetId);
  }
  if (seen.size !== tree.size) {
    errors.push(`expected ${tree.size} unique nodes, got ${seen.size}`);
  }
  const edges = listFundingEdges(tree);
  const expectedEdges = Math.max(0, tree.size - 1);
  if (edges.length !== expectedEdges) {
    errors.push(`expected ${expectedEdges} edges in binary tree, got ${edges.length}`);
  }
  const maxD = tree.size > 0 ? Math.max(...tree.nodes.map((_, i) => depthFromRoot(i))) : 0;
  return {
    ok: errors.length === 0,
    errors,
    nodeCount: tree.size,
    edgeCount: edges.length,
    maxDepth: maxD,
  };
}

function tracePathToRoot(childIndex) {
  const path = [];
  let i = childIndex;
  while (i >= 0) {
    path.unshift(i);
    if (i === 0) break;
    i = Math.floor((i - 1) / 2);
  }
  return path;
}

/** Indices with no children (terminal assets in the funding tree). */
function listLeafIndices(tree) {
  const out = [];
  for (let i = 0; i < tree.size; i++) {
    const n = tree.nodes[i];
    if (n.left === null && n.right === null) out.push(i);
  }
  return out;
}

/**
 * After funding flows down the tree, each leaf swaps back to the root asset (e.g. G→A, E→A).
 * Root index is always 0 in heap layout.
 */
function buildReturnToRootEdges(tree) {
  const root = 0;
  const leaves = listLeafIndices(tree);
  const out = [];
  for (const leaf of leaves) {
    if (leaf === root) continue;
    out.push({
      kind: "return_to_root",
      leafIndex: leaf,
      rootIndex: root,
      leafAssetId: tree.nodes[leaf].assetId,
      rootAssetId: tree.nodes[root].assetId,
    });
  }
  return out;
}

module.exports = {
  buildBinaryFundingTree,
  listFundingEdges,
  groupEdgesByChildDepth,
  validateFundingTreeStructure,
  depthFromRoot,
  tracePathToRoot,
  listLeafIndices,
  buildReturnToRootEdges,
};
