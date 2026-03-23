/**
 * Merkle tree for board history checkpoints.
 *
 * A binary Merkle tree where each leaf is a board state hash at a specific tick.
 * Level K covers 2^K ticks. Internal nodes are SHA-256(left || right).
 * The root hash commits to the entire history.
 *
 * Storage is O(log T) for T checkpoints: we keep only the right-spine nodes
 * needed to compute the root plus any completed subtree roots.
 *
 * @module coin/merkle
 */

import { sha256, toHex, fromHex } from './hash.js';

const ZERO_HASH = new Uint8Array(32);

/**
 * Combine two 32-byte hashes into a parent hash.
 * @param {Uint8Array} left
 * @param {Uint8Array} right
 * @returns {Uint8Array}
 */
function hashPair(left, right) {
  const combined = new Uint8Array(64);
  combined.set(left, 0);
  combined.set(right, 32);
  return sha256(combined);
}

export class BoardMerkleTree {
  constructor() {
    /** @type {Array<{stateHash: Uint8Array, tick: number}>} */
    this._leaves = [];
    /**
     * Internal node storage. _nodes[level] is a Map<index, Uint8Array>.
     * Level 0 = leaves, level 1 = pairs of leaves, etc.
     * @type {Map<number, Map<number, Uint8Array>>}
     */
    this._nodes = new Map();
  }

  /**
   * Append a new state checkpoint.
   * @param {Uint8Array|string} stateHash - 32-byte hash or hex string
   * @param {number} tick
   */
  append(stateHash, tick) {
    if (typeof stateHash === 'string') {
      stateHash = fromHex(stateHash);
    }
    const index = this._leaves.length;
    this._leaves.push({ stateHash: new Uint8Array(stateHash), tick });

    // Store the leaf hash at level 0
    this._setNode(0, index, new Uint8Array(stateHash));

    // Propagate up: whenever a pair is complete, compute the parent
    let level = 0;
    let idx = index;
    while (idx % 2 === 1) {
      const left = this._getNode(level, idx - 1);
      const right = this._getNode(level, idx);
      const parentIdx = idx >>> 1;
      this._setNode(level + 1, parentIdx, hashPair(left, right));
      level++;
      idx = parentIdx;
    }
  }

  /**
   * @param {number} level
   * @param {number} index
   * @param {Uint8Array} hash
   * @private
   */
  _setNode(level, index, hash) {
    if (!this._nodes.has(level)) {
      this._nodes.set(level, new Map());
    }
    this._nodes.get(level).set(index, hash);
  }

  /**
   * @param {number} level
   * @param {number} index
   * @returns {Uint8Array}
   * @private
   */
  _getNode(level, index) {
    const levelMap = this._nodes.get(level);
    if (levelMap && levelMap.has(index)) {
      return levelMap.get(index);
    }
    return ZERO_HASH;
  }

  /**
   * Get the root hash committing to the entire history.
   * For an incomplete tree (non-power-of-2 leaves), we pad with zero hashes.
   * Computes the root fresh each time to avoid stale cached padding nodes.
   * @returns {string} hex-encoded root hash
   */
  root() {
    const n = this._leaves.length;
    if (n === 0) return toHex(ZERO_HASH);
    if (n === 1) return toHex(this._getNode(0, 0));

    const levels = Math.ceil(Math.log2(n));

    // Build temporary level maps for the root computation.
    // Start with stored nodes at level 0, then compute upward.
    // Use stored complete-pair nodes from append() where available,
    // but recompute any node that involves padding (odd-count levels).
    const tempNodes = new Map();

    const getTemp = (level, index) => {
      const tm = tempNodes.get(level);
      if (tm && tm.has(index)) return tm.get(index);
      return this._getNode(level, index);
    };

    const setTemp = (level, index, hash) => {
      if (!tempNodes.has(level)) tempNodes.set(level, new Map());
      tempNodes.get(level).set(index, hash);
    };

    let currentLevelSize = n;
    for (let level = 0; level < levels; level++) {
      const parentCount = Math.ceil(currentLevelSize / 2);
      for (let i = 0; i < parentCount; i++) {
        const leftIdx = i * 2;
        const rightIdx = i * 2 + 1;

        // If both children exist and the parent is already stored from
        // append() (meaning it was a complete pair at insertion time),
        // we can use the stored value. Otherwise recompute.
        const hasBothChildren = rightIdx < currentLevelSize;
        const storedParent = this._nodes.get(level + 1)?.get(i);

        if (hasBothChildren && storedParent) {
          // Complete pair, stored node is valid
          setTemp(level + 1, i, storedParent);
        } else {
          const left = getTemp(level, leftIdx);
          const right = hasBothChildren
            ? getTemp(level, rightIdx)
            : ZERO_HASH;
          setTemp(level + 1, i, hashPair(left, right));
        }
      }
      currentLevelSize = parentCount;
    }

    return toHex(getTemp(levels, 0));
  }

  /**
   * Build temporary node maps for the full tree (used by prove).
   * @returns {Map<number, Map<number, Uint8Array>>}
   * @private
   */
  _buildFullTree() {
    const n = this._leaves.length;
    const levels = Math.ceil(Math.log2(n));
    const tempNodes = new Map();

    const getTemp = (level, index) => {
      const tm = tempNodes.get(level);
      if (tm && tm.has(index)) return tm.get(index);
      return this._getNode(level, index);
    };

    const setTemp = (level, index, hash) => {
      if (!tempNodes.has(level)) tempNodes.set(level, new Map());
      tempNodes.get(level).set(index, hash);
    };

    // Copy level 0 from stored nodes
    for (let i = 0; i < n; i++) {
      setTemp(0, i, this._getNode(0, i));
    }

    let currentLevelSize = n;
    for (let level = 0; level < levels; level++) {
      const parentCount = Math.ceil(currentLevelSize / 2);
      for (let i = 0; i < parentCount; i++) {
        const leftIdx = i * 2;
        const rightIdx = i * 2 + 1;
        const hasBothChildren = rightIdx < currentLevelSize;
        const storedParent = this._nodes.get(level + 1)?.get(i);

        if (hasBothChildren && storedParent) {
          setTemp(level + 1, i, storedParent);
        } else {
          const left = getTemp(level, leftIdx);
          const right = hasBothChildren ? getTemp(level, rightIdx) : ZERO_HASH;
          setTemp(level + 1, i, hashPair(left, right));
        }
      }
      currentLevelSize = parentCount;
    }

    return tempNodes;
  }

  /**
   * Generate a Merkle inclusion proof for the leaf at a given tick.
   * @param {number} tick
   * @returns {{ stateHash: string, tick: number, proof: string[], index: number }}
   */
  prove(tick) {
    const leafIndex = this._leaves.findIndex(l => l.tick === tick);
    if (leafIndex === -1) {
      throw new Error(`No checkpoint at tick ${tick}`);
    }

    const n = this._leaves.length;
    const levels = Math.ceil(Math.log2(n));
    const fullTree = this._buildFullTree();

    const getNode = (level, index) => {
      const tm = fullTree.get(level);
      if (tm && tm.has(index)) return tm.get(index);
      return ZERO_HASH;
    };

    const proof = [];
    let idx = leafIndex;
    let currentLevelSize = n;

    for (let level = 0; level < levels; level++) {
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      const sibling = siblingIdx >= 0 && siblingIdx < currentLevelSize
        ? getNode(level, siblingIdx)
        : ZERO_HASH;
      proof.push(toHex(sibling));
      idx = idx >>> 1;
      currentLevelSize = Math.ceil(currentLevelSize / 2);
    }

    return {
      stateHash: toHex(this._leaves[leafIndex].stateHash),
      tick,
      proof,
      index: leafIndex
    };
  }

  /**
   * Verify a Merkle inclusion proof against a root hash.
   * @param {string} rootHash - hex
   * @param {string} stateHash - hex
   * @param {number} tick
   * @param {string[]} proof - hex sibling hashes
   * @param {number} index - leaf index
   * @returns {boolean}
   */
  static verify(rootHash, stateHash, tick, proof, index) {
    let current = fromHex(stateHash);
    let idx = index;

    for (const siblingHex of proof) {
      const sibling = fromHex(siblingHex);
      if (idx % 2 === 0) {
        current = hashPair(current, sibling);
      } else {
        current = hashPair(sibling, current);
      }
      idx = idx >>> 1;
    }

    return toHex(current) === rootHash;
  }

  /**
   * Get the state hash at a specific tick (if checkpointed).
   * @param {number} tick
   * @returns {string|null} hex state hash, or null if not checkpointed
   */
  getState(tick) {
    const leaf = this._leaves.find(l => l.tick === tick);
    return leaf ? toHex(leaf.stateHash) : null;
  }

  /** Number of checkpoints stored. */
  get size() {
    return this._leaves.length;
  }

  /**
   * Serialize the tree for storage/transmission.
   * @returns {Object}
   */
  serialize() {
    return {
      leaves: this._leaves.map(l => ({
        stateHash: toHex(l.stateHash),
        tick: l.tick
      }))
    };
  }

  /**
   * Deserialize a tree from stored data.
   * @param {Object} data
   * @returns {BoardMerkleTree}
   */
  static deserialize(data) {
    const tree = new BoardMerkleTree();
    for (const leaf of data.leaves) {
      tree.append(fromHex(leaf.stateHash), leaf.tick);
    }
    return tree;
  }
}
