import { describe, it, expect } from 'vitest';
import { Board6502Engine } from '../engines/board6502.js';
import { detectNicheEvents, DEFAULT_NICHE_BONUS } from '../niche.js';
import { writeCellBytes, readCellMemory } from '../../engine/board.js';
import { assemble } from '../../engine/assembler.js';
import { getPreset } from '../../cli/lib/terminal/presets.js';

// --- Helpers ---

function makeEngine(seed = 42, size = 4) {
  const engine = new Board6502Engine();
  engine.init({ size, seed });
  return engine;
}

function makeConfig(seed = 42, size = 4) {
  return { gameId: 'board6502', size, seed };
}

// --- lastWriter provenance tests ---

describe('lastWriter provenance', () => {
  it('perfect copy preserves lastWriter', () => {
    const engine = makeEngine(42, 4);
    const ctrl = engine.controller;

    // Set noise to 0 for perfect copy
    ctrl.boardParams.pBitNoise = 0;

    // Set lastWriter for the origin cell
    const originCellIdx = ctrl.memory.ijToCellIndex(
      ctrl.memory.iOrig, ctrl.memory.jOrig
    );
    ctrl.lastWriter[originCellIdx] = 'wallet-alice';

    // Perform a perfect copy (BRK 245 = copy to dest 1)
    // copyCellWithNoise(dest) copies neighbor 0 -> neighbor dest
    ctrl.copyCellWithNoise(1);

    // Get the destination cell index
    const dstBase = ctrl.memory.neighborCellStorageBase(1);
    const dstCellIdx = Math.floor(dstBase / ctrl.memory.M);

    expect(ctrl.lastWriter[dstCellIdx]).toBe('wallet-alice');
  });

  it('imperfect copy clears lastWriter', () => {
    const engine = makeEngine(42, 4);
    const ctrl = engine.controller;

    // Set high noise to guarantee bit errors
    ctrl.boardParams.pBitNoise = 1.0; // every bit flipped

    // Set lastWriter for the origin cell
    const originCellIdx = ctrl.memory.ijToCellIndex(
      ctrl.memory.iOrig, ctrl.memory.jOrig
    );
    ctrl.lastWriter[originCellIdx] = 'wallet-alice';

    // Perform a noisy copy
    ctrl.copyCellWithNoise(1);

    // Get the destination cell index
    const dstBase = ctrl.memory.neighborCellStorageBase(1);
    const dstCellIdx = Math.floor(dstBase / ctrl.memory.M);

    expect(ctrl.lastWriter[dstCellIdx]).toBe('');
  });

  it('swap preserves lastWriter', () => {
    const engine = makeEngine(42, 4);
    const ctrl = engine.controller;

    // Get cell indices for neighbor 0 and neighbor 1
    const base0 = ctrl.memory.neighborCellStorageBase(0);
    const base1 = ctrl.memory.neighborCellStorageBase(1);
    const cellIdx0 = Math.floor(base0 / ctrl.memory.M);
    const cellIdx1 = Math.floor(base1 / ctrl.memory.M);

    // Set lastWriter for both cells
    ctrl.lastWriter[cellIdx0] = 'wallet-alice';
    ctrl.lastWriter[cellIdx1] = 'wallet-bob';

    // Swap cells
    ctrl.swapCells(0, 1);

    // After swap, writers should be exchanged
    expect(ctrl.lastWriter[cellIdx0]).toBe('wallet-bob');
    expect(ctrl.lastWriter[cellIdx1]).toBe('wallet-alice');
  });

  it('commitWrites sets lastWriter to boardOwner', () => {
    const engine = makeEngine(42, 4);
    const ctrl = engine.controller;

    // Set board owner
    ctrl.boardOwner = 'wallet-charlie';

    // Enable undo history (needed for commitWrites to track writes)
    ctrl.memory.resetUndoHistory();

    // Write a byte via undo-tracked method to trigger tracking
    const cellIdx = ctrl.memory.ijToCellIndex(0, 0);
    const byteIdx = ctrl.memory.ijbToByteIndex(0, 0, 0);
    ctrl.memory.setByteWithUndo(byteIdx, 0x42);

    // Commit writes
    ctrl.commitWrites();

    expect(ctrl.lastWriter[cellIdx]).toBe('wallet-charlie');
  });

  it('lastWriter serializes and deserializes', () => {
    const engine = makeEngine(42, 4);
    const ctrl = engine.controller;

    // Set some lastWriter values
    ctrl.lastWriter[0] = 'wallet-alice';
    ctrl.lastWriter[1] = 'wallet-bob';
    ctrl.boardOwner = 'wallet-charlie';

    // Serialize
    const state = ctrl.state;
    expect(state.lastWriter[0]).toBe('wallet-alice');
    expect(state.lastWriter[1]).toBe('wallet-bob');
    expect(state.boardOwner).toBe('wallet-charlie');

    // Create new controller and restore
    const engine2 = makeEngine(99, 4);
    engine2.controller.state = state;

    expect(engine2.controller.lastWriter[0]).toBe('wallet-alice');
    expect(engine2.controller.lastWriter[1]).toBe('wallet-bob');
    expect(engine2.controller.boardOwner).toBe('wallet-charlie');
  });
});

// --- Niche detection tests ---

describe('Niche event detection', () => {
  it('detects provenance-based Niche event after cross-board copy', () => {
    const engineA = makeEngine(42, 4);
    const engineB = makeEngine(99, 4);

    // Simulate: set lastWriter on board B cells to walletA
    // This mimics what happens when A's boundary is written to B
    const walletA = 'wallet-alice';
    const walletB = 'wallet-bob';

    // Tag a cell on board B as written by walletA
    engineB.controller.lastWriter[0] = walletA;

    const events = detectNicheEvents(engineA, engineB, walletA, walletB);

    // Should find at least one provenance event on board B
    const provenanceEvents = events.filter(e => e.type === 'provenance' && e.board === 'B');
    expect(provenanceEvents.length).toBeGreaterThanOrEqual(1);
    expect(provenanceEvents[0].wallet).toBe(walletA);
  });

  it('detects bidirectional Niche events', () => {
    const engineA = makeEngine(42, 4);
    const engineB = makeEngine(99, 4);

    const walletA = 'wallet-alice';
    const walletB = 'wallet-bob';

    // Tag a cell on B as written by A, and a cell on A as written by B
    engineB.controller.lastWriter[0] = walletA;
    engineA.controller.lastWriter[3] = walletB;

    const events = detectNicheEvents(engineA, engineB, walletA, walletB);

    const eventsOnB = events.filter(e => e.board === 'B' && e.type === 'provenance');
    const eventsOnA = events.filter(e => e.board === 'A' && e.type === 'provenance');

    expect(eventsOnB.length).toBeGreaterThanOrEqual(1);
    expect(eventsOnA.length).toBeGreaterThanOrEqual(1);
  });

  it('no Niche events when no cross-board content', () => {
    const engineA = makeEngine(42, 4);
    const engineB = makeEngine(99, 4);

    const walletA = 'wallet-alice';
    const walletB = 'wallet-bob';

    // No lastWriter set, different seeds = different content
    const events = detectNicheEvents(engineA, engineB, walletA, walletB);

    // Should have no provenance events (no lastWriter set)
    const provenanceEvents = events.filter(e => e.type === 'provenance');
    expect(provenanceEvents.length).toBe(0);
  });
});

// Note: Niche detection is kept for display purposes only.
// It no longer affects coin rewards (v2 protocol).
