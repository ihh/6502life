/**
 * Single-block BLAKE3 for deterministic board initialization.
 *
 * Produces identical output to the JAX reference in jax6502/mine_blake3.py.
 * Message = seed (4 bytes LE) || cell_index (4 bytes LE), padded to 64 bytes.
 * Uses BLAKE3 IV (same as BLAKE2s), 7-round message permutation.
 * Flags: CHUNK_START | CHUNK_END | ROOT. Counter = 0, block_len = 8.
 *
 * Also includes the Turtle's Tiers bias table (from mine_turtles_tiers.py):
 * raw BLAKE3 bytes are mapped through an inverse-CDF lookup that biases
 * toward replicator-relevant opcodes ($B5, $9D, $00, $04, $CA, etc.).
 * The mined organisms in mined_organisms.json use this bias.
 *
 * @module coin/blake3
 */

// BLAKE3 IV (same as BLAKE2s)
const IV = new Uint32Array([
    0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
    0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
]);

// BLAKE3 message permutation schedule (7 rounds)
const MSG_SCHEDULE = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8],
    [3, 4, 10, 12, 13, 2, 7, 14, 6, 5, 9, 0, 11, 15, 8, 1],
    [10, 7, 12, 9, 14, 3, 13, 15, 4, 0, 11, 2, 5, 8, 1, 6],
    [12, 13, 9, 11, 15, 10, 14, 8, 7, 2, 5, 3, 0, 1, 6, 4],
    [9, 14, 11, 5, 8, 12, 15, 1, 13, 3, 0, 10, 2, 6, 4, 7],
    [11, 15, 5, 0, 1, 9, 8, 6, 14, 10, 2, 12, 3, 4, 7, 13],
];

// BLAKE3 flags
const CHUNK_START = 1;
const CHUNK_END = 2;
const ROOT = 8;

/**
 * Rotate left for 32-bit unsigned integers.
 * @param {number} v
 * @param {number} n
 * @returns {number}
 */
function rotl32(v, n) {
    return ((v << n) | (v >>> (32 - n))) >>> 0;
}

/**
 * BLAKE3 quarter-round (G function).
 * Operates in-place on the 16-word state array.
 * @param {Uint32Array} s - 16-word state
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @param {number} d
 * @param {number} mx - first message word
 * @param {number} my - second message word
 */
function g(s, a, b, c, d, mx, my) {
    s[a] = (s[a] + s[b] + mx) >>> 0;
    s[d] = rotl32(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0;
    s[b] = rotl32(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b] + my) >>> 0;
    s[d] = rotl32(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0;
    s[b] = rotl32(s[b] ^ s[c], 7);
}

/**
 * BLAKE3 single-block compression function.
 *
 * @param {Uint32Array} msg - uint32[16] message block
 * @param {Uint32Array} iv - uint32[8] chaining value (IV for first block)
 * @param {number} counter - block counter (0 for single block)
 * @param {number} blockLen - number of message bytes
 * @param {number} flags - BLAKE3 flags
 * @returns {Uint32Array} uint32[8] output chaining value
 */
export function blake3Compress(msg, iv, counter, blockLen, flags) {
    // Build 16-word state:
    //   [0..7]   = chaining value (key_words / IV)
    //   [8..11]  = IV[0..3]
    //   [12..15] = counter_lo, counter_hi, block_len, flags
    const state = new Uint32Array(16);
    state[0] = iv[0]; state[1] = iv[1]; state[2] = iv[2]; state[3] = iv[3];
    state[4] = iv[4]; state[5] = iv[5]; state[6] = iv[6]; state[7] = iv[7];
    state[8]  = IV[0]; state[9]  = IV[1]; state[10] = IV[2]; state[11] = IV[3];
    state[12] = (counter >>> 0);
    state[13] = 0;  // counter high 32 bits (always 0 for us)
    state[14] = (blockLen >>> 0);
    state[15] = (flags >>> 0);

    // 7 rounds with message permutation
    for (let round = 0; round < 7; round++) {
        const perm = MSG_SCHEDULE[round];
        // Column step
        g(state, 0, 4,  8, 12, msg[perm[0]],  msg[perm[1]]);
        g(state, 1, 5,  9, 13, msg[perm[2]],  msg[perm[3]]);
        g(state, 2, 6, 10, 14, msg[perm[4]],  msg[perm[5]]);
        g(state, 3, 7, 11, 15, msg[perm[6]],  msg[perm[7]]);
        // Diagonal step
        g(state, 0, 5, 10, 15, msg[perm[8]],  msg[perm[9]]);
        g(state, 1, 6, 11, 12, msg[perm[10]], msg[perm[11]]);
        g(state, 2, 7,  8, 13, msg[perm[12]], msg[perm[13]]);
        g(state, 3, 4,  9, 14, msg[perm[14]], msg[perm[15]]);
    }

    // Output: XOR first 8 words with last 8
    const out = new Uint32Array(8);
    for (let i = 0; i < 8; i++) {
        out[i] = (state[i] ^ state[i + 8]) >>> 0;
    }
    return out;
}

/**
 * Generate nBytes of BLAKE3 output for a single cell.
 *
 * Message = seed (4 bytes LE) || cellIndex (4 bytes LE), padded to 64 bytes.
 * For the first 32 bytes, uses counter=0 with ROOT flag.
 * For additional 32-byte blocks, increments the counter (standard BLAKE3
 * extended output: re-run compression with same inputs but counter=1,2,...
 * and without the ROOT flag on the inner call, then XOR).
 *
 * Actually, BLAKE3 extended output works by taking the pre-finalization
 * state and running output blocks with increasing counters. For single-chunk
 * messages, this is equivalent to re-running the compression with the same
 * message and increasing counter, keeping all flags.
 *
 * @param {number} seed - 32-bit seed
 * @param {number} cellIndex - 32-bit cell index
 * @param {number} nBytes - number of output bytes (default 32)
 * @returns {Uint8Array}
 */
export function blake3Cell(seed, cellIndex, nBytes = 32) {
    // Build the 16-word message: seed || cellIndex || zeros
    const msg = new Uint32Array(16);
    msg[0] = seed >>> 0;
    msg[1] = cellIndex >>> 0;
    // msg[2..15] = 0 (already zeroed)

    const flags = CHUNK_START | CHUNK_END | ROOT;
    const output = new Uint8Array(nBytes);
    let offset = 0;
    let counter = 0;

    while (offset < nBytes) {
        const out = blake3Compress(msg, IV, counter, 8, flags);
        // Convert uint32[8] to bytes (little-endian), copy what we need
        const block = new Uint8Array(out.buffer);
        const toCopy = Math.min(32, nBytes - offset);
        output.set(block.subarray(0, toCopy), offset);
        offset += toCopy;
        counter++;
    }

    return output;
}

/**
 * Generate full board memory from a 32-bit seed using BLAKE3.
 *
 * Each cell gets 1024 bytes generated by blake3Cell with increasing
 * output block counters. Cells are indexed row-major:
 *   cell_index = row * boardSize + col
 *
 * @param {number} seed - 32-bit seed
 * @param {number} boardSize - board dimension (boardSize x boardSize cells)
 * @returns {Uint8Array} boardSize*boardSize*1024 bytes
 */
export function blake3Board(seed, boardSize) {
    const nCells = boardSize * boardSize;
    const cellBytes = 1024;
    const total = nCells * cellBytes;
    const board = new Uint8Array(total);

    for (let i = 0; i < nCells; i++) {
        const cell = blake3Cell(seed, i, cellBytes);
        board.set(cell, i * cellBytes);
    }

    return board;
}

// ── Turtle's Tiers bias (from jax6502/mine_turtles_tiers.py) ──────

/**
 * Per-byte weights for the Turtle's Tiers soup.
 * Replicator-relevant opcodes get higher weight → appear more often.
 */
function buildSoupWeights() {
    const w = new Float64Array(256).fill(1);
    w[0x00] = 400;   // zero/address
    w[0x04] = 100;   // STA page
    w[0xB5] = 200; w[0x9D] = 200;  // X load/store
    w[0xB7] = 63;  w[0x99] = 63;   // Y load/store
    w[0xCA] = 200;   // DEX (common)
    w[0xE8] = 40;    // INX
    w[0x88] = 7;     // DEY
    w[0xC8] = 2;     // INY
    w[0x03] = 5; w[0xFF] = 5;      // shifted variants
    for (const b of [0x10,0x30,0x50,0x70,0x90,0xB0,0xD0,0xF0]) w[b] = 40; // branches
    // Safe inserts
    for (const b of [
        0xEA,0x1A,0x3A,0x5A,0x7A,0xDA,0xFA,
        0x08,0x48,0x58,0x78,0x9A,0xD8,0xF8,
        0x18,0x38,0xB8,
        0xA8,0xAA,0xBA,
        0x98,0x8A,0x68,
        0x80,0x82,0x89,0xC2,0xE2,
        0x44,0x64,
        0x14,0x34,0x54,0x74,0xD4,0xF4,
        0xA0,0xA2,0xA9,
        0x0C,0x1C,0x3C,0x5C,0x7C,0xDC,0xFC,
    ]) { if (w[b] < 11) w[b] = 11; }
    return w;
}

/**
 * Build inverse-CDF lookup table from soup weights.
 * Maps uniform u16 (0-65535) → biased byte (0-255).
 * Matches jax6502/mine_turtles_tiers.py::build_soup_lookup exactly.
 *
 * @returns {Uint8Array} 65536-entry lookup table
 */
export function buildSoupLookup() {
    const weights = buildSoupWeights();
    const total = weights.reduce((s, w) => s + w, 0);
    const cdf = new Float64Array(256);
    let cum = 0;
    for (let i = 0; i < 256; i++) {
        cum += weights[i] / total;
        cdf[i] = cum;
    }

    const lut = new Uint8Array(65536);
    let bi = 0;
    for (let i = 0; i < 65536; i++) {
        while (bi < 255 && cdf[bi] < (i + 0.5) / 65536) bi++;
        lut[i] = bi;
    }
    return lut;
}

/**
 * Apply Turtle's Tiers bias to raw BLAKE3 bytes.
 * Each raw byte is mapped: idx = raw * 257, clamped to 0-65535,
 * then looked up in the inverse-CDF table.
 *
 * @param {Uint8Array} raw - raw BLAKE3 output
 * @param {Uint8Array} lookup - from buildSoupLookup()
 * @returns {Uint8Array} biased bytes
 */
export function applyBias(raw, lookup) {
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
        const idx = Math.min(raw[i] * 257, 65535);
        out[i] = lookup[idx];
    }
    return out;
}

/**
 * Generate one biased cell: BLAKE3 → 24 raw bytes → bias → pad to 32.
 * Matches jax6502/mine_dfa.py::generate_cell exactly.
 *
 * @param {number} seed - 32-bit seed
 * @param {number} cellIndex - cell index
 * @param {Uint8Array} lookup - from buildSoupLookup()
 * @returns {Uint8Array} 32 bytes
 */
export function generateBiasedCell(seed, cellIndex, lookup) {
    const raw = blake3Cell(seed, cellIndex, 24);
    const biased = applyBias(raw, lookup);
    const padded = new Uint8Array(32);
    padded.set(biased);
    return padded;
}
