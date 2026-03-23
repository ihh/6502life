/**
 * Session recorder — wraps an Engine, records inputs, produces a hash chain.
 *
 * A session captures: initial state + timestamped inputs + blocks (hash chain).
 * This is sufficient to reproduce the full simulation trajectory.
 *
 * @module coin/session
 */

import { randomUUID } from 'node:crypto';
import { sha256, toHex } from './hash.js';
import { BoardMerkleTree } from './merkle.js';
import { coinsEarned, decayedBalance, canAffordMove, DEFAULT_COIN_PARAMS } from './economics.js';

/**
 * @typedef {Object} Block
 * @property {number} index
 * @property {string} prevHash - hex-encoded SHA-256 of previous block (zeros for genesis)
 * @property {string} startStateHash - hex-encoded SHA-256 of state at block start
 * @property {string} endStateHash - hex-encoded SHA-256 of state at block end
 * @property {import('./engine.js').Input[]} inputs - inputs applied during this block
 * @property {number} startTick - simulation tick at block start
 * @property {number} endTick - simulation tick at block end
 * @property {number} wallTimeMs - wall-clock ms elapsed during this block
 * @property {Record<string, number>} summary - engine summary stats at block end
 */

/**
 * @typedef {Object} SessionRecord
 * @property {string} id - UUID
 * @property {import('./engine.js').EngineConfig} config
 * @property {string} initialStateHex - hex-encoded initial serialized state
 * @property {import('./engine.js').Input[]} inputs
 * @property {number} finalTick
 * @property {Block[]} blocks
 */

const ZERO_HASH = '0'.repeat(64);

export class Session {
  /**
   * @param {import('./engine.js').Engine} engine - initialized engine
   * @param {import('./engine.js').EngineConfig} config
   * @param {Object} [options]
   * @param {number} [options.blockInterval=10000] - ticks per block
   */
  constructor(engine, config, options = {}) {
    this.id = randomUUID();
    this.engine = engine;
    this.config = config;
    this.blockInterval = options.blockInterval ?? 10000;

    /** Whether this session is a share session (earns at accelerated rate) */
    this.isSharing = options.isSharing ?? false;

    /** Coin economics parameters */
    this.coinParams = { ...DEFAULT_COIN_PARAMS, ...options.coinParams };

    /** Current coin balance */
    this.coinBalance = options.initialBalance ?? 0;

    /** Tick of last balance update (for decay) */
    this._lastBalanceTick = 0;

    /** @type {import('./engine.js').Input[]} */
    this.inputs = [];
    /** @type {Block[]} */
    this.blocks = [];

    // Merkle tree for board history checkpoints
    this.merkleTree = new BoardMerkleTree();

    // Capture initial state
    this.initialState = engine.serialize();
    this.initialStateHex = toHex(this.initialState);

    // Current block tracking
    this._blockStartTick = engine.clock();
    this._blockStartStateHash = toHex(sha256(this.initialState));

    // Append initial state as first checkpoint
    this.merkleTree.append(this._blockStartStateHash, this._blockStartTick);
    this._blockInputs = [];
    this._blockStartWallTime = Date.now();
    this._nextBlockTick = this._blockStartTick + this.blockInterval;
  }

  /**
   * Apply an input to the engine and record it.
   * @param {import('./engine.js').Input} input
   */
  /**
   * Apply an input (Move) to the engine, spending coins.
   * Throws if balance is insufficient.
   * @param {import('./engine.js').Input} input
   * @param {Object} [options]
   * @param {boolean} [options.skipCoinCheck=false] - bypass coin check
   */
  async applyInput(input, options = {}) {
    if (!options.skipCoinCheck) {
      // Update balance with decay before checking
      this._updateBalance();
      const cost = this.coinParams.moveCost;
      if (!canAffordMove(this.coinBalance, cost)) {
        throw new Error(`Insufficient coins: balance=${this.coinBalance.toFixed(4)}, cost=${cost}`);
      }
      this.coinBalance -= cost;
    }
    await this.engine.applyInput(input);
    this.inputs.push(input);
    this._blockInputs.push(input);
  }

  /**
   * Step the engine forward by n ticks, producing blocks as needed.
   * @param {number} [n=1]
   * @returns {number} total steps executed
   */
  step(n = 1) {
    let remaining = n;
    let totalExecuted = 0;

    while (remaining > 0) {
      const currentTick = this.engine.clock();
      const ticksToNextBlock = this._nextBlockTick - currentTick;
      const stepsThisRound = Math.min(remaining, ticksToNextBlock);

      if (stepsThisRound > 0) {
        const executed = this.engine.step(stepsThisRound);
        totalExecuted += executed;
        remaining -= executed;
      }

      // Check if we've reached a block boundary
      if (this.engine.clock() >= this._nextBlockTick) {
        this._produceBlock();
      }
    }

    return totalExecuted;
  }

  /**
   * Produce a block at the current engine state.
   * @private
   */
  /**
   * Update coin balance: apply decay and earn coins for elapsed ticks.
   * @private
   */
  _updateBalance() {
    const currentTick = this.engine.clock();
    const elapsed = currentTick - this._lastBalanceTick;
    if (elapsed > 0) {
      // Apply decay first
      this.coinBalance = decayedBalance(this.coinBalance, elapsed, this.coinParams);
      // Then earn
      this.coinBalance += coinsEarned(elapsed, this.isSharing, this.coinParams);
      this._lastBalanceTick = currentTick;
    }
  }

  _produceBlock() {
    const endState = this.engine.serialize();
    const endStateHash = toHex(sha256(endState));
    const now = Date.now();

    // Update coin balance at block boundary
    this._updateBalance();

    const prevHash = this.blocks.length > 0
      ? this.blocks[this.blocks.length - 1]._hash
      : ZERO_HASH;

    // Append end-of-block state to Merkle tree
    this.merkleTree.append(endStateHash, this.engine.clock());

    const block = {
      index: this.blocks.length,
      prevHash,
      startStateHash: this._blockStartStateHash,
      endStateHash,
      inputs: [...this._blockInputs],
      startTick: this._blockStartTick,
      endTick: this.engine.clock(),
      wallTimeMs: now - this._blockStartWallTime,
      summary: this.engine.summarize(),
      merkleRoot: this.merkleTree.root(),
      coinBalance: this.coinBalance,
    };

    // Compute block hash (hash of canonical block content)
    block._hash = toHex(sha256(new TextEncoder().encode(canonicalBlockString(block))));

    this.blocks.push(block);

    // Reset for next block
    this._blockStartTick = this.engine.clock();
    this._blockStartStateHash = endStateHash;
    this._blockInputs = [];
    this._blockStartWallTime = now;
    this._nextBlockTick = this._blockStartTick + this.blockInterval;
  }

  /**
   * Finalize the session — produce a final block if there are unrecorded ticks.
   * @returns {SessionRecord}
   */
  finalize() {
    // Produce final block if there are ticks since the last block
    if (this.engine.clock() > this._blockStartTick) {
      this._produceBlock();
    }

    return {
      id: this.id,
      config: this.config,
      initialStateHex: this.initialStateHex,
      inputs: this.inputs,
      finalTick: this.engine.clock(),
      coinBalance: this.coinBalance,
      merkleTree: this.merkleTree.serialize(),
      merkleRoot: this.merkleTree.root(),
      blocks: this.blocks.map(b => ({
        index: b.index,
        prevHash: b.prevHash,
        startStateHash: b.startStateHash,
        endStateHash: b.endStateHash,
        inputs: b.inputs,
        startTick: b.startTick,
        endTick: b.endTick,
        wallTimeMs: b.wallTimeMs,
        summary: b.summary,
        merkleRoot: b.merkleRoot,
        coinBalance: b.coinBalance,
        hash: b._hash
      }))
    };
  }
}

/**
 * Produce a canonical string representation of a block for hashing.
 * Uses sorted keys, no whitespace.
 * @param {Block} block
 * @returns {string}
 */
function canonicalBlockString(block) {
  const obj = {
    endStateHash: block.endStateHash,
    endTick: block.endTick,
    index: block.index,
    inputs: block.inputs,
    merkleRoot: block.merkleRoot,
    prevHash: block.prevHash,
    startStateHash: block.startStateHash,
    startTick: block.startTick,
    summary: sortObj(block.summary),
    wallTimeMs: block.wallTimeMs
  };
  return JSON.stringify(obj);
}

/**
 * Sort an object's keys for canonical JSON.
 * @param {Record<string, unknown>} obj
 * @returns {Record<string, unknown>}
 */
function sortObj(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortObj);
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObj(obj[key]);
  }
  return sorted;
}
