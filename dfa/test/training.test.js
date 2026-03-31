import { describe, it, expect } from 'vitest';
import { extractFeatures, trainWeights, trainIteration } from '../training.js';
import { buildPipeline, sampleCandidates } from '../pipeline.js';
import { simulateCandidate } from '../simulate.js';
import { PRNG } from '../../webgpu/prng.js';

const REP = new Uint8Array([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]);

describe('extractFeatures', () => {
    it('extracts features from canonical replicator', () => {
        const f = extractFeatures(REP);
        expect(f.addrMatch).toBe(true);
        expect(f.addrMismatch).toBe(false);
        expect(f.usesINX).toBe(true);
        expect(f.usesDEX).toBe(false);
        expect(f.branchOpcode).toBe(0x90);
        expect(f.programLength).toBe(8);
    });

    it('detects addr mismatch', () => {
        const bad = new Uint8Array([0xB5, 0x10, 0x9D, 0x20, 0x04, 0xE8, 0x90, 0xF8]);
        const f = extractFeatures(bad);
        expect(f.addrMatch).toBe(false);
        expect(f.addrMismatch).toBe(true);
    });
});

describe('trainWeights', () => {
    it('computes base rate from examples', () => {
        const examples = [
            { bytes: REP, replicated: true },
            { bytes: REP, replicated: false },
            { bytes: REP, replicated: false },
            { bytes: REP, replicated: false },
        ];
        const w = trainWeights(examples);
        expect(w.baseRate).toBeCloseTo(0.25);
        expect(w.n).toBe(4);
    });

    it('addr-match feature gets higher weight than mismatch', () => {
        const match = new Uint8Array([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]);
        const mismatch = new Uint8Array([0xB5, 0x10, 0x9D, 0x20, 0x04, 0xE8, 0x90, 0xF8]);
        const examples = [
            { bytes: match, replicated: true },
            { bytes: match, replicated: true },
            { bytes: mismatch, replicated: false },
            { bytes: mismatch, replicated: false },
        ];
        const w = trainWeights(examples);
        expect(w.featureWeights.addrMatch).toBe(1.0);
        expect(w.featureWeights.addrMismatch).toBe(0.0);
    });

    it('handles empty examples', () => {
        const w = trainWeights([]);
        expect(w.baseRate).toBe(0);
        expect(w.n).toBe(0);
    });
});

describe('trainIteration', () => {
    it('runs one iteration with real simulation', async () => {
        const { dfa } = buildPipeline();
        const rng = new PRNG(42);

        const { weights, examples } = await trainIteration(
            () => {
                const { samples } = sampleCandidates(dfa, 8, 5, rng);
                return samples;
            },
            async (bytes) => simulateCandidate(bytes, { passes: 30, seed: 99 }),
        );

        expect(examples.length).toBe(5);
        expect(weights.n).toBe(5);
        // Each example should have features
        for (const ex of examples) {
            expect(ex.features).toBeDefined();
            expect(typeof ex.replicated).toBe('boolean');
        }
    });
});

describe('End-to-end loop: sample → simulate → train', () => {
    it('runs 3 iterations of the training loop', async () => {
        const { dfa } = buildPipeline();
        const rng = new PRNG(2026);
        const batchSize = 5;
        const iterations = 3;

        const history = [];

        for (let iter = 0; iter < iterations; iter++) {
            const { samples } = sampleCandidates(dfa, 8, batchSize, rng);
            const examples = [];

            for (const bytes of samples) {
                const result = await simulateCandidate(bytes, { passes: 30, seed: iter });
                examples.push({
                    bytes,
                    replicated: result.copied,
                    features: extractFeatures(bytes),
                });
            }

            const weights = trainWeights(examples);
            history.push({
                iter,
                weights,
                replicators: examples.filter(e => e.replicated).length,
                total: examples.length,
            });
        }

        expect(history.length).toBe(3);
        // All iterations should have run
        for (const h of history) {
            expect(h.total).toBe(batchSize);
            expect(h.weights.n).toBe(batchSize);
        }
    }, 30000); // generous timeout for simulation
});
