/**
 * Corner swap protocol for social play.
 *
 * When two players share, they swap a rectangular block of cells from
 * a corner of each board. This is instantaneous — no merged board,
 * no prolonged simulation. Cells from your board go on theirs, cells
 * from theirs go on yours.
 *
 * The rectangle is W × D, flush with two edges (i.e. in a corner):
 *   W <= min(B1, B2)
 *   D <= W
 *
 * Compatible with different board sizes and hyperparameters — each board
 * keeps its own params throughout.
 *
 * @module coin/board-merge
 */

import { readCellMemory, writeCellBytes } from '../engine/board.js';
import { sha256, toHex } from './hash.js';

/**
 * @typedef {'ne'|'se'|'sw'|'nw'} Corner
 */

/**
 * @typedef {Object} SwapResult
 * @property {string} preHashA - SHA-256 of board A before swap
 * @property {string} preHashB - SHA-256 of board B before swap
 * @property {string} postHashA - SHA-256 of board A after swap
 * @property {string} postHashB - SHA-256 of board B after swap
 * @property {number} width - W
 * @property {number} depth - D
 * @property {Corner} cornerA - which corner of A was swapped
 * @property {Corner} cornerB - which corner of B was swapped
 */

/**
 * Swap a rectangular block of cells between two boards' corners.
 *
 * @param {Object} engineA - engine with .controller, .size, .serialize()
 * @param {Corner} cornerA - which corner of A
 * @param {Object} engineB - engine with .controller, .size, .serialize()
 * @param {Corner} cornerB - which corner of B
 * @param {Object} [options]
 * @param {number} [options.width] - W (default: min of board sizes)
 * @param {number} [options.depth] - D (default: W)
 * @returns {SwapResult}
 */
export function swapCorner(engineA, cornerA, engineB, cornerB, options = {}) {
  const B1 = engineA.size;
  const B2 = engineB.size;
  const maxW = Math.min(B1, B2);
  const W = Math.min(options.width ?? maxW, maxW);
  const D = Math.min(options.depth ?? W, W);

  if (W < 1) throw new Error('Width must be >= 1');
  if (D < 1) throw new Error('Depth must be >= 1');

  // Record pre-swap hashes
  const preHashA = toHex(sha256(engineA.serialize()));
  const preHashB = toHex(sha256(engineB.serialize()));

  // Compute the (i,j) rectangles for each board
  const rectA = cornerRect(B1, cornerA, W, D);
  const rectB = cornerRect(B2, cornerB, W, D);

  // Read all cells from both rectangles
  const cellsA = readRect(engineA.controller, rectA);
  const cellsB = readRect(engineB.controller, rectB);

  const writersA = readWriters(engineA.controller, rectA, B1);
  const writersB = readWriters(engineB.controller, rectB, B2);

  // Swap: write B's cells onto A, A's cells onto B
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
    cornerA, cornerB,
  };
}

/**
 * Compute the rectangle of (i,j) coords for a corner block.
 *
 * W is the extent along the i-axis, D along the j-axis.
 * The block is flush with two edges (a corner).
 *
 * Corner layout (i increases right, j increases up):
 *   'sw' → i: 0..W-1,       j: 0..D-1
 *   'se' → i: B-W..B-1,     j: 0..D-1
 *   'nw' → i: 0..W-1,       j: B-D..B-1
 *   'ne' → i: B-W..B-1,     j: B-D..B-1
 */
function cornerRect(B, corner, W, D) {
  let i0, j0;
  switch (corner) {
    case 'sw': i0 = 0;     j0 = 0;     break;
    case 'se': i0 = B - W; j0 = 0;     break;
    case 'nw': i0 = 0;     j0 = B - D; break;
    case 'ne': i0 = B - W; j0 = B - D; break;
    default: throw new Error(`Unknown corner: ${corner}`);
  }

  const cells = [];
  for (let di = 0; di < W; di++) {
    for (let dj = 0; dj < D; dj++) {
      cells.push({ i: i0 + di, j: j0 + dj });
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

export { cornerRect };
