/**
 * Share protocol: instantaneous corner swap between two boards.
 *
 * A share is a single migration event — a W×D rectangle of cells
 * from a corner of each board is swapped. No merged board,
 * no prolonged simulation.
 *
 * @module coin/share-protocol
 */

import { swapCorner } from './board-merge.js';

/**
 * Execute an instantaneous corner swap between two boards.
 *
 * @param {Object} engineA - engine with .controller, .size, .serialize()
 * @param {Object} engineB
 * @param {Object} [options]
 * @param {import('./board-merge.js').Corner} [options.cornerA='se'] - A's swap corner
 * @param {import('./board-merge.js').Corner} [options.cornerB='sw'] - B's swap corner
 * @param {number} [options.width] - W (default: min board size)
 * @param {number} [options.depth] - D (default: W)
 * @returns {import('./board-merge.js').SwapResult}
 */
export function executeShare(engineA, engineB, options = {}) {
  const cornerA = options.cornerA ?? 'se';
  const cornerB = options.cornerB ?? 'sw';
  return swapCorner(engineA, cornerA, engineB, cornerB, {
    width: options.width,
    depth: options.depth,
  });
}
