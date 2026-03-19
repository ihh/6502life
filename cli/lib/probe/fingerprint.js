// MinHash-based fingerprinting for cell content
// Uses k-mer (shingle) hashing with MinHash for mutation-resilient similarity detection

// FNV-1a 32-bit hash — fast, no dependencies
function fnv1a(data, offset, length) {
    let h = 0x811c9dc5;
    for (let i = 0; i < length; i++) {
        h ^= data[offset + i];
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

// Hash a k-mer (shingle) starting at position `pos` in `data`
function hashKmer(data, pos, k) {
    return fnv1a(data, pos, k);
}

// Compute MinHash signature: the N smallest hash values over all k-mers
// This is resilient to single-byte substitutions since most k-mers are unaffected
export function minhash(data, offset, length, k = 4, numHashes = 32) {
    const mins = new Uint32Array(numHashes).fill(0xFFFFFFFF);

    const end = offset + length - k + 1;
    if (end <= offset) {
        // Data too short for even one k-mer
        return mins;
    }

    for (let pos = offset; pos < end; pos++) {
        const base = hashKmer(data, pos, k);
        // For each hash function, mix with a different seed
        for (let h = 0; h < numHashes; h++) {
            // Cheap secondary hash: multiply by different odd constants
            const v = Math.imul(base ^ (h * 0x9e3779b9), 0x85ebca6b) >>> 0;
            if (v < mins[h]) mins[h] = v;
        }
    }

    return mins;
}

// Jaccard similarity estimate from two MinHash signatures
export function minhashSimilarity(sigA, sigB) {
    let matches = 0;
    for (let i = 0; i < sigA.length; i++) {
        if (sigA[i] === sigB[i]) matches++;
    }
    return matches / sigA.length;
}

// Simple content hash for exact-match fingerprinting (fast, deterministic)
export function contentHash(data, offset, length) {
    return fnv1a(data, offset, length);
}

// Compute both exact hash and minhash for a cell's code region
export function fingerprint(cellBytes, range = [0, 896]) {
    const [start, end] = range;
    const length = end - start;
    return {
        hash: contentHash(cellBytes, start, length),
        minhash: minhash(cellBytes, start, length),
    };
}

// Hex string for a hash value
export function hashHex(h) {
    return (h >>> 0).toString(16).padStart(8, '0');
}
