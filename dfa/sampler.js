/**
 * Backward stochastic traceback: uniform sampling from a DFA's language.
 *
 * Given precomputed Forward counts, samples a uniformly random byte
 * sequence of length L that is accepted by the DFA.
 *
 * Algorithm: at each position, choose the next byte proportional to
 * count[next_state][remaining_length - 1]. This gives an exact uniform
 * sample over all accepted sequences of the given length.
 */

import { forwardCountsFloat, forwardCountsBigInt } from './forward.js';

/**
 * Precompute Forward tables for sampling.
 *
 * @param {import('./dfa.js').DFA} dfa - compiled DFA
 * @param {number} L - sequence length to sample
 * @returns {Object} precomputed tables for sampleSequence
 */
export function prepareSampler(dfa, L) {
    dfa._ensureCompiled();
    const counts = forwardCountsFloat(dfa, L);
    return {
        dfa,
        L,
        counts,
        numStates: dfa._compiled.numStates,
        trans: dfa._compiled.trans,
        initial: dfa._compiled.initial,
    };
}

/**
 * Sample one accepted sequence of length L.
 *
 * @param {Object} sampler - from prepareSampler()
 * @param {Object} rng - PRNG with .real() method returning [0,1)
 * @returns {Uint8Array|null} sampled sequence, or null if no accepted
 *   sequences of this length exist
 */
export function sampleSequence(sampler, rng) {
    const { L, counts, numStates, trans, initial } = sampler;

    // Check if any accepted sequences exist
    if (counts[initial][L] === 0) return null;

    const result = new Uint8Array(L);
    let state = initial;

    for (let pos = 0; pos < L; pos++) {
        const remaining = L - pos - 1;

        // Compute weights for each possible byte
        let totalWeight = 0;
        // Use a temporary array to avoid per-byte allocation
        const weights = new Float64Array(256);
        for (let b = 0; b < 256; b++) {
            const next = trans[state * 256 + b];
            if (next >= 0) {
                weights[b] = counts[next][remaining];
            }
            totalWeight += weights[b];
        }

        if (totalWeight === 0) return null; // shouldn't happen if counts are correct

        // Sample byte proportional to weights
        let r = rng.real() * totalWeight;
        let chosen = 255; // fallback
        for (let b = 0; b < 256; b++) {
            r -= weights[b];
            if (r <= 0) {
                chosen = b;
                break;
            }
        }

        result[pos] = chosen;
        state = trans[state * 256 + chosen];
    }

    return result;
}

/**
 * Generate N samples and return them as an array.
 *
 * @param {import('./dfa.js').DFA} dfa
 * @param {number} L - sequence length
 * @param {number} N - number of samples
 * @param {Object} rng - PRNG with .real() method
 * @returns {Uint8Array[]}
 */
export function sampleN(dfa, L, N, rng) {
    const sampler = prepareSampler(dfa, L);
    const samples = [];
    for (let i = 0; i < N; i++) {
        const seq = sampleSequence(sampler, rng);
        if (seq) samples.push(seq);
    }
    return samples;
}
