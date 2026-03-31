/**
 * Simplified weight training: adjust reviewer weights from simulation data.
 *
 * Not full Baum-Welch (which needs Forward-Backward over the composed
 * machine per training example). Instead, uses direct weight update:
 * for each "risky" feature observed in training candidates, adjust its
 * weight based on the fraction of candidates with that feature that
 * replicated successfully.
 *
 * Features: addr-match mismatch, specific NOP opcodes, etc.
 * For now, the only trainable weight is addr-match mismatchWeight.
 */

/**
 * @typedef {Object} TrainingExample
 * @property {Uint8Array} bytes - candidate byte sequence
 * @property {boolean} replicated - did it replicate in simulation?
 * @property {Object} [features] - extracted features (auto-computed if absent)
 */

/**
 * Extract features from a candidate byte sequence.
 * @param {Uint8Array|number[]} bytes
 * @returns {Object} feature map
 */
export function extractFeatures(bytes) {
    return {
        addrMatch: bytes[1] === bytes[3],
        addrMismatch: bytes[1] !== bytes[3],
        usesINX: bytes[5] === 0xE8,
        usesDEX: bytes[5] === 0xCA,
        branchOpcode: bytes[6],
        programLength: bytes.length,
    };
}

/**
 * Train weights from simulation data.
 *
 * Computes empirical P(replicated | feature) for each feature,
 * then uses those as updated weights.
 *
 * @param {TrainingExample[]} examples
 * @returns {TrainedWeights}
 *
 * @typedef {Object} TrainedWeights
 * @property {number} addrMismatchWeight - P(replicates | addr mismatch)
 * @property {Object} featureWeights - per-feature P(replicates | feature present)
 * @property {number} baseRate - overall P(replicates)
 * @property {number} n - total examples
 */
export function trainWeights(examples) {
    const featureCounts = {};
    const featureSuccess = {};
    let totalSuccess = 0;

    for (const ex of examples) {
        const features = ex.features || extractFeatures(ex.bytes);
        const success = ex.replicated ? 1 : 0;
        totalSuccess += success;

        for (const [key, val] of Object.entries(features)) {
            if (typeof val !== 'boolean') continue;
            if (!val) continue;
            featureCounts[key] = (featureCounts[key] || 0) + 1;
            featureSuccess[key] = (featureSuccess[key] || 0) + success;
        }
    }

    const n = examples.length;
    const baseRate = n > 0 ? totalSuccess / n : 0;

    const featureWeights = {};
    for (const key of Object.keys(featureCounts)) {
        const count = featureCounts[key];
        const successes = featureSuccess[key] || 0;
        featureWeights[key] = count > 0 ? successes / count : baseRate;
    }

    return {
        addrMismatchWeight: featureWeights.addrMismatch || 0,
        featureWeights,
        baseRate,
        n,
    };
}

/**
 * Run one training iteration: sample → simulate → update weights.
 *
 * @param {Function} sampleFn - () => Uint8Array[] (batch of candidates)
 * @param {Function} simFn - (Uint8Array) => Promise<{copied: boolean}>
 * @param {Object} [prevWeights] - previous trained weights
 * @returns {Promise<{weights: TrainedWeights, examples: TrainingExample[]}>}
 */
export async function trainIteration(sampleFn, simFn, prevWeights = null) {
    const candidates = sampleFn();
    const examples = [];

    for (const bytes of candidates) {
        const result = await simFn(bytes);
        examples.push({
            bytes,
            replicated: result.copied,
            features: extractFeatures(bytes),
        });
    }

    const weights = trainWeights(examples);
    return { weights, examples };
}
