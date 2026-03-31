/**
 * Neural surrogate oracle: predicts spread from byte sequences.
 *
 * Replaces the expensive BareSimCPU simulation in the WFST training
 * inner loop. A simple model: per-byte score table (position × byte → weight),
 * combined multiplicatively. This is essentially a log-linear model
 * that mirrors the WFST's product-of-weights structure.
 *
 * Why not a deep network? Because:
 * 1. We want the oracle to be interpretable (which bytes are safe)
 * 2. The WFST already captures the structure; the oracle just needs
 *    to estimate per-transition viability
 * 3. A log-linear model trains from tiny datasets (hundreds of examples)
 * 4. It can be converted back into WFST weights directly
 *
 * The "neural" part: the per-byte scores are learned from simulation data
 * via gradient descent (logistic regression on the product of scores).
 */

/**
 * Log-linear oracle: P(viable) = sigmoid(sum of log-scores along path).
 *
 * For each (position, byte) pair in a sequence, a score s(pos, byte) is
 * looked up. The predicted viability is:
 *   logit = sum_i s(position_i, byte_i) + bias
 *   P(viable) = sigmoid(logit)
 *
 * Training: binary cross-entropy loss, SGD.
 */
export class LogLinearOracle {
    /**
     * @param {number} maxLen - maximum sequence length
     * @param {Object} [opts]
     * @param {number} [opts.lr=0.1] - learning rate
     */
    constructor(maxLen = 32, opts = {}) {
        this.maxLen = maxLen;
        this.lr = opts.lr || 0.1;

        // Score table: position × byte → float (initialized to 0 = neutral)
        this.scores = new Float64Array(maxLen * 256); // all zeros
        this.bias = 0;
    }

    /**
     * Predict P(viable) for a byte sequence.
     * @param {Uint8Array} bytes
     * @returns {number} probability in [0, 1]
     */
    predict(bytes) {
        let logit = this.bias;
        for (let i = 0; i < bytes.length && i < this.maxLen; i++) {
            logit += this.scores[i * 256 + bytes[i]];
        }
        return sigmoid(logit);
    }

    /**
     * Predict and return the logit (for training).
     */
    logit(bytes) {
        let l = this.bias;
        for (let i = 0; i < bytes.length && i < this.maxLen; i++) {
            l += this.scores[i * 256 + bytes[i]];
        }
        return l;
    }

    /**
     * Train on a batch of examples.
     * @param {{ bytes: Uint8Array, viable: boolean }[]} examples
     * @param {number} [epochs=1]
     * @returns {{ loss: number }}
     */
    trainBatch(examples, epochs = 1) {
        let totalLoss = 0;

        for (let epoch = 0; epoch < epochs; epoch++) {
            totalLoss = 0;

            for (const ex of examples) {
                const p = this.predict(ex.bytes);
                const y = ex.viable ? 1 : 0;
                const loss = -y * Math.log(p + 1e-15) - (1 - y) * Math.log(1 - p + 1e-15);
                totalLoss += loss;

                // Gradient: d(loss)/d(logit) = p - y
                const grad = p - y;

                // Update scores for each position
                for (let i = 0; i < ex.bytes.length && i < this.maxLen; i++) {
                    this.scores[i * 256 + ex.bytes[i]] -= this.lr * grad;
                }
                this.bias -= this.lr * grad;
            }
        }

        return { loss: totalLoss / examples.length };
    }

    /**
     * Extract per-(position, byte) viability scores.
     * Returns the most and least viable bytes at each position.
     */
    analyze() {
        const analysis = [];
        for (let pos = 0; pos < this.maxLen; pos++) {
            const byteScores = [];
            for (let b = 0; b < 256; b++) {
                const s = this.scores[pos * 256 + b];
                if (s !== 0) byteScores.push({ byte: b, score: s });
            }
            if (byteScores.length > 0) {
                byteScores.sort((a, b) => b.score - a.score);
                analysis.push({
                    pos,
                    top5: byteScores.slice(0, 5),
                    bottom5: byteScores.slice(-5).reverse(),
                    nNonzero: byteScores.length,
                });
            }
        }
        return analysis;
    }

    /**
     * Convert oracle scores to WFST transition weights.
     * For each (position, byte), the WFST weight = sigmoid(score).
     *
     * @returns {Map<string, number>} key = 'pos:byte_hex' → weight
     */
    toWFSTWeights() {
        const weights = new Map();
        for (let pos = 0; pos < this.maxLen; pos++) {
            for (let b = 0; b < 256; b++) {
                const s = this.scores[pos * 256 + b];
                if (s !== 0) {
                    weights.set(`${pos}:${b.toString(16).padStart(2, '0')}`, sigmoid(s));
                }
            }
        }
        return weights;
    }
}

/**
 * Collect training data from simulation.
 * Runs the WFST sampler and simulator, returns labeled examples.
 */
export async function collectTrainingData(wfstSampler, simulateFn, N) {
    const examples = [];
    for (let i = 0; i < N; i++) {
        const bytes = wfstSampler();
        if (!bytes) continue;
        const result = await simulateFn(bytes);
        examples.push({
            bytes,
            viable: result.copied,
            spread: result.spread,
        });
    }
    return examples;
}

/**
 * Inner/outer training loop.
 *
 * Outer: collect real simulation data, train neural oracle
 * Inner: use neural oracle as fast WFST training signal
 *
 * @param {Object} opts
 * @param {Function} opts.wfstSampler - () => Uint8Array
 * @param {Function} opts.simulateFn - async (bytes) => {copied, spread}
 * @param {Function} opts.updateWFST - (examples) => void
 * @param {number} [opts.outerIters=5]
 * @param {number} [opts.realSamplesPerOuter=200]
 * @param {number} [opts.oracleSamplesPerInner=2000]
 * @param {number} [opts.oracleEpochs=5]
 * @param {number} [opts.maxLen=32]
 * @returns {Promise<Object>}
 */
export async function innerOuterLoop(opts) {
    const {
        wfstSampler, simulateFn, updateWFST,
        outerIters = 5,
        realSamplesPerOuter = 200,
        oracleSamplesPerInner = 2000,
        oracleEpochs = 5,
        maxLen = 32,
    } = opts;

    const oracle = new LogLinearOracle(maxLen, { lr: 0.05 });
    const allRealExamples = [];
    const history = [];

    for (let outer = 0; outer < outerIters; outer++) {
        // Outer: collect real simulation data
        const realExamples = await collectTrainingData(
            wfstSampler, simulateFn, realSamplesPerOuter);
        allRealExamples.push(...realExamples);

        // Train oracle on all accumulated real data
        const { loss } = oracle.trainBatch(allRealExamples, oracleEpochs);

        // Inner: use oracle for fast WFST training
        const oracleExamples = [];
        for (let i = 0; i < oracleSamplesPerInner; i++) {
            const bytes = wfstSampler();
            if (!bytes) continue;
            const p = oracle.predict(bytes);
            oracleExamples.push({
                bytes,
                reward: p,
                viable: p > 0.5,
                spread: p * 63,
            });
        }

        // Update WFST from oracle predictions
        updateWFST(oracleExamples);

        // Stats
        const realViable = realExamples.filter(e => e.viable).length;
        const oracleViable = oracleExamples.filter(e => e.viable).length;

        history.push({
            outer,
            realViable,
            realTotal: realExamples.length,
            oracleLoss: loss,
            oracleViable,
            oracleTotal: oracleExamples.length,
        });
    }

    return { oracle, history, allRealExamples };
}

function sigmoid(x) {
    if (x > 20) return 1;
    if (x < -20) return 0;
    return 1 / (1 + Math.exp(-x));
}
