// Jukes-Cantor distance for the 6502life noisy copy channel
//
// The copyCellWithNoise function copies M=1024 bytes from source to dest.
// Each bit is independently randomized with probability ε = pBitNoise,
// and faithfully copied with probability 1-ε.
//
// This is a binary symmetric channel — the 2-state Jukes-Cantor model.
//
// After T copy events on the tree path between two cells:
//
//   P(bit differs) = p = ½(1 - (1-ε)^T)
//
//   T = log(1 - 2p) / log(1 - ε)
//
// Saturation at p → ½.
//
// For bytes, bits within a byte are independent (no byte-level noise), so:
//
//   P(byte differs) = 1 - [(1 + (1-ε)^T)/2]^8 = 1 - [(1-p)]^8 ... wait
//   P(byte matches) = P(all 8 bits match) = [(1-p)]^8 ... no
//   P(bit matches) = 1-p = ½(1 + (1-ε)^T)
//   P(byte matches) = [½(1 + (1-ε)^T)]^8
//
//   T = log(2·(1 - p_byte)^{1/8} - 1) / log(1 - ε)
//
// Per-byte Hamming distance h ~ Bin(8, p). The histogram {n_0,...,n_8}
// has sufficient statistic p̂ = mean_h / 8.

const DEFAULT_EPS = 1 / 2048;  // ~1 bit error per 256-byte page

/**
 * Expected bit mismatch fraction after T copy events.
 */
export function expectedBitMismatch(T, eps = DEFAULT_EPS) {
    return 0.5 * (1 - Math.pow(1 - eps, T));
}

/**
 * Expected byte mismatch fraction after T copy events.
 */
export function expectedByteMismatch(T, eps = DEFAULT_EPS) {
    const q = Math.pow(1 - eps, T);
    return 1 - Math.pow((1 + q) / 2, 8);
}

/**
 * Jukes-Cantor distance from observed bit mismatch fraction.
 * T = log(1 - 2p) / log(1 - ε)
 */
export function distanceFromBitMismatch(pBit, eps = DEFAULT_EPS) {
    if (pBit <= 0) return 0;
    if (pBit >= 0.5) return Infinity;
    if (eps <= 0) return pBit > 0 ? Infinity : 0;
    return Math.log(1 - 2 * pBit) / Math.log(1 - eps);
}

/**
 * Distance from observed byte mismatch fraction.
 * T = log(2·(1-p)^{1/8} - 1) / log(1-ε)
 */
export function distanceFromByteMismatch(pByte, eps = DEFAULT_EPS) {
    if (pByte <= 0) return 0;
    if (pByte >= 255 / 256) return Infinity;
    if (eps <= 0) return pByte > 0 ? Infinity : 0;
    const inner = 2 * Math.pow(1 - pByte, 1 / 8) - 1;
    if (inner <= 0) return Infinity;
    return Math.log(inner) / Math.log(1 - eps);
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
export function cellDistance(a, b, eps = DEFAULT_EPS, range = [0, 896]) {
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
        bitDist: distanceFromBitMismatch(pBit, eps),
        byteDist: distanceFromByteMismatch(pByte, eps),
        diffBits,
        diffBytes,
        totalBits,
        totalBytes,
    };
}
