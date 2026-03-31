/**
 * Active learning for WFST replicator models.
 *
 * Allocates simulation budget to maximize information gain:
 * 1. Identify transitions with most uncertain weights (near 0.5)
 * 2. Sample sequences that traverse those transitions
 * 3. Simulate and update
 * 4. Validate with importance sampling
 *
 * The key insight: simulation is expensive, Forward/sampling is cheap.
 * Active learning concentrates simulation where it reduces uncertainty most.
 */

import { FAIL } from './transducer.js';
import {
    weightedForward, weightedSample, updateWeights,
    weightedBeff, logPathProbability, importanceSamplingEstimate,
} from './weighted-sampler.js';
import { simulateCandidate } from './simulate.js';

// 24 safe single-byte opcodes (from prefix sweep, P=1.0 with all 4 viable pairs)
const SAFE_SLIDE_OPS = new Set([
    0x08, 0x18, 0x1A, 0x28, 0x3A, 0x48, 0x58, 0x5A,
    0x60, 0x68, 0x78, 0x7A, 0x88, 0x8A, 0x98, 0x9A,
    0xA8, 0xB8, 0xC8, 0xD8, 0xDA, 0xEA, 0xF8, 0xFA,
]);

/**
 * Compute entropy of a Bernoulli(p) variable: -p log p - (1-p) log (1-p).
 * @param {number} p
 * @returns {number} entropy in bits
 */
function bernoulliEntropy(p) {
    if (p <= 0 || p >= 1) return 0;
    return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

/**
 * Find the most uncertain transitions in the trained WFST.
 * Uncertainty = entropy of the weight treated as P(safe).
 *
 * @param {import('./transducer.js').CopyTransducer} transducer
 * @param {Object} [opts]
 * @param {number} [opts.topK=20] - return top K most uncertain
 * @returns {Object[]} sorted by uncertainty (descending)
 */
export function findUncertainTransitions(transducer, opts = {}) {
    const { topK = 20 } = opts;
    const { trans, numStates, stateNames } = transducer;

    const results = [];
    for (let s = 0; s < numStates; s++) {
        for (let b = 0; b < 256; b++) {
            const t = trans[s * 256 + b];
            if (!t || t.verdict === FAIL) continue;
            if (t.weight >= 0.95 || t.weight <= 0.05) continue; // skip near-certain
            const entropy = bernoulliEntropy(t.weight);
            results.push({
                state: s,
                stateName: stateNames[s],
                byte: b,
                weight: t.weight,
                entropy,
            });
        }
    }

    results.sort((a, b) => b.entropy - a.entropy);
    return results.slice(0, topK);
}

/**
 * Active sampling: preferentially sample sequences that traverse
 * uncertain transitions, by temporarily boosting their weights.
 *
 * @param {import('./transducer.js').CopyTransducer} transducer
 * @param {number} L - sequence length
 * @param {Set<number>} acceptStates
 * @param {number} N - number of samples
 * @param {Object} rng
 * @param {Object} [opts]
 * @param {number} [opts.explorationBoost=3] - weight multiplier for uncertain transitions
 * @returns {{ samples: Uint8Array[], originalWeights: Map }}
 */
export function activeSample(transducer, L, acceptStates, N, rng, opts = {}) {
    const { explorationBoost = 3 } = opts;
    const { trans } = transducer;

    // Find uncertain transitions
    const uncertain = findUncertainTransitions(transducer, { topK: 50 });
    const boostedKeys = new Map();

    // Temporarily boost uncertain transition weights
    for (const u of uncertain) {
        const key = u.state * 256 + u.byte;
        const t = trans[key];
        boostedKeys.set(key, t.weight); // save original
        t.weight = Math.min(1.0, t.weight * explorationBoost);
    }

    // Sample with boosted weights
    const fwd = weightedForward(transducer, L, acceptStates);
    const samples = [];
    for (let i = 0; i < N; i++) {
        const seq = weightedSample(transducer, L, fwd, rng);
        if (seq) samples.push(seq);
    }

    // Restore original weights
    for (const [key, origWeight] of boostedKeys) {
        trans[key].weight = origWeight;
    }

    return { samples, boostedKeys };
}

/**
 * Run one active learning iteration:
 * 1. Active sample (explore uncertain transitions)
 * 2. Simulate
 * 3. Update weights with proper blame assignment
 * 4. Compute IS estimate
 *
 * @param {import('./transducer.js').CopyTransducer} transducer
 * @param {Set<number>} acceptStates
 * @param {number} L
 * @param {Object} rng
 * @param {Object} [opts]
 * @param {number} [opts.exploreSamples=30] - active exploration samples
 * @param {number} [opts.exploitSamples=20] - exploit (IS validation) samples
 * @param {number} [opts.passes=80]
 * @param {number} [opts.seed=42]
 * @returns {Promise<Object>}
 */
export async function activeIteration(transducer, acceptStates, L, rng, opts = {}) {
    const {
        exploreSamples = 30, exploitSamples = 20,
        passes = 80, seed = 42,
    } = opts;
    const simFn = async (bytes) => simulateCandidate(bytes, { passes, seed });
    const maxSpread = 63;

    // 1. Active exploration: sample sequences traversing uncertain transitions
    const { samples: exploreSamps } = activeSample(
        transducer, L, acceptStates, exploreSamples, rng);

    // 2. Simulate exploration samples
    const examples = [];
    for (const bytes of exploreSamps) {
        const sim = await simFn(bytes);
        examples.push({
            bytes,
            reward: sim.spread / maxSpread,
            viable: sim.copied,
            spread: sim.spread,
        });
    }

    // 3. Update weights with proper blame assignment
    updateWeights(transducer, examples);

    // 4. IS validation (exploit: sample from trained model)
    const is = await importanceSamplingEstimate(
        transducer, acceptStates, L, exploitSamples, simFn, rng);

    // 5. Measure uncertainty reduction
    const uncertain = findUncertainTransitions(transducer, { topK: 50 });
    const meanEntropy = uncertain.length > 0
        ? uncertain.reduce((s, u) => s + u.entropy, 0) / uncertain.length
        : 0;

    return {
        nExplore: exploreSamps.length,
        nViable: examples.filter(e => e.viable).length,
        meanSpread: examples.reduce((s, e) => s + e.spread, 0) / examples.length,
        beffWFST: is.beffWFST,
        beffIS: is.beffIS,
        gap: is.beffIS - is.beffWFST,
        isViableRate: is.viableRate,
        nUncertain: uncertain.length,
        meanEntropy,
    };
}

/**
 * Pre-seed slide weights from known safe opcodes.
 * Sets weight=lowWeight for non-safe bytes at slide states,
 * keeping safe bytes at 1.0. This concentrates sampling on
 * plausible slide bytes, enabling training at longer lengths.
 *
 * @param {import('./transducer.js').CopyTransducer} transducer
 * @param {string[]} slideStateNames - opcode state names that are slide states
 * @param {import('./transducer.js').CopyTransducer} opcode - for state index lookup
 * @param {import('./transducer.js').CopyTransducer} offset - for product state computation
 * @param {Object} [opts]
 * @param {number} [opts.lowWeight=0.01] - weight for non-safe slide bytes
 */
export function preseedSlideWeights(transducer, opcode, offset, opts = {}) {
    const { lowWeight = 0.01 } = opts;
    const slideNames = ['slide0', 'slide1', 'slide2', 'slide3'];
    const nS = offset.numStates;

    for (const name of slideNames) {
        const opcIdx = opcode.stateIdx.get(name);
        if (opcIdx === undefined) continue;

        for (let posK = 0; posK < nS; posK++) {
            const prodState = opcIdx * nS + posK;
            for (let b = 0; b < 256; b++) {
                const t = transducer.trans[prodState * 256 + b];
                if (!t || t.verdict === FAIL) continue;
                if (!SAFE_SLIDE_OPS.has(b)) {
                    t.weight = lowWeight;
                }
            }
        }
    }
}

/**
 * Run the full active learning loop across multiple lengths.
 *
 * @param {import('./transducer.js').CopyTransducer} transducer
 * @param {Set<number>} acceptStates
 * @param {Object} opts
 * @param {number[]} opts.lengths - lengths to train on
 * @param {number} [opts.itersPerLength=4]
 * @param {number} [opts.exploreSamples=30]
 * @param {number} [opts.exploitSamples=20]
 * @param {number} [opts.passes=80]
 * @param {number} [opts.seed=42]
 * @param {Object} opts.rng
 * @returns {Promise<Object>}
 */
export async function activeTrainingLoop(transducer, acceptStates, opts) {
    const {
        lengths, itersPerLength = 4,
        exploreSamples = 30, exploitSamples = 20,
        passes = 80, seed = 42, rng,
    } = opts;

    const history = [];

    for (const L of lengths) {
        for (let iter = 0; iter < itersPerLength; iter++) {
            const result = await activeIteration(
                transducer, acceptStates, L, rng,
                { exploreSamples, exploitSamples, passes, seed });
            history.push({ L, iter, ...result });
        }
    }

    // Final cumulative B_eff estimate
    const beffByLength = {};
    for (const h of history) {
        beffByLength[h.L] = h.beffIS; // use last IS estimate per length
    }

    let cumP = 0;
    for (const [L, beff] of Object.entries(beffByLength)) {
        if (beff < Infinity) cumP += 2 ** (-beff);
    }
    const cumBeff = cumP > 0 ? -Math.log2(cumP) : Infinity;

    return { history, beffByLength, cumBeff };
}
