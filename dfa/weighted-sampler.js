/**
 * Weighted Forward/sampler on a CopyTransducer.
 *
 * Unlike the DFA-based forward.js/sampler.js (which treat all valid
 * transitions equally), this operates directly on the transducer's
 * transition weights. FAIL-verdict transitions are excluded.
 *
 * This enables Baum-Welch-style training: sample → simulate → update
 * weights → resample, all on the same composed machine.
 */

import { FAIL } from './transducer.js';

/**
 * Weighted Forward: count[s][n] = total weight of length-n paths
 * from state s to an accepting state, using transition weights.
 *
 * @param {import('./transducer.js').CopyTransducer} transducer
 * @param {number} L - sequence length
 * @param {Set<number>} acceptStates - state indices to treat as accepting
 * @returns {Float64Array[]} count[state] = Float64Array(L+1)
 */
export function weightedForward(transducer, L, acceptStates) {
    const { numStates, trans } = transducer;

    const count = Array.from({ length: numStates }, () =>
        new Float64Array(L + 1)
    );

    // Base: count[s][0] = 1 if accepting, else 0
    for (let s = 0; s < numStates; s++) {
        count[s][0] = acceptStates.has(s) ? 1 : 0;
    }

    // Fill: count[s][n] = sum_b weight(s,b) * count[next(s,b)][n-1]
    for (let n = 1; n <= L; n++) {
        for (let s = 0; s < numStates; s++) {
            let total = 0;
            for (let b = 0; b < 256; b++) {
                const t = trans[s * 256 + b];
                if (!t || t.verdict === FAIL) continue;
                total += t.weight * count[t.next][n - 1];
            }
            count[s][n] = total;
        }
    }

    return count;
}

/**
 * Sample one sequence from the weighted transducer.
 *
 * @param {import('./transducer.js').CopyTransducer} transducer
 * @param {number} L - sequence length
 * @param {Float64Array[]} forwardCounts - from weightedForward
 * @param {Object} rng - PRNG with .real()
 * @returns {Uint8Array|null}
 */
export function weightedSample(transducer, L, forwardCounts, rng) {
    const { trans, initial } = transducer;

    if (forwardCounts[initial][L] === 0) return null;

    const result = new Uint8Array(L);
    let state = initial;

    for (let pos = 0; pos < L; pos++) {
        const remaining = L - pos - 1;
        let totalWeight = 0;
        const weights = new Float64Array(256);

        for (let b = 0; b < 256; b++) {
            const t = trans[state * 256 + b];
            if (!t || t.verdict === FAIL) continue;
            weights[b] = t.weight * forwardCounts[t.next][remaining];
            totalWeight += weights[b];
        }

        if (totalWeight === 0) return null;

        let r = rng.real() * totalWeight;
        let chosen = 255;
        for (let b = 0; b < 256; b++) {
            r -= weights[b];
            if (r <= 0) { chosen = b; break; }
        }

        result[pos] = chosen;
        state = trans[state * 256 + chosen].next;
    }

    return result;
}

/**
 * Update transducer weights from simulation results (M-step).
 *
 * Uses spread count as a continuous reward signal, normalized to [0,1].
 * This gives gradient even from near-misses (spread=1 gets partial credit).
 *
 * For each transition (state, byte), the new weight is the mean reward
 * of examples that used that transition, with Laplace smoothing.
 *
 * @param {import('./transducer.js').CopyTransducer} transducer
 * @param {{ bytes: Uint8Array, reward: number }[]} examples
 *   reward should be in [0,1], e.g. spread/maxSpread
 * @param {Object} [opts]
 * @param {number} [opts.alpha=0.1] - Laplace smoothing pseudocount
 */
export function updateWeights(transducer, examples, opts = {}) {
    const { alpha = 0.1 } = opts;
    const { trans, initial } = transducer;

    const reward = new Float64Array(transducer.numStates * 256);
    const total = new Float64Array(transducer.numStates * 256);

    for (const ex of examples) {
        let state = initial;
        for (const b of ex.bytes) {
            const key = state * 256 + b;
            const t = trans[key];
            if (!t) break;
            total[key]++;
            reward[key] += ex.reward;
            state = t.next;
        }
    }

    // Update weights where we have observations
    for (let key = 0; key < transducer.numStates * 256; key++) {
        if (total[key] === 0) continue;
        const t = trans[key];
        if (!t || t.verdict === FAIL) continue;
        t.weight = (reward[key] + alpha) / (total[key] + 2 * alpha);
    }
}

/**
 * Compute weighted B_eff = -log2(P(viable at length L)).
 *
 * P = weightedForward[initial][L] / (256^L * product of max weights)
 * Actually: P = Z_weighted / 256^L where Z_weighted is the
 * total weight of viable paths. But this needs normalization.
 *
 * Simpler: B_eff ≈ -log2(Z_weighted) + L*8 where Z_weighted
 * = forwardCounts[initial][L] using current weights.
 *
 * @param {Float64Array[]} forwardCounts
 * @param {number} initial - initial state index
 * @param {number} L
 * @returns {number}
 */
export function weightedBeff(forwardCounts, initial, L) {
    const z = forwardCounts[initial][L];
    if (z === 0) return Infinity;
    return -Math.log2(z) + L * 8;
}

/**
 * Run the complete training loop on the composed transducer.
 *
 * @param {import('./transducer.js').CopyTransducer} transducer
 * @param {Set<number>} acceptStates
 * @param {Function} simulateFn - async (Uint8Array) => { copied: boolean }
 * @param {Object} opts
 * @param {number} opts.L - sequence length
 * @param {number} [opts.iterations=5]
 * @param {number} [opts.samplesPerIter=50]
 * @param {Object} opts.rng - PRNG
 * @returns {Promise<Object[]>} iteration history
 */
export async function trainLoop(transducer, acceptStates, simulateFn, opts) {
    const { L, iterations = 5, samplesPerIter = 50, rng } = opts;
    const history = [];

    for (let iter = 0; iter < iterations; iter++) {
        // Forward with current weights
        const fwd = weightedForward(transducer, L, acceptStates);
        const beff = weightedBeff(fwd, transducer.initial, L);

        // Sample
        const samples = [];
        for (let i = 0; i < samplesPerIter; i++) {
            const seq = weightedSample(transducer, L, fwd, rng);
            if (seq) samples.push(seq);
        }

        // Simulate and compute rewards
        const examples = [];
        const maxSpread = (8 * 8) - 1; // 63 for 8×8 board
        for (const bytes of samples) {
            const result = await simulateFn(bytes);
            examples.push({
                bytes,
                viable: result.copied,
                spread: result.spread,
                reward: result.spread / maxSpread, // continuous [0,1]
            });
        }

        const nViable = examples.filter(e => e.viable).length;
        const meanSpread = examples.reduce((s, e) => s + e.spread, 0) / examples.length;

        // M-step: update weights using continuous reward
        updateWeights(transducer, examples);

        history.push({
            iter,
            beff,
            nSampled: samples.length,
            nViable,
            viableRate: samples.length > 0 ? nViable / samples.length : 0,
            meanSpread,
        });
    }

    return history;
}
