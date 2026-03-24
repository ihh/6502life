import { describe, it, expect } from 'vitest';
import { swapEdge, edgeRect } from '../board-merge.js';
import { executeShare } from '../share-protocol.js';
import { Board6502Engine } from '../engines/board6502.js';
import { readCellMemory, writeCellBytes } from '../../engine/board.js';
import { sha256, toHex } from '../hash.js';

// --- Helpers ---

function makeEngine(seed = 42, size = 8) {
  const engine = new Board6502Engine();
  engine.init({ size, seed });
  return engine;
}

function cellChecksum(engine, i, j) {
  const data = readCellMemory(engine.controller, i, j);
  return toHex(sha256(data));
}

function randomizeEngine(engine) {
  const B = engine.size;
  for (let i = 0; i < B; i++) {
    for (let j = 0; j < B; j++) {
      const data = new Uint8Array(1024);
      for (let k = 0; k < 1024; k++) data[k] = Math.random() * 256 | 0;
      writeCellBytes(engine.controller, i, j, 0, data);
    }
  }
}

// --- edgeRect tests ---

describe('edgeRect', () => {
  it('south edge: D=2, W=8 on 8x8 board', () => {
    const { cells, W, D } = edgeRect(8, 'south', 8, 2);
    expect(W).toBe(8);
    expect(D).toBe(2);
    expect(cells.length).toBe(16);
    // South edge: j=0 and j=1, i=0..7
    for (const { i, j } of cells) {
      expect(j).toBeLessThan(2);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(8);
    }
  });

  it('east edge: D=3, W=4 on 8x8 board', () => {
    const { cells } = edgeRect(8, 'east', 4, 3);
    expect(cells.length).toBe(12);
    // East edge: i=7,6,5 (depth 3 from right), j centered
    for (const { i, j } of cells) {
      expect(i).toBeGreaterThanOrEqual(5);
      expect(i).toBeLessThan(8);
    }
  });

  it('centers strip when W < B', () => {
    const { cells } = edgeRect(8, 'north', 4, 1);
    // W=4 on B=8, offset=2, so i should be 2,3,4,5
    const iVals = new Set(cells.map(c => c.i));
    expect(iVals).toEqual(new Set([2, 3, 4, 5]));
    // North edge depth 1: j=7
    for (const { j } of cells) {
      expect(j).toBe(7);
    }
  });
});

// --- swapEdge tests ---

describe('swapEdge', () => {
  it('swaps cells between two same-size boards', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);
    randomizeEngine(a);
    randomizeEngine(b);

    // Record pre-swap checksums for edge cells
    const preA_0_0 = cellChecksum(a, 0, 0);
    const preB_7_0 = cellChecksum(b, 7, 0);

    const result = swapEdge(a, 'west', b, 'east', { depth: 1 });

    expect(result.width).toBe(8);
    expect(result.depth).toBe(1);

    // After swap: A's west column should have B's east column data
    const postA_0_0 = cellChecksum(a, 0, 0);
    const postB_7_0 = cellChecksum(b, 7, 0);

    // A's cell (0,0) should now contain what was B's cell (7,0)
    expect(postA_0_0).toBe(preB_7_0);
    // B's cell (7,0) should now contain what was A's cell (0,0)
    expect(postB_7_0).toBe(preA_0_0);
  });

  it('works with different-size boards', () => {
    const a = makeEngine(42, 16);
    const b = makeEngine(99, 8);
    randomizeEngine(a);
    randomizeEngine(b);

    // W = min(16, 8) = 8
    const result = swapEdge(a, 'east', b, 'west', { depth: 2 });
    expect(result.width).toBe(8);
    expect(result.depth).toBe(2);
  });

  it('preserves lastWriter across swap', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    // Set known lastWriter values
    a.controller.lastWriter[0] = 'alice';  // cell (0,0)
    b.controller.lastWriter[7] = 'bob';    // cell (0,7) in B's east strip at depth=1 is i=7, j=0

    // Actually let's use the west edge of A (i=0) and east edge of B (i=7)
    // Cell index = j + B*i, so cell (0,0) = idx 0, cell (7,0) = idx 0 + 8*7 = 56
    a.controller.lastWriter[0] = 'alice';
    b.controller.lastWriter[56] = 'bob';

    swapEdge(a, 'west', b, 'east', { depth: 1 });

    // After swap: A's (0,0) should have bob's provenance
    expect(a.controller.lastWriter[0]).toBe('bob');
    // B's (7,0) should have alice's provenance
    expect(b.controller.lastWriter[56]).toBe('alice');
  });

  it('hashes change after swap', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);
    randomizeEngine(a);
    randomizeEngine(b);

    const result = swapEdge(a, 'east', b, 'west', { depth: 1 });

    expect(result.preHashA).not.toBe(result.postHashA);
    expect(result.preHashB).not.toBe(result.postHashB);
  });

  it('double swap restores original state', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);
    randomizeEngine(a);
    randomizeEngine(b);

    const hashA0 = toHex(sha256(a.serialize()));
    const hashB0 = toHex(sha256(b.serialize()));

    swapEdge(a, 'east', b, 'west', { depth: 2 });
    swapEdge(a, 'east', b, 'west', { depth: 2 });

    expect(toHex(sha256(a.serialize()))).toBe(hashA0);
    expect(toHex(sha256(b.serialize()))).toBe(hashB0);
  });

  it('depth defaults to min board size', () => {
    const a = makeEngine(42, 4);
    const b = makeEngine(99, 8);

    const result = swapEdge(a, 'east', b, 'west');
    expect(result.width).toBe(4);
    expect(result.depth).toBe(4);
  });

  it('throws on depth < 1', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);
    expect(() => swapEdge(a, 'east', b, 'west', { depth: 0 })).toThrow();
  });

  it('all four edges work', () => {
    for (const edge of ['north', 'south', 'east', 'west']) {
      const a = makeEngine(42, 8);
      const b = makeEngine(99, 8);
      randomizeEngine(a);
      randomizeEngine(b);
      const result = swapEdge(a, edge, b, edge, { depth: 1 });
      expect(result.preHashA).not.toBe(result.postHashA);
    }
  });
});

// --- ShareSession (executeShare) ---

describe('executeShare', () => {
  it('executes a share with defaults', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);
    randomizeEngine(a);
    randomizeEngine(b);

    const result = executeShare(a, b);
    expect(result.preHashA).not.toBe(result.postHashA);
    expect(result.edgeA).toBe('east');
    expect(result.edgeB).toBe('west');
  });

  it('accepts custom edges and depth', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);
    randomizeEngine(a);
    randomizeEngine(b);

    const result = executeShare(a, b, {
      edgeA: 'north',
      edgeB: 'south',
      depth: 2,
    });
    expect(result.depth).toBe(2);
    expect(result.edgeA).toBe('north');
    expect(result.edgeB).toBe('south');
  });

  it('works with different board sizes', () => {
    const a = makeEngine(42, 16);
    const b = makeEngine(99, 8);
    randomizeEngine(a);
    randomizeEngine(b);

    const result = executeShare(a, b, { depth: 3 });
    expect(result.width).toBe(8);
    expect(result.depth).toBe(3);
  });
});
