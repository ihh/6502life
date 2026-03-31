import { describe, it, expect } from 'vitest';
import {
    ProfileHMM, InsertEmission,
    hmmForward, hmmForwardExact, hmmScore,
    hmmSample, hmmUpdateParams, hmmImportanceSampling,
    viterbiAlignment,
    MATCH_EMISSIONS, SAFE_SINGLE, SAFE_TWO_BYTE_PREFIXES,
    insertLogProb, logSumExp,
    NUM_STATES, insertIdx, matchIdx, forwardWithM1,
} from '../profile-hmm.js';
import { PRNG } from '../../webgpu/prng.js';

// The minimal replicator: B5 00 9D 00 04 E8 90 F8
const MINIMAL_REPLICATOR = new Uint8Array([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]);

// Variant with DEX instead of INX
const DEX_REPLICATOR = new Uint8Array([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xCA, 0x90, 0xF8]);

// Variant with BNE instead of BCC
const BNE_REPLICATOR = new Uint8Array([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0xD0, 0xF8]);

// With one NOP prefix: EA B5 00 9D 00 04 E8 90 F8
// M1 at pos 1, M8 at pos 8. offset = -(8-1+1) = -8 = 0xF8
const NOP_PREFIX_REPLICATOR = new Uint8Array([0xEA, 0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]);

// With one NOP suffix: B5 00 9D 00 04 E8 90 F8 EA
const NOP_SUFFIX_REPLICATOR = new Uint8Array([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8, 0xEA]);

// With NOP between M5 and M6: B5 00 9D 00 04 EA E8 90 F7
const NOP_MIDDLE_REPLICATOR = new Uint8Array([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xEA, 0xE8, 0x90, 0xF7]);

// Random non-replicator
const RANDOM_SEQ = new Uint8Array([0x4C, 0x00, 0x10, 0xA9, 0xFF, 0x8D, 0x00, 0x02]);

describe('logSumExp', () => {
    it('handles -Infinity correctly', () => {
        expect(logSumExp(-Infinity, 0)).toBe(0);
        expect(logSumExp(0, -Infinity)).toBe(0);
        expect(logSumExp(-Infinity, -Infinity)).toBe(-Infinity);
    });

    it('is approximately correct for normal values', () => {
        // log(e^0 + e^0) = log(2) ≈ 0.693
        expect(logSumExp(0, 0)).toBeCloseTo(Math.log(2), 10);
        // log(e^1 + e^2) = log(e + e^2)
        expect(logSumExp(1, 2)).toBeCloseTo(Math.log(Math.exp(1) + Math.exp(2)), 10);
    });

    it('is numerically stable for large values', () => {
        const a = 1000, b = 1000;
        const result = logSumExp(a, b);
        expect(result).toBeCloseTo(1000 + Math.log(2), 10);
    });
});

describe('ProfileHMM constructor', () => {
    it('creates an HMM with correct state count', () => {
        const hmm = new ProfileHMM();
        expect(hmm.numStates).toBe(NUM_STATES);
        expect(hmm.numStates).toBe(18);
    });

    it('has 9 delta values', () => {
        const hmm = new ProfileHMM();
        expect(hmm.delta.length).toBe(9);
        for (let k = 0; k < 9; k++) {
            expect(hmm.delta[k]).toBeGreaterThan(0);
            expect(hmm.delta[k]).toBeLessThan(1);
        }
    });

    it('has match emission distributions for M1-M7', () => {
        const hmm = new ProfileHMM();
        for (let k = 0; k < 7; k++) {
            expect(hmm.matchLogProbs[k]).toBeInstanceOf(Map);
            expect(hmm.matchLogProbs[k].size).toBeGreaterThan(0);
        }
        // M8 is deterministic (null)
        expect(hmm.matchLogProbs[7]).toBeNull();
    });

    it('has insert emission distribution covering all 256 bytes', () => {
        const hmm = new ProfileHMM();
        // All 256 bytes have finite log-probabilities
        for (let b = 0; b < 256; b++) {
            expect(hmm.insertLogProbs[b]).toBeGreaterThan(-Infinity);
        }
        // Safe opcodes have higher probability than background bytes
        const nopLogP = hmm.insertLogProbs[0xEA]; // NOP
        const bgLogP = hmm.insertLogProbs[0x00];  // not in any safe list
        expect(nopLogP).toBeGreaterThan(bgLogP);
    });

    it('accepts custom delta values', () => {
        const delta = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
        const hmm = new ProfileHMM({ delta });
        for (let k = 0; k < 9; k++) {
            expect(hmm.delta[k]).toBe(0.5);
        }
    });
});

describe('hmmForwardExact', () => {
    it('assigns non-zero probability to the minimal replicator', () => {
        const hmm = new ProfileHMM();
        const logP = hmmForwardExact(hmm, MINIMAL_REPLICATOR);
        expect(logP).toBeGreaterThan(-Infinity);
        expect(logP).toBeLessThan(0);
    });

    it('assigns non-zero probability to DEX variant', () => {
        const hmm = new ProfileHMM();
        const logP = hmmForwardExact(hmm, DEX_REPLICATOR);
        expect(logP).toBeGreaterThan(-Infinity);
    });

    it('assigns non-zero probability to BNE variant', () => {
        const hmm = new ProfileHMM();
        const logP = hmmForwardExact(hmm, BNE_REPLICATOR);
        expect(logP).toBeGreaterThan(-Infinity);
    });

    it('assigns non-zero probability to NOP-prefix replicator', () => {
        const hmm = new ProfileHMM();
        const logP = hmmForwardExact(hmm, NOP_PREFIX_REPLICATOR);
        expect(logP).toBeGreaterThan(-Infinity);
    });

    it('assigns non-zero probability to NOP-suffix replicator', () => {
        const hmm = new ProfileHMM();
        const logP = hmmForwardExact(hmm, NOP_SUFFIX_REPLICATOR);
        expect(logP).toBeGreaterThan(-Infinity);
    });

    it('assigns non-zero probability to NOP-middle replicator', () => {
        const hmm = new ProfileHMM();
        const logP = hmmForwardExact(hmm, NOP_MIDDLE_REPLICATOR);
        expect(logP).toBeGreaterThan(-Infinity);
    });

    it('assigns -Infinity to random non-replicator', () => {
        const hmm = new ProfileHMM();
        const logP = hmmForwardExact(hmm, RANDOM_SEQ);
        expect(logP).toBe(-Infinity);
    });

    it('returns -Infinity for sequences shorter than 8', () => {
        const hmm = new ProfileHMM();
        expect(hmmForwardExact(hmm, new Uint8Array([0xB5, 0x00]))).toBe(-Infinity);
        expect(hmmForwardExact(hmm, new Uint8Array([]))).toBe(-Infinity);
    });

    it('minimal replicator has higher probability than variants with inserts', () => {
        const hmm = new ProfileHMM();
        const logMinimal = hmmForwardExact(hmm, MINIMAL_REPLICATOR);
        const logPrefix = hmmForwardExact(hmm, NOP_PREFIX_REPLICATOR);
        const logMiddle = hmmForwardExact(hmm, NOP_MIDDLE_REPLICATOR);

        // Minimal should be most probable (no inserts needed)
        expect(logMinimal).toBeGreaterThan(logPrefix);
        expect(logMinimal).toBeGreaterThan(logMiddle);
    });

    it('probability is a proper distribution (sums to ≤ 1 for length 8)', () => {
        const hmm = new ProfileHMM();
        // The minimal replicator has P < 1
        const logP = hmmForwardExact(hmm, MINIMAL_REPLICATOR);
        expect(Math.exp(logP)).toBeLessThanOrEqual(1);
    });
});

describe('hmmScore', () => {
    it('gives positive score for viable replicators', () => {
        const hmm = new ProfileHMM();
        const score = hmmScore(hmm, MINIMAL_REPLICATOR);
        // log2(P(seq|HMM)) + 8*8 = 64 + log2(P(seq|HMM))
        // Should be positive because P(seq|HMM) >> 2^(-64)
        expect(score).toBeGreaterThan(0);
    });

    it('gives higher score for minimal replicator than variants', () => {
        const hmm = new ProfileHMM();
        const scoreMinimal = hmmScore(hmm, MINIMAL_REPLICATOR);
        const scoreDex = hmmScore(hmm, DEX_REPLICATOR);
        const scorePrefix = hmmScore(hmm, NOP_PREFIX_REPLICATOR);

        // All should be positive
        expect(scoreMinimal).toBeGreaterThan(0);
        expect(scoreDex).toBeGreaterThan(0);
        expect(scorePrefix).toBeGreaterThan(0);

        // Minimal should have highest score (most compressed)
        expect(scoreMinimal).toBeGreaterThanOrEqual(scoreDex);
    });

    it('gives -Infinity for random sequences', () => {
        const hmm = new ProfileHMM();
        const score = hmmScore(hmm, RANDOM_SEQ);
        expect(score).toBe(-Infinity);
    });

    it('score increases with null model baseline (8L) for longer replicators', () => {
        const hmm = new ProfileHMM();
        const score8 = hmmScore(hmm, MINIMAL_REPLICATOR);
        const score9 = hmmScore(hmm, NOP_PREFIX_REPLICATOR);
        // The 9-byte version gets +8 bits from the null model but loses
        // some from the insert probability
        // Both should be significantly positive
        expect(score8).toBeGreaterThan(10);
        expect(score9).toBeGreaterThan(10);
    });
});

describe('hmmSample', () => {
    it('returns null for L < 8', () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(42);
        expect(hmmSample(hmm, 7, rng)).toBeNull();
        expect(hmmSample(hmm, 0, rng)).toBeNull();
    });

    it('produces valid 8-byte sequences', () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(42);

        for (let i = 0; i < 20; i++) {
            const seq = hmmSample(hmm, 8, rng);
            expect(seq).not.toBeNull();
            expect(seq.length).toBe(8);

            // Must contain B5 00 9D 00 04 (M1-M5)
            const b5Pos = seq.indexOf(0xB5);
            expect(b5Pos).toBeGreaterThanOrEqual(0);
            expect(seq[b5Pos + 1]).toBe(0x00);
            expect(seq[b5Pos + 2]).toBe(0x9D);
            expect(seq[b5Pos + 3]).toBe(0x00);
            expect(seq[b5Pos + 4]).toBe(0x04);

            // M6 must be INX or DEX
            expect([0xE8, 0xCA]).toContain(seq[b5Pos + 5]);

            // M7 must be a branch opcode
            expect([0x90, 0xD0, 0x10, 0x30, 0x50, 0x70, 0xB0]).toContain(seq[b5Pos + 6]);

            // M8 must be the correct offset
            const expectedOffset = (-(b5Pos + 8 - b5Pos + 1 - 2)) & 0xFF;
            // Actually: offset = -(m8Pos - m1Pos + 1) mod 256
            const m8Pos = b5Pos + 7;
            const correctOffset = (-(m8Pos - b5Pos + 1)) & 0xFF;
            expect(seq[m8Pos]).toBe(correctOffset);
        }
    });

    it('produces valid 10-byte sequences with inserts', () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(123);

        let found = false;
        for (let i = 0; i < 100; i++) {
            const seq = hmmSample(hmm, 10, rng);
            expect(seq).not.toBeNull();
            expect(seq.length).toBe(10);

            // Should still contain the core match bytes
            const b5Pos = seq.indexOf(0xB5);
            expect(b5Pos).toBeGreaterThanOrEqual(0);
            found = true;
        }
        expect(found).toBe(true);
    });

    it('sampled sequences have non-zero forward probability', () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(42);

        for (let i = 0; i < 10; i++) {
            const seq = hmmSample(hmm, 8, rng);
            expect(seq).not.toBeNull();

            const logP = hmmForwardExact(hmm, seq);
            expect(logP).toBeGreaterThan(-Infinity);
        }
    });

    it('produces diverse samples', () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(42);
        const seen = new Set();

        for (let i = 0; i < 50; i++) {
            const seq = hmmSample(hmm, 8, rng);
            if (seq) seen.add(Array.from(seq).join(','));
        }

        // Should see multiple distinct sequences (M6 has 2 options, M7 has 7)
        expect(seen.size).toBeGreaterThanOrEqual(2);
    });
});

describe('viterbiAlignment', () => {
    it('correctly aligns the minimal replicator', () => {
        const hmm = new ProfileHMM();
        const result = viterbiAlignment(hmm, MINIMAL_REPLICATOR);

        expect(result).not.toBeNull();
        expect(result.m1Pos).toBe(0);
        expect(result.insertCounts[0]).toBe(0); // I0
        for (let k = 1; k <= 7; k++) {
            expect(result.insertCounts[k]).toBe(0); // I1..I7
        }
        expect(result.insertCounts[8]).toBe(0); // I8
        expect(result.logProb).toBeGreaterThan(-Infinity);
    });

    it('correctly aligns NOP-prefix replicator', () => {
        const hmm = new ProfileHMM();
        const result = viterbiAlignment(hmm, NOP_PREFIX_REPLICATOR);

        expect(result).not.toBeNull();
        expect(result.m1Pos).toBe(1);
        expect(result.insertCounts[0]).toBe(1); // I0 has 1 NOP
        expect(result.logProb).toBeGreaterThan(-Infinity);
    });

    it('correctly aligns NOP-middle replicator', () => {
        const hmm = new ProfileHMM();
        const result = viterbiAlignment(hmm, NOP_MIDDLE_REPLICATOR);

        expect(result).not.toBeNull();
        expect(result.m1Pos).toBe(0);
        expect(result.insertCounts[5]).toBe(1); // I5 has 1 NOP (between M5 and M6)
        expect(result.logProb).toBeGreaterThan(-Infinity);
    });

    it('returns null for random sequences', () => {
        const hmm = new ProfileHMM();
        const result = viterbiAlignment(hmm, RANDOM_SEQ);
        expect(result).toBeNull();
    });
});

describe('insertLogProb', () => {
    it('returns 0 for count=0', () => {
        const hmm = new ProfileHMM();
        expect(insertLogProb(hmm, 0, new Uint8Array([]), 0, 0)).toBe(0);
    });

    it('returns finite value for single safe NOP', () => {
        const hmm = new ProfileHMM();
        const seq = new Uint8Array([0xEA]); // NOP
        const logP = insertLogProb(hmm, 0, seq, 0, 1);
        expect(logP).toBeGreaterThan(-Infinity);
        expect(logP).toBeLessThan(0);
    });

    it('assigns low probability to unusual insert bytes', () => {
        const hmm = new ProfileHMM();
        const seq = new Uint8Array([0xB5]); // LDA zpx — not a typical insert
        const logP = insertLogProb(hmm, 0, seq, 0, 1);
        // With full-alphabet support, all bytes get nonzero probability
        // but unusual ones get much lower probability than safe NOPs
        expect(logP).toBeGreaterThan(-Infinity);
        const nopSeq = new Uint8Array([0xEA]); // NOP — safe insert
        const nopLogP = insertLogProb(hmm, 0, nopSeq, 0, 1);
        expect(nopLogP).toBeGreaterThan(logP); // NOP should be much more likely
    });

    it('handles two-byte inserts', () => {
        const hmm = new ProfileHMM();
        const seq = new Uint8Array([0xA0, 0x42]); // LDY #$42
        const logP = insertLogProb(hmm, 0, seq, 0, 2);
        expect(logP).toBeGreaterThan(-Infinity);
    });

    it('assigns finite probability to single-byte insert of a two-byte prefix', () => {
        const hmm = new ProfileHMM();
        const seq = new Uint8Array([0xA0]); // LDY — now valid as a 1-byte insert
        const logP = insertLogProb(hmm, 0, seq, 0, 1);
        // In the mixture model, any single byte has nonzero 1-byte path probability
        expect(logP).toBeGreaterThan(-Infinity);
        expect(logP).toBeLessThan(0);
    });
});

describe('hmmUpdateParams', () => {
    it('increases delta for examples with many inserts', () => {
        const hmm = new ProfileHMM();
        const origDelta0 = hmm.delta[0];

        // Create examples with inserts before M1
        const examples = [];
        for (let i = 0; i < 20; i++) {
            // 3 NOPs before the replicator
            // M1 at pos 3, M8 at pos 10. offset = -(10-3+1) = -8 = 0xF8
            const seq = new Uint8Array([0xEA, 0xEA, 0xEA, 0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]);
            examples.push({ bytes: seq, reward: 1.0 });
        }

        hmmUpdateParams(hmm, examples);

        // delta[0] should increase (more inserts at position 0)
        expect(hmm.delta[0]).toBeGreaterThan(origDelta0);
    });

    it('decreases delta for examples with no inserts', () => {
        const hmm = new ProfileHMM({ delta: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] });

        const examples = [];
        for (let i = 0; i < 20; i++) {
            examples.push({ bytes: MINIMAL_REPLICATOR, reward: 1.0 });
        }

        hmmUpdateParams(hmm, examples);

        // All deltas should decrease toward 0
        for (let k = 0; k < 9; k++) {
            expect(hmm.delta[k]).toBeLessThan(0.5);
        }
    });

    it('does not crash with empty examples', () => {
        const hmm = new ProfileHMM();
        hmmUpdateParams(hmm, []);
        // Deltas should remain unchanged
        expect(hmm.delta[0]).toBeCloseTo(0.3, 5);
    });
});

describe('forward/sample round-trip consistency', () => {
    it('sampled sequences have consistent log-probabilities', () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(42);

        for (let i = 0; i < 20; i++) {
            const seq = hmmSample(hmm, 8, rng);
            if (!seq) continue;

            const logP = hmmForwardExact(hmm, seq);
            const score = hmmScore(hmm, seq);

            // Both should be finite
            expect(logP).toBeGreaterThan(-Infinity);
            expect(score).toBeGreaterThan(-Infinity);

            // Score should be positive for replicator-like sequences
            expect(score).toBeGreaterThan(0);
        }
    });

    it('sampled L=10 sequences have valid forward probability', () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(99);

        let nValid = 0;
        for (let i = 0; i < 30; i++) {
            const seq = hmmSample(hmm, 10, rng);
            if (!seq) continue;

            const logP = hmmForwardExact(hmm, seq);
            if (logP > -Infinity) nValid++;
        }

        // At least some should have valid forward probability
        expect(nValid).toBeGreaterThan(0);
    });

    it('branch offset is correct for sampled sequences', () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(42);

        for (let L = 8; L <= 12; L++) {
            for (let trial = 0; trial < 10; trial++) {
                const seq = hmmSample(hmm, L, rng);
                if (!seq) continue;

                // Find B5 (M1 position)
                const m1Pos = seq.indexOf(0xB5);
                expect(m1Pos).toBeGreaterThanOrEqual(0);

                // Find the branch offset (M8)
                // M8 is 7 match positions after M1, with inserts in between
                const alignment = viterbiAlignment(hmm, seq);
                if (!alignment) continue;

                const m8Pos = alignment.matchPositions[7];
                const expectedOffset = (-(m8Pos - m1Pos + 1)) & 0xFF;
                expect(seq[m8Pos]).toBe(expectedOffset);
            }
        }
    });
});

describe('score ordering', () => {
    it('known viable sequences score higher than random', () => {
        const hmm = new ProfileHMM();

        const viableScore = hmmScore(hmm, MINIMAL_REPLICATOR);
        const randomScore = hmmScore(hmm, RANDOM_SEQ);

        expect(viableScore).toBeGreaterThan(0);
        expect(randomScore).toBe(-Infinity);
    });

    it('replicator variants all have positive scores', () => {
        const hmm = new ProfileHMM();

        const scores = [
            hmmScore(hmm, MINIMAL_REPLICATOR),
            hmmScore(hmm, DEX_REPLICATOR),
            hmmScore(hmm, BNE_REPLICATOR),
            hmmScore(hmm, NOP_PREFIX_REPLICATOR),
            hmmScore(hmm, NOP_SUFFIX_REPLICATOR),
            hmmScore(hmm, NOP_MIDDLE_REPLICATOR),
        ];

        for (const s of scores) {
            expect(s).toBeGreaterThan(0);
        }
    });
});

describe('state indexing', () => {
    it('insert and match indices are disjoint', () => {
        const insertIndices = new Set();
        const matchIndices = new Set();

        for (let k = 0; k <= 8; k++) insertIndices.add(insertIdx(k));
        for (let k = 1; k <= 8; k++) matchIndices.add(matchIdx(k));

        for (const i of insertIndices) {
            expect(matchIndices.has(i)).toBe(false);
        }
    });

    it('all state indices are within bounds', () => {
        for (let k = 0; k <= 8; k++) {
            expect(insertIdx(k)).toBeGreaterThanOrEqual(0);
            expect(insertIdx(k)).toBeLessThan(NUM_STATES);
        }
        for (let k = 1; k <= 8; k++) {
            expect(matchIdx(k)).toBeGreaterThanOrEqual(0);
            expect(matchIdx(k)).toBeLessThan(NUM_STATES);
        }
    });
});

describe('edge cases', () => {
    it('handles sequence of all 0xB5 bytes', () => {
        const hmm = new ProfileHMM();
        const seq = new Uint8Array(8).fill(0xB5);
        // Should return -Infinity (0xB5 at position 1 is not 0x00 for M2)
        const logP = hmmForwardExact(hmm, seq);
        expect(logP).toBe(-Infinity);
    });

    it('handles very long sequences', () => {
        const hmm = new ProfileHMM();
        // 20 NOPs + replicator core
        const prefix = new Array(20).fill(0xEA);
        const core = [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0x00];
        const seq = new Uint8Array([...prefix, ...core]);
        // Fix the branch offset
        const m1Pos = 20;
        const m8Pos = 27;
        seq[m8Pos] = (-(m8Pos - m1Pos + 1)) & 0xFF;

        const logP = hmmForwardExact(hmm, seq);
        expect(logP).toBeGreaterThan(-Infinity);

        const score = hmmScore(hmm, seq);
        expect(score).toBeGreaterThan(0);
    });

    it('sampler handles L=8 deterministically (no room for inserts)', () => {
        const hmm = new ProfileHMM();
        const rng = new PRNG(42);

        const seq = hmmSample(hmm, 8, rng);
        expect(seq).not.toBeNull();
        expect(seq.length).toBe(8);

        // All 8 bytes must be match bytes
        expect(seq[0]).toBe(0xB5);
        expect(seq[1]).toBe(0x00);
        expect(seq[2]).toBe(0x9D);
        expect(seq[3]).toBe(0x00);
        expect(seq[4]).toBe(0x04);
        expect([0xE8, 0xCA]).toContain(seq[5]);
        expect([0x90, 0xD0, 0x10, 0x30, 0x50, 0x70, 0xB0]).toContain(seq[6]);

        // Branch offset
        const expectedOffset = (-(7 - 0 + 1)) & 0xFF;
        expect(seq[7]).toBe(expectedOffset);
    });

    it('correctly computes branch offset for different M1 positions', () => {
        // NOP prefix means M1 is at position 1, M8 at position 8
        // offset = -(8 - 1 + 1) = -8 = 0xF8
        const hmm = new ProfileHMM();
        const logP = hmmForwardExact(hmm, NOP_PREFIX_REPLICATOR);
        expect(logP).toBeGreaterThan(-Infinity);

        // Verify offset: M1 at pos 1, M8 at pos 8
        // offset should be -(8 - 1 + 1) = -8 = 0xF8
        // Verify offset: M1 at pos 1, M8 at pos 8
        // offset = -(8 - 1 + 1) = -8 = 0xF8
        expect(NOP_PREFIX_REPLICATOR[8]).toBe(0xF8);
    });
});

describe('InsertEmission', () => {
    it('produces valid log-probabilities for 1-byte sequences', () => {
        const ie = new InsertEmission();
        const seq = new Uint8Array([0xEA]); // NOP
        const lp = ie.logProb(seq, 0, 1);
        expect(lp).toBeGreaterThan(-Infinity);
        expect(lp).toBeLessThan(0);
    });

    it('produces valid log-probabilities for 2-byte sequences', () => {
        const ie = new InsertEmission();
        const seq = new Uint8Array([0xA0, 0x42]); // LDY #$42
        const lp = ie.logProb(seq, 0, 2);
        expect(lp).toBeGreaterThan(-Infinity);
        expect(lp).toBeLessThan(0);
    });

    it('produces valid log-probabilities for 3-byte sequences', () => {
        const ie = new InsertEmission();
        const seq = new Uint8Array([0xAD, 0x00, 0x04]); // LDA $0400
        const lp = ie.logProb(seq, 0, 3);
        expect(lp).toBeGreaterThan(-Infinity);
        expect(lp).toBeLessThan(0);
    });

    it('returns -Infinity for count outside 1-3', () => {
        const ie = new InsertEmission();
        const seq = new Uint8Array([0xEA, 0xEA, 0xEA, 0xEA]);
        expect(ie.logProb(seq, 0, 0)).toBe(-Infinity);
        expect(ie.logProb(seq, 0, 4)).toBe(-Infinity);
    });

    it('mixture components have distinct distributions', () => {
        const ie = new InsertEmission();
        // 2-byte class 0 (immediate loads) should assign higher prob to A0 xx
        // than class 2 (undocumented NOPs)
        const class0_lp = ie.p2LogProbs[0][0][0xA0]; // P(byte1=A0 | class 0)
        const class2_lp = ie.p2LogProbs[2][0][0xA0]; // P(byte1=A0 | class 2)
        expect(class0_lp).toBeGreaterThan(class2_lp);

        // Conversely, class 2 should prefer 0x80 (undoc NOP)
        const class0_80 = ie.p2LogProbs[0][0][0x80];
        const class2_80 = ie.p2LogProbs[2][0][0x80];
        expect(class2_80).toBeGreaterThan(class0_80);
    });

    it('sampler produces 1, 2, and 3-byte inserts', () => {
        const ie = new InsertEmission();
        const rng = new PRNG(42);
        const counts = [0, 0, 0, 0]; // counts for length 1, 2, 3

        for (let i = 0; i < 500; i++) {
            const emission = ie.sample(rng);
            counts[emission.length]++;
        }

        // All three lengths should appear (alpha = [0.6, 0.3, 0.1])
        expect(counts[1]).toBeGreaterThan(0);
        expect(counts[2]).toBeGreaterThan(0);
        expect(counts[3]).toBeGreaterThan(0);

        // 1-byte should be most common
        expect(counts[1]).toBeGreaterThan(counts[2]);
        expect(counts[2]).toBeGreaterThan(counts[3]);
    });

    it('sample then logProb round-trip is consistent', () => {
        const ie = new InsertEmission();
        const rng = new PRNG(42);

        for (let i = 0; i < 50; i++) {
            const emission = ie.sample(rng);
            const lp = ie.logProb(emission, 0, emission.length);
            expect(lp).toBeGreaterThan(-Infinity);
            expect(lp).toBeLessThan(0);
        }
    });
});

describe('forward algorithm with 3-byte inserts', () => {
    it('handles sequences with 3-byte inserts correctly', () => {
        const hmm = new ProfileHMM();
        // Insert a 3-byte instruction (LDA $0400 = AD 00 04) before the replicator
        // M1 at pos 3, M8 at pos 10. offset = -(10-3+1) = -8 = 0xF8
        const seq = new Uint8Array([0xAD, 0x00, 0x04, 0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]);
        const logP = hmmForwardExact(hmm, seq);
        expect(logP).toBeGreaterThan(-Infinity);
    });

    it('handles sequences with 3-byte inserts in the middle', () => {
        const hmm = new ProfileHMM();
        // Insert AD 00 04 between M5 and M6
        // B5 00 9D 00 04 [AD 00 04] E8 90 offset
        // M1=0, M8=10, offset = -(10-0+1) = -11 = 0xF5
        const seq = new Uint8Array([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xAD, 0x00, 0x04, 0xE8, 0x90, 0xF5]);
        const logP = hmmForwardExact(hmm, seq);
        expect(logP).toBeGreaterThan(-Infinity);
    });
});
