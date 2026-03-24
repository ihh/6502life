/**
 * Economic verification — checks that a session's player inputs (writes)
 * are affordable given the coin earn/spend/decay rules.
 *
 * This is decoupled from hash/replay verification (coin/verify.js).
 * Hash verification checks "did the simulation actually produce these states?"
 * Economic verification checks "did the player have enough coins to do what
 * they claimed to do?"
 *
 * @module coin/verify-economics
 */

import { coinsEarned, decayedBalance, DEFAULT_COIN_PARAMS } from './economics.js';

/**
 * @typedef {Object} EconBlock
 * @property {number} startTick
 * @property {number} endTick
 * @property {Array<{tick: number}>} inputs - player inputs in this block
 * @property {number} [coinBalance] - recorded balance at block end (optional)
 */

/**
 * @typedef {Object} EconVerifyResult
 * @property {boolean} valid
 * @property {number} finalBalance - computed balance at end of session
 * @property {Array<{blockIndex: number, valid: boolean, balance: number, error?: string}>} blocks
 * @property {string} [error] - top-level error
 */

/**
 * Verify that a session's inputs are economically valid.
 *
 * Walks the block sequence, tracking coin balance through earn (from sim
 * ticks) and spend (from player inputs). Each input costs moveCost coins.
 * Balance decays exponentially between events.
 *
 * @param {Object} record - session record (same shape as SessionRecord)
 * @param {Object} [options]
 * @param {Object} [options.coinParams] - override DEFAULT_COIN_PARAMS
 * @param {boolean} [options.isSharing=false] - whether session was a share
 * @param {number} [options.initialBalance=0] - starting coin balance
 * @param {number} [options.balanceTolerance=0.001] - tolerance for recorded vs computed balance
 * @returns {EconVerifyResult}
 */
export function verifyEconomics(record, options = {}) {
  const params = { ...DEFAULT_COIN_PARAMS, ...options.coinParams };
  const isSharing = options.isSharing ?? false;
  const tolerance = options.balanceTolerance ?? 0.001;
  const results = [];

  let balance = options.initialBalance ?? 0;
  let lastTick = record.blocks.length > 0 ? record.blocks[0].startTick : 0;

  try {
    for (const block of record.blocks) {
      // Collect all input ticks in this block, sorted
      const inputTicks = (block.inputs || [])
        .map(inp => inp.tick)
        .sort((a, b) => a - b);

      // Process each input: earn up to its tick, then spend
      for (const tick of inputTicks) {
        const elapsed = tick - lastTick;
        if (elapsed > 0) {
          balance = decayedBalance(balance, elapsed, params);
          balance += coinsEarned(elapsed, isSharing, params);
          lastTick = tick;
        }

        // Spend
        balance -= params.moveCost;
        if (balance < -tolerance) {
          results.push({
            blockIndex: block.index,
            valid: false,
            balance,
            error: `Insufficient coins at tick ${tick}: balance=${balance.toFixed(6)}, cost=${params.moveCost}`
          });
          return { valid: false, finalBalance: balance, blocks: results, error: results[results.length - 1].error };
        }
      }

      // Earn remaining ticks to block end
      const elapsed = block.endTick - lastTick;
      if (elapsed > 0) {
        balance = decayedBalance(balance, elapsed, params);
        balance += coinsEarned(elapsed, isSharing, params);
        lastTick = block.endTick;
      }

      // Optionally check recorded balance
      const blockResult = { blockIndex: block.index, valid: true, balance };
      if (block.coinBalance !== undefined) {
        const diff = Math.abs(balance - block.coinBalance);
        if (diff > tolerance) {
          blockResult.valid = false;
          blockResult.error = `Balance mismatch: computed=${balance.toFixed(6)}, recorded=${block.coinBalance.toFixed(6)}`;
          results.push(blockResult);
          return { valid: false, finalBalance: balance, blocks: results, error: blockResult.error };
        }
      }
      results.push(blockResult);
    }

    return { valid: true, finalBalance: balance, blocks: results };
  } catch (err) {
    return { valid: false, finalBalance: balance, blocks: results, error: err.message };
  }
}
