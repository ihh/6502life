/**
 * Board merge/split protocol for edge sharing during social play.
 *
 * When two players share an edge, their boards temporarily merge into one
 * larger board. The merge is deterministic given both initial states.
 *
 * Since BoardMemory only supports square boards, a merge of two BxB boards
 * creates a (2B)x(2B) board. For east-west merges, A occupies the left half
 * (cols 0..B-1, rows 0..B-1) and B occupies the right half (cols B..2B-1,
 * rows 0..B-1). For north-south merges, A occupies the top half and B the
 * bottom half. The unused quadrants remain zeroed (inert cells).
 *
 * @module coin/board-merge
 */

import { createBoard, readCellMemory, writeCellBytes } from '../engine/board.js';
import { sha256, sha256str, toHex } from './hash.js';

/**
 * Merge two Board6502Engine instances into one larger board.
 *
 * @param {import('./engines/board6502.js').Board6502Engine} engineA
 * @param {import('./engines/board6502.js').Board6502Engine} engineB
 * @param {'east-west'|'north-south'} mergeEdge
 * @param {Object} [options]
 * @param {string} [options.paramStrategy='min'] - How to combine board params: 'min', 'max', 'average', 'a', 'b'
 * @returns {{ mergedEngine: import('./engines/board6502.js').Board6502Engine, mapping: MergeMapping }}
 */
export function mergeBoards(engineA, engineB, mergeEdge, options = {}) {
  const { paramStrategy = 'min' } = options;
  const sizeA = engineA.size;
  const sizeB = engineB.size;

  if (sizeA !== sizeB) {
    throw new Error(`Board sizes must match: ${sizeA} vs ${sizeB}`);
  }

  const B = sizeA;
  const mergedSize = 2 * B;

  // Derive a new PRNG seed from both boards' states
  const serA = engineA.serialize();
  const serB = engineB.serialize();
  const combined = new Uint8Array(serA.length + serB.length);
  combined.set(serA, 0);
  combined.set(serB, serA.length);
  const hashBytes = sha256(combined);
  const seed = (hashBytes[0] | (hashBytes[1] << 8) | (hashBytes[2] << 16) | (hashBytes[3] << 24)) >>> 0;

  // Merge board params
  const paramsA = engineA.controller.boardParams;
  const paramsB = engineB.controller.boardParams;
  const mergedParams = mergeParams(paramsA, paramsB, paramStrategy);

  // Create the merged board using the low-level createBoard
  const { Board6502Engine } = await6502EngineSync();
  const mergedEngine = new Board6502Engine();
  mergedEngine.init({ size: mergedSize, seed, ...mergedParams });

  // Build mapping
  const mapping = {
    mergeEdge,
    originalSize: B,
    mergedSize,
  };

  // Copy cells from A and B into the merged board
  if (mergeEdge === 'east-west') {
    // A occupies left half: cols 0..B-1, rows 0..B-1
    for (let i = 0; i < B; i++) {
      for (let j = 0; j < B; j++) {
        const cellData = readCellMemory(engineA.controller, i, j);
        writeCellBytes(mergedEngine.controller, i, j, 0, cellData);
        // Copy lastWriter
        const srcIdx = j + B * i;
        const dstIdx = j + mergedSize * i;
        mergedEngine.controller.lastWriter[dstIdx] = engineA.controller.lastWriter[srcIdx];
        mergedEngine.controller.lastWriteTime[dstIdx] = engineA.controller.lastWriteTime[srcIdx];
        mergedEngine.controller.lastMoveTime[dstIdx] = engineA.controller.lastMoveTime[srcIdx];
      }
    }
    // B occupies right half: cols B..2B-1, rows 0..B-1
    for (let i = 0; i < B; i++) {
      for (let j = 0; j < B; j++) {
        const cellData = readCellMemory(engineB.controller, i, j);
        writeCellBytes(mergedEngine.controller, i + B, j, 0, cellData);
        const srcIdx = j + B * i;
        const dstIdx = j + mergedSize * (i + B);
        mergedEngine.controller.lastWriter[dstIdx] = engineB.controller.lastWriter[srcIdx];
        mergedEngine.controller.lastWriteTime[dstIdx] = engineB.controller.lastWriteTime[srcIdx];
        mergedEngine.controller.lastMoveTime[dstIdx] = engineB.controller.lastMoveTime[srcIdx];
      }
    }
  } else if (mergeEdge === 'north-south') {
    // A occupies top half: cols 0..B-1, rows 0..B-1
    for (let i = 0; i < B; i++) {
      for (let j = 0; j < B; j++) {
        const cellData = readCellMemory(engineA.controller, i, j);
        writeCellBytes(mergedEngine.controller, i, j, 0, cellData);
        const srcIdx = j + B * i;
        const dstIdx = j + mergedSize * i;
        mergedEngine.controller.lastWriter[dstIdx] = engineA.controller.lastWriter[srcIdx];
        mergedEngine.controller.lastWriteTime[dstIdx] = engineA.controller.lastWriteTime[srcIdx];
        mergedEngine.controller.lastMoveTime[dstIdx] = engineA.controller.lastMoveTime[srcIdx];
      }
    }
    // B occupies bottom half: cols 0..B-1, rows B..2B-1
    for (let i = 0; i < B; i++) {
      for (let j = 0; j < B; j++) {
        const cellData = readCellMemory(engineB.controller, i, j);
        writeCellBytes(mergedEngine.controller, i, j + B, 0, cellData);
        const srcIdx = j + B * i;
        const dstIdx = (j + B) + mergedSize * i;
        mergedEngine.controller.lastWriter[dstIdx] = engineB.controller.lastWriter[srcIdx];
        mergedEngine.controller.lastWriteTime[dstIdx] = engineB.controller.lastWriteTime[srcIdx];
        mergedEngine.controller.lastMoveTime[dstIdx] = engineB.controller.lastMoveTime[srcIdx];
      }
    }
  } else {
    throw new Error(`Unknown merge edge: ${mergeEdge}`);
  }

  return { mergedEngine, mapping };
}

/**
 * Run the merged board for a given number of ticks (interrupts).
 *
 * @param {import('./engines/board6502.js').Board6502Engine} mergedEngine
 * @param {number} ticks - Number of interrupts to run
 * @param {Array<{tick: number, action: Object}>} [moves] - Player moves to apply at specific ticks
 * @returns {import('./engines/board6502.js').Board6502Engine}
 */
export function runMerged(mergedEngine, ticks, moves = []) {
  // Sort moves by tick
  const sortedMoves = [...moves].sort((a, b) => a.tick - b.tick);
  let moveIdx = 0;
  const startTick = mergedEngine.clock();

  for (let t = 0; t < ticks; t++) {
    const currentTick = startTick + t;

    // Apply any moves scheduled for this tick
    while (moveIdx < sortedMoves.length && sortedMoves[moveIdx].tick <= currentTick) {
      mergedEngine.applyInput(sortedMoves[moveIdx]);
      moveIdx++;
    }

    mergedEngine.step(1);
  }

  // Apply any remaining moves
  while (moveIdx < sortedMoves.length) {
    mergedEngine.applyInput(sortedMoves[moveIdx]);
    moveIdx++;
  }

  return mergedEngine;
}

/**
 * Split a merged board back into two separate boards.
 *
 * @param {import('./engines/board6502.js').Board6502Engine} mergedEngine
 * @param {MergeMapping} mapping
 * @returns {{ engineA: import('./engines/board6502.js').Board6502Engine, engineB: import('./engines/board6502.js').Board6502Engine }}
 */
export function splitBoards(mergedEngine, mapping) {
  const { mergeEdge, originalSize: B, mergedSize } = mapping;

  // Derive new PRNG seeds from the merged final state
  const mergedSer = mergedEngine.serialize();
  const seedBytesA = sha256str(new TextDecoder().decode(mergedSer) + 'A');
  const seedBytesB = sha256str(new TextDecoder().decode(mergedSer) + 'B');
  const seedA = (seedBytesA[0] | (seedBytesA[1] << 8) | (seedBytesA[2] << 16) | (seedBytesA[3] << 24)) >>> 0;
  const seedB = (seedBytesB[0] | (seedBytesB[1] << 8) | (seedBytesB[2] << 16) | (seedBytesB[3] << 24)) >>> 0;

  // Extract board params from merged engine
  const mergedParams = { ...mergedEngine.controller.boardParams };

  const { Board6502Engine } = await6502EngineSync();

  const engineA = new Board6502Engine();
  engineA.init({ size: B, seed: seedA, ...mergedParams });
  const engineB = new Board6502Engine();
  engineB.init({ size: B, seed: seedB, ...mergedParams });

  if (mergeEdge === 'east-west') {
    // A from left half
    for (let i = 0; i < B; i++) {
      for (let j = 0; j < B; j++) {
        const cellData = readCellMemory(mergedEngine.controller, i, j);
        writeCellBytes(engineA.controller, i, j, 0, cellData);
        const mergedIdx = j + mergedSize * i;
        const localIdx = j + B * i;
        engineA.controller.lastWriter[localIdx] = mergedEngine.controller.lastWriter[mergedIdx];
        engineA.controller.lastWriteTime[localIdx] = mergedEngine.controller.lastWriteTime[mergedIdx];
        engineA.controller.lastMoveTime[localIdx] = mergedEngine.controller.lastMoveTime[mergedIdx];
      }
    }
    // B from right half
    for (let i = 0; i < B; i++) {
      for (let j = 0; j < B; j++) {
        const cellData = readCellMemory(mergedEngine.controller, i + B, j);
        writeCellBytes(engineB.controller, i, j, 0, cellData);
        const mergedIdx = j + mergedSize * (i + B);
        const localIdx = j + B * i;
        engineB.controller.lastWriter[localIdx] = mergedEngine.controller.lastWriter[mergedIdx];
        engineB.controller.lastWriteTime[localIdx] = mergedEngine.controller.lastWriteTime[mergedIdx];
        engineB.controller.lastMoveTime[localIdx] = mergedEngine.controller.lastMoveTime[mergedIdx];
      }
    }
  } else if (mergeEdge === 'north-south') {
    // A from top half
    for (let i = 0; i < B; i++) {
      for (let j = 0; j < B; j++) {
        const cellData = readCellMemory(mergedEngine.controller, i, j);
        writeCellBytes(engineA.controller, i, j, 0, cellData);
        const mergedIdx = j + mergedSize * i;
        const localIdx = j + B * i;
        engineA.controller.lastWriter[localIdx] = mergedEngine.controller.lastWriter[mergedIdx];
        engineA.controller.lastWriteTime[localIdx] = mergedEngine.controller.lastWriteTime[mergedIdx];
        engineA.controller.lastMoveTime[localIdx] = mergedEngine.controller.lastMoveTime[mergedIdx];
      }
    }
    // B from bottom half
    for (let i = 0; i < B; i++) {
      for (let j = 0; j < B; j++) {
        const cellData = readCellMemory(mergedEngine.controller, i, j + B);
        writeCellBytes(engineB.controller, i, j, 0, cellData);
        const mergedIdx = (j + B) + mergedSize * i;
        const localIdx = j + B * i;
        engineB.controller.lastWriter[localIdx] = mergedEngine.controller.lastWriter[mergedIdx];
        engineB.controller.lastWriteTime[localIdx] = mergedEngine.controller.lastWriteTime[mergedIdx];
        engineB.controller.lastMoveTime[localIdx] = mergedEngine.controller.lastMoveTime[mergedIdx];
      }
    }
  } else {
    throw new Error(`Unknown merge edge: ${mergeEdge}`);
  }

  return { engineA, engineB };
}

/**
 * Merge board params from two boards.
 * @param {Object} paramsA
 * @param {Object} paramsB
 * @param {string} strategy - 'min', 'max', 'average', 'a', 'b'
 * @returns {Object}
 */
function mergeParams(paramsA, paramsB, strategy) {
  const numericKeys = ['pBitNoise', 'pBrkFailure'];
  const boolKeys = ['magnetosensing', 'implementsMove', 'implementsCopy', 'implementsSync', 'implementsAsync'];
  const result = {};

  for (const key of numericKeys) {
    const a = paramsA[key] ?? 0;
    const b = paramsB[key] ?? 0;
    switch (strategy) {
      case 'min': result[key] = Math.min(a, b); break;
      case 'max': result[key] = Math.max(a, b); break;
      case 'average': result[key] = (a + b) / 2; break;
      case 'a': result[key] = a; break;
      case 'b': result[key] = b; break;
      default: result[key] = Math.min(a, b);
    }
  }

  // For boolean params, use OR (enable if either board enables)
  for (const key of boolKeys) {
    const a = paramsA[key] ?? false;
    const b = paramsB[key] ?? false;
    result[key] = a || b;
  }

  return result;
}

/**
 * Synchronous import of Board6502Engine. We cache the class reference.
 * @returns {{ Board6502Engine: typeof import('./engines/board6502.js').Board6502Engine }}
 */
let _Board6502Engine = null;
function await6502EngineSync() {
  if (!_Board6502Engine) {
    // Lazy-loaded to avoid circular dependencies
    throw new Error('Board6502Engine not registered. Call registerEngine() first.');
  }
  return { Board6502Engine: _Board6502Engine };
}

/**
 * Register the Board6502Engine class (avoids circular import).
 * @param {typeof import('./engines/board6502.js').Board6502Engine} cls
 */
export function registerEngine(cls) {
  _Board6502Engine = cls;
}

/**
 * @typedef {Object} MergeMapping
 * @property {'east-west'|'north-south'} mergeEdge
 * @property {number} originalSize - Original board size B
 * @property {number} mergedSize - Merged board size 2B
 */
