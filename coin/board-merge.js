/**
 * Edge swap protocol for social play.
 *
 * When two players share, they swap a rectangular strip of cells flush
 * with one edge of each board. This is instantaneous — no merged board,
 * no prolonged simulation. Cells from your board go on theirs, cells
 * from theirs go on yours.
 *
 * The strip dimensions are:
 *   W = min(B1, B2)  (width, along the shared edge)
 *   D <= W            (depth, perpendicular to the edge)
 *
 * Compatible with different board sizes and hyperparameters — each board
 * keeps its own params throughout.
 *
 * @module coin/board-merge
 */

import { readCellMemory, writeCellBytes } from '../engine/board.js';
import { sha256, toHex } from './hash.js';

/**
 * @typedef {'north'|'south'|'east'|'west'} Edge
 */

/**
 * @typedef {Object} SwapResult
 * @property {string} preHashA - SHA-256 of board A before swap
 * @property {string} preHashB - SHA-256 of board B before swap
 * @property {string} postHashA - SHA-256 of board A after swap
 * @property {string} postHashB - SHA-256 of board B after swap
 * @property {number} width - W (cells along edge)
 * @property {number} depth - D (cells perpendicular to edge)
 * @property {Edge} edgeA - which edge of A was swapped
 * @property {Edge} edgeB - which edge of B was swapped
 */

/**
 * Swap a rectangular strip of cells between two boards.
 *
 * @param {Object} engineA - engine with .controller, .size, .serialize()
 * @param {Edge} edgeA - which edge of A to swap from
 * @param {Object} engineB - engine with .controller, .size, .serialize()
 * @param {Edge} edgeB - which edge of B to swap from
 * @param {Object} [options]
 * @param {number} [options.depth] - D (default: min of board sizes)
 * @returns {SwapResult}
 */
export function swapEdge(engineA, edgeA, engineB, edgeB, options = {}) {
  const B1 = engineA.size;
  const B2 = engineB.size;
  const W = Math.min(B1, B2);
  const D = Math.min(options.depth ?? W, W);

  if (D < 1) throw new Error('Depth must be >= 1');

  // Record pre-swap hashes
  const preHashA = toHex(sha256(engineA.serialize()));
  const preHashB = toHex(sha256(engineB.serialize()));

  // Compute the (i,j) rectangles for each board
  const rectA = edgeRect(B1, edgeA, W, D);
  const rectB = edgeRect(B2, edgeB, W, D);

  // Read all cells from both strips
  const cellsA = readRect(engineA.controller, rectA);
  const cellsB = readRect(engineB.controller, rectB);

  // Also read lastWriter for provenance
  const writersA = readWriters(engineA.controller, rectA, B1);
  const writersB = readWriters(engineB.controller, rectB, B2);

  // Write B's cells onto A's strip, and A's cells onto B's strip
  writeRect(engineA.controller, rectA, cellsB);
  writeRect(engineB.controller, rectB, cellsA);

  writeWriters(engineA.controller, rectA, B1, writersB);
  writeWriters(engineB.controller, rectB, B2, writersA);

  // Record post-swap hashes
  const postHashA = toHex(sha256(engineA.serialize()));
  const postHashB = toHex(sha256(engineB.serialize()));

  return {
    preHashA, preHashB,
    postHashA, postHashB,
    width: W, depth: D,
    edgeA, edgeB,
  };
}

/**
 * Compute the rectangle of (i,j) coords for a strip flush with an edge.
 * Returns { cells: [{i,j}, ...], W, D }
 *
 * The strip is W cells along the edge and D cells deep.
 * Cells are centered along the edge when W < B.
 */
function edgeRect(B, edge, W, D) {
  const cells = [];
  // Offset to center the strip when W < B
  const offset = Math.floor((B - W) / 2);

  for (let along = 0; along < W; along++) {
    for (let deep = 0; deep < D; deep++) {
      let i, j;
      switch (edge) {
        case 'north':
          i = offset + along;
          j = B - 1 - deep;
          break;
        case 'south':
          i = offset + along;
          j = deep;
          break;
        case 'east':
          i = B - 1 - deep;
          j = offset + along;
          break;
        case 'west':
          i = deep;
          j = offset + along;
          break;
        default:
          throw new Error(`Unknown edge: ${edge}`);
      }
      cells.push({ i, j });
    }
  }
  return { cells, W, D };
}

function readRect(controller, rect) {
  return rect.cells.map(({ i, j }) => readCellMemory(controller, i, j));
}

function writeRect(controller, rect, cellData) {
  rect.cells.forEach(({ i, j }, idx) => {
    writeCellBytes(controller, i, j, 0, cellData[idx]);
  });
}

function readWriters(controller, rect, B) {
  return rect.cells.map(({ i, j }) => {
    const cellIdx = j + B * i;
    return {
      lastWriter: controller.lastWriter[cellIdx],
      lastWriteTime: controller.lastWriteTime[cellIdx],
      lastMoveTime: controller.lastMoveTime[cellIdx],
    };
  });
}

function writeWriters(controller, rect, B, writers) {
  rect.cells.forEach(({ i, j }, idx) => {
    const cellIdx = j + B * i;
    controller.lastWriter[cellIdx] = writers[idx].lastWriter;
    controller.lastWriteTime[cellIdx] = writers[idx].lastWriteTime;
    controller.lastMoveTime[cellIdx] = writers[idx].lastMoveTime;
  });
}

export { edgeRect };
