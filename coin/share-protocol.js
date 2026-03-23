/**
 * Full share protocol: merge two boards, run simulation, split back.
 *
 * @module coin/share-protocol
 */

import { mergeBoards, runMerged, splitBoards } from './board-merge.js';
import { sha256, toHex } from './hash.js';

/**
 * A share session that merges two boards, runs the merged simulation,
 * and splits back into two separate boards.
 */
export class ShareSession {
  /**
   * @param {import('./engines/board6502.js').Board6502Engine} engineA
   * @param {import('./engines/board6502.js').Board6502Engine} engineB
   * @param {Object} options
   * @param {'east-west'|'north-south'} [options.mergeEdge='east-west']
   * @param {number} [options.duration=100] - Number of ticks to run merged board
   * @param {Array<{tick: number, action: Object}>} [options.movesA] - Player A moves
   * @param {Array<{tick: number, action: Object}>} [options.movesB] - Player B moves
   * @param {string} [options.paramStrategy='min'] - Board param merge strategy
   */
  constructor(engineA, engineB, options = {}) {
    this.engineA = engineA;
    this.engineB = engineB;
    this.mergeEdge = options.mergeEdge ?? 'east-west';
    this.duration = options.duration ?? 100;
    this.movesA = options.movesA ?? [];
    this.movesB = options.movesB ?? [];
    this.paramStrategy = options.paramStrategy ?? 'min';
  }

  /**
   * Execute the full share: merge -> run -> split.
   *
   * @returns {{
   *   initialHashA: string,
   *   initialHashB: string,
   *   finalHashA: string,
   *   finalHashB: string,
   *   mergedStateHash: string,
   *   engineA: import('./engines/board6502.js').Board6502Engine,
   *   engineB: import('./engines/board6502.js').Board6502Engine,
   *   mergeEdge: string,
   *   duration: number,
   *   moves: Array
   * }}
   */
  execute() {
    // 1. Record initial state hashes
    const initialHashA = toHex(sha256(this.engineA.serialize()));
    const initialHashB = toHex(sha256(this.engineB.serialize()));

    // 2. Merge boards
    const { mergedEngine, mapping } = mergeBoards(
      this.engineA, this.engineB, this.mergeEdge,
      { paramStrategy: this.paramStrategy }
    );

    // 3. Combine moves from both players
    const allMoves = [...this.movesA, ...this.movesB];

    // 4. Run merged board
    runMerged(mergedEngine, this.duration, allMoves);

    // 5. Record merged state hash
    const mergedStateHash = toHex(sha256(mergedEngine.serialize()));

    // 6. Split back into two boards
    const { engineA, engineB } = splitBoards(mergedEngine, mapping);

    // 7. Record final state hashes
    const finalHashA = toHex(sha256(engineA.serialize()));
    const finalHashB = toHex(sha256(engineB.serialize()));

    return {
      initialHashA,
      initialHashB,
      finalHashA,
      finalHashB,
      mergedStateHash,
      engineA,
      engineB,
      mergeEdge: this.mergeEdge,
      duration: this.duration,
      moves: allMoves,
    };
  }
}
