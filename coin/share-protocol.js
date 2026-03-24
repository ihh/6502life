/**
 * Share protocol: instantaneous edge swap between two boards.
 *
 * A share is a single migration event — a rectangular strip of cells
 * flush with one edge of each board is swapped. No merged board,
 * no prolonged simulation.
 *
 * @module coin/share-protocol
 */

import { swapEdge } from './board-merge.js';
import { sha256, toHex } from './hash.js';

/**
 * Execute an instantaneous edge swap between two boards.
 *
 * @param {Object} engineA - engine with .controller, .size, .serialize()
 * @param {Object} engineB
 * @param {Object} [options]
 * @param {import('./board-merge.js').Edge} [options.edgeA='east'] - A's swap edge
 * @param {import('./board-merge.js').Edge} [options.edgeB='west'] - B's swap edge
 * @param {number} [options.depth] - strip depth (default: min board size)
 * @returns {import('./board-merge.js').SwapResult}
 */
export function executeShare(engineA, engineB, options = {}) {
  const edgeA = options.edgeA ?? 'east';
  const edgeB = options.edgeB ?? 'west';
  return swapEdge(engineA, edgeA, engineB, edgeB, { depth: options.depth });
}
