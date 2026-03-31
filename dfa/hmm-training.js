/**
 * HMM training pipeline: wires the profile HMM into inner/outer training loops.
 *
 * Outer loop: sample from HMM → simulate (ground truth) → update HMM params
 * Inner loop: sample from HMM → neural oracle scoring → fast HMM updates
 * Combined: alternates outer (simulation) and inner (oracle) iterations
 *
 * Key learning: EM on the InsertEmission mixture model discovers which
 * opcode-operand combinations are safe at each insert position.
 *
 * @module dfa/hmm-training
 */

import {
    ProfileHMM, InsertEmission,
    hmmSample, hmmScore, hmmForwardExact,
    hmmUpdateParams, hmmImportanceSampling,
    viterbiAlignment,
    logSumExp,
} from './profile-hmm.js';

// ---- EM update for InsertEmission mixture ----

/**
 * EM update for the InsertEmission mixture model.
 *
 * For each insert observed in Viterbi-aligned training data:
 *   E-step: compute posterior responsibility of each latent class
 *   M-step: update marginal distributions using weighted counts
 *
 * This is the key learning step — the model discovers which
 * opcode-operand combinations are safe at each insert position.
 *
 * @param {ProfileHMM} hmm
 * @param {{ bytes: Uint8Array, alignment: Object, viable: boolean }[]} alignedExamples
 */
export function emUpdateInsertEmission(hmm, alignedExamples) {
    const ie = hmm.insertEmission;
    const N = ie.N;
    const pseudocount = 0.01; // Dirichlet smoothing

    // Accumulators for 1-byte path
    const p1Counts = new Float64Array(256);
    let p1Total = 0;

    // Accumulators for 2-byte path: per class, per position
    const p2Counts = [];
    const p2ClassWeight = new Float64Array(N);
    for (let k = 0; k < N; k++) {
        p2Counts.push([new Float64Array(256), new Float64Array(256)]);
    }

    // Accumulators for 3-byte path: per class, per position
    const p3Counts = [];
    const p3ClassWeight = new Float64Array(N);
    for (let k = 0; k < N; k++) {
        p3Counts.push([new Float64Array(256), new Float64Array(256), new Float64Array(256)]);
    }

    // Path weight accumulators
    let pathWeight1 = 0;
    let pathWeight2 = 0;
    let pathWeight3 = 0;

    for (const ex of alignedExamples) {
        const { bytes, alignment, viable } = ex;
        if (!alignment) continue;

        const weight = viable ? 1.0 : 0.1; // down-weight non-viable examples

        // Extract insert segments from the alignment
        const insertSegments = extractInsertSegments(bytes, alignment);

        for (const seg of insertSegments) {
            // Decompose each insert segment into 1/2/3-byte emissions
            const emissions = decomposeInsertSegment(bytes, seg.start, seg.length);

            for (const em of emissions) {
                const { start, count } = em;

                if (count === 1) {
                    const b = bytes[start];
                    p1Counts[b] += weight;
                    p1Total += weight;
                    pathWeight1 += weight;
                } else if (count === 2) {
                    const b1 = bytes[start], b2 = bytes[start + 1];
                    // E-step: compute posterior responsibility gamma_k
                    const logResp = new Float64Array(N);
                    let logNorm = -Infinity;
                    for (let k = 0; k < N; k++) {
                        logResp[k] = ie.logPi[k] + ie.p2LogProbs[k][0][b1] + ie.p2LogProbs[k][1][b2];
                        logNorm = logSumExp(logNorm, logResp[k]);
                    }
                    // M-step: accumulate weighted counts
                    for (let k = 0; k < N; k++) {
                        const gamma = Math.exp(logResp[k] - logNorm);
                        const w = gamma * weight;
                        p2Counts[k][0][b1] += w;
                        p2Counts[k][1][b2] += w;
                        p2ClassWeight[k] += w;
                    }
                    pathWeight2 += weight;
                } else if (count === 3) {
                    const b1 = bytes[start], b2 = bytes[start + 1], b3 = bytes[start + 2];
                    // E-step
                    const logResp = new Float64Array(N);
                    let logNorm = -Infinity;
                    for (let k = 0; k < N; k++) {
                        logResp[k] = ie.logRho[k] +
                            ie.p3LogProbs[k][0][b1] + ie.p3LogProbs[k][1][b2] + ie.p3LogProbs[k][2][b3];
                        logNorm = logSumExp(logNorm, logResp[k]);
                    }
                    for (let k = 0; k < N; k++) {
                        const gamma = Math.exp(logResp[k] - logNorm);
                        const w = gamma * weight;
                        p3Counts[k][0][b1] += w;
                        p3Counts[k][1][b2] += w;
                        p3Counts[k][2][b3] += w;
                        p3ClassWeight[k] += w;
                    }
                    pathWeight3 += weight;
                }
            }
        }
    }

    // Update 1-byte distribution
    if (p1Total > 0) {
        let total = 0;
        for (let b = 0; b < 256; b++) {
            p1Counts[b] += pseudocount;
            total += p1Counts[b];
        }
        for (let b = 0; b < 256; b++) {
            ie.p1LogProbs[b] = Math.log(p1Counts[b] / total);
        }
    }

    // Update 2-byte class distributions
    for (let k = 0; k < N; k++) {
        if (p2ClassWeight[k] === 0) continue;
        for (let pos = 0; pos < 2; pos++) {
            let total = 0;
            for (let b = 0; b < 256; b++) {
                p2Counts[k][pos][b] += pseudocount;
                total += p2Counts[k][pos][b];
            }
            for (let b = 0; b < 256; b++) {
                ie.p2LogProbs[k][pos][b] = Math.log(p2Counts[k][pos][b] / total);
            }
        }
    }

    // Update 2-byte class mixing weights
    const totalPi = p2ClassWeight.reduce((s, w) => s + w, 0);
    if (totalPi > 0) {
        for (let k = 0; k < N; k++) {
            ie.logPi[k] = Math.log((p2ClassWeight[k] + pseudocount) / (totalPi + N * pseudocount));
        }
    }

    // Update 3-byte class distributions
    for (let k = 0; k < N; k++) {
        if (p3ClassWeight[k] === 0) continue;
        for (let pos = 0; pos < 3; pos++) {
            let total = 0;
            for (let b = 0; b < 256; b++) {
                p3Counts[k][pos][b] += pseudocount;
                total += p3Counts[k][pos][b];
            }
            for (let b = 0; b < 256; b++) {
                ie.p3LogProbs[k][pos][b] = Math.log(p3Counts[k][pos][b] / total);
            }
        }
    }

    // Update 3-byte class mixing weights
    const totalRho = p3ClassWeight.reduce((s, w) => s + w, 0);
    if (totalRho > 0) {
        for (let k = 0; k < N; k++) {
            ie.logRho[k] = Math.log((p3ClassWeight[k] + pseudocount) / (totalRho + N * pseudocount));
        }
    }

    // Update path mixing weights (alpha)
    const totalPath = pathWeight1 + pathWeight2 + pathWeight3;
    if (totalPath > 0) {
        ie.logAlpha[0] = Math.log((pathWeight1 + pseudocount) / (totalPath + 3 * pseudocount));
        ie.logAlpha[1] = Math.log((pathWeight2 + pseudocount) / (totalPath + 3 * pseudocount));
        ie.logAlpha[2] = Math.log((pathWeight3 + pseudocount) / (totalPath + 3 * pseudocount));
    }
}

/**
 * Extract insert segments from a Viterbi alignment.
 * @param {Uint8Array} bytes
 * @param {Object} alignment - from viterbiAlignment
 * @returns {{ start: number, length: number, insertIdx: number }[]}
 */
function extractInsertSegments(bytes, alignment) {
    const { insertCounts, matchPositions } = alignment;
    const segments = [];

    // I0: before M1
    if (insertCounts[0] > 0) {
        segments.push({ start: 0, length: insertCounts[0], insertIdx: 0 });
    }

    // I1..I8: after each match state
    for (let k = 1; k <= 8; k++) {
        if (insertCounts[k] > 0) {
            const mkPos = matchPositions[k - 1];
            segments.push({ start: mkPos + 1, length: insertCounts[k], insertIdx: k });
        }
    }

    return segments;
}

/**
 * Decompose an insert segment into individual 1/2/3-byte emissions.
 * Uses greedy decomposition matching the HMM's emission structure.
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} length
 * @returns {{ start: number, count: number }[]}
 */
function decomposeInsertSegment(bytes, start, length) {
    const emissions = [];
    let pos = start;
    const end = start + length;

    while (pos < end) {
        const remaining = end - pos;
        // Prefer multi-byte emissions when possible
        if (remaining >= 3) {
            // Check if 3-byte emission makes sense (known 3-byte opcode)
            const b = bytes[pos];
            if (is3ByteOpcode(b)) {
                emissions.push({ start: pos, count: 3 });
                pos += 3;
                continue;
            }
        }
        if (remaining >= 2) {
            // Check if 2-byte emission makes sense
            const b = bytes[pos];
            if (is2ByteOpcode(b)) {
                emissions.push({ start: pos, count: 2 });
                pos += 2;
                continue;
            }
        }
        // Default: 1-byte emission
        emissions.push({ start: pos, count: 1 });
        pos += 1;
    }

    return emissions;
}

// Known 2-byte opcodes for insert decomposition
const TWO_BYTE_OPCODES = new Set([
    0xA0, 0xA2, 0xE0, 0xC0, // immediate loads/compares
    0x85, 0xA5, 0x24, 0x45, 0x65, 0x84, 0xA4, 0xC4, 0xE4, 0x05, 0x25, // zpg
    0x80, 0x82, 0x89, 0xC2, 0xE2, // undocumented 2-byte NOPs
]);

// Known 3-byte opcodes for insert decomposition
const THREE_BYTE_OPCODES = new Set([
    0xAD, 0xAE, 0xAC, // absolute loads
    0x8D, 0x8E, 0x8C, // absolute stores
    0x0C, 0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC, // undocumented 3-byte NOPs
]);

function is2ByteOpcode(b) { return TWO_BYTE_OPCODES.has(b); }
function is3ByteOpcode(b) { return THREE_BYTE_OPCODES.has(b); }

// ---- Exploration utilities ----

/**
 * Thompson sampling on insert emission mixture weights.
 * Instead of MAP estimate, sample from posterior Dirichlet.
 *
 * Perturbs logPi and logRho by sampling from Dirichlet with current
 * weights as concentration parameters. Returns the original values
 * so they can be restored.
 *
 * @param {ProfileHMM} hmm
 * @param {Object} rng - PRNG with .real()
 * @returns {{ origLogPi: Float64Array, origLogRho: Float64Array }}
 */
export function thompsonSampleMixture(hmm, rng) {
    const ie = hmm.insertEmission;
    const N = ie.N;

    const origLogPi = new Float64Array(ie.logPi);
    const origLogRho = new Float64Array(ie.logRho);

    // Sample from Dirichlet using gamma distribution approximation
    const concentration = 5.0; // controls how far from MAP we go

    // Perturb 2-byte class weights
    const piAlphas = new Float64Array(N);
    for (let k = 0; k < N; k++) {
        piAlphas[k] = Math.exp(ie.logPi[k]) * concentration + 0.1;
    }
    const newPi = sampleDirichlet(piAlphas, rng);
    for (let k = 0; k < N; k++) {
        ie.logPi[k] = Math.log(Math.max(1e-10, newPi[k]));
    }

    // Perturb 3-byte class weights
    const rhoAlphas = new Float64Array(N);
    for (let k = 0; k < N; k++) {
        rhoAlphas[k] = Math.exp(ie.logRho[k]) * concentration + 0.1;
    }
    const newRho = sampleDirichlet(rhoAlphas, rng);
    for (let k = 0; k < N; k++) {
        ie.logRho[k] = Math.log(Math.max(1e-10, newRho[k]));
    }

    return { origLogPi, origLogRho };
}

/**
 * Restore mixture weights after Thompson sampling.
 * @param {ProfileHMM} hmm
 * @param {{ origLogPi: Float64Array, origLogRho: Float64Array }} saved
 */
export function restoreThompsonWeights(hmm, saved) {
    hmm.insertEmission.logPi.set(saved.origLogPi);
    hmm.insertEmission.logRho.set(saved.origLogRho);
}

/**
 * Sample from a Dirichlet distribution using the gamma trick.
 * @param {Float64Array} alphas - concentration parameters
 * @param {Object} rng
 * @returns {Float64Array} sampled probabilities
 */
function sampleDirichlet(alphas, rng) {
    const K = alphas.length;
    const samples = new Float64Array(K);
    let total = 0;

    for (let k = 0; k < K; k++) {
        // Gamma(alpha, 1) via Marsaglia and Tsang's method for alpha >= 1
        // For alpha < 1, use Gamma(alpha+1, 1) * U^(1/alpha)
        samples[k] = sampleGamma(alphas[k], rng);
        total += samples[k];
    }

    if (total === 0) {
        // Fallback: uniform
        for (let k = 0; k < K; k++) samples[k] = 1 / K;
        return samples;
    }

    for (let k = 0; k < K; k++) {
        samples[k] /= total;
    }

    return samples;
}

/**
 * Sample from Gamma(alpha, 1) distribution.
 * Uses Marsaglia and Tsang's method.
 * @param {number} alpha
 * @param {Object} rng
 * @returns {number}
 */
function sampleGamma(alpha, rng) {
    if (alpha < 1) {
        // Gamma(alpha) = Gamma(alpha+1) * U^(1/alpha)
        const g = sampleGamma(alpha + 1, rng);
        return g * Math.pow(rng.real() + 1e-30, 1 / alpha);
    }

    const d = alpha - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);

    for (let iter = 0; iter < 1000; iter++) {
        let x, v;
        do {
            // Box-Muller transform for normal sample
            const u1 = rng.real() + 1e-30;
            const u2 = rng.real();
            x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            v = 1 + c * x;
        } while (v <= 0);

        v = v * v * v;
        const u = rng.real();

        if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }

    return alpha; // fallback
}

/**
 * Entropy bonus: compute mean entropy of insert distributions.
 * Higher entropy means more uniform (less concentrated) distributions.
 * Returns a value that can be used as regularization.
 *
 * @param {ProfileHMM} hmm
 * @returns {number} mean entropy in nats
 */
export function insertEntropy(hmm) {
    const ie = hmm.insertEmission;
    let totalEntropy = 0;
    let nDists = 0;

    // 1-byte distribution entropy
    totalEntropy += distributionEntropy(ie.p1LogProbs);
    nDists++;

    // 2-byte class distributions
    for (let k = 0; k < ie.N; k++) {
        for (let pos = 0; pos < 2; pos++) {
            totalEntropy += distributionEntropy(ie.p2LogProbs[k][pos]);
            nDists++;
        }
    }

    // 3-byte class distributions
    for (let k = 0; k < ie.N; k++) {
        for (let pos = 0; pos < 3; pos++) {
            totalEntropy += distributionEntropy(ie.p3LogProbs[k][pos]);
            nDists++;
        }
    }

    return totalEntropy / nDists;
}

/**
 * Compute entropy H(p) = -sum p_i log p_i for a log-probability distribution.
 * @param {Float64Array} logProbs - length 256
 * @returns {number} entropy in nats
 */
function distributionEntropy(logProbs) {
    let h = 0;
    for (let b = 0; b < 256; b++) {
        const p = Math.exp(logProbs[b]);
        if (p > 0) h -= p * logProbs[b];
    }
    return h;
}

/**
 * Targeted probing: find sequences where oracle and HMM disagree most.
 * These are the most informative examples for simulation.
 *
 * @param {ProfileHMM} hmm
 * @param {Function} oracleFn - (Uint8Array) => number (predicted P(viable))
 * @param {number} N - number of candidates to evaluate
 * @param {Object} rng - PRNG with .real()
 * @param {Object} [opts]
 * @param {number[]} [opts.lengths] - lengths to sample at
 * @param {number} [opts.topK=20] - return top K disagreements
 * @returns {{ bytes: Uint8Array, hmmScore: number, oracleScore: number, disagreement: number }[]}
 */
export function findDisagreements(hmm, oracleFn, N, rng, opts = {}) {
    const { lengths = [8, 10, 12], topK = 20 } = opts;
    const candidates = [];

    for (let i = 0; i < N; i++) {
        const L = lengths[i % lengths.length];
        const bytes = hmmSample(hmm, L, rng);
        if (!bytes) continue;

        const hScore = hmmScore(hmm, bytes);
        const oScore = oracleFn(bytes);

        // Disagreement: absolute difference between HMM's implied viability
        // and oracle's prediction
        const hmmViability = sigmoid(hScore); // rough proxy
        const disagreement = Math.abs(hmmViability - oScore);

        candidates.push({
            bytes,
            hmmScore: hScore,
            oracleScore: oScore,
            disagreement,
        });
    }

    candidates.sort((a, b) => b.disagreement - a.disagreement);
    return candidates.slice(0, topK);
}

function sigmoid(x) {
    if (x > 20) return 1;
    if (x < -20) return 0;
    return 1 / (1 + Math.exp(-x));
}

// ---- Progress logging ----

/**
 * Compute and log training metrics.
 *
 * @param {ProfileHMM} hmm
 * @param {Object[]} history - array of iteration results
 * @param {number} iteration - current iteration index
 * @returns {Object} metrics
 */
export function logTrainingProgress(hmm, history, iteration) {
    const ie = hmm.insertEmission;
    const current = history[iteration] || {};

    // Insert emission entropy
    const entropy = insertEntropy(hmm);

    // Top insert bytes by probability (1-byte path)
    const topBytes = [];
    for (let b = 0; b < 256; b++) {
        topBytes.push({ byte: b, logP: ie.p1LogProbs[b] });
    }
    topBytes.sort((a, b) => b.logP - a.logP);
    const top10 = topBytes.slice(0, 10).map(t => ({
        byte: t.byte.toString(16).padStart(2, '0'),
        prob: Math.exp(t.logP).toFixed(4),
    }));

    // Path mixing weights
    const pathWeights = {
        oneByte: Math.exp(ie.logAlpha[0]).toFixed(3),
        twoByte: Math.exp(ie.logAlpha[1]).toFixed(3),
        threeByte: Math.exp(ie.logAlpha[2]).toFixed(3),
    };

    // 2-byte class mixing weights
    const classWeights2 = [];
    for (let k = 0; k < ie.N; k++) {
        classWeights2.push(Math.exp(ie.logPi[k]).toFixed(3));
    }

    const metrics = {
        iteration,
        entropy,
        top10InsertBytes: top10,
        pathWeights,
        classWeights2,
        viableRate: current.viableRate ?? null,
        beffIS: current.beffIS ?? null,
        beffHMM: current.beffHMM ?? null,
    };

    return metrics;
}

// ---- Outer training loop ----

/**
 * Outer training loop for the profile HMM.
 *
 * Each iteration:
 *   1. Sample M candidates from HMM at various lengths
 *   2. Simulate each (ground truth)
 *   3. Update HMM parameters (M-step with Viterbi alignment)
 *   4. Update insert emission distributions (EM on mixture)
 *   5. IS validation
 *   6. Log progress
 *
 * @param {ProfileHMM} hmm
 * @param {Function} simulateFn - async (Uint8Array) => { spread, copied }
 * @param {Object} opts
 * @param {number[]} opts.lengths - sequence lengths to train on [8, 10, 12, 16, 20]
 * @param {number} opts.samplesPerLength - samples per length per iteration (default 50)
 * @param {number} opts.iterations - outer iterations (default 10)
 * @param {number} opts.isValidationN - samples for IS validation (default 200)
 * @param {Object} opts.rng - PRNG with .real() method
 * @returns {Promise<Object[]>} iteration history
 */
export async function hmmTrainLoop(hmm, simulateFn, opts = {}) {
    const {
        lengths = [8, 10, 12, 16, 20],
        samplesPerLength = 50,
        iterations = 10,
        isValidationN = 200,
        rng,
    } = opts;

    const history = [];
    const maxSpread = 63;

    for (let iter = 0; iter < iterations; iter++) {
        const allExamples = [];
        const alignedExamples = [];

        // 1. Sample M candidates at various lengths
        for (const L of lengths) {
            for (let i = 0; i < samplesPerLength; i++) {
                const bytes = hmmSample(hmm, L, rng);
                if (!bytes) continue;

                // 2. Simulate each
                const sim = await simulateFn(bytes);
                const viable = sim.copied;
                const reward = sim.spread / maxSpread;

                allExamples.push({ bytes, viable, reward, spread: sim.spread });

                // Align for EM
                const alignment = viterbiAlignment(hmm, bytes);
                if (alignment) {
                    alignedExamples.push({ bytes, alignment, viable });
                }
            }
        }

        // 3. Update HMM parameters (delta)
        hmmUpdateParams(hmm, allExamples);

        // 4. Update insert emission distributions (EM on mixture)
        if (alignedExamples.length > 0) {
            emUpdateInsertEmission(hmm, alignedExamples);
        }

        // 5. IS validation at first length
        const isL = lengths[0];
        let isResult = { beffIS: Infinity, viableRate: 0, nViable: 0 };
        if (isValidationN > 0) {
            isResult = await hmmImportanceSampling(
                hmm, isL, Math.min(isValidationN, 50), simulateFn, rng);
        }

        // 6. Stats
        const nViable = allExamples.filter(e => e.viable).length;
        const viableRate = allExamples.length > 0 ? nViable / allExamples.length : 0;
        const meanSpread = allExamples.length > 0
            ? allExamples.reduce((s, e) => s + e.spread, 0) / allExamples.length
            : 0;

        const iterResult = {
            iter,
            nSampled: allExamples.length,
            nViable,
            viableRate,
            meanSpread,
            beffIS: isResult.beffIS,
            isViableRate: isResult.viableRate,
        };

        history.push(iterResult);

        // Log progress
        logTrainingProgress(hmm, history, iter);
    }

    return history;
}

// ---- Inner loop (oracle-driven) ----

/**
 * Inner training loop using neural oracle instead of simulation.
 * Runs many iterations cheaply between outer-loop simulation batches.
 *
 * @param {ProfileHMM} hmm
 * @param {Function} oracleFn - (Uint8Array) => number (predicted P(viable))
 * @param {Object} opts
 * @param {number} opts.iterations - inner iterations (default 100)
 * @param {number} opts.samplesPerIter - samples per iteration (default 500)
 * @param {number[]} opts.lengths - sequence lengths (default [8, 10, 12])
 * @param {Object} opts.rng - PRNG
 * @returns {Object[]} iteration history
 */
export function hmmInnerLoop(hmm, oracleFn, opts = {}) {
    const {
        iterations = 100,
        samplesPerIter = 500,
        lengths = [8, 10, 12],
        rng,
    } = opts;

    const history = [];
    const maxSpread = 63;

    for (let iter = 0; iter < iterations; iter++) {
        const allExamples = [];
        const alignedExamples = [];
        const perLength = Math.ceil(samplesPerIter / lengths.length);

        for (const L of lengths) {
            for (let i = 0; i < perLength; i++) {
                const bytes = hmmSample(hmm, L, rng);
                if (!bytes) continue;

                const p = oracleFn(bytes);
                const viable = p > 0.5;
                const reward = p;

                allExamples.push({ bytes, viable, reward, spread: p * maxSpread });

                const alignment = viterbiAlignment(hmm, bytes);
                if (alignment) {
                    alignedExamples.push({ bytes, alignment, viable });
                }
            }
        }

        // Update HMM parameters
        hmmUpdateParams(hmm, allExamples);

        // Update insert emissions via EM
        if (alignedExamples.length > 0) {
            emUpdateInsertEmission(hmm, alignedExamples);
        }

        const nViable = allExamples.filter(e => e.viable).length;
        history.push({
            iter,
            nSampled: allExamples.length,
            nViable,
            viableRate: allExamples.length > 0 ? nViable / allExamples.length : 0,
            meanReward: allExamples.length > 0
                ? allExamples.reduce((s, e) => s + e.reward, 0) / allExamples.length
                : 0,
        });
    }

    return history;
}

// ---- Combined inner/outer loop ----

/**
 * Combined inner/outer loop (mirrors neural-oracle.js::innerOuterLoop).
 *
 * Outer loop: real simulation, IS validation, oracle retraining
 * Inner loop: neural oracle scoring, HMM parameter updates
 *
 * @param {ProfileHMM} hmm
 * @param {Function} simulateFn - async (bytes) => { copied, spread }
 * @param {Function} oracleFn - (Uint8Array) => number (predicted P(viable))
 * @param {Object} opts
 * @param {number} [opts.outerIters=5] - outer iterations
 * @param {number} [opts.innerIters=10] - inner iterations per outer
 * @param {number} [opts.outerSamplesPerLength=50] - real samples per length
 * @param {number} [opts.innerSamplesPerIter=200] - oracle samples per inner iter
 * @param {number[]} [opts.lengths=[8, 10, 12]] - sequence lengths
 * @param {Object} opts.rng - PRNG
 * @param {Function} [opts.retrainOracle] - (examples) => void, retrain oracle on real data
 * @returns {Promise<Object>}
 */
export async function hmmInnerOuterLoop(hmm, simulateFn, oracleFn, opts = {}) {
    const {
        outerIters = 5,
        innerIters = 10,
        outerSamplesPerLength = 50,
        innerSamplesPerIter = 200,
        lengths = [8, 10, 12],
        rng,
        retrainOracle,
    } = opts;

    const history = [];
    const allRealExamples = [];
    const maxSpread = 63;

    for (let outer = 0; outer < outerIters; outer++) {
        // --- Outer: collect real simulation data ---
        const realExamples = [];
        const realAligned = [];

        for (const L of lengths) {
            for (let i = 0; i < outerSamplesPerLength; i++) {
                const bytes = hmmSample(hmm, L, rng);
                if (!bytes) continue;

                const sim = await simulateFn(bytes);
                const viable = sim.copied;
                const reward = sim.spread / maxSpread;

                realExamples.push({ bytes, viable, reward, spread: sim.spread });

                const alignment = viterbiAlignment(hmm, bytes);
                if (alignment) {
                    realAligned.push({ bytes, alignment, viable });
                }
            }
        }

        allRealExamples.push(...realExamples);

        // Update HMM from real data
        hmmUpdateParams(hmm, realExamples);
        if (realAligned.length > 0) {
            emUpdateInsertEmission(hmm, realAligned);
        }

        // Retrain oracle on accumulated real data
        if (retrainOracle) {
            retrainOracle(allRealExamples);
        }

        // Stats
        const realViable = realExamples.filter(e => e.viable).length;

        // --- Inner: fast oracle-driven updates ---
        const innerHistory = hmmInnerLoop(hmm, oracleFn, {
            iterations: innerIters,
            samplesPerIter: innerSamplesPerIter,
            lengths,
            rng,
        });

        const lastInner = innerHistory[innerHistory.length - 1] || {};

        history.push({
            outer,
            realViable,
            realTotal: realExamples.length,
            innerViableRate: lastInner.viableRate ?? 0,
            innerMeanReward: lastInner.meanReward ?? 0,
        });
    }

    return { history, allRealExamples };
}

// ---- Exports ----

export {
    extractInsertSegments,
    decomposeInsertSegment,
    sampleDirichlet,
    distributionEntropy,
};
