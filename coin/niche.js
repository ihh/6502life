/**
 * Niche event detection for social mining.
 *
 * Detects when organisms from one board are thriving on another board,
 * using two orthogonal methods:
 * 1. Provenance-based: lastWriter field matches the partner's wallet ID
 * 2. MinHash-based: fingerprint similarity above threshold
 *
 * @module coin/niche
 */

import { readCellMemory } from '../engine/board.js';
import { minhash, minhashSimilarity } from '../cli/lib/probe/fingerprint.js';

/**
 * Default Niche bonus per event (in coins).
 */
export const DEFAULT_NICHE_BONUS = 0.69;

/**
 * Default MinHash similarity threshold for Niche detection.
 */
export const DEFAULT_MINHASH_THRESHOLD = 0.5;

/**
 * Detect Niche events between two boards.
 *
 * Checks all cells on board B for lastWriter === walletA (A's organisms
 * thriving on B's territory), and all cells on board A for
 * lastWriter === walletB (B's organisms thriving on A's territory).
 *
 * Also does MinHash fingerprint comparison for cells without provenance,
 * catching mutated descendants that lost their lastWriter due to noise.
 *
 * @param {import('./engines/board6502.js').Board6502Engine} engineA
 * @param {import('./engines/board6502.js').Board6502Engine} engineB
 * @param {string} walletA - wallet ID for player A
 * @param {string} walletB - wallet ID for player B
 * @param {Object} [options]
 * @param {number} [options.minhashThreshold=0.5] - similarity threshold for MinHash detection
 * @returns {Array<{ type: 'provenance'|'minhash', board: 'A'|'B', cell: [number, number], similarity?: number, wallet: string }>}
 */
export function detectNicheEvents(engineA, engineB, walletA, walletB, options = {}) {
  const threshold = options.minhashThreshold ?? DEFAULT_MINHASH_THRESHOLD;
  const events = [];

  const sizeA = engineA.size;
  const sizeB = engineB.size;

  // Collect fingerprints from board A for MinHash comparison
  const fingerprintsA = [];
  for (let i = 0; i < sizeA; i++) {
    for (let j = 0; j < sizeA; j++) {
      const cellIdx = engineA.memory.ijToCellIndex(i, j);
      const cellData = readCellMemory(engineA.controller, i, j);
      fingerprintsA.push({
        i, j, cellIdx,
        sig: minhash(cellData, 0, Math.min(cellData.length, 896)),
        lastWriter: engineA.controller.lastWriter[cellIdx],
      });
    }
  }

  // Collect fingerprints from board B for MinHash comparison
  const fingerprintsB = [];
  for (let i = 0; i < sizeB; i++) {
    for (let j = 0; j < sizeB; j++) {
      const cellIdx = engineB.memory.ijToCellIndex(i, j);
      const cellData = readCellMemory(engineB.controller, i, j);
      fingerprintsB.push({
        i, j, cellIdx,
        sig: minhash(cellData, 0, Math.min(cellData.length, 896)),
        lastWriter: engineB.controller.lastWriter[cellIdx],
      });
    }
  }

  // Check board B for cells with lastWriter === walletA (provenance-based)
  const provenanceBCells = new Set();
  for (const fp of fingerprintsB) {
    if (walletA && fp.lastWriter === walletA) {
      events.push({
        type: 'provenance',
        board: 'B',
        cell: [fp.i, fp.j],
        wallet: walletA,
      });
      provenanceBCells.add(fp.cellIdx);
    }
  }

  // Check board A for cells with lastWriter === walletB (provenance-based)
  const provenanceACells = new Set();
  for (const fp of fingerprintsA) {
    if (walletB && fp.lastWriter === walletB) {
      events.push({
        type: 'provenance',
        board: 'A',
        cell: [fp.i, fp.j],
        wallet: walletB,
      });
      provenanceACells.add(fp.cellIdx);
    }
  }

  // MinHash comparison: for cells on B NOT already detected by provenance,
  // compare against all cells on A to find mutated descendants
  for (const fpB of fingerprintsB) {
    if (provenanceBCells.has(fpB.cellIdx)) continue;
    // Skip if this cell already has walletB as writer (it's native)
    if (fpB.lastWriter === walletB) continue;

    let bestSim = 0;
    for (const fpA of fingerprintsA) {
      const sim = minhashSimilarity(fpA.sig, fpB.sig);
      if (sim > bestSim) bestSim = sim;
    }
    if (bestSim >= threshold) {
      events.push({
        type: 'minhash',
        board: 'B',
        cell: [fpB.i, fpB.j],
        similarity: bestSim,
        wallet: walletA,
      });
    }
  }

  // MinHash comparison: for cells on A NOT already detected by provenance,
  // compare against all cells on B to find mutated descendants
  for (const fpA of fingerprintsA) {
    if (provenanceACells.has(fpA.cellIdx)) continue;
    // Skip if this cell already has walletA as writer (it's native)
    if (fpA.lastWriter === walletA) continue;

    let bestSim = 0;
    for (const fpB of fingerprintsB) {
      const sim = minhashSimilarity(fpB.sig, fpA.sig);
      if (sim > bestSim) bestSim = sim;
    }
    if (bestSim >= threshold) {
      events.push({
        type: 'minhash',
        board: 'A',
        cell: [fpA.i, fpA.j],
        similarity: bestSim,
        wallet: walletB,
      });
    }
  }

  return events;
}
