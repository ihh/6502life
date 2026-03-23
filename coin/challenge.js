/**
 * Challenge protocol for verifying board history via Merkle proofs.
 *
 * Two players derive pseudorandom challenge timepoints from their combined
 * public keys, then prove they checkpointed those states.
 *
 * @module coin/challenge
 */

import { sha256, toHex } from './hash.js';
import { BoardMerkleTree } from './merkle.js';

/**
 * Generate pseudorandom challenge timepoints from two public keys.
 * The result is deterministic given the same inputs (order-independent).
 *
 * @param {Uint8Array} myPublicKey
 * @param {Uint8Array} theirPublicKey
 * @param {number} numChallenges
 * @param {number} maxTick - exclusive upper bound
 * @returns {number[]} sorted array of tick values in [0, maxTick)
 */
export function generateChallenges(myPublicKey, theirPublicKey, numChallenges, maxTick) {
  if (maxTick <= 0) return [];
  if (numChallenges <= 0) return [];

  // Combine keys in sorted order so result is the same regardless of who calls
  const keyA = toHex(myPublicKey);
  const keyB = toHex(theirPublicKey);
  const ordered = keyA < keyB
    ? [myPublicKey, theirPublicKey]
    : [theirPublicKey, myPublicKey];

  const seed = new Uint8Array(ordered[0].length + ordered[1].length);
  seed.set(ordered[0], 0);
  seed.set(ordered[1], ordered[0].length);

  const ticks = [];
  let counter = 0;

  // Generate ticks by repeatedly hashing seed + counter
  while (ticks.length < numChallenges) {
    const counterBytes = new Uint8Array(4);
    new DataView(counterBytes.buffer).setUint32(0, counter, false);

    const input = new Uint8Array(seed.length + 4);
    input.set(seed, 0);
    input.set(counterBytes, seed.length);

    const hash = sha256(input);
    // Read a 32-bit big-endian value from the hash and mod by maxTick
    const val = new DataView(hash.buffer, hash.byteOffset).getUint32(0, false);
    const tick = val % maxTick;

    if (!ticks.includes(tick)) {
      ticks.push(tick);
    }
    counter++;
  }

  return ticks.sort((a, b) => a - b);
}

/**
 * Respond to a challenge: provide Merkle proofs for requested ticks.
 * For ticks not exactly checkpointed, finds the nearest earlier checkpoint.
 *
 * @param {BoardMerkleTree} tree
 * @param {number[]} challengeTicks
 * @returns {Array<{ stateHash: string, tick: number, proof: string[], index: number }>}
 */
export function respondToChallenge(tree, challengeTicks) {
  return challengeTicks.map(tick => tree.prove(tick));
}

/**
 * Verify a challenge response against a known root hash.
 *
 * @param {string} rootHash - hex Merkle root
 * @param {Array<{ stateHash: string, tick: number, proof: string[], index: number }>} response
 * @returns {boolean}
 */
export function verifyChallenge(rootHash, response) {
  return response.every(({ stateHash, tick, proof, index }) =>
    BoardMerkleTree.verify(rootHash, stateHash, tick, proof, index)
  );
}
