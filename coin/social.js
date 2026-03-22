/**
 * Edge-sharing protocol for social mining.
 *
 * Two boards share a boundary: one board's export edge maps to the other's
 * import edge. Boundary data is exchanged at configurable tick intervals.
 *
 * @module coin/social
 */

import { sha256, toHex } from './hash.js';

/**
 * @typedef {'north' | 'south' | 'east' | 'west'} Edge
 */

/**
 * @typedef {Object} BoundaryFrame
 * @property {number} tick - simulation tick at time of exchange
 * @property {Uint8Array} data - serialized boundary strip
 * @property {string} hash - hex SHA-256 of data
 */

/**
 * Opposite edges for the default pairing.
 * If board A exports east, board B imports west (and vice versa).
 */
const OPPOSITE_EDGE = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east'
};

/**
 * Share boundary data between two engines at the current tick.
 *
 * Reads the export edge from each engine, writes it to the partner's
 * import edge, and returns the boundary frames for both directions.
 *
 * @param {import('./engine.js').Engine} engineA
 * @param {Edge} edgeA - A's export edge (data flows FROM this edge)
 * @param {import('./engine.js').Engine} engineB
 * @param {Edge} edgeB - B's export edge (data flows FROM this edge)
 * @returns {{ aToB: BoundaryFrame, bToA: BoundaryFrame }}
 */
export function shareBoundary(engineA, edgeA, engineB, edgeB) {
  const tickA = engineA.clock();
  const tickB = engineB.clock();

  // Read boundaries
  const dataA = engineA.getBoundary(edgeA);
  const dataB = engineB.getBoundary(edgeB);

  // Compute hashes
  const hashA = toHex(sha256(dataA));
  const hashB = toHex(sha256(dataB));

  // Write to partner's import edge (opposite of their export)
  const importEdgeB = OPPOSITE_EDGE[edgeA];
  const importEdgeA = OPPOSITE_EDGE[edgeB];

  engineB.setBoundary(importEdgeB, dataA);
  engineA.setBoundary(importEdgeA, dataB);

  return {
    aToB: { tick: tickA, data: dataA, hash: hashA },
    bToA: { tick: tickB, data: dataB, hash: hashB }
  };
}

/**
 * Manages a pair of boards sharing one edge.
 *
 * Runs both engines in lockstep, exchanging boundary data at a
 * configurable interval (every N ticks).
 */
export class EdgeSession {
  /**
   * @param {import('./engine.js').Engine} engineA - first engine (initialized)
   * @param {import('./engine.js').Engine} engineB - second engine (initialized)
   * @param {Object} [options]
   * @param {Edge} [options.edgeA='east'] - A's export edge
   * @param {Edge} [options.edgeB='east'] - B's export edge
   * @param {number} [options.shareInterval=100] - ticks between boundary syncs
   */
  constructor(engineA, engineB, options = {}) {
    this.engineA = engineA;
    this.engineB = engineB;
    this.edgeA = options.edgeA ?? 'east';
    this.edgeB = options.edgeB ?? 'east';
    this.shareInterval = options.shareInterval ?? 100;

    /** @type {BoundaryFrame[]} frames sent from A to B */
    this.framesAtoB = [];
    /** @type {BoundaryFrame[]} frames sent from B to A */
    this.framesBtoA = [];

    this._ticksSinceLastShare = 0;
  }

  /**
   * Advance both engines by n ticks, sharing boundaries at each interval.
   *
   * @param {number} n - total ticks to advance
   * @returns {{ ticksExecuted: number, sharesPerformed: number }}
   */
  step(n) {
    let remaining = n;
    let totalExecuted = 0;
    let shares = 0;

    while (remaining > 0) {
      const ticksToNextShare = this.shareInterval - this._ticksSinceLastShare;
      const batch = Math.min(remaining, ticksToNextShare);

      this.engineA.step(batch);
      this.engineB.step(batch);
      totalExecuted += batch;
      remaining -= batch;
      this._ticksSinceLastShare += batch;

      // Share boundary at interval
      if (this._ticksSinceLastShare >= this.shareInterval) {
        const frames = shareBoundary(
          this.engineA, this.edgeA,
          this.engineB, this.edgeB
        );
        this.framesAtoB.push(frames.aToB);
        this.framesBtoA.push(frames.bToA);
        this._ticksSinceLastShare = 0;
        shares++;
      }
    }

    return { ticksExecuted: totalExecuted, sharesPerformed: shares };
  }

  /**
   * Get all boundary exchange records.
   * @returns {{ aToB: BoundaryFrame[], bToA: BoundaryFrame[] }}
   */
  getFrames() {
    return {
      aToB: this.framesAtoB,
      bToA: this.framesBtoA
    };
  }

  /**
   * Serialize all frames to a JSON-safe format (data as hex).
   * @returns {{ aToB: Object[], bToA: Object[] }}
   */
  serializeFrames() {
    const serialize = (frames) => frames.map(f => ({
      tick: f.tick,
      dataHex: toHex(f.data),
      hash: f.hash
    }));
    return {
      aToB: serialize(this.framesAtoB),
      bToA: serialize(this.framesBtoA)
    };
  }
}
