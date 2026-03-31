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
 * Update transducer weights (M-step with proper AND-gate blame assignment).
 *
 * Each transition i independently passes with probability wᵢ.
 * The sequence passes iff ALL transitions pass (AND gate).
 *
 * For viable sequences: all transitions get PASS credit.
 * For non-viable sequences: blame is assigned via posterior:
 *   P(FAILᵢ | sequence failed) = (1 - wᵢ) / (1 - ∏ wⱼ)
 * When weights are equal, blame is equal across all risky transitions.
 *
 * @param {import('./transducer.js').CopyTransducer} transducer
 * @param {{ bytes: Uint8Array, reward: number }[]} examples
 *   reward in [0,1]: 1 = fully viable, 0 = not viable
 * @param {Object} [opts]
 * @param {number} [opts.alpha=0.1] - Laplace smoothing pseudocount
 */
export function updateWeights(transducer, examples, opts = {}) {
    const { alpha = 0.1 } = opts;
    const { trans, initial } = transducer;

    const passCount = new Float64Array(transducer.numStates * 256);
    const failCount = new Float64Array(transducer.numStates * 256);

    for (const ex of examples) {
        // Trace path, collect trainable transitions
        let state = initial;
        const path = []; // [{key, weight}]
        for (const b of ex.bytes) {
            const key = state * 256 + b;
            const t = trans[key];
            if (!t) break;
            if (t.verdict !== FAIL && t.weight < 1.0) {
                path.push({ key, weight: t.weight });
            }
            state = t.next;
        }

        if (ex.reward >= 0.5) {
            // Viable: all transitions passed → full PASS credit
            for (const { key } of path) {
                passCount[key] += ex.reward;
            }
        } else if (path.length > 0) {
            // Non-viable: AND-gate blame assignment
            // P(sequence failed) = 1 - ∏ wᵢ
            let logProd = 0;
            for (const { weight } of path) logProd += Math.log(weight);
            const prodW = Math.exp(logProd);
            const pFailed = 1 - prodW;

            if (pFailed > 1e-15) {
                for (const { key, weight } of path) {
                    // P(FAILᵢ | failed) = (1-wᵢ) / (1-∏wⱼ)
                    const pBlame = (1 - weight) / pFailed;
                    const pPass = 1 - pBlame;
                    failCount[key] += pBlame * (1 - ex.reward);
                    passCount[key] += pPass * (1 - ex.reward);
                }
            } else {
                // All weights ≈ 1, but oracle says fail — spread blame equally
                const blame = (1 - ex.reward) / path.length;
                for (const { key } of path) {
                    failCount[key] += blame;
                }
            }
        }
    }

    // M-step: update weights
    for (let key = 0; key < transducer.numStates * 256; key++) {
        const p = passCount[key];
        const f = failCount[key];
        if (p + f === 0) continue;
        const t = trans[key];
        if (!t || t.verdict === FAIL) continue;
        t.weight = (p + alpha) / (p + f + 2 * alpha);
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

// --- Importance sampling ---

/**
 * Compute the log-probability of a sequence under the current WFST.
 * log q(x) = sum_i log( w(s_i, x_i) * fwd[s_{i+1}][L-i-1] / fwd[s_i][L-i] )
 *
 * @param {CopyTransducer} transducer
 * @param {Float64Array[]} forwardCounts - from weightedForward
 * @param {Uint8Array} bytes
 * @returns {number} log2 q(x)
 */
export function logPathProbability(transducer, forwardCounts, bytes) {
    const { trans, initial } = transducer;
    const L = bytes.length;
    let state = initial;
    let logQ = 0;

    for (let i = 0; i < L; i++) {
        const remaining = L - i;
        const z = forwardCounts[state][remaining];
        if (z === 0) return -Infinity;

        const b = bytes[i];
        const t = trans[state * 256 + b];
        if (!t || t.verdict === FAIL) return -Infinity;

        const nextRemaining = remaining - 1;
        const pByte = (t.weight * forwardCounts[t.next][nextRemaining]) / z;
        if (pByte <= 0) return -Infinity;

        logQ += Math.log2(pByte);
        state = t.next;
    }

    return logQ;
}

/**
 * Importance sampling estimate of P(viable | length L).
 *
 * Samples from the WFST (proposal q), simulates each, and computes:
 *   P(viable) ≈ (1/N) * sum_i [ viable_i * P_uniform(x_i) / q(x_i) ]
 *
 * Also returns the WFST's own estimate for comparison.
 *
 * @param {CopyTransducer} transducer
 * @param {Set<number>} acceptStates
 * @param {number} L
 * @param {number} N - number of samples
 * @param {Function} simulateFn - async (bytes) => { spread, copied }
 * @param {Object} rng
 * @returns {Promise<Object>}
 */
export async function importanceSamplingEstimate(transducer, acceptStates, L, N, simulateFn, rng) {
    const fwd = weightedForward(transducer, L, acceptStates);
    const logUniform = -L * 8; // log2(1/256^L)

    const samples = [];
    let sumIW = 0;
    let sumIW2 = 0;
    let nViable = 0;

    for (let i = 0; i < N; i++) {
        const bytes = weightedSample(transducer, L, fwd, rng);
        if (!bytes) continue;

        const sim = await simulateFn(bytes);
        const viable = sim.copied ? 1 : 0;
        nViable += viable;

        const logQ = logPathProbability(transducer, fwd, bytes);
        // importance weight = P_uniform / q = 2^(logUniform - logQ)
        const logIW = logUniform - logQ;
        const iw = 2 ** logIW;

        sumIW += viable * iw;
        sumIW2 += iw * iw;

        samples.push({ bytes, viable, logQ, logIW, spread: sim.spread });
    }

    const pViableIS = sumIW / N;
    const beffIS = pViableIS > 0 ? -Math.log2(pViableIS) : Infinity;

    // WFST's own estimate
    const beffWFST = weightedBeff(fwd, transducer.initial, L);

    // Effective sample size
    const ess = N > 0 ? (N * N) / (sumIW2 * N * N / (sumIW * sumIW || 1)) : 0;

    return {
        pViableIS,
        beffIS,
        beffWFST,
        nSampled: samples.length,
        nViable,
        viableRate: samples.length > 0 ? nViable / samples.length : 0,
        ess: Math.min(N, ess),
    };
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
