import { describe, it, expect } from 'vitest';
import { swapCorner, cornerRect } from '../board-merge.js';
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

// --- cornerRect tests ---

describe('cornerRect', () => {
  it('sw corner: W=3, D=2 on 8x8 board', () => {
    const { cells, W, D } = cornerRect(8, 'sw', 3, 2);
    expect(W).toBe(3);
    expect(D).toBe(2);
    expect(cells.length).toBe(6);
    for (const { i, j } of cells) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(3);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(2);
    }
  });

  it('ne corner: W=2, D=2 on 8x8 board', () => {
    const { cells } = cornerRect(8, 'ne', 2, 2);
    expect(cells.length).toBe(4);
    for (const { i, j } of cells) {
      expect(i).toBeGreaterThanOrEqual(6);
      expect(i).toBeLessThan(8);
      expect(j).toBeGreaterThanOrEqual(6);
      expect(j).toBeLessThan(8);
    }
  });

  it('se corner: W=4, D=1 on 8x8 board', () => {
    const { cells } = cornerRect(8, 'se', 4, 1);
    expect(cells.length).toBe(4);
    for (const { i, j } of cells) {
      expect(i).toBeGreaterThanOrEqual(4);
      expect(j).toBe(0);
    }
  });

  it('nw corner: W=8, D=8 covers entire board', () => {
    const { cells } = cornerRect(8, 'nw', 8, 8);
    expect(cells.length).toBe(64);
  });

  it('all four corners produce non-overlapping 2x2 blocks', () => {
    const allCells = new Set();
    for (const corner of ['sw', 'se', 'nw', 'ne']) {
      const { cells } = cornerRect(8, corner, 2, 2);
      for (const { i, j } of cells) {
        const key = `${i},${j}`;
        expect(allCells.has(key)).toBe(false);
        allCells.add(key);
      }
    }
    expect(allCells.size).toBe(16);
  });
});

// --- swapCorner tests ---

describe('swapCorner', () => {
  it('swaps cells between two same-size boards', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);
    randomizeEngine(a);
    randomizeEngine(b);

    // Record pre-swap checksums for corner cells
    const preA_0_0 = cellChecksum(a, 0, 0);
    const preB_0_0 = cellChecksum(b, 0, 0);

    const result = swapCorner(a, 'sw', b, 'sw', { width: 1, depth: 1 });

    expect(result.width).toBe(1);
    expect(result.depth).toBe(1);

    // After swap: A's (0,0) should have B's old (0,0)
    expect(cellChecksum(a, 0, 0)).toBe(preB_0_0);
    expect(cellChecksum(b, 0, 0)).toBe(preA_0_0);
  });

  it('works with different-size boards', () => {
    const a = makeEngine(42, 16);
    const b = makeEngine(99, 8);
    randomizeEngine(a);
    randomizeEngine(b);

    const result = swapCorner(a, 'se', b, 'sw', { width: 4, depth: 3 });
    expect(result.width).toBe(4);
    expect(result.depth).toBe(3);
  });

  it('W defaults to min board size, D defaults to W', () => {
    const a = makeEngine(42, 4);
    const b = makeEngine(99, 8);

    const result = swapCorner(a, 'ne', b, 'nw');
    expect(result.width).toBe(4);
    expect(result.depth).toBe(4);
  });

  it('preserves lastWriter across swap', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    // SW corner cell (0,0) → cellIdx = 0
    a.controller.lastWriter[0] = 'alice';
    b.controller.lastWriter[0] = 'bob';

    swapCorner(a, 'sw', b, 'sw', { width: 1, depth: 1 });

    expect(a.controller.lastWriter[0]).toBe('bob');
    expect(b.controller.lastWriter[0]).toBe('alice');
  });

  it('hashes change after swap', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);
    randomizeEngine(a);
    randomizeEngine(b);

    const result = swapCorner(a, 'ne', b, 'nw', { width: 2, depth: 2 });

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

    swapCorner(a, 'se', b, 'sw', { width: 3, depth: 2 });
    swapCorner(a, 'se', b, 'sw', { width: 3, depth: 2 });

    expect(toHex(sha256(a.serialize()))).toBe(hashA0);
    expect(toHex(sha256(b.serialize()))).toBe(hashB0);
  });

  it('throws on width < 1', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);
    expect(() => swapCorner(a, 'sw', b, 'sw', { width: 0 })).toThrow();
  });

  it('clamps W to min board size and D to W', () => {
    const a = makeEngine(42, 4);
    const b = makeEngine(99, 8);
    // Request W=100, D=100 — should clamp to W=4, D=4
    const result = swapCorner(a, 'sw', b, 'sw', { width: 100, depth: 100 });
    expect(result.width).toBe(4);
    expect(result.depth).toBe(4);
  });

  it('all four corners work', () => {
    for (const corner of ['ne', 'se', 'sw', 'nw']) {
      const a = makeEngine(42, 8);
      const b = makeEngine(99, 8);
      randomizeEngine(a);
      randomizeEngine(b);
      const result = swapCorner(a, corner, b, corner, { width: 2, depth: 2 });
      expect(result.preHashA).not.toBe(result.postHashA);
    }
  });
});

// --- executeShare ---

describe('executeShare', () => {
  it('executes a share with defaults', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);
    randomizeEngine(a);
    randomizeEngine(b);

    const result = executeShare(a, b);
    expect(result.preHashA).not.toBe(result.postHashA);
    expect(result.cornerA).toBe('se');
    expect(result.cornerB).toBe('sw');
  });

  it('accepts custom corners and dimensions', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);
    randomizeEngine(a);
    randomizeEngine(b);

    const result = executeShare(a, b, {
      cornerA: 'ne',
      cornerB: 'nw',
      width: 3,
      depth: 2,
    });
    expect(result.width).toBe(3);
    expect(result.depth).toBe(2);
    expect(result.cornerA).toBe('ne');
    expect(result.cornerB).toBe('nw');
  });

  it('works with different board sizes', () => {
    const a = makeEngine(42, 16);
    const b = makeEngine(99, 8);
    randomizeEngine(a);
    randomizeEngine(b);

    const result = executeShare(a, b, { width: 4, depth: 3 });
    expect(result.width).toBe(4);
    expect(result.depth).toBe(3);
  });
});
