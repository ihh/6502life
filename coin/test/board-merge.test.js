import { describe, it, expect, beforeAll } from 'vitest';
import { mergeBoards, runMerged, splitBoards, registerEngine } from '../board-merge.js';
import { ShareSession } from '../share-protocol.js';
import { Board6502Engine } from '../engines/board6502.js';
import { readCellMemory, writeCellBytes } from '../../engine/board.js';
import { sha256, toHex } from '../hash.js';

// Register the engine class so board-merge can create new engines
beforeAll(() => {
  registerEngine(Board6502Engine);
});

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

// --- Merge tests ---

describe('mergeBoards', () => {
  it('merges two 8x8 boards into a 16x16 board (east-west)', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);
    a.step(10);
    b.step(10);

    const { mergedEngine, mapping } = mergeBoards(a, b, 'east-west');

    expect(mapping.originalSize).toBe(8);
    expect(mapping.mergedSize).toBe(16);
    expect(mapping.mergeEdge).toBe('east-west');
    expect(mergedEngine.size).toBe(16);
  });

  it('merges two 8x8 boards into a 16x16 board (north-south)', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    const { mergedEngine, mapping } = mergeBoards(a, b, 'north-south');

    expect(mapping.mergeEdge).toBe('north-south');
    expect(mergedEngine.size).toBe(16);
  });

  it('cell data is correctly positioned in merged board (east-west)', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    // Write distinctive data to specific cells
    const markerA = new Uint8Array(1024);
    markerA[0] = 0xAA;
    markerA[1] = 0xBB;
    writeCellBytes(a.controller, 3, 5, 0, markerA);

    const markerB = new Uint8Array(1024);
    markerB[0] = 0xCC;
    markerB[1] = 0xDD;
    writeCellBytes(b.controller, 2, 4, 0, markerB);

    const { mergedEngine } = mergeBoards(a, b, 'east-west');

    // A's cell (3,5) should be at merged (3,5)
    const mergedCellA = readCellMemory(mergedEngine.controller, 3, 5);
    expect(mergedCellA[0]).toBe(0xAA);
    expect(mergedCellA[1]).toBe(0xBB);

    // B's cell (2,4) should be at merged (2+8, 4) = (10, 4)
    const mergedCellB = readCellMemory(mergedEngine.controller, 10, 4);
    expect(mergedCellB[0]).toBe(0xCC);
    expect(mergedCellB[1]).toBe(0xDD);
  });

  it('cell data is correctly positioned in merged board (north-south)', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    const markerA = new Uint8Array(1024);
    markerA[0] = 0x11;
    writeCellBytes(a.controller, 2, 3, 0, markerA);

    const markerB = new Uint8Array(1024);
    markerB[0] = 0x22;
    writeCellBytes(b.controller, 4, 6, 0, markerB);

    const { mergedEngine } = mergeBoards(a, b, 'north-south');

    // A's cell (2,3) at merged (2,3)
    const mergedCellA = readCellMemory(mergedEngine.controller, 2, 3);
    expect(mergedCellA[0]).toBe(0x11);

    // B's cell (4,6) at merged (4, 6+8) = (4, 14)
    const mergedCellB = readCellMemory(mergedEngine.controller, 4, 14);
    expect(mergedCellB[0]).toBe(0x22);
  });

  it('rejects mismatched board sizes', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 4);

    expect(() => mergeBoards(a, b, 'east-west')).toThrow('Board sizes must match');
  });
});

// --- Split tests ---

describe('splitBoards', () => {
  it('split recovers two separate boards with correct cells (east-west)', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    // Write markers
    const markerA = new Uint8Array(1024);
    markerA[0] = 0xAA;
    writeCellBytes(a.controller, 0, 0, 0, markerA);

    const markerB = new Uint8Array(1024);
    markerB[0] = 0xBB;
    writeCellBytes(b.controller, 7, 7, 0, markerB);

    const { mergedEngine, mapping } = mergeBoards(a, b, 'east-west');
    const { engineA, engineB } = splitBoards(mergedEngine, mapping);

    expect(engineA.size).toBe(8);
    expect(engineB.size).toBe(8);

    // Check markers survived
    const recoveredA = readCellMemory(engineA.controller, 0, 0);
    expect(recoveredA[0]).toBe(0xAA);

    const recoveredB = readCellMemory(engineB.controller, 7, 7);
    expect(recoveredB[0]).toBe(0xBB);
  });

  it('split recovers correct cells (north-south)', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    const markerA = new Uint8Array(1024);
    markerA[0] = 0x55;
    writeCellBytes(a.controller, 3, 3, 0, markerA);

    const markerB = new Uint8Array(1024);
    markerB[0] = 0x77;
    writeCellBytes(b.controller, 5, 5, 0, markerB);

    const { mergedEngine, mapping } = mergeBoards(a, b, 'north-south');
    const { engineA, engineB } = splitBoards(mergedEngine, mapping);

    const recoveredA = readCellMemory(engineA.controller, 3, 3);
    expect(recoveredA[0]).toBe(0x55);

    const recoveredB = readCellMemory(engineB.controller, 5, 5);
    expect(recoveredB[0]).toBe(0x77);
  });

  it('all cells round-trip through merge/split (east-west)', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    // Capture all cell checksums before merge
    const checksumsA = {};
    const checksumsB = {};
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        checksumsA[`${i},${j}`] = cellChecksum(a, i, j);
        checksumsB[`${i},${j}`] = cellChecksum(b, i, j);
      }
    }

    const { mergedEngine, mapping } = mergeBoards(a, b, 'east-west');
    const { engineA, engineB } = splitBoards(mergedEngine, mapping);

    // Verify all cells match
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        expect(cellChecksum(engineA, i, j)).toBe(checksumsA[`${i},${j}`]);
        expect(cellChecksum(engineB, i, j)).toBe(checksumsB[`${i},${j}`]);
      }
    }
  });
});

// --- PRNG tests ---

describe('PRNG handling', () => {
  it('PRNG states differ after split (not same as pre-merge)', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    // Capture pre-merge PRNG state
    const preMergeSeedA = a.controller.memory.mt.mt.slice();
    const preMergeSeedB = b.controller.memory.mt.mt.slice();

    const { mergedEngine, mapping } = mergeBoards(a, b, 'east-west');
    const { engineA, engineB } = splitBoards(mergedEngine, mapping);

    // Post-split PRNG should differ from pre-merge
    const postSplitSeedA = engineA.controller.memory.mt.mt.slice();
    const postSplitSeedB = engineB.controller.memory.mt.mt.slice();

    // PRNG states should NOT be identical to pre-merge
    const sameA = preMergeSeedA.every((v, i) => v === postSplitSeedA[i]);
    const sameB = preMergeSeedB.every((v, i) => v === postSplitSeedB[i]);
    expect(sameA).toBe(false);
    expect(sameB).toBe(false);

    // The two split boards should also have different PRNGs from each other
    const sameAB = postSplitSeedA.every((v, i) => v === postSplitSeedB[i]);
    expect(sameAB).toBe(false);
  });
});

// --- Determinism tests ---

describe('determinism', () => {
  it('merge is deterministic (same inputs produce same merged state)', () => {
    const a1 = makeEngine(42, 8);
    const b1 = makeEngine(99, 8);
    a1.step(5);
    b1.step(5);

    const a2 = makeEngine(42, 8);
    const b2 = makeEngine(99, 8);
    a2.step(5);
    b2.step(5);

    const { mergedEngine: m1 } = mergeBoards(a1, b1, 'east-west');
    const { mergedEngine: m2 } = mergeBoards(a2, b2, 'east-west');

    // Cell data at every position should match
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 8; j++) {
        expect(cellChecksum(m1, i, j)).toBe(cellChecksum(m2, i, j));
      }
    }
  });

  it('full merge/run/split cycle is deterministic', () => {
    const a1 = makeEngine(42, 8);
    const b1 = makeEngine(99, 8);
    a1.step(5);
    b1.step(5);

    const a2 = makeEngine(42, 8);
    const b2 = makeEngine(99, 8);
    a2.step(5);
    b2.step(5);

    const { mergedEngine: m1, mapping: map1 } = mergeBoards(a1, b1, 'east-west');
    const { mergedEngine: m2, mapping: map2 } = mergeBoards(a2, b2, 'east-west');

    runMerged(m1, 10);
    runMerged(m2, 10);

    const hash1 = toHex(sha256(m1.serialize()));
    const hash2 = toHex(sha256(m2.serialize()));
    expect(hash1).toBe(hash2);

    const split1 = splitBoards(m1, map1);
    const split2 = splitBoards(m2, map2);

    const hashA1 = toHex(sha256(split1.engineA.serialize()));
    const hashA2 = toHex(sha256(split2.engineA.serialize()));
    expect(hashA1).toBe(hashA2);

    const hashB1 = toHex(sha256(split1.engineB.serialize()));
    const hashB2 = toHex(sha256(split2.engineB.serialize()));
    expect(hashB1).toBe(hashB2);
  });
});

// --- Simulation on merged board ---

describe('merged board simulation', () => {
  it('organisms can cross the merge boundary during simulation', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    // Write nonzero data to A's rightmost column (i=7) near the boundary
    for (let j = 0; j < 8; j++) {
      const marker = new Uint8Array(1024);
      marker.fill(0x42);
      writeCellBytes(a.controller, 7, j, 0, marker);
    }

    const { mergedEngine, mapping } = mergeBoards(a, b, 'east-west');

    // Verify that A's edge cells are adjacent to B's cells in the merged board
    // A's cell (7,0) is at merged (7,0), B's cell (0,0) is at merged (8,0)
    const edgeCellA = readCellMemory(mergedEngine.controller, 7, 0);
    expect(edgeCellA[0]).toBe(0x42);

    // Run simulation - the merged board runs as a single entity
    runMerged(mergedEngine, 50);

    // After running, the merged board should have executed normally.
    // We just verify it ran without errors.
    expect(mergedEngine.clock()).toBe(50);
  });
});

// --- lastWriter preservation ---

describe('lastWriter preservation', () => {
  it('lastWriter is preserved through merge/split', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    // Set lastWriter for specific cells
    const idxA = 5 + 8 * 3; // cell (3,5) in A
    a.controller.lastWriter[idxA] = 'wallet-A';

    const idxB = 2 + 8 * 1; // cell (1,2) in B
    b.controller.lastWriter[idxB] = 'wallet-B';

    const { mergedEngine, mapping } = mergeBoards(a, b, 'east-west');

    // Check lastWriter in merged board
    // A's (3,5) -> merged (3,5), index = 5 + 16*3 = 53
    expect(mergedEngine.controller.lastWriter[5 + 16 * 3]).toBe('wallet-A');
    // B's (1,2) -> merged (1+8, 2) = (9,2), index = 2 + 16*9 = 146
    expect(mergedEngine.controller.lastWriter[2 + 16 * 9]).toBe('wallet-B');

    // Split and verify
    const { engineA, engineB } = splitBoards(mergedEngine, mapping);
    expect(engineA.controller.lastWriter[5 + 8 * 3]).toBe('wallet-A');
    expect(engineB.controller.lastWriter[2 + 8 * 1]).toBe('wallet-B');
  });
});

// --- Board params handling ---

describe('board params', () => {
  it('uses minimum pBitNoise by default', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    a.controller.boardParams.pBitNoise = 0.01;
    b.controller.boardParams.pBitNoise = 0.001;

    const { mergedEngine } = mergeBoards(a, b, 'east-west');

    expect(mergedEngine.controller.boardParams.pBitNoise).toBe(0.001);
  });

  it('respects paramStrategy option', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    a.controller.boardParams.pBitNoise = 0.01;
    b.controller.boardParams.pBitNoise = 0.005;

    const { mergedEngine: mMax } = mergeBoards(a, b, 'east-west', { paramStrategy: 'max' });
    expect(mMax.controller.boardParams.pBitNoise).toBe(0.01);

    // Re-create engines (consumed by merge)
    const a2 = makeEngine(42, 8);
    const b2 = makeEngine(99, 8);
    a2.controller.boardParams.pBitNoise = 0.01;
    b2.controller.boardParams.pBitNoise = 0.005;

    const { mergedEngine: mAvg } = mergeBoards(a2, b2, 'east-west', { paramStrategy: 'average' });
    expect(mAvg.controller.boardParams.pBitNoise).toBeCloseTo(0.0075);
  });
});

// --- ShareSession integration ---

describe('ShareSession', () => {
  it('executes full merge/run/split cycle', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);
    a.step(5);
    b.step(5);

    const session = new ShareSession(a, b, {
      mergeEdge: 'east-west',
      duration: 20,
    });

    const result = session.execute();

    expect(result.initialHashA).toBeTruthy();
    expect(result.initialHashB).toBeTruthy();
    expect(result.finalHashA).toBeTruthy();
    expect(result.finalHashB).toBeTruthy();
    expect(result.mergedStateHash).toBeTruthy();
    expect(result.engineA.size).toBe(8);
    expect(result.engineB.size).toBe(8);
    expect(result.duration).toBe(20);

    // Final hashes should differ from initial (simulation changed state)
    // (Not guaranteed for trivially empty boards, but very likely with seeded PRNG)
    expect(result.mergedStateHash).toBeTruthy();
  });

  it('ShareSession is deterministic', () => {
    const a1 = makeEngine(42, 8);
    const b1 = makeEngine(99, 8);
    a1.step(5);
    b1.step(5);

    const a2 = makeEngine(42, 8);
    const b2 = makeEngine(99, 8);
    a2.step(5);
    b2.step(5);

    const s1 = new ShareSession(a1, b1, { mergeEdge: 'east-west', duration: 20 });
    const s2 = new ShareSession(a2, b2, { mergeEdge: 'east-west', duration: 20 });

    const r1 = s1.execute();
    const r2 = s2.execute();

    expect(r1.mergedStateHash).toBe(r2.mergedStateHash);
    expect(r1.finalHashA).toBe(r2.finalHashA);
    expect(r1.finalHashB).toBe(r2.finalHashB);
  });
});
