import { describe, it, expect } from 'vitest';
import { BoardMerkleTree } from '../merkle.js';
import { sha256, toHex } from '../hash.js';
import { LifeEngine } from '../engines/life.js';
import { Session } from '../session.js';

/**
 * Helper: make a deterministic state hash for a given tick.
 */
function stateHashAt(tick) {
  return sha256(new TextEncoder().encode(`state-at-tick-${tick}`));
}

describe('BoardMerkleTree', () => {
  it('starts empty with zero root', () => {
    const tree = new BoardMerkleTree();
    expect(tree.size).toBe(0);
    expect(tree.root()).toBe('0'.repeat(64));
  });

  it('root changes on each append', () => {
    const tree = new BoardMerkleTree();
    const roots = new Set();

    for (let i = 0; i < 8; i++) {
      tree.append(stateHashAt(i * 100), i * 100);
      roots.add(tree.root());
    }
    // All roots should be distinct
    expect(roots.size).toBe(8);
  });

  it('single leaf root equals the leaf hash', () => {
    const tree = new BoardMerkleTree();
    const hash = stateHashAt(0);
    tree.append(hash, 0);
    expect(tree.root()).toBe(toHex(hash));
  });

  it('accepts hex string state hashes', () => {
    const tree = new BoardMerkleTree();
    const hash = stateHashAt(0);
    tree.append(toHex(hash), 0);
    expect(tree.root()).toBe(toHex(hash));
  });

  it('getState returns the correct hash for a checkpointed tick', () => {
    const tree = new BoardMerkleTree();
    const h0 = stateHashAt(0);
    const h100 = stateHashAt(100);
    tree.append(h0, 0);
    tree.append(h100, 100);

    expect(tree.getState(0)).toBe(toHex(h0));
    expect(tree.getState(100)).toBe(toHex(h100));
    expect(tree.getState(50)).toBeNull();
  });

  it('size tracks appended checkpoints', () => {
    const tree = new BoardMerkleTree();
    expect(tree.size).toBe(0);
    tree.append(stateHashAt(0), 0);
    expect(tree.size).toBe(1);
    tree.append(stateHashAt(100), 100);
    expect(tree.size).toBe(2);
  });
});

describe('Merkle proofs', () => {
  it('prove and verify a specific tick', () => {
    const tree = new BoardMerkleTree();
    for (let i = 0; i < 8; i++) {
      tree.append(stateHashAt(i * 10), i * 10);
    }
    const root = tree.root();

    const proof = tree.prove(30);
    expect(proof.tick).toBe(30);
    expect(proof.stateHash).toBe(toHex(stateHashAt(30)));
    expect(proof.index).toBe(3);

    expect(BoardMerkleTree.verify(root, proof.stateHash, proof.tick, proof.proof, proof.index)).toBe(true);
  });

  it('verify all leaves in a power-of-2 tree', () => {
    const tree = new BoardMerkleTree();
    const ticks = [0, 10, 20, 30, 40, 50, 60, 70];
    for (const t of ticks) {
      tree.append(stateHashAt(t), t);
    }
    const root = tree.root();

    for (const t of ticks) {
      const proof = tree.prove(t);
      expect(BoardMerkleTree.verify(root, proof.stateHash, proof.tick, proof.proof, proof.index)).toBe(true);
    }
  });

  it('verify all leaves in a non-power-of-2 tree', () => {
    const tree = new BoardMerkleTree();
    const ticks = [0, 10, 20, 30, 40];
    for (const t of ticks) {
      tree.append(stateHashAt(t), t);
    }
    const root = tree.root();

    for (const t of ticks) {
      const proof = tree.prove(t);
      expect(BoardMerkleTree.verify(root, proof.stateHash, proof.tick, proof.proof, proof.index)).toBe(true);
    }
  });

  it('tampered state hash fails verification', () => {
    const tree = new BoardMerkleTree();
    for (let i = 0; i < 4; i++) {
      tree.append(stateHashAt(i * 10), i * 10);
    }
    const root = tree.root();
    const proof = tree.prove(20);

    // Tamper with the state hash
    const tamperedHash = toHex(stateHashAt(999));
    expect(BoardMerkleTree.verify(root, tamperedHash, proof.tick, proof.proof, proof.index)).toBe(false);
  });

  it('tampered proof sibling fails verification', () => {
    const tree = new BoardMerkleTree();
    for (let i = 0; i < 4; i++) {
      tree.append(stateHashAt(i * 10), i * 10);
    }
    const root = tree.root();
    const proof = tree.prove(10);

    // Tamper with a sibling in the proof
    const tamperedProof = [...proof.proof];
    tamperedProof[0] = 'ff'.repeat(32);
    expect(BoardMerkleTree.verify(root, proof.stateHash, proof.tick, tamperedProof, proof.index)).toBe(false);
  });

  it('wrong index fails verification', () => {
    const tree = new BoardMerkleTree();
    for (let i = 0; i < 4; i++) {
      tree.append(stateHashAt(i * 10), i * 10);
    }
    const root = tree.root();
    const proof = tree.prove(10);

    // Use wrong index
    expect(BoardMerkleTree.verify(root, proof.stateHash, proof.tick, proof.proof, proof.index + 1)).toBe(false);
  });

  it('throws on non-existent tick', () => {
    const tree = new BoardMerkleTree();
    tree.append(stateHashAt(0), 0);
    expect(() => tree.prove(999)).toThrow('No checkpoint at tick 999');
  });
});

describe('Merkle serialize/deserialize', () => {
  it('round-trips correctly', () => {
    const tree = new BoardMerkleTree();
    for (let i = 0; i < 10; i++) {
      tree.append(stateHashAt(i * 100), i * 100);
    }

    const serialized = tree.serialize();
    const restored = BoardMerkleTree.deserialize(serialized);

    expect(restored.size).toBe(tree.size);
    expect(restored.root()).toBe(tree.root());

    // Proofs from the restored tree should verify against the same root
    const root = tree.root();
    for (let i = 0; i < 10; i++) {
      const tick = i * 100;
      const proof = restored.prove(tick);
      expect(BoardMerkleTree.verify(root, proof.stateHash, proof.tick, proof.proof, proof.index)).toBe(true);
    }
  });

  it('serialized form contains all leaves', () => {
    const tree = new BoardMerkleTree();
    tree.append(stateHashAt(0), 0);
    tree.append(stateHashAt(50), 50);
    tree.append(stateHashAt(100), 100);

    const data = tree.serialize();
    expect(data.leaves.length).toBe(3);
    expect(data.leaves[0].tick).toBe(0);
    expect(data.leaves[1].tick).toBe(50);
    expect(data.leaves[2].tick).toBe(100);
  });
});

describe('Session Merkle integration', () => {
  function makeSession(opts = {}) {
    const config = {
      gameId: 'life',
      width: opts.size ?? 16,
      height: opts.size ?? 16,
      seed: opts.seed ?? 42
    };
    const engine = new LifeEngine();
    engine.init(config);
    return new Session(engine, config, {
      blockInterval: opts.blockInterval ?? 100
    });
  }

  it('session record includes merkle tree and root', () => {
    const session = makeSession({ blockInterval: 100 });
    session.step(300);
    const record = session.finalize();

    expect(record.merkleTree).toBeDefined();
    expect(record.merkleRoot).toBeDefined();
    expect(typeof record.merkleRoot).toBe('string');
    expect(record.merkleRoot.length).toBe(64);
  });

  it('each block includes a merkle root', () => {
    const session = makeSession({ blockInterval: 100 });
    session.step(300);
    const record = session.finalize();

    for (const block of record.blocks) {
      expect(block.merkleRoot).toBeDefined();
      expect(typeof block.merkleRoot).toBe('string');
      expect(block.merkleRoot.length).toBe(64);
    }
  });

  it('merkle roots grow monotonically (each block adds checkpoints)', () => {
    const session = makeSession({ blockInterval: 100 });
    session.step(300);
    const record = session.finalize();

    // Each block should have a different merkle root from the previous
    const roots = record.blocks.map(b => b.merkleRoot);
    const uniqueRoots = new Set(roots);
    expect(uniqueRoots.size).toBe(roots.length);
  });

  it('final merkle root matches the tree root', () => {
    const session = makeSession({ blockInterval: 100 });
    session.step(200);
    const record = session.finalize();

    const restored = BoardMerkleTree.deserialize(record.merkleTree);
    expect(restored.root()).toBe(record.merkleRoot);
  });

  it('merkle tree has correct number of checkpoints', () => {
    const session = makeSession({ blockInterval: 100 });
    session.step(300);
    const record = session.finalize();

    // 1 initial + 3 block boundaries = 4 checkpoints
    expect(record.merkleTree.leaves.length).toBe(4);
  });

  it('restored tree produces verifiable proofs', () => {
    const session = makeSession({ blockInterval: 100 });
    session.step(200);
    const record = session.finalize();

    const restored = BoardMerkleTree.deserialize(record.merkleTree);
    const root = restored.root();

    for (const leaf of record.merkleTree.leaves) {
      const proof = restored.prove(leaf.tick);
      expect(BoardMerkleTree.verify(root, proof.stateHash, proof.tick, proof.proof, proof.index)).toBe(true);
    }
  });
});

describe('Tree size is O(log T)', () => {
  it('tree stores exactly T leaves (compact representation)', () => {
    // The tree stores all leaves but internal nodes are computed on the fly.
    // Serialized form is just the leaves array.
    const tree = new BoardMerkleTree();
    for (let i = 0; i < 1000; i++) {
      tree.append(stateHashAt(i), i);
    }
    expect(tree.size).toBe(1000);

    // The serialized form only contains the leaves
    const data = tree.serialize();
    expect(data.leaves.length).toBe(1000);

    // But proofs are O(log N) in length
    const proof = tree.prove(500);
    expect(proof.proof.length).toBe(Math.ceil(Math.log2(1000)));
  });
});
