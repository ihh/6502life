// Jukes-Cantor distance for the 6502life noisy copy channel
//
// The copyCellWithNoise function copies M=1024 bytes from source to dest.
// Each bit is independently resampled with probability ε = pBitNoise,
// and faithfully copied with probability 1-ε.
//
// When a bit is resampled, it becomes 0 with probability q = pBitNoiseZero
// and 1 with probability 1-q. Default q = 0.5 (fair coin = binary symmetric
// channel = standard Jukes-Cantor). Setting q = 1 gives pure erasure noise.
//
// The stationary distribution is π(0) = q, π(1) = 1-q.
// The equilibrium mismatch fraction (saturation) is 2q(1-q).
//
// After T copy events on the tree path between two cells:
//
//   P(bit differs) = p = 2q(1-q)(1 - (1-ε)^T)
//
//   T = log(1 - p/(2q(1-q))) / log(1 - ε)
//
// When q = 0.5 this reduces to p = ½(1-(1-ε)^T), the standard binary JC.
//
// For bytes, bits within a byte are independent, so:
//
//   P(byte matches) = (1-p)^8
//
//   T = log(1 - (1-(1-p_byte)^{1/8})/(2q(1-q))) / log(1 - ε)

const DEFAULT_EPS = 1 / 2048;  // ~1 bit error per 256-byte page
const DEFAULT_Q = 0.5;         // fair coin (standard Jukes-Cantor)

/**
 * Saturation (equilibrium) bit mismatch fraction for bias q.
 */
export function saturationMismatch(q = DEFAULT_Q) {
    return 2 * q * (1 - q);
}

/**
 * Expected bit mismatch fraction after T copy events.
 */
export function expectedBitMismatch(T, eps = DEFAULT_EPS, q = DEFAULT_Q) {
    return 2 * q * (1 - q) * (1 - Math.pow(1 - eps, T));
}

/**
 * Expected byte mismatch fraction after T copy events.
 */
export function expectedByteMismatch(T, eps = DEFAULT_EPS, q = DEFAULT_Q) {
    const pBit = expectedBitMismatch(T, eps, q);
    return 1 - Math.pow(1 - pBit, 8);
}

/**
 * Jukes-Cantor distance from observed bit mismatch fraction.
 * T = log(1 - p/(2q(1-q))) / log(1 - ε)
 */
export function distanceFromBitMismatch(pBit, eps = DEFAULT_EPS, q = DEFAULT_Q) {
    if (pBit <= 0) return 0;
    const pMax = 2 * q * (1 - q);
    if (pMax <= 0) return pBit > 0 ? Infinity : 0;
    if (pBit >= pMax) return Infinity;
    if (eps <= 0) return pBit > 0 ? Infinity : 0;
    return Math.log(1 - pBit / pMax) / Math.log(1 - eps);
}

/**
 * Distance from observed byte mismatch fraction.
 */
export function distanceFromByteMismatch(pByte, eps = DEFAULT_EPS, q = DEFAULT_Q) {
    if (pByte <= 0) return 0;
    const pMax = 2 * q * (1 - q);
    const pMaxByte = 1 - Math.pow(1 - pMax, 8);
    if (pMaxByte <= 0) return pByte > 0 ? Infinity : 0;
    if (pByte >= pMaxByte) return Infinity;
    if (eps <= 0) return pByte > 0 ? Infinity : 0;
    // Recover bit mismatch from byte mismatch
    const pBit = 1 - Math.pow(1 - pByte, 1 / 8);
    return Math.log(1 - pBit / pMax) / Math.log(1 - eps);
}

// --- Hamming distances ---

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

/**
 * Compute evolutionary distance between two cell byte arrays.
 */
export function cellDistance(a, b, eps = DEFAULT_EPS, range = [0, 896], q = DEFAULT_Q) {
    const [start, end] = range;
    const totalBytes = end - start;
    const totalBits = totalBytes * 8;

    const diffBytes = hammingBytes(a, b, start, end);
    const diffBits = hammingBits(a, b, start, end);

    const pByte = diffBytes / totalBytes;
    const pBit = diffBits / totalBits;

    return {
        pBit,
        pByte,
        bitDist: distanceFromBitMismatch(pBit, eps, q),
        byteDist: distanceFromByteMismatch(pByte, eps, q),
        diffBits,
        diffBytes,
        totalBits,
        totalBytes,
    };
}
