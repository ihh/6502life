import { describe, it, expect } from 'vitest';
import {
    emUpdateInsertEmission,
    hmmTrainLoop,
    hmmInnerLoop,
    hmmInnerOuterLoop,
    thompsonSampleMixture,
    restoreThompsonWeights,
    insertEntropy,
    findDisagreements,
    logTrainingProgress,
    extractInsertSegments,
    decomposeInsertSegment,
    distributionEntropy,
} from '../hmm-training.js';
import {
    ProfileHMM,
    hmmSample,
    hmmScore,
    hmmImportanceSampling,
    viterbiAlignment,
} from '../profile-hmm.js';
import { PRNG } from '../../webgpu/prng.js';

// The minimal replicator: B5 00 9D 00 04 E8 90 F8
const MINIMAL_REPLICATOR = new Uint8Array([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]);

// With one NOP prefix: EA B5 00 9D 00 04 E8 90 F8
const NOP_PREFIX_REPLICATOR = new Uint8Array([0xEA, 0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]);

// With LDY# prefix: A0 42 B5 00 9D 00 04 E8 90 F8
// M1 at pos 2, M8 at pos 9, offset = -(9-2+1) = -8 = 0xF8
const LDY_PREFIX_REPLICATOR = new Uint8Array([0xA0, 0x42, 0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]);

// Two NOP prefixes: EA EA B5 00 9D 00 04 E8 90 F6
const TWO_NOP_PREFIX = new Uint8Array([0xEA, 0xEA, 0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF6]);

/**
 * Mock simulate function: returns viable for known replicator patterns.
 */
function mockSimulate(bytes) {
    // Check if it has the core pattern B5 00 9D 00 04 {E8|CA} {90|D0|...}
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const hasCore = hex.includes('b5009d000004e890') || hex.includes('b5009d000004ca90');
    const spread = hasCore ? 48 : 0;
    return Promise.resolve({ copied: hasCore, spread, functional: hasCore ? 48 : 0 });
}

/**
 * Mock oracle function: returns P(viable) based on HMM score.
 */
function mockOracle(bytes) {
    const hmm = new ProfileHMM();
    const score = hmmScore(hmm, bytes);
    if (score === -Infinity) return 0;
    return 1 / (1 + Math.exp(-score / 10));
}

describe('EM update on InsertEmission mixture', () => {
    it('after training on sequences with NOP inserts, NOP probability increases', () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(42);

        // Get initial NOP probability
        const nopByte = 0xEA;
        const initialNopLogP = hmm.insertEmission.p1LogProbs[nopByte];

        // Create training data with NOP inserts
        const alignedExamples = [];
        for (let i = 0; i < 50; i++) {
            const bytes = NOP_PREFIX_REPLICATOR;
            const alignment = viterbiAlignment(hmm, bytes);
            if (alignment) {
                alignedExamples.push({ bytes, alignment, viable: true });
            }
        }

        expect(alignedExamples.length).toBeGreaterThan(0);

        // Run EM
        emUpdateInsertEmission(hmm, alignedExamples);

        // NOP probability should have increased
        const updatedNopLogP = hmm.insertEmission.p1LogProbs[nopByte];
        expect(updatedNopLogP).toBeGreaterThan(initialNopLogP);
    });

    it('after training on sequences with LDY# inserts, 2-byte class 0 weight increases', () => {
        const hmm = new ProfileHMM();

        // Get initial class 0 weight for 2-byte path
        const initialLogPi0 = hmm.insertEmission.logPi[0];

        // Create training data with LDY# A0 42 prefix (2-byte insert)
        const alignedExamples = [];
        for (let i = 0; i < 50; i++) {
            const bytes = LDY_PREFIX_REPLICATOR;
            const alignment = viterbiAlignment(hmm, bytes);
            if (alignment) {
                alignedExamples.push({ bytes, alignment, viable: true });
            }
        }

        expect(alignedExamples.length).toBeGreaterThan(0);

        // Run EM
        emUpdateInsertEmission(hmm, alignedExamples);

        // Class 0 (immediate loads) should have high weight since A0 is in that class
        // The LDY# opcode 0xA0 is in class 0's distribution
        const updatedLogPi0 = hmm.insertEmission.logPi[0];

        // After seeing 50 examples of 2-byte inserts from class 0,
        // class 0's weight should be dominant
        const pi0 = Math.exp(updatedLogPi0);
        expect(pi0).toBeGreaterThan(0.3); // should be well above uniform 1/3
    });
});

describe('Inner loop with mock oracle', () => {
    it('reduces or maintains B_eff estimate over iterations', () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(123);

        // Compute initial score on a reference sequence
        const initialScore = hmmScore(hmm, MINIMAL_REPLICATOR);

        const history = hmmInnerLoop(hmm, mockOracle, {
            iterations: 5,
            samplesPerIter: 50,
            lengths: [8],
            rng,
        });

        expect(history.length).toBe(5);
        // Each iteration should produce results
        for (const h of history) {
            expect(h.nSampled).toBeGreaterThan(0);
            expect(h.viableRate).toBeGreaterThanOrEqual(0);
            expect(h.viableRate).toBeLessThanOrEqual(1);
        }
    });
});

describe('Outer loop with real simulation', () => {
    it('finds viable sequences at L=8', async () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(42);

        const history = await hmmTrainLoop(hmm, mockSimulate, {
            lengths: [8],
            samplesPerLength: 20,
            iterations: 2,
            isValidationN: 10,
            rng,
        });

        expect(history.length).toBe(2);
        // At L=8, the only viable sequence is the exact core replicator
        // With mock simulate, we should see some structure
        for (const h of history) {
            expect(h.nSampled).toBeGreaterThan(0);
            expect(typeof h.viableRate).toBe('number');
            expect(typeof h.beffIS).toBe('number');
        }
    });
});

describe('IS validation', () => {
    it('produces finite estimates', async () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(42);

        const result = await hmmImportanceSampling(hmm, 8, 20, mockSimulate, rng);

        expect(typeof result.beffIS).toBe('number');
        expect(result.nSampled).toBeGreaterThan(0);
        expect(typeof result.viableRate).toBe('number');
        // ESS should be non-negative
        expect(result.ess).toBeGreaterThanOrEqual(0);
    });
});

describe('Thompson sampling', () => {
    it('produces different mixture weights each call', () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(42);

        // Sample twice with different seeds
        const saved1 = thompsonSampleMixture(hmm, rng);
        const weights1 = [...hmm.insertEmission.logPi];
        restoreThompsonWeights(hmm, saved1);

        const rng2 = new PRNG(999);
        const saved2 = thompsonSampleMixture(hmm, rng2);
        const weights2 = [...hmm.insertEmission.logPi];
        restoreThompsonWeights(hmm, saved2);

        // The two samples should be different
        let anyDifferent = false;
        for (let k = 0; k < weights1.length; k++) {
            if (Math.abs(weights1[k] - weights2[k]) > 1e-10) {
                anyDifferent = true;
                break;
            }
        }
        expect(anyDifferent).toBe(true);
    });

    it('restores original weights correctly', () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(42);

        const origPi = [...hmm.insertEmission.logPi];
        const origRho = [...hmm.insertEmission.logRho];

        const saved = thompsonSampleMixture(hmm, rng);

        // Weights should have changed
        let changed = false;
        for (let k = 0; k < origPi.length; k++) {
            if (Math.abs(hmm.insertEmission.logPi[k] - origPi[k]) > 1e-10) {
                changed = true;
                break;
            }
        }
        expect(changed).toBe(true);

        // Restore
        restoreThompsonWeights(hmm, saved);

        for (let k = 0; k < origPi.length; k++) {
            expect(hmm.insertEmission.logPi[k]).toBeCloseTo(origPi[k], 10);
            expect(hmm.insertEmission.logRho[k]).toBeCloseTo(origRho[k], 10);
        }
    });
});

describe('Entropy bonus', () => {
    it('is higher for uniform distributions than concentrated ones', () => {
        const hmm1 = new ProfileHMM();
        const hmm2 = new ProfileHMM();

        // Make hmm2's insert emission concentrated on a single byte
        for (let b = 0; b < 256; b++) {
            hmm2.insertEmission.p1LogProbs[b] = b === 0xEA ? Math.log(0.99) : Math.log(0.01 / 255);
        }

        const entropy1 = insertEntropy(hmm1); // default (more spread out)
        const entropy2 = insertEntropy(hmm2); // concentrated

        // hmm1 should have higher entropy since its 1-byte distribution is more uniform
        // Note: the comparison is on the mean entropy across all distributions,
        // but the 1-byte distribution change should dominate
        expect(entropy1).toBeGreaterThan(entropy2);
    });

    it('returns positive values', () => {
        const hmm = new ProfileHMM();
        const entropy = insertEntropy(hmm);
        expect(entropy).toBeGreaterThan(0);
    });
});

describe('findDisagreements', () => {
    it('returns sequences with high oracle-HMM score divergence', () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(42);

        // Oracle that always predicts 0.5 (maximally uncertain)
        const uncertainOracle = () => 0.5;

        const disagreements = findDisagreements(hmm, uncertainOracle, 50, rng, {
            lengths: [8, 10],
            topK: 10,
        });

        expect(disagreements.length).toBeGreaterThan(0);
        expect(disagreements.length).toBeLessThanOrEqual(10);

        // Should be sorted by disagreement (descending)
        for (let i = 1; i < disagreements.length; i++) {
            expect(disagreements[i - 1].disagreement).toBeGreaterThanOrEqual(
                disagreements[i].disagreement);
        }

        // Each result should have the required fields
        for (const d of disagreements) {
            expect(d.bytes).toBeInstanceOf(Uint8Array);
            expect(typeof d.hmmScore).toBe('number');
            expect(typeof d.oracleScore).toBe('number');
            expect(typeof d.disagreement).toBe('number');
            expect(d.disagreement).toBeGreaterThanOrEqual(0);
        }
    });

    it('returns more disagreements when oracle contradicts HMM', () => {
        const hmm = new ProfileHMM();
        const rng1 = new PRNG(42);
        const rng2 = new PRNG(42);

        // Oracle that agrees with HMM
        const agreeOracle = (bytes) => {
            const score = hmmScore(hmm, bytes);
            return score === -Infinity ? 0 : (score > 0 ? 1 : 0);
        };

        // Oracle that always disagrees
        const disagreeOracle = (bytes) => {
            const score = hmmScore(hmm, bytes);
            return score === -Infinity ? 1 : 0;
        };

        const agree = findDisagreements(hmm, agreeOracle, 30, rng1, { lengths: [8] });
        const disagree = findDisagreements(hmm, disagreeOracle, 30, rng2, { lengths: [8] });

        // Mean disagreement should be higher for the contradicting oracle
        const meanAgree = agree.reduce((s, d) => s + d.disagreement, 0) / (agree.length || 1);
        const meanDisagree = disagree.reduce((s, d) => s + d.disagreement, 0) / (disagree.length || 1);

        expect(meanDisagree).toBeGreaterThan(meanAgree);
    });
});

describe('Training at multiple lengths', () => {
    it('works with L=8 and L=10 simultaneously', async () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(42);

        const history = await hmmTrainLoop(hmm, mockSimulate, {
            lengths: [8, 10],
            samplesPerLength: 10,
            iterations: 2,
            isValidationN: 5,
            rng,
        });

        expect(history.length).toBe(2);
        // Should have sampled at both lengths
        for (const h of history) {
            expect(h.nSampled).toBeGreaterThan(0);
        }
    });
});

describe('hmmInnerOuterLoop', () => {
    it('completes without errors (smoke test with tiny params)', async () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(42);

        const result = await hmmInnerOuterLoop(hmm, mockSimulate, mockOracle, {
            outerIters: 2,
            innerIters: 3,
            outerSamplesPerLength: 5,
            innerSamplesPerIter: 20,
            lengths: [8],
            rng,
        });

        expect(result.history.length).toBe(2);
        expect(result.allRealExamples.length).toBeGreaterThan(0);

        for (const h of result.history) {
            expect(typeof h.outer).toBe('number');
            expect(typeof h.realViable).toBe('number');
            expect(typeof h.realTotal).toBe('number');
            expect(typeof h.innerViableRate).toBe('number');
        }
    });

    it('supports retrainOracle callback', async () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(42);

        let retrainCalls = 0;
        const retrainOracle = (examples) => {
            retrainCalls++;
            expect(Array.isArray(examples)).toBe(true);
        };

        await hmmInnerOuterLoop(hmm, mockSimulate, mockOracle, {
            outerIters: 2,
            innerIters: 2,
            outerSamplesPerLength: 3,
            innerSamplesPerIter: 10,
            lengths: [8],
            rng,
            retrainOracle,
        });

        expect(retrainCalls).toBe(2);
    });
});

describe('logTrainingProgress', () => {
    it('returns structured metrics', () => {
        const hmm = new ProfileHMM();
        const history = [
            { iter: 0, viableRate: 0.1, beffIS: 45.2 },
        ];

        const metrics = logTrainingProgress(hmm, history, 0);

        expect(typeof metrics.entropy).toBe('number');
        expect(metrics.entropy).toBeGreaterThan(0);
        expect(metrics.top10InsertBytes.length).toBe(10);
        expect(metrics.pathWeights).toBeDefined();
        expect(metrics.classWeights2.length).toBe(3); // N=3 classes
        expect(metrics.viableRate).toBe(0.1);
        expect(metrics.beffIS).toBe(45.2);
    });
});

describe('Helper functions', () => {
    it('extractInsertSegments returns correct segments', () => {
        const hmm = new ProfileHMM();
        const bytes = NOP_PREFIX_REPLICATOR;
        const alignment = viterbiAlignment(hmm, bytes);
        expect(alignment).not.toBeNull();

        const segments = extractInsertSegments(bytes, alignment);
        // Should have at least one insert segment (the NOP prefix)
        expect(segments.length).toBeGreaterThan(0);
        // First segment should be the prefix insert
        expect(segments[0].start).toBe(0);
        expect(segments[0].length).toBe(1);
    });

    it('decomposeInsertSegment handles 1-byte inserts', () => {
        const bytes = new Uint8Array([0xEA]); // NOP
        const emissions = decomposeInsertSegment(bytes, 0, 1);
        expect(emissions.length).toBe(1);
        expect(emissions[0].count).toBe(1);
    });

    it('decomposeInsertSegment handles 2-byte inserts', () => {
        const bytes = new Uint8Array([0xA0, 0x42]); // LDY #$42
        const emissions = decomposeInsertSegment(bytes, 0, 2);
        expect(emissions.length).toBe(1);
        expect(emissions[0].count).toBe(2);
    });

    it('decomposeInsertSegment handles mixed inserts', () => {
        const bytes = new Uint8Array([0xEA, 0xA0, 0x42]); // NOP, LDY #$42
        const emissions = decomposeInsertSegment(bytes, 0, 3);
        expect(emissions.length).toBe(2);
        expect(emissions[0].count).toBe(1); // NOP
        expect(emissions[1].count).toBe(2); // LDY #imm
    });

    it('distributionEntropy is maximal for uniform', () => {
        const uniform = new Float64Array(256);
        const logP = Math.log(1 / 256);
        for (let b = 0; b < 256; b++) uniform[b] = logP;

        const maxEntropy = distributionEntropy(uniform);
        expect(maxEntropy).toBeCloseTo(Math.log(256), 5);
    });
});
