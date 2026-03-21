/**
 * Session replay and verification.
 *
 * Given a session record (initial state + inputs + blocks), replays the
 * simulation and verifies every block's state hashes and hash chain integrity.
 *
 * @module coin/verify
 */

import { sha256, toHex, fromHex } from './hash.js';

/**
 * @typedef {Object} BlockResult
 * @property {number} index
 * @property {boolean} valid
 * @property {string} [error] - description of failure if invalid
 * @property {string} computedStartHash
 * @property {string} computedEndHash
 * @property {string} recordedStartHash
 * @property {string} recordedEndHash
 */

/**
 * @typedef {Object} VerifyResult
 * @property {boolean} valid
 * @property {BlockResult[]} blocks
 * @property {string} [error] - top-level error if verification failed entirely
 */

const ZERO_HASH = '0'.repeat(64);

/**
 * Verify a session record by replaying the simulation.
 *
 * @param {import('./session.js').SessionRecord} record
 * @param {import('./engine.js').Engine} engine - fresh engine instance (not yet initialized)
 * @returns {VerifyResult}
 */
export function verifySession(record, engine) {
  const results = [];

  try {
    // Restore initial state
    engine.init(record.config);
    engine.deserialize(fromHex(record.initialStateHex));

    // Verify initial state hash matches first block's startStateHash
    const initialHash = toHex(sha256(engine.serialize()));
    if (record.blocks.length > 0 && initialHash !== record.blocks[0].startStateHash) {
      return {
        valid: false,
        blocks: [],
        error: `Initial state hash mismatch: computed ${initialHash}, recorded ${record.blocks[0].startStateHash}`
      };
    }

    // Sort inputs by tick for replay
    const inputs = [...record.inputs].sort((a, b) => a.tick - b.tick);
    let inputIdx = 0;

    let prevBlockHash = ZERO_HASH;

    for (const block of record.blocks) {
      const startState = engine.serialize();
      const computedStartHash = toHex(sha256(startState));

      // Verify hash chain linkage
      if (block.prevHash !== prevBlockHash) {
        results.push({
          index: block.index,
          valid: false,
          error: `Hash chain broken: prevHash ${block.prevHash} != expected ${prevBlockHash}`,
          computedStartHash,
          computedEndHash: '',
          recordedStartHash: block.startStateHash,
          recordedEndHash: block.endStateHash
        });
        return { valid: false, blocks: results };
      }

      // Verify start state hash
      if (computedStartHash !== block.startStateHash) {
        results.push({
          index: block.index,
          valid: false,
          error: `Start state hash mismatch: computed ${computedStartHash}, recorded ${block.startStateHash}`,
          computedStartHash,
          computedEndHash: '',
          recordedStartHash: block.startStateHash,
          recordedEndHash: block.endStateHash
        });
        return { valid: false, blocks: results };
      }

      // Step the engine from startTick to endTick, applying inputs along the way
      const targetTick = block.endTick;
      while (engine.clock() < targetTick) {
        // Apply any inputs at the current tick
        while (inputIdx < inputs.length && inputs[inputIdx].tick <= engine.clock()) {
          engine.applyInput(inputs[inputIdx]);
          inputIdx++;
        }

        // Step to next input or to target, whichever is closer
        const nextInputTick = inputIdx < inputs.length ? inputs[inputIdx].tick : targetTick;
        const stepsToTake = Math.min(nextInputTick, targetTick) - engine.clock();
        if (stepsToTake > 0) {
          engine.step(stepsToTake);
        }

        // Apply inputs at the tick we just reached
        while (inputIdx < inputs.length && inputs[inputIdx].tick <= engine.clock()) {
          engine.applyInput(inputs[inputIdx]);
          inputIdx++;
        }
      }

      // Verify end state hash
      const endState = engine.serialize();
      const computedEndHash = toHex(sha256(endState));

      if (computedEndHash !== block.endStateHash) {
        results.push({
          index: block.index,
          valid: false,
          error: `End state hash mismatch: computed ${computedEndHash}, recorded ${block.endStateHash}`,
          computedStartHash,
          computedEndHash,
          recordedStartHash: block.startStateHash,
          recordedEndHash: block.endStateHash
        });
        return { valid: false, blocks: results };
      }

      // Verify block hash
      const blockObj = {
        endStateHash: block.endStateHash,
        endTick: block.endTick,
        index: block.index,
        inputs: block.inputs,
        prevHash: block.prevHash,
        startStateHash: block.startStateHash,
        startTick: block.startTick,
        summary: sortObj(block.summary),
        wallTimeMs: block.wallTimeMs
      };
      const computedBlockHash = toHex(sha256(new TextEncoder().encode(JSON.stringify(blockObj))));
      if (computedBlockHash !== block.hash) {
        results.push({
          index: block.index,
          valid: false,
          error: `Block hash mismatch: computed ${computedBlockHash}, recorded ${block.hash}`,
          computedStartHash,
          computedEndHash,
          recordedStartHash: block.startStateHash,
          recordedEndHash: block.endStateHash
        });
        return { valid: false, blocks: results };
      }

      prevBlockHash = block.hash;

      results.push({
        index: block.index,
        valid: true,
        computedStartHash,
        computedEndHash,
        recordedStartHash: block.startStateHash,
        recordedEndHash: block.endStateHash
      });
    }

    return { valid: true, blocks: results };
  } catch (err) {
    return { valid: false, blocks: results, error: err.message };
  }
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
