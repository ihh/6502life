// Jukes-Cantor-like distance formulas for the 6502life noisy copy model
//
// The copyCellWithNoise noise model is a hierarchical binary symmetric channel:
//   Cell level:  with prob pCellNoise, all bits randomized (ignore pCellMask for distance)
//   Byte level:  with prob pByteNoise, all 8 bits in byte randomized
//   Bit level:   with prob pBitNoise (ε), single bit randomized
//
// This gives an effective per-bit randomization rate:
//   ε_eff = 1 - (1 - pCellNoise)(1 - pByteNoise)(1 - pBitNoise)
//
// and a per-byte randomization rate (correlated across all 8 bits):
//   r = pCellNoise + pByteNoise * (1 - pCellNoise)
//
// === BIT-LEVEL MODEL (binary Jukes-Cantor) ===
//
// Each bit evolves under a 2-state symmetric Markov chain. Per copy event,
// each bit is independently randomized with prob ε_eff. After T copy events
// on the tree path between two leaves:
//
//   P(bit differs) = p_bit = 1/2 · (1 - (1-ε_eff)^T)
//
//   T = log(1 - 2·p_bit) / log(1 - ε_eff)
//
// Saturation: p_bit → 1/2.
//
// === 9-STATE BYTE HAMMING MODEL (combined bit + byte noise) ===
//
// Each byte is modeled as a 9-state Markov chain, where the state h ∈ {0,...,8}
// is the number of bit differences between two corresponding bytes.
//
// Per copy event, for one byte:
//   - With prob r: byte randomized → h ~ Bin(8, 1/2) regardless of current state
//   - With prob 1-r: bit-level noise only → each of the h "diff" bits repairs
//     with prob ε/2, each of the 8-h "same" bits breaks with prob ε/2
//
// The eigenvalues of this 9×9 transition matrix are:
//   λ_0 = 1,  λ_k = (1-r)(1-ε)^k  for k = 1,...,8
//
// and the eigenvectors are the Krawtchouk polynomials K_k(h; 8, 1/2).
//
// Using the generating function Σ_k z^k K_k(h) = (1-z)^h (1+z)^{8-h},
// the distribution starting from h=0 after T copy events has a beautiful
// closed form as a MIXTURE OF TWO BINOMIALS:
//
//   π_T(h) = (1-s) · Bin(h; 8, 1/2) + s · Bin(h; 8, p)
//
// where:
//   s = (1-r)^T   = P(no byte-randomization on the tree path)
//   p = (1-(1-ε)^T)/2  = per-bit mismatch prob from bit-noise alone
//   Bin(h; 8, q)  = C(8,h) q^h (1-q)^{8-h}
//
// Interpretation: with probability s the byte was never hit by byte/cell noise,
// so h ~ Bin(8, p) from bit-noise accumulation. With probability 1-s it was
// randomized at some point, wiping all signal: h ~ Bin(8, 1/2).
//
// For default parameters (r=0): s=1, so π_T is purely Bin(8, p), and the
// mean gives the same estimate as the bit-level formula.
//
// For r > 0: the mixture has overdispersion relative to a single binomial.
// The full histogram {n_0,...,n_8} constrains both s and p (hence T),
// giving a more efficient estimator than bit-level or byte-match-only.
//
// === BYTE MATCH/MISMATCH MODEL (legacy, derivable from 9-state) ===
//
// P(byte match) = π_T(0) = (1-s)/256 + s·(1-p)^8
//               = (1-s)/256 + s·[(1+(1-ε)^T)/2]^8
//
// For r=0: T = log(2·(1-p_byte)^{1/8} - 1) / log(1-ε)
// For r>0: numerical bisection.
// Saturation: p_byte → 255/256.

const DEFAULT_NOISE = {
    pCellNoise: 0,
    pByteNoise: 0,
    pBitNoise: 0.001,
};

// --- Precomputed binomial coefficients C(8, k) ---
const C8 = [1, 8, 28, 56, 70, 56, 28, 8, 1];

/**
 * Compute effective noise rates from noise parameters.
 * @param {object} noiseParams - { pCellNoise, pByteNoise, pBitNoise }
 * @returns {{ epsEff: number, r: number, eps: number }}
 */
export function noiseRates(noiseParams = DEFAULT_NOISE) {
    const pCN = noiseParams.pCellNoise || 0;
    const pBN = noiseParams.pByteNoise || 0;
    const eps = noiseParams.pBitNoise || 0;
    const epsEff = 1 - (1 - pCN) * (1 - pBN) * (1 - eps);
    const r = pCN + pBN * (1 - pCN);
    return { epsEff, r, eps };
}

// =====================================================================
// Forward model: T copy events → expected distributions / fractions
// =====================================================================

/**
 * Expected bit mismatch fraction after T copy events.
 * p_bit = 1/2 · (1 - (1-ε_eff)^T)
 */
export function expectedBitMismatch(T, noiseParams = DEFAULT_NOISE) {
    const { epsEff } = noiseRates(noiseParams);
    return 0.5 * (1 - Math.pow(1 - epsEff, T));
}

/**
 * Expected byte mismatch fraction after T copy events.
 * P(byte differs) = 1 - π_T(0).
 */
export function expectedByteMismatch(T, noiseParams = DEFAULT_NOISE) {
    const { r, eps } = noiseRates(noiseParams);
    const s = Math.pow(1 - r, T);
    const q = Math.pow(1 - eps, T);
    return 1 - ((1 - s) / 256 + s * Math.pow((1 + q) / 2, 8));
}

/**
 * Full 9-state distribution: π_T(h) for h = 0,...,8.
 * Returns Float64Array of length 9.
 *
 *   π_T(h) = (1-s) · Bin(h; 8, 1/2) + s · Bin(h; 8, p)
 *
 * where s = (1-r)^T, p = (1-(1-ε)^T)/2.
 */
export function byteHammingDistribution(T, noiseParams = DEFAULT_NOISE) {
    const { r, eps } = noiseRates(noiseParams);
    const s = Math.pow(1 - r, T);        // P(no byte-randomization)
    const p = (1 - Math.pow(1 - eps, T)) / 2;  // bit-noise mismatch prob
    const pi = new Float64Array(9);
    for (let h = 0; h <= 8; h++) {
        const binHalf = C8[h] / 256;    // Bin(h; 8, 1/2)
        const binP = C8[h] * Math.pow(p, h) * Math.pow(1 - p, 8 - h);  // Bin(h; 8, p)
        pi[h] = (1 - s) * binHalf + s * binP;
    }
    return pi;
}

// =====================================================================
// Observed data: Hamming distances and histograms
// =====================================================================

/**
 * Bit-level Hamming distance: count of differing bits.
 */
export function hammingBits(a, b, start = 0, end = undefined) {
    end = end ?? Math.min(a.length, b.length);
    let count = 0;
    for (let i = start; i < end; i++) {
        let xor = a[i] ^ b[i];
        while (xor) { xor &= xor - 1; count++; }
    }
    return count;
}

/**
 * Byte-level Hamming distance: count of differing bytes.
 */
export function hammingBytes(a, b, start = 0, end = undefined) {
    end = end ?? Math.min(a.length, b.length);
    let count = 0;
    for (let i = start; i < end; i++) {
        if (a[i] !== b[i]) count++;
    }
    return count;
}

/**
 * Per-byte Hamming distance histogram: counts of bytes with h = 0..8 bit differences.
 * Returns Uint32Array of length 9.
 */
export function byteHammingHistogram(a, b, start = 0, end = undefined) {
    end = end ?? Math.min(a.length, b.length);
    const hist = new Uint32Array(9);
    for (let i = start; i < end; i++) {
        let xor = a[i] ^ b[i];
        let bits = 0;
        while (xor) { xor &= xor - 1; bits++; }
        hist[bits]++;
    }
    return hist;
}

// =====================================================================
// Inverse: observed data → distance T
// =====================================================================

/**
 * Jukes-Cantor distance from observed bit mismatch fraction.
 * T = log(1 - 2·p) / log(1 - ε_eff)
 *
 * Returns Infinity if p ≥ 0.5 (saturation).
 */
export function distanceFromBitMismatch(pBit, noiseParams = DEFAULT_NOISE) {
    if (pBit <= 0) return 0;
    if (pBit >= 0.5) return Infinity;
    const { epsEff } = noiseRates(noiseParams);
    if (epsEff <= 0) return pBit > 0 ? Infinity : 0;
    return Math.log(1 - 2 * pBit) / Math.log(1 - epsEff);
}

/**
 * Distance from observed byte mismatch fraction.
 * For r=0: T = log(2·(1-p)^{1/8} - 1) / log(1-ε)
 * For r>0: numerical bisection.
 *
 * Returns Infinity if p ≥ 255/256 (saturation).
 */
export function distanceFromByteMismatch(pByte, noiseParams = DEFAULT_NOISE) {
    if (pByte <= 0) return 0;
    if (pByte >= 255 / 256) return Infinity;
    const { r, eps } = noiseRates(noiseParams);
    if (eps <= 0 && r <= 0) return pByte > 0 ? Infinity : 0;

    if (r === 0) {
        const inner = 2 * Math.pow(1 - pByte, 1 / 8) - 1;
        if (inner <= 0) return Infinity;
        return Math.log(inner) / Math.log(1 - eps);
    }

    let lo = 0, hi = 1;
    while (expectedByteMismatch(hi, noiseParams) < pByte) hi *= 2;
    for (let i = 0; i < 100; i++) {
        const mid = (lo + hi) / 2;
        if (expectedByteMismatch(mid, noiseParams) < pByte) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

/**
 * EM algorithm for the two-component binomial mixture:
 *
 *   π(h | s, p) = (1-s) · Bin(h; 8, 1/2) + s · Bin(h; 8, p)
 *
 * where s = weight of the "bit-noise only" component (bytes never hit by byte noise),
 * and p = per-bit mismatch probability from bit-noise accumulation.
 *
 * E-step: posterior that byte h came from the signal component:
 *   w_h = s · Bin(h; 8, p) / π(h | s, p)
 *
 * M-step (closed form):
 *   s ← Σ_h n_h · w_h / L
 *   p ← Σ_h h · n_h · w_h / (8 · Σ_h n_h · w_h)
 *
 * @param {Uint32Array} histogram - counts n_0,...,n_8
 * @param {object} [options] - { maxIter, tol, sInit, pInit }
 * @returns {{ s, p, logLik, pi, iterations }}
 */
export function fitBinomialMixture(histogram, options = {}) {
    const L = histogram.reduce((a, b) => a + b, 0);
    if (L === 0) return { s: 1, p: 0, logLik: 0, pi: new Float64Array(9), iterations: 0 };

    const maxIter = options.maxIter || 200;
    const tol = options.tol || 1e-12;

    // Initialize
    let meanH = 0;
    for (let h = 0; h <= 8; h++) meanH += h * histogram[h];
    meanH /= L;

    let s = options.sInit ?? 0.9;
    let p = options.pInit ?? Math.max(1e-10, Math.min(meanH / 8, 0.4999));

    const binHalf = new Float64Array(9);  // Bin(h; 8, 1/2) — precompute
    for (let h = 0; h <= 8; h++) binHalf[h] = C8[h] / 256;

    let iter = 0;
    for (; iter < maxIter; iter++) {
        // Compute Bin(h; 8, p)
        const binP = new Float64Array(9);
        for (let h = 0; h <= 8; h++) {
            binP[h] = C8[h] * Math.pow(Math.max(p, 1e-300), h) * Math.pow(Math.max(1 - p, 1e-300), 8 - h);
        }

        // E-step: posterior weights
        const w = new Float64Array(9);
        for (let h = 0; h <= 8; h++) {
            const pi_h = (1 - s) * binHalf[h] + s * binP[h];
            w[h] = pi_h > 0 ? s * binP[h] / pi_h : 0;
        }

        // M-step
        let sumNW = 0, sumHNW = 0;
        for (let h = 0; h <= 8; h++) {
            sumNW += histogram[h] * w[h];
            sumHNW += h * histogram[h] * w[h];
        }
        const sNew = Math.max(1e-10, Math.min(1 - 1e-10, sumNW / L));
        const pNew = sumNW > 0 ? Math.max(1e-10, Math.min(0.4999, sumHNW / (8 * sumNW))) : p;

        if (Math.abs(sNew - s) < tol && Math.abs(pNew - p) < tol) {
            s = sNew;
            p = pNew;
            iter++;
            break;
        }
        s = sNew;
        p = pNew;
    }

    // Final distribution
    const pi = new Float64Array(9);
    for (let h = 0; h <= 8; h++) {
        const binP = C8[h] * Math.pow(p, h) * Math.pow(1 - p, 8 - h);
        pi[h] = (1 - s) * binHalf[h] + s * binP;
    }

    return { s, p, logLik: logLikelihood(histogram, pi), pi, iterations: iter };
}

/**
 * Maximum likelihood distance from per-byte Hamming histogram.
 *
 * Given observed histogram {n_0,...,n_8} (counts of bytes with h bit differences),
 * estimates the evolutionary distance T.
 *
 * For r=0: the distribution is Bin(8, p), and the MLE is closed-form:
 *   p̂ = mean_h / 8,  T̂ = log(1 - 2p̂) / log(1-ε)
 *
 * For r>0: uses EM to fit (s, p) as free parameters, then recovers T from each:
 *   T_from_p = log(1 - 2p) / log(1 - ε)       (bit-noise estimate)
 *   T_from_s = log(s) / log(1 - r)             (byte-noise estimate)
 *   T        = (T_from_p + T_from_s) / 2       (average, when model holds)
 *
 * The discrepancy |T_from_p - T_from_s| diagnoses model violations.
 *
 * Returns { T, Tp, Ts, s, p, logLik, pi, chiSq, df }
 */
export function distanceFromByteHamming(histogram, noiseParams = DEFAULT_NOISE) {
    const { r, eps } = noiseRates(noiseParams);
    const L = histogram.reduce((a, b) => a + b, 0);
    if (L === 0) return { T: 0, Tp: 0, Ts: 0, s: 1, p: 0, logLik: 0, pi: new Float64Array(9), chiSq: 0, df: 0 };

    let meanH = 0;
    for (let h = 0; h <= 8; h++) meanH += h * histogram[h];
    meanH /= L;

    if (r === 0) {
        // Closed form: s=1, p̂ = mean_h / 8
        const pHat = meanH / 8;
        const T = distanceFromBitMismatch(pHat, noiseParams);
        const pi = byteHammingDistribution(T, noiseParams);
        const { chiSq, df } = goodnessOfFit(histogram, pi, L);
        return {
            T, Tp: T, Ts: T,
            s: 1, p: pHat,
            logLik: logLikelihood(histogram, pi),
            pi, chiSq, df,
        };
    }

    // r > 0: constrained MLE via mean (closed form).
    // E[h] = 8 · p_bit(T) = 4(1 - (1-ε_eff)^T), same as bit-level.
    // The mean is a sufficient statistic when the model holds.
    const pHat = meanH / 8;
    const T = distanceFromBitMismatch(pHat, noiseParams);

    // Also run unconstrained EM to get (s, p) as free parameters.
    // Under the model, Tp ≈ Ts; discrepancy diagnoses model violations.
    const em = fitBinomialMixture(histogram);
    const Tp = distanceFromBitMismatch(em.p, { pCellNoise: 0, pByteNoise: 0, pBitNoise: eps });
    const Ts = (em.s >= 1) ? 0 : (em.s <= 0) ? Infinity : Math.log(em.s) / Math.log(1 - r);

    const pi = byteHammingDistribution(T, noiseParams);
    const { chiSq, df } = goodnessOfFit(histogram, pi, L);
    return {
        T, Tp, Ts,
        s: em.s, p: em.p,
        logLik: logLikelihood(histogram, pi),
        pi, chiSq, df,
    };
}

function logLikelihood(histogram, pi) {
    let ll = 0;
    for (let h = 0; h <= 8; h++) {
        if (histogram[h] > 0) {
            ll += histogram[h] * Math.log(Math.max(pi[h], 1e-300));
        }
    }
    return ll;
}

function goodnessOfFit(histogram, pi, L) {
    let chiSq = 0;
    let df = -1;  // subtract 1 for the fitted parameter T
    for (let h = 0; h <= 8; h++) {
        const expected = L * pi[h];
        if (expected >= 5) {
            chiSq += (histogram[h] - expected) ** 2 / expected;
            df++;
        }
    }
    return { chiSq, df: Math.max(df, 0) };
}

// =====================================================================
// All-in-one cell comparison
// =====================================================================

/**
 * Compute evolutionary distance between two cell byte arrays.
 * Uses all three estimators: bit-level, byte-match, and 9-state histogram MLE.
 */
export function cellDistance(a, b, noiseParams = DEFAULT_NOISE, range = [0, 896]) {
    const [start, end] = range;
    const totalBytes = end - start;
    const totalBits = totalBytes * 8;

    const diffBytes = hammingBytes(a, b, start, end);
    const diffBits = hammingBits(a, b, start, end);
    const hist = byteHammingHistogram(a, b, start, end);

    const pByte = diffBytes / totalBytes;
    const pBit = diffBits / totalBits;

    const histResult = distanceFromByteHamming(hist, noiseParams);

    return {
        pBit,
        pByte,
        bitDist: distanceFromBitMismatch(pBit, noiseParams),
        byteDist: distanceFromByteMismatch(pByte, noiseParams),
        histDist: histResult.T,
        chiSq: histResult.chiSq,
        df: histResult.df,
        histogram: hist,
        fittedPi: histResult.pi,
        diffBits,
        diffBytes,
        totalBits,
        totalBytes,
    };
}
