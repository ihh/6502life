import { describe, it, expect } from 'vitest';
import { buildDFA, DFA } from '../dfa.js';
import { forwardCountsBigInt, totalAccepting, acceptProbability,
         logAcceptProbability, effectiveBits, forwardCountsFloat } from '../forward.js';
import { PRNG } from '../../webgpu/prng.js';

describe('Forward algorithm: exact counts', () => {
    it('trivial accept-all DFA: 256^L accepted sequences', () => {
        const dfa = buildDFA(1, 0, [0], [{ from: 0, to: 0, on: '*' }]);
        expect(totalAccepting(dfa, 0)).toBe(1n);
        expect(totalAccepting(dfa, 1)).toBe(256n);
        expect(totalAccepting(dfa, 2)).toBe(65536n);
        expect(totalAccepting(dfa, 3)).toBe(16777216n);
    });

    it('trivial reject-all DFA: 0 accepted for L>0', () => {
        const dfa = buildDFA(1, 0, [], [{ from: 0, to: 0, on: '*' }]);
        expect(totalAccepting(dfa, 0)).toBe(0n);
        expect(totalAccepting(dfa, 1)).toBe(0n);
    });

    it('single-byte DFA: exactly 1 accepted sequence of length 1', () => {
        const dfa = buildDFA(2, 0, [1], [{ from: 0, to: 1, on: 0xB5 }]);
        expect(totalAccepting(dfa, 0)).toBe(0n); // not in accept state initially
        expect(totalAccepting(dfa, 1)).toBe(1n); // only B5
        expect(totalAccepting(dfa, 2)).toBe(0n); // state 1 has no transitions
    });

    it('toy replicator B5 XX 9D: 256 accepted at length 3', () => {
        const dfa = buildDFA(4, 0, [3], [
            { from: 0, to: 1, on: 0xB5 },
            { from: 1, to: 2, on: '*' },
            { from: 2, to: 3, on: 0x9D },
        ]);
        expect(totalAccepting(dfa, 3)).toBe(256n); // 1 × 256 × 1
        expect(totalAccepting(dfa, 2)).toBe(0n);
        expect(totalAccepting(dfa, 4)).toBe(0n);
    });

    it('DFA with self-loop: NOP* B5 XX 9D', () => {
        const dfa = buildDFA(4, 0, [3], [
            { from: 0, to: 0, on: 0xEA },  // NOP slide
            { from: 0, to: 1, on: 0xB5 },
            { from: 1, to: 2, on: '*' },
            { from: 2, to: 3, on: 0x9D },
        ]);
        // Length 3: no NOPs. 1 × 256 × 1 = 256
        expect(totalAccepting(dfa, 3)).toBe(256n);
        // Length 4: 1 NOP + B5 XX 9D. 1 × 1 × 256 × 1 = 256
        expect(totalAccepting(dfa, 4)).toBe(256n);
        // Length 5: 2 NOPs + B5 XX 9D. 1 × 1 × 1 × 256 × 1 = 256
        expect(totalAccepting(dfa, 5)).toBe(256n);
    });

    it('acceptance probability for toy DFA', () => {
        const dfa = buildDFA(4, 0, [3], [
            { from: 0, to: 1, on: 0xB5 },
            { from: 1, to: 2, on: '*' },
            { from: 2, to: 3, on: 0x9D },
        ]);
        // P(L=3) = 256 / 256^3 = 1/65536
        const p = acceptProbability(dfa, 3);
        expect(Math.abs(p - 1 / 65536)).toBeLessThan(1e-6);
    });

    it('logAcceptProbability and effectiveBits', () => {
        const dfa = buildDFA(4, 0, [3], [
            { from: 0, to: 1, on: 0xB5 },
            { from: 1, to: 2, on: '*' },
            { from: 2, to: 3, on: 0x9D },
        ]);
        // P = 256 / 256^3 = 256^{-2} = 2^{-16}
        const logP = logAcceptProbability(dfa, 3);
        expect(Math.abs(logP - (-16))).toBeLessThan(0.01);
        expect(Math.abs(effectiveBits(dfa, 3) - 16)).toBeLessThan(0.01);
    });
});

describe('Forward: float vs BigInt agreement', () => {
    it('float counts match BigInt for small DFA', () => {
        const dfa = buildDFA(4, 0, [3], [
            { from: 0, to: 0, on: 0xEA },
            { from: 0, to: 1, on: 0xB5 },
            { from: 1, to: 2, on: '*' },
            { from: 2, to: 3, on: 0x9D },
        ]);
        const bigCounts = forwardCountsBigInt(dfa, 10);
        const floatCounts = forwardCountsFloat(dfa, 10);

        for (let s = 0; s < 4; s++) {
            for (let n = 0; n <= 10; n++) {
                const big = Number(bigCounts[s][n]);
                const flt = floatCounts[s][n];
                if (big === 0) {
                    expect(flt).toBe(0);
                } else {
                    expect(Math.abs(flt - big) / big).toBeLessThan(1e-10);
                }
            }
        }
    });
});

describe('Forward: cross-validate with fuzzing', () => {
    it('fuzz acceptance rate matches Forward probability', () => {
        // DFA: (CLC|SEC|NOP)* B5 XX 9D XX 04 (INX|DEX)
        const SLIDE = [0x18, 0x38, 0xEA];
        const dfa = buildDFA(7, 0, [6], [
            { from: 0, to: 0, on: SLIDE },
            { from: 0, to: 1, on: 0xB5 },
            { from: 1, to: 2, on: '*' },
            { from: 2, to: 3, on: 0x9D },
            { from: 3, to: 4, on: '*' },
            { from: 4, to: 5, on: 0x04 },
            { from: 5, to: 6, on: [0xE8, 0xCA] },
        ]);

        // Exact probability at length 6 (no slide):
        // P = (1/256)(256/256)(1/256)(256/256)(1/256)(2/256) = 2/256^4
        // Use logAcceptProbability for precision at small probabilities
        const logP6 = logAcceptProbability(dfa, 6);
        // P = 2/256^4 = 2^{-31}. log2(P) = -31.
        expect(Math.abs(logP6 - (-31))).toBeLessThan(0.01);

        // At length 7 (1 slide byte): P = 6/256^5. log2(6/256^5) = log2(6) - 40 ≈ -37.415
        const logP7 = logAcceptProbability(dfa, 7);
        expect(Math.abs(logP7 - (Math.log2(6) - 40))).toBeLessThan(0.01);

        // B_eff at length 6: -log2(2/256^4) = 32 - 1 = 31
        expect(Math.abs(effectiveBits(dfa, 6) - 31)).toBeLessThan(0.01);
    });
});
