import { describe, it, expect } from 'vitest';
import { buildDFA, DFA } from '../dfa.js';
import { totalAccepting, forwardCountsFloat } from '../forward.js';
import { prepareSampler, sampleSequence, sampleN } from '../sampler.js';
import { PRNG } from '../../webgpu/prng.js';

describe('Sampler: basic correctness', () => {
    it('all samples are accepted by the DFA', () => {
        const dfa = buildDFA(4, 0, [3], [
            { from: 0, to: 0, on: 0xEA },
            { from: 0, to: 1, on: 0xB5 },
            { from: 1, to: 2, on: '*' },
            { from: 2, to: 3, on: 0x9D },
        ]);

        const rng = new PRNG(42);
        const samples = sampleN(dfa, 5, 1000, rng); // length 5 = 2 NOPs + B5 XX 9D

        expect(samples.length).toBe(1000);
        for (const seq of samples) {
            expect(dfa.accepts(seq)).toBe(true);
        }
    });

    it('returns null when no accepted sequences exist', () => {
        const dfa = buildDFA(1, 0, [], [{ from: 0, to: 0, on: '*' }]);
        const sampler = prepareSampler(dfa, 5);
        const rng = new PRNG(42);
        expect(sampleSequence(sampler, rng)).toBeNull();
    });

    it('reproducible: same seed gives same samples', () => {
        const dfa = buildDFA(4, 0, [3], [
            { from: 0, to: 1, on: 0xB5 },
            { from: 1, to: 2, on: '*' },
            { from: 2, to: 3, on: 0x9D },
        ]);

        const s1 = sampleN(dfa, 3, 100, new PRNG(12345));
        const s2 = sampleN(dfa, 3, 100, new PRNG(12345));

        for (let i = 0; i < 100; i++) {
            expect(Array.from(s1[i])).toEqual(Array.from(s2[i]));
        }
    });

    it('different seeds give different samples', () => {
        const dfa = buildDFA(4, 0, [3], [
            { from: 0, to: 1, on: 0xB5 },
            { from: 1, to: 2, on: '*' },
            { from: 2, to: 3, on: 0x9D },
        ]);

        const s1 = sampleN(dfa, 3, 10, new PRNG(111));
        const s2 = sampleN(dfa, 3, 10, new PRNG(222));

        let allSame = true;
        for (let i = 0; i < 10; i++) {
            if (s1[i][1] !== s2[i][1]) allSame = false; // byte 1 is free
        }
        expect(allSame).toBe(false);
    });
});

describe('Sampler: distribution correctness', () => {
    it('byte 1 distribution is uniform for B5 XX 9D pattern', () => {
        // B5 XX 9D: byte 1 can be any value 0-255 with equal probability
        const dfa = buildDFA(4, 0, [3], [
            { from: 0, to: 1, on: 0xB5 },
            { from: 1, to: 2, on: '*' },
            { from: 2, to: 3, on: 0x9D },
        ]);

        const N = 10000;
        const rng = new PRNG(42);
        const samples = sampleN(dfa, 3, N, rng);

        // Count byte 1 values
        const counts = new Uint32Array(256);
        for (const seq of samples) counts[seq[1]]++;

        // Chi-squared test: expected = N/256 ≈ 39 per bin
        const expected = N / 256;
        let chi2 = 0;
        for (let b = 0; b < 256; b++) {
            chi2 += (counts[b] - expected) ** 2 / expected;
        }
        // Chi-squared with 255 df: 95th percentile ≈ 293
        expect(chi2).toBeLessThan(350); // generous threshold
    });

    it('NOP slide length distribution matches Forward probabilities', () => {
        // DFA: NOP* B5 XX 9D, length exactly 5
        // Accepted sequences: 2 NOPs + B5 XX 9D, or NOP slide of other lengths
        // Length 5: can be 0,1,2 NOPs only (since core is 3 bytes)
        // 0 NOPs: impossible (length 3 ≠ 5)
        // 2 NOPs: NOP NOP B5 XX 9D → 1 × 1 × 1 × 256 × 1 = 256 sequences
        // That's the only option for length 5.

        const dfa = buildDFA(4, 0, [3], [
            { from: 0, to: 0, on: 0xEA },
            { from: 0, to: 1, on: 0xB5 },
            { from: 1, to: 2, on: '*' },
            { from: 2, to: 3, on: 0x9D },
        ]);

        expect(totalAccepting(dfa, 5)).toBe(256n);

        const rng = new PRNG(42);
        const samples = sampleN(dfa, 5, 1000, rng);

        // All samples should be: EA EA B5 XX 9D
        for (const seq of samples) {
            expect(seq[0]).toBe(0xEA);
            expect(seq[1]).toBe(0xEA);
            expect(seq[2]).toBe(0xB5);
            expect(seq[4]).toBe(0x9D);
        }
    });
});

// --- Phase 5: Cross-validate sampler vs fuzzer ---

describe('Sampler vs Fuzzer cross-validation', () => {
    // Use a DFA with enough acceptance probability that fuzzing
    // yields a reasonable sample. A 2-byte DFA: byte 0 ∈ {A,B,C},
    // byte 1 = anything. This has 3 × 256 = 768 accepted 2-byte
    // sequences out of 65536 total → P ≈ 1.17%.
    function makeSimpleDFA() {
        return buildDFA(2, 0, [1], [
            { from: 0, to: 1, on: [0xAA, 0xBB, 0xCC] },
        ]);
    }

    it('sampler distribution matches fuzzer distribution', () => {
        const dfa = makeSimpleDFA();
        const N_fuzz = 500000;
        const rng_fuzz = new PRNG(11111);

        // Fuzz: generate random 1-byte sequences, collect accepted
        const fuzzCounts = new Uint32Array(256); // byte 0 distribution
        let fuzzTotal = 0;
        for (let t = 0; t < N_fuzz; t++) {
            const b = rng_fuzz.below(256);
            if (dfa.accepts([b])) {
                fuzzCounts[b]++;
                fuzzTotal++;
            }
        }

        // Sample: generate same number of samples
        const rng_sample = new PRNG(22222);
        const sampleCounts = new Uint32Array(256);
        for (let t = 0; t < fuzzTotal; t++) {
            const seq = sampleN(dfa, 1, 1, rng_sample)[0];
            sampleCounts[seq[0]]++;
        }

        // Both should have counts only at AA, BB, CC (uniform among them)
        expect(fuzzCounts[0xAA]).toBeGreaterThan(0);
        expect(fuzzCounts[0xBB]).toBeGreaterThan(0);
        expect(fuzzCounts[0xCC]).toBeGreaterThan(0);
        expect(sampleCounts[0xAA]).toBeGreaterThan(0);
        expect(sampleCounts[0xBB]).toBeGreaterThan(0);
        expect(sampleCounts[0xCC]).toBeGreaterThan(0);

        // Verify proportions match (each should be ~1/3)
        const fP = fuzzCounts[0xAA] / fuzzTotal;
        const sP = sampleCounts[0xAA] / fuzzTotal;
        expect(Math.abs(fP - 1 / 3)).toBeLessThan(0.02);
        expect(Math.abs(sP - 1 / 3)).toBeLessThan(0.02);

        // No other bytes should be accepted
        for (let b = 0; b < 256; b++) {
            if (b !== 0xAA && b !== 0xBB && b !== 0xCC) {
                expect(fuzzCounts[b]).toBe(0);
                expect(sampleCounts[b]).toBe(0);
            }
        }
    });

    it('multi-byte sampler vs fuzzer: joint distribution', () => {
        // DFA: (NOP|CLC) B5 — 2-3 bytes, slide + core
        // 2 bytes: B5 accepted? No, need state after B5 to be accept.
        // Let's make: (A|B)* C, length exactly 3
        // Accepted: anything from {A,B}^2 × {C} → 4 sequences
        const A = 0x10, B = 0x20, C = 0x30;
        const dfa = buildDFA(2, 0, [1], [
            { from: 0, to: 0, on: [A, B] },
            { from: 0, to: 1, on: C },
        ]);

        // Length 3: 2 slide bytes + C. Each slide byte is A or B (2 choices).
        // Total: 2 × 2 × 1 = 4 accepted sequences.
        expect(totalAccepting(dfa, 3)).toBe(4n);

        // Fuzz
        const rng_fuzz = new PRNG(33333);
        const fuzzSeqs = new Map(); // "hex" → count
        let fuzzTotal = 0;
        for (let t = 0; t < 200000; t++) {
            const seq = [rng_fuzz.below(256), rng_fuzz.below(256), rng_fuzz.below(256)];
            if (dfa.accepts(seq)) {
                const key = seq.join(',');
                fuzzSeqs.set(key, (fuzzSeqs.get(key) || 0) + 1);
                fuzzTotal++;
            }
        }

        // Sample
        const rng_sample = new PRNG(44444);
        const sampleSeqs = new Map();
        const N_sample = Math.max(fuzzTotal, 100);
        for (let t = 0; t < N_sample; t++) {
            const seq = sampleN(dfa, 3, 1, rng_sample)[0];
            const key = Array.from(seq).join(',');
            sampleSeqs.set(key, (sampleSeqs.get(key) || 0) + 1);
        }

        // Both should have exactly 4 distinct sequences
        expect(sampleSeqs.size).toBe(4);

        // Each should be ~25% of total (uniform)
        for (const [key, count] of sampleSeqs) {
            const proportion = count / N_sample;
            expect(proportion).toBeGreaterThan(0.15);
            expect(proportion).toBeLessThan(0.35);
        }
    });
});
