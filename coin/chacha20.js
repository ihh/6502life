/**
 * ChaCha20 stream cipher for board initialization.
 *
 * Given a 32-byte key and 12-byte nonce, produces a deterministic
 * pseudorandom byte stream. Used to initialize board cell memory
 * from a seed, replacing the Mersenne Twister / Xoshiro PRNGs.
 *
 * ChaCha20 is preferred because:
 * 1. Cryptographically secure — no shortcut to find seeds that produce
 *    specific cell patterns (like replicators)
 * 2. Standardized (RFC 7539) — verifiable across implementations
 * 3. Fast — ~1 cycle/byte on modern hardware
 *
 * @module coin/chacha20
 */

/**
 * ChaCha20 quarter-round on state array.
 * @param {Uint32Array} s
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @param {number} d
 */
function quarterRound(s, a, b, c, d) {
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl32(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl32(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl32(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl32(s[b] ^ s[c], 7);
}

function rotl32(v, n) {
    return ((v << n) | (v >>> (32 - n))) >>> 0;
}

/**
 * Generate one 64-byte ChaCha20 block.
 * @param {Uint32Array} key - 8 × uint32 (32 bytes)
 * @param {number} counter - block counter
 * @param {Uint32Array} nonce - 3 × uint32 (12 bytes)
 * @returns {Uint8Array} 64 bytes of keystream
 */
function chacha20Block(key, counter, nonce) {
    // Initial state: "expand 32-byte k" + key + counter + nonce
    const state = new Uint32Array(16);
    state[0] = 0x61707865; // "expa"
    state[1] = 0x3320646e; // "nd 3"
    state[2] = 0x79622d32; // "2-by"
    state[3] = 0x6b206574; // "te k"
    state[4] = key[0]; state[5] = key[1]; state[6] = key[2]; state[7] = key[3];
    state[8] = key[4]; state[9] = key[5]; state[10] = key[6]; state[11] = key[7];
    state[12] = counter >>> 0;
    state[13] = nonce[0]; state[14] = nonce[1]; state[15] = nonce[2];

    // Working copy
    const working = new Uint32Array(state);

    // 20 rounds (10 double-rounds)
    for (let i = 0; i < 10; i++) {
        // Column rounds
        quarterRound(working, 0, 4, 8, 12);
        quarterRound(working, 1, 5, 9, 13);
        quarterRound(working, 2, 6, 10, 14);
        quarterRound(working, 3, 7, 11, 15);
        // Diagonal rounds
        quarterRound(working, 0, 5, 10, 15);
        quarterRound(working, 1, 6, 11, 12);
        quarterRound(working, 2, 7, 8, 13);
        quarterRound(working, 3, 4, 9, 14);
    }

    // Add original state
    for (let i = 0; i < 16; i++) {
        working[i] = (working[i] + state[i]) >>> 0;
    }

    return new Uint8Array(working.buffer);
}

/**
 * Generate a ChaCha20 keystream of arbitrary length.
 *
 * @param {Uint8Array} key - 32 bytes
 * @param {Uint8Array} nonce - 12 bytes
 * @param {number} length - number of bytes to generate
 * @returns {Uint8Array}
 */
export function chacha20Stream(key, nonce, length) {
    const keyWords = new Uint32Array(key.buffer, key.byteOffset, 8);
    const nonceWords = new Uint32Array(nonce.buffer, nonce.byteOffset, 3);
    const output = new Uint8Array(length);

    let offset = 0;
    let counter = 0;
    while (offset < length) {
        const block = chacha20Block(keyWords, counter, nonceWords);
        const remaining = length - offset;
        const toCopy = Math.min(64, remaining);
        output.set(block.subarray(0, toCopy), offset);
        offset += toCopy;
        counter++;
    }

    return output;
}

/**
 * Derive a 32-byte ChaCha20 key from a seed string or number.
 * Uses SHA-256 of the seed as the key material.
 *
 * @param {string|number} seed
 * @returns {Uint8Array} 32-byte key
 */
export function seedToKey(seed) {
    // Use crypto.subtle if available, otherwise simple hash
    const data = typeof seed === 'string'
        ? new TextEncoder().encode(seed)
        : new TextEncoder().encode(String(seed));
    // Simple portable hash (not using node crypto for browser compat)
    // SHA-256 via the same approach as coin/hash.js but inline for portability
    return sha256Portable(data);
}

/**
 * Derive a 12-byte nonce from board parameters.
 * Includes size and optional salt to commit to board setup.
 *
 * @param {Object} params
 * @param {number} params.size - board dimension
 * @param {boolean} [params.saltWithParams=false] - include all params in nonce derivation
 * @param {Object} [params.boardParams] - board hyperparameters to salt in
 * @param {number} [params.difficulty] - mining difficulty to salt in
 * @returns {Uint8Array} 12-byte nonce
 */
export function deriveNonce(params) {
    const parts = [String(params.size)];
    if (params.saltWithParams) {
        // Salt board params into the nonce so the owner commits to their
        // board setup before seeing the random initialization
        if (params.boardParams) parts.push(JSON.stringify(params.boardParams));
        if (params.difficulty != null) parts.push(`d=${params.difficulty}`);
    }
    const data = new TextEncoder().encode(parts.join('|'));
    const hash = sha256Portable(data);
    return hash.subarray(0, 12);
}

/**
 * Generate the full initial board memory from a seed.
 *
 * @param {string|number} seed - board seed
 * @param {number} size - board dimension (size × size cells)
 * @param {Object} [opts]
 * @param {boolean} [opts.saltWithParams=false]
 * @param {Object} [opts.boardParams]
 * @param {number} [opts.difficulty]
 * @returns {Uint8Array} size*size*1024 bytes of initial cell memory
 */
export function generateBoardInit(seed, size, opts = {}) {
    const key = seedToKey(seed);
    const nonce = deriveNonce({ size, ...opts });
    const totalBytes = size * size * 1024;
    return chacha20Stream(key, nonce, totalBytes);
}

// --- Portable SHA-256 ---
// Minimal implementation for browser compatibility (no node:crypto dependency)

function sha256Portable(data) {
    const K = new Uint32Array([
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ]);

    // Pre-processing: padding
    const bitLen = data.length * 8;
    const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
    padded.set(data);
    padded[data.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 4, bitLen, false);

    let [h0,h1,h2,h3,h4,h5,h6,h7] = [
        0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
        0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];

    const W = new Uint32Array(64);

    for (let chunk = 0; chunk < padded.length; chunk += 64) {
        for (let i = 0; i < 16; i++) W[i] = view.getUint32(chunk + i * 4, false);
        for (let i = 16; i < 64; i++) {
            const s0 = rotl32(W[i-15], 25) ^ rotl32(W[i-15], 14) ^ (W[i-15] >>> 3);
            const s1 = rotl32(W[i-2], 15) ^ rotl32(W[i-2], 13) ^ (W[i-2] >>> 10);
            W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0;
        }

        let [a,b,c,d,e,f,g,h] = [h0,h1,h2,h3,h4,h5,h6,h7];
        for (let i = 0; i < 64; i++) {
            const S1 = rotl32(e, 26) ^ rotl32(e, 21) ^ rotl32(e, 7);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
            const S0 = rotl32(a, 30) ^ rotl32(a, 19) ^ rotl32(a, 10);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }

        h0 = (h0+a)>>>0; h1 = (h1+b)>>>0; h2 = (h2+c)>>>0; h3 = (h3+d)>>>0;
        h4 = (h4+e)>>>0; h5 = (h5+f)>>>0; h6 = (h6+g)>>>0; h7 = (h7+h)>>>0;
    }

    const result = new Uint8Array(32);
    const rv = new DataView(result.buffer);
    rv.setUint32(0,h0,false); rv.setUint32(4,h1,false); rv.setUint32(8,h2,false); rv.setUint32(12,h3,false);
    rv.setUint32(16,h4,false); rv.setUint32(20,h5,false); rv.setUint32(24,h6,false); rv.setUint32(28,h7,false);
    return result;
}
