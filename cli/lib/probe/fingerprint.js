// MinHash-based fingerprinting for cell content
// Uses RLE-compressed k-mer (shingle) hashing with MinHash for mutation-resilient similarity detection

// FNV-1a 32-bit hash — fast, no dependencies
function fnv1a(data, offset, length) {
    let h = 0x811c9dc5;
    for (let i = 0; i < length; i++) {
        h ^= data[offset + i];
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

// Run-length encode: collapses runs of repeated bytes into (byte, byte, count-2).
// This prevents long runs of padding (e.g. 800+ zero bytes) from dominating the
// k-mer set and drowning out the actual program content.
function rleEncode(data, offset, length) {
    const result = [];
    let i = offset;
    const end = offset + length;
    while (i < end) {
        const b = data[i];
        let run = 1;
        while (i + run < end && data[i + run] === b && run < 257) {
            run++;
        }
        if (run >= 2) {
            result.push(b, b, run - 2);
            i += run;
        } else {
            result.push(b);
            i++;
        }
    }
    return new Uint8Array(result);
}

// Compute MinHash signature over RLE-compressed k-mers.
// RLE compression ensures that long runs of identical bytes (padding) are collapsed,
// so the MinHash signature reflects actual program content rather than background fill.
export function minhash(data, offset, length, k = 4, numHashes = 64) {
    const encoded = rleEncode(data, offset, length);
    const mins = new Uint32Array(numHashes).fill(0xFFFFFFFF);

    const end = encoded.length - k + 1;
    if (end <= 0) {
        return mins;
    }

    for (let pos = 0; pos < end; pos++) {
        const base = fnv1a(encoded, pos, k);
        // For each hash function, mix with a different seed
        for (let h = 0; h < numHashes; h++) {
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
