import { describe, it, expect } from 'vitest';
import {
    noiseRates,
    expectedBitMismatch,
    expectedByteMismatch,
    byteHammingDistribution,
    byteHammingHistogram,
    distanceFromBitMismatch,
    distanceFromByteMismatch,
    distanceFromByteHamming,
    fitBinomialMixture,
    hammingBits,
    hammingBytes,
    cellDistance,
} from '../distance.js';

describe('noiseRates', () => {
    it('computes default rates', () => {
        const { epsEff, r, eps } = noiseRates();
        expect(eps).toBe(0.001);
        expect(r).toBe(0);
        expect(epsEff).toBeCloseTo(0.001);
    });

    it('computes combined rates', () => {
        const { epsEff, r } = noiseRates({ pCellNoise: 0.01, pByteNoise: 0.02, pBitNoise: 0.05 });
        expect(r).toBeCloseTo(0.0298);
        expect(epsEff).toBeCloseTo(1 - 0.99 * 0.98 * 0.95);
    });
});

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

    it('byte mismatch ≥ bit mismatch for same T', () => {
        for (const T of [10, 100, 500, 1000]) {
            expect(expectedByteMismatch(T)).toBeGreaterThanOrEqual(expectedBitMismatch(T));
        }
    });
});

// === 9-state byte Hamming distribution ===

describe('byteHammingDistribution', () => {
    it('T=0 is all weight on h=0', () => {
        const pi = byteHammingDistribution(0);
        expect(pi[0]).toBeCloseTo(1);
        for (let h = 1; h <= 8; h++) expect(pi[h]).toBeCloseTo(0);
    });

    it('T→∞ converges to Bin(8, 1/2)', () => {
        const pi = byteHammingDistribution(1e8);
        const C8 = [1, 8, 28, 56, 70, 56, 28, 8, 1];
        for (let h = 0; h <= 8; h++) {
            expect(pi[h]).toBeCloseTo(C8[h] / 256, 3);
        }
    });

    it('sums to 1', () => {
        for (const T of [0, 1, 10, 100, 1000]) {
            const pi = byteHammingDistribution(T);
            const sum = pi.reduce((a, b) => a + b, 0);
            expect(sum).toBeCloseTo(1, 10);
        }
    });

    it('for r=0, matches Binomial(8, p)', () => {
        const np = { pCellNoise: 0, pByteNoise: 0, pBitNoise: 0.01 };
        const T = 50;
        const pi = byteHammingDistribution(T, np);
        const p = (1 - Math.pow(1 - 0.01, T)) / 2;
        const C8 = [1, 8, 28, 56, 70, 56, 28, 8, 1];
        for (let h = 0; h <= 8; h++) {
            const binP = C8[h] * Math.pow(p, h) * Math.pow(1 - p, 8 - h);
            expect(pi[h]).toBeCloseTo(binP, 10);
        }
    });

    it('for r>0, is a mixture of two binomials', () => {
        const np = { pCellNoise: 0, pByteNoise: 0.02, pBitNoise: 0.01 };
        const T = 100;
        const pi = byteHammingDistribution(T, np);

        // Verify mixture decomposition manually
        const r = 0.02;
        const eps = 0.01;
        const s = Math.pow(1 - r, T);
        const p = (1 - Math.pow(1 - eps, T)) / 2;
        const C8 = [1, 8, 28, 56, 70, 56, 28, 8, 1];
        for (let h = 0; h <= 8; h++) {
            const expected = (1 - s) * C8[h] / 256 + s * C8[h] * Math.pow(p, h) * Math.pow(1 - p, 8 - h);
            expect(pi[h]).toBeCloseTo(expected, 10);
        }
    });

    it('mean equals 8·p_bit (same as bit-level estimate)', () => {
        const np = { pCellNoise: 0, pByteNoise: 0.02, pBitNoise: 0.01 };
        for (const T of [10, 50, 200]) {
            const pi = byteHammingDistribution(T, np);
            let mean = 0;
            for (let h = 0; h <= 8; h++) mean += h * pi[h];
            const expectedMean = 8 * expectedBitMismatch(T, np);
            expect(mean).toBeCloseTo(expectedMean, 8);
        }
    });

    it('r>0 inflates variance vs pure binomial', () => {
        const T = 100;
        const piNoR = byteHammingDistribution(T, { pCellNoise: 0, pByteNoise: 0, pBitNoise: 0.01 });
        const piWithR = byteHammingDistribution(T, { pCellNoise: 0, pByteNoise: 0.05, pBitNoise: 0.01 });
        const variance = (pi) => {
            let m = 0, m2 = 0;
            for (let h = 0; h <= 8; h++) { m += h * pi[h]; m2 += h * h * pi[h]; }
            return m2 - m * m;
        };
        expect(variance(piWithR)).toBeGreaterThan(variance(piNoR));
    });

    it('π_T(0) matches expectedByteMismatch', () => {
        for (const np of [
            { pCellNoise: 0, pByteNoise: 0, pBitNoise: 0.001 },
            { pCellNoise: 0, pByteNoise: 0.01, pBitNoise: 0.001 },
            { pCellNoise: 0.01, pByteNoise: 0.02, pBitNoise: 0.05 },
        ]) {
            for (const T of [10, 50, 200]) {
                const pi = byteHammingDistribution(T, np);
                const pByte = expectedByteMismatch(T, np);
                expect(1 - pi[0]).toBeCloseTo(pByte, 8);
            }
        }
    });
});

describe('byteHammingHistogram', () => {
    it('identical arrays give all weight on h=0', () => {
        const a = new Uint8Array([1, 2, 3, 4]);
        const hist = byteHammingHistogram(a, a);
        expect(hist[0]).toBe(4);
        for (let h = 1; h <= 8; h++) expect(hist[h]).toBe(0);
    });

    it('counts bit differences per byte', () => {
        const a = new Uint8Array([0b11110000, 0b00000000]);
        const b = new Uint8Array([0b11001100, 0b11111111]);
        const hist = byteHammingHistogram(a, b);
        expect(hist[4]).toBe(1);  // first byte: 4 bits differ
        expect(hist[8]).toBe(1);  // second byte: 8 bits differ
    });
});

describe('inverse: distance from bit mismatch', () => {
    it('round-trips through forward model', () => {
        for (const T of [1, 10, 50, 100, 500, 2000]) {
            const p = expectedBitMismatch(T);
            expect(distanceFromBitMismatch(p)).toBeCloseTo(T, 6);
        }
    });

    it('handles edge cases', () => {
        expect(distanceFromBitMismatch(0)).toBe(0);
        expect(distanceFromBitMismatch(0.5)).toBe(Infinity);
    });
});

describe('inverse: distance from byte mismatch', () => {
    it('round-trips (r=0)', () => {
        for (const T of [1, 10, 50, 100, 500, 2000]) {
            const p = expectedByteMismatch(T);
            expect(distanceFromByteMismatch(p)).toBeCloseTo(T, 3);
        }
    });

    it('round-trips (r>0, bisection)', () => {
        const np = { pCellNoise: 0, pByteNoise: 0.01, pBitNoise: 0.001 };
        for (const T of [1, 10, 50, 100, 500]) {
            const p = expectedByteMismatch(T, np);
            expect(distanceFromByteMismatch(p, np)).toBeCloseTo(T, 1);
        }
    });
});

describe('fitBinomialMixture (EM)', () => {
    it('recovers (s, p) from a pure Bin(8, p)', () => {
        // s=1: no noise component, should recover p
        const p = 0.1;
        const L = 10000;
        const C8 = [1, 8, 28, 56, 70, 56, 28, 8, 1];
        const hist = new Uint32Array(9);
        for (let h = 0; h <= 8; h++) hist[h] = Math.round(L * C8[h] * Math.pow(p, h) * Math.pow(1 - p, 8 - h));
        const result = fitBinomialMixture(hist);
        expect(result.s).toBeGreaterThan(0.95);  // nearly 1
        expect(result.p).toBeCloseTo(p, 1);
    });

    it('recovers (s, p) from a known mixture', () => {
        // s=0.7, p=0.05
        const s = 0.7, p = 0.05;
        const L = 50000;
        const C8 = [1, 8, 28, 56, 70, 56, 28, 8, 1];
        const hist = new Uint32Array(9);
        for (let h = 0; h <= 8; h++) {
            const binP = C8[h] * Math.pow(p, h) * Math.pow(1 - p, 8 - h);
            const binHalf = C8[h] / 256;
            hist[h] = Math.round(L * ((1 - s) * binHalf + s * binP));
        }
        const result = fitBinomialMixture(hist);
        expect(result.s).toBeCloseTo(s, 1);
        expect(result.p).toBeCloseTo(p, 1);
    });

    it('converges in few iterations', () => {
        const L = 10000;
        const C8 = [1, 8, 28, 56, 70, 56, 28, 8, 1];
        const hist = new Uint32Array(9);
        const p = 0.08;
        for (let h = 0; h <= 8; h++) hist[h] = Math.round(L * C8[h] * Math.pow(p, h) * Math.pow(1 - p, 8 - h));
        const result = fitBinomialMixture(hist);
        expect(result.iterations).toBeLessThan(100);
    });
});

describe('inverse: distance from byte Hamming histogram', () => {
    it('recovers T from exact distribution (r=0)', () => {
        const np = { pCellNoise: 0, pByteNoise: 0, pBitNoise: 0.001 };
        for (const T of [10, 50, 200, 1000]) {
            const pi = byteHammingDistribution(T, np);
            const L = 10000;
            const hist = new Uint32Array(9);
            for (let h = 0; h <= 8; h++) hist[h] = Math.round(L * pi[h]);
            const result = distanceFromByteHamming(hist, np);
            expect(result.T).toBeCloseTo(T, 0);
        }
    });

    it('recovers T from exact distribution (r>0)', () => {
        const np = { pCellNoise: 0, pByteNoise: 0.02, pBitNoise: 0.01 };
        for (const T of [10, 50, 200]) {
            const pi = byteHammingDistribution(T, np);
            const L = 50000;
            const hist = new Uint32Array(9);
            for (let h = 0; h <= 8; h++) hist[h] = Math.round(L * pi[h]);
            const result = distanceFromByteHamming(hist, np);
            // Constrained T (from mean) should be close
            expect(Math.abs(result.T - T) / Math.max(T, 1)).toBeLessThan(0.02);
        }
    });

    it('Tp ≈ Ts when signal is strong (s > 0.3)', () => {
        const np = { pCellNoise: 0, pByteNoise: 0.02, pBitNoise: 0.01 };
        // s = (1-0.02)^T > 0.3 requires T < ~60
        for (const T of [10, 30]) {
            const pi = byteHammingDistribution(T, np);
            const L = 50000;
            const hist = new Uint32Array(9);
            for (let h = 0; h <= 8; h++) hist[h] = Math.round(L * pi[h]);
            const result = distanceFromByteHamming(hist, np);
            expect(Math.abs(result.Tp - result.Ts) / Math.max(T, 1)).toBeLessThan(0.1);
        }
    });

    it('gives same T as bit-level for r=0', () => {
        const np = { pCellNoise: 0, pByteNoise: 0, pBitNoise: 0.001 };
        const T = 100;
        const pi = byteHammingDistribution(T, np);
        const L = 10000;
        const hist = new Uint32Array(9);
        for (let h = 0; h <= 8; h++) hist[h] = Math.round(L * pi[h]);
        const result = distanceFromByteHamming(hist, np);

        let meanH = 0;
        for (let h = 0; h <= 8; h++) meanH += h * hist[h];
        meanH /= hist.reduce((a, b) => a + b, 0);
        const pBit = meanH / 8;
        const bitT = distanceFromBitMismatch(pBit, np);

        expect(result.T).toBeCloseTo(bitT, 1);
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
});

describe('empirical validation: Monte Carlo copy chain', () => {
    function simulateCopyChain(T, noiseParams, cellSize = 896) {
        const ancestor = new Uint8Array(cellSize);
        for (let i = 0; i < cellSize; i++) ancestor[i] = (i * 37 + 13) & 0xFF;

        const pCN = noiseParams.pCellNoise || 0;
        const pBN = noiseParams.pByteNoise || 0;
        const eps = noiseParams.pBitNoise || 0;

        let current = new Uint8Array(ancestor);
        for (let t = 0; t < T; t++) {
            const next = new Uint8Array(cellSize);
            if (pCN > 0 && Math.random() < pCN) {
                for (let b = 0; b < cellSize; b++) next[b] = Math.floor(Math.random() * 256);
                current = next;
                continue;
            }
            for (let b = 0; b < cellSize; b++) {
                if (pBN > 0 && Math.random() < pBN) {
                    next[b] = Math.floor(Math.random() * 256);
                    continue;
                }
                let byte = current[b];
                for (let bit = 0; bit < 8; bit++) {
                    if (eps > 0 && Math.random() < eps) {
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

    it('bit-level distance matches analytical prediction', () => {
        const np = { pCellNoise: 0, pByteNoise: 0, pBitNoise: 0.001 };
        const T = 200;
        const nTrials = 50;
        const cellSize = 896;

        let totalBitDiff = 0;
        for (let trial = 0; trial < nTrials; trial++) {
            const { ancestor, descendant } = simulateCopyChain(T, np, cellSize);
            totalBitDiff += hammingBits(ancestor, descendant);
        }
        const observedPBit = totalBitDiff / (nTrials * cellSize * 8);
        expect(observedPBit).toBeCloseTo(expectedBitMismatch(T, np), 1);
    });

    it('byte-level distance matches analytical prediction', () => {
        const np = { pCellNoise: 0, pByteNoise: 0, pBitNoise: 0.001 };
        const T = 200;
        const nTrials = 50;
        const cellSize = 896;

        let totalByteDiff = 0;
        for (let trial = 0; trial < nTrials; trial++) {
            const { ancestor, descendant } = simulateCopyChain(T, np, cellSize);
            totalByteDiff += hammingBytes(ancestor, descendant);
        }
        const observedPByte = totalByteDiff / (nTrials * cellSize);
        expect(observedPByte).toBeCloseTo(expectedByteMismatch(T, np), 1);
    });

    it('byte Hamming histogram matches mixture-of-binomials (r=0)', () => {
        const np = { pCellNoise: 0, pByteNoise: 0, pBitNoise: 0.005 };
        const T = 100;
        const nTrials = 200;
        const cellSize = 896;

        const totalHist = new Uint32Array(9);
        for (let trial = 0; trial < nTrials; trial++) {
            const { ancestor, descendant } = simulateCopyChain(T, np, cellSize);
            const hist = byteHammingHistogram(ancestor, descendant);
            for (let h = 0; h <= 8; h++) totalHist[h] += hist[h];
        }
        const totalBytes = nTrials * cellSize;
        const expected = byteHammingDistribution(T, np);
        for (let h = 0; h <= 8; h++) {
            if (expected[h] > 0.001) {
                const observed = totalHist[h] / totalBytes;
                expect(observed).toBeCloseTo(expected[h], 1);
            }
        }
    });

    it('byte Hamming histogram matches mixture-of-binomials (r>0)', () => {
        const np = { pCellNoise: 0, pByteNoise: 0.02, pBitNoise: 0.005 };
        const T = 50;
        const nTrials = 200;
        const cellSize = 896;

        const totalHist = new Uint32Array(9);
        for (let trial = 0; trial < nTrials; trial++) {
            const { ancestor, descendant } = simulateCopyChain(T, np, cellSize);
            const hist = byteHammingHistogram(ancestor, descendant);
            for (let h = 0; h <= 8; h++) totalHist[h] += hist[h];
        }
        const totalBytes = nTrials * cellSize;
        const expected = byteHammingDistribution(T, np);
        for (let h = 0; h <= 8; h++) {
            if (expected[h] > 0.001) {
                const observed = totalHist[h] / totalBytes;
                expect(observed).toBeCloseTo(expected[h], 1);
            }
        }
    });

    it('MLE recovers T from simulated data', () => {
        const np = { pCellNoise: 0, pByteNoise: 0, pBitNoise: 0.005 };
        const T = 80;
        const nTrials = 100;
        const cellSize = 896;

        const totalHist = new Uint32Array(9);
        for (let trial = 0; trial < nTrials; trial++) {
            const { ancestor, descendant } = simulateCopyChain(T, np, cellSize);
            const hist = byteHammingHistogram(ancestor, descendant);
            for (let h = 0; h <= 8; h++) totalHist[h] += hist[h];
        }
        const result = distanceFromByteHamming(totalHist, np);
        expect(result.T).toBeCloseTo(T, -1);  // within ~10
    });

    it('MLE recovers T with byte noise', () => {
        const np = { pCellNoise: 0, pByteNoise: 0.02, pBitNoise: 0.005 };
        const T = 50;
        const nTrials = 100;
        const cellSize = 896;

        const totalHist = new Uint32Array(9);
        for (let trial = 0; trial < nTrials; trial++) {
            const { ancestor, descendant } = simulateCopyChain(T, np, cellSize);
            const hist = byteHammingHistogram(ancestor, descendant);
            for (let h = 0; h <= 8; h++) totalHist[h] += hist[h];
        }
        const result = distanceFromByteHamming(totalHist, np);
        expect(result.T).toBeCloseTo(T, -1);  // within ~10
    });
});
