import { describe, it, expect } from 'vitest';
import {
    expectedBitMismatch,
    expectedByteMismatch,
    distanceFromBitMismatch,
    distanceFromByteMismatch,
    hammingBits,
    hammingBytes,
    byteHammingHistogram,
    cellDistance,
} from '../distance.js';

const EPS = 1 / 2048;

describe('forward model', () => {
    it('T=0 gives zero mismatch', () => {
        expect(expectedBitMismatch(0)).toBe(0);
        expect(expectedByteMismatch(0)).toBe(0);
    });

    it('T→∞ saturates', () => {
        expect(expectedBitMismatch(1e8)).toBeCloseTo(0.5, 4);
        expect(expectedByteMismatch(1e8)).toBeCloseTo(255 / 256, 4);
    });

    it('bit mismatch increases monotonically', () => {
        let prev = 0;
        for (let T = 10; T <= 1000; T += 10) {
            const p = expectedBitMismatch(T);
            expect(p).toBeGreaterThan(prev);
            prev = p;
        }
    });

    it('byte mismatch ≥ bit mismatch', () => {
        for (const T of [10, 100, 500, 1000]) {
            expect(expectedByteMismatch(T)).toBeGreaterThanOrEqual(expectedBitMismatch(T));
        }
    });

    it('byte mismatch = 1 - (1-p_bit)^8 (independent bits)', () => {
        for (const T of [10, 50, 200]) {
            const pBit = expectedBitMismatch(T);
            const pByte = expectedByteMismatch(T);
            expect(pByte).toBeCloseTo(1 - Math.pow(1 - pBit, 8), 10);
        }
    });
});

describe('inverse (distance estimation)', () => {
    it('round-trips bit mismatch', () => {
        for (const T of [1, 10, 50, 100, 500, 2000]) {
            const p = expectedBitMismatch(T);
            expect(distanceFromBitMismatch(p)).toBeCloseTo(T, 6);
        }
    });

    it('round-trips byte mismatch', () => {
        for (const T of [1, 10, 50, 100, 500, 2000]) {
            const p = expectedByteMismatch(T);
            expect(distanceFromByteMismatch(p)).toBeCloseTo(T, 3);
        }
    });

    it('handles edge cases', () => {
        expect(distanceFromBitMismatch(0)).toBe(0);
        expect(distanceFromBitMismatch(0.5)).toBe(Infinity);
        expect(distanceFromByteMismatch(0)).toBe(0);
        expect(distanceFromByteMismatch(255 / 256)).toBe(Infinity);
    });
});

describe('Hamming distances', () => {
    it('identical arrays give 0', () => {
        const a = new Uint8Array([1, 2, 3, 4]);
        expect(hammingBits(a, a)).toBe(0);
        expect(hammingBytes(a, a)).toBe(0);
    });

    it('counts bit differences', () => {
        const a = new Uint8Array([0b11110000]);
        const b = new Uint8Array([0b11001100]);
        expect(hammingBits(a, b)).toBe(4);
        expect(hammingBytes(a, b)).toBe(1);
    });

    it('respects range', () => {
        const a = new Uint8Array([0xFF, 0x00, 0xFF]);
        const b = new Uint8Array([0x00, 0x00, 0x00]);
        expect(hammingBytes(a, b, 1, 2)).toBe(0);
        expect(hammingBytes(a, b, 0, 3)).toBe(2);
    });

    it('histogram counts per-byte bit differences', () => {
        const a = new Uint8Array([0b11110000, 0b00000000]);
        const b = new Uint8Array([0b11001100, 0b11111111]);
        const hist = byteHammingHistogram(a, b);
        expect(hist[4]).toBe(1);
        expect(hist[8]).toBe(1);
    });
});

describe('empirical validation: Monte Carlo copy chain', () => {
    function simulateCopyChain(T, eps, cellSize = 896) {
        const ancestor = new Uint8Array(cellSize);
        for (let i = 0; i < cellSize; i++) ancestor[i] = (i * 37 + 13) & 0xFF;

        let current = new Uint8Array(ancestor);
        for (let t = 0; t < T; t++) {
            const next = new Uint8Array(cellSize);
            for (let b = 0; b < cellSize; b++) {
                let byte = current[b];
                for (let bit = 0; bit < 8; bit++) {
                    if (Math.random() < eps) {
                        if (Math.random() < 0.5) byte |= (1 << bit);
                        else byte &= ~(1 << bit);
                    }
                }
                next[b] = byte;
            }
            current = next;
        }
        return { ancestor, descendant: current };
    }

    it('bit-level distance matches prediction', () => {
        const T = 200;
        const nTrials = 50;
        const cellSize = 896;

        let totalBitDiff = 0;
        for (let trial = 0; trial < nTrials; trial++) {
            const { ancestor, descendant } = simulateCopyChain(T, EPS, cellSize);
            totalBitDiff += hammingBits(ancestor, descendant);
        }
        const observedPBit = totalBitDiff / (nTrials * cellSize * 8);
        expect(observedPBit).toBeCloseTo(expectedBitMismatch(T, EPS), 1);
    });

    it('byte-level distance matches prediction', () => {
        const T = 200;
        const nTrials = 50;
        const cellSize = 896;

        let totalByteDiff = 0;
        for (let trial = 0; trial < nTrials; trial++) {
            const { ancestor, descendant } = simulateCopyChain(T, EPS, cellSize);
            totalByteDiff += hammingBytes(ancestor, descendant);
        }
        const observedPByte = totalByteDiff / (nTrials * cellSize);
        expect(observedPByte).toBeCloseTo(expectedByteMismatch(T, EPS), 1);
    });

    it('MLE recovers T from simulated data', () => {
        const T = 80;
        const nTrials = 100;
        const cellSize = 896;

        let totalBitDiff = 0;
        for (let trial = 0; trial < nTrials; trial++) {
            const { ancestor, descendant } = simulateCopyChain(T, EPS, cellSize);
            totalBitDiff += hammingBits(ancestor, descendant);
        }
        const observedPBit = totalBitDiff / (nTrials * cellSize * 8);
        const recoveredT = distanceFromBitMismatch(observedPBit, EPS);
        expect(recoveredT).toBeCloseTo(T, -1);  // within ~10
    });
});
