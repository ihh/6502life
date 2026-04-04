// DFA Miner: BLAKE3 → Turtle's Tiers bias → 18 parallel DFAs
// Each workgroup processes one seed, threads scan cells in parallel.

// Bindings:
//   group 0, binding 0: uniforms (seed_base, board_size, n_seeds)
//   group 0, binding 1: DFA tables [18][25][256] as u32
//   group 0, binding 2: soup bias LUT [65536] as u32 (packed 4 bytes)
//   group 0, binding 3: output hits [n_seeds] as u32

struct Uniforms {
    seed_base: u32,
    board_size: u32,
    n_seeds: u32,
    _pad: u32,
};

@group(0) @binding(0) var<uniform> uni: Uniforms;
@group(0) @binding(1) var<storage, read> dfa_tables: array<u32>;  // [18*25*256]
@group(0) @binding(2) var<storage, read> soup_lut: array<u32>;    // [16384] packed 4 bytes each
@group(0) @binding(3) var<storage, read_write> hits: array<u32>;

// ── BLAKE3 constants ────────────────────────────────────────────────

const B3_IV = array<u32, 8>(
    0x6A09E667u, 0xBB67AE85u, 0x3C6EF372u, 0xA54FF53Au,
    0x510E527Fu, 0x9B05688Cu, 0x1F83D9ABu, 0x5BE0CD19u
);

const B3_PERM = array<array<u32, 16>, 7>(
    array<u32,16>(0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15),
    array<u32,16>(2,6,3,10,7,0,4,13,1,11,12,5,9,14,15,8),
    array<u32,16>(3,4,10,12,13,2,7,14,6,5,9,0,11,15,8,1),
    array<u32,16>(10,7,12,9,14,3,13,15,4,0,11,2,5,8,1,6),
    array<u32,16>(12,13,9,11,15,10,14,8,7,2,5,3,0,1,6,4),
    array<u32,16>(9,14,11,5,8,12,15,1,13,3,0,10,2,6,4,7),
    array<u32,16>(11,15,5,0,1,9,8,6,14,10,2,12,3,4,7,13),
);

// ── BLAKE3 G function ───────────────────────────────────────────────

fn rotl32(x: u32, n: u32) -> u32 {
    return (x << n) | (x >> (32u - n));
}

fn b3_g(s: ptr<function, array<u32, 16>>, a: u32, b: u32, c: u32, d: u32, mx: u32, my: u32) {
    (*s)[a] = (*s)[a] + (*s)[b] + mx;
    (*s)[d] = rotl32((*s)[d] ^ (*s)[a], 16u);
    (*s)[c] = (*s)[c] + (*s)[d];
    (*s)[b] = rotl32((*s)[b] ^ (*s)[c], 12u);
    (*s)[a] = (*s)[a] + (*s)[b] + my;
    (*s)[d] = rotl32((*s)[d] ^ (*s)[a], 8u);
    (*s)[c] = (*s)[c] + (*s)[d];
    (*s)[b] = rotl32((*s)[b] ^ (*s)[c], 7u);
}

// ── BLAKE3 compress: single block ───────────────────────────────────

fn blake3_compress(seed: u32, cell_index: u32) -> array<u32, 8> {
    // Message: seed || cell_index || zeros (16 words)
    var msg: array<u32, 16>;
    msg[0] = seed;
    msg[1] = cell_index;
    // msg[2..15] = 0 (default)

    // Initial state
    var s: array<u32, 16>;
    s[0] = B3_IV[0]; s[1] = B3_IV[1]; s[2] = B3_IV[2]; s[3] = B3_IV[3];
    s[4] = B3_IV[4]; s[5] = B3_IV[5]; s[6] = B3_IV[6]; s[7] = B3_IV[7];
    s[8] = B3_IV[0]; s[9] = B3_IV[1]; s[10] = B3_IV[2]; s[11] = B3_IV[3];
    s[12] = 0u;     // counter
    s[13] = 0u;     // counter high
    s[14] = 8u;     // block_len
    s[15] = 11u;    // flags: CHUNK_START(1) | CHUNK_END(2) | ROOT(8)

    // 7 rounds
    for (var r = 0u; r < 7u; r++) {
        let p = B3_PERM[r];
        b3_g(&s, 0,4,8,12,  msg[p[0]], msg[p[1]]);
        b3_g(&s, 1,5,9,13,  msg[p[2]], msg[p[3]]);
        b3_g(&s, 2,6,10,14, msg[p[4]], msg[p[5]]);
        b3_g(&s, 3,7,11,15, msg[p[6]], msg[p[7]]);
        b3_g(&s, 0,5,10,15, msg[p[8]], msg[p[9]]);
        b3_g(&s, 1,6,11,12, msg[p[10]],msg[p[11]]);
        b3_g(&s, 2,7,8,13,  msg[p[12]],msg[p[13]]);
        b3_g(&s, 3,4,9,14,  msg[p[14]],msg[p[15]]);
    }

    // XOR finalization
    var out: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) {
        out[i] = s[i] ^ s[i + 8u];
    }
    return out;
}

// ── Bias lookup ─────────────────────────────────────────────────────

fn soup_lookup(raw_byte: u32) -> u32 {
    // raw * 257, clamped to 0-65535
    let idx = min(raw_byte * 257u, 65535u);
    // LUT is packed as u32 (4 bytes per entry), so we need byte-level access
    let word_idx = idx / 4u;
    let byte_idx = idx % 4u;
    let word = soup_lut[word_idx];
    return (word >> (byte_idx * 8u)) & 0xFFu;
}

// ── Generate biased cell (24 bytes → 6 u32 words) ──────────────────

fn generate_cell(seed: u32, cell_index: u32) -> array<u32, 6> {
    let raw = blake3_compress(seed, cell_index);
    // raw is 8 u32 = 32 bytes, we use first 24 bytes = 6 u32
    // Apply bias to each byte
    var biased: array<u32, 6>;
    for (var w = 0u; w < 6u; w++) {
        let word = raw[w];
        let b0 = soup_lookup(word & 0xFFu);
        let b1 = soup_lookup((word >> 8u) & 0xFFu);
        let b2 = soup_lookup((word >> 16u) & 0xFFu);
        let b3 = soup_lookup((word >> 24u) & 0xFFu);
        biased[w] = b0 | (b1 << 8u) | (b2 << 16u) | (b3 << 24u);
    }
    return biased;
}

// ── DFA scan ────────────────────────────────────────────────────────

const N_DFAS: u32 = 18u;
const N_STATES: u32 = 25u;
const ACCEPT: u32 = 9u;
const CELL_BYTES: u32 = 24u;

fn dfa_lookup(dfa_idx: u32, state: u32, byte_val: u32) -> u32 {
    // dfa_tables layout: [dfa_idx * N_STATES * 256 + state * 256 + byte_val]
    let idx = dfa_idx * N_STATES * 256u + state * 256u + byte_val;
    return dfa_tables[idx];
}

fn run_dfas_on_cell(cell: array<u32, 6>) -> bool {
    // Run all 18 DFAs in parallel on the 24-byte cell
    var states: array<u32, 18>;
    // Initial states: all 0

    // Process 24 bytes (6 words × 4 bytes)
    for (var w = 0u; w < 6u; w++) {
        let word = cell[w];
        for (var bi = 0u; bi < 4u; bi++) {
            let byte_val = (word >> (bi * 8u)) & 0xFFu;
            for (var d = 0u; d < N_DFAS; d++) {
                states[d] = dfa_lookup(d, states[d], byte_val);
            }
        }
    }

    // Also process 8 zero bytes (positions 24-31) to match JAX padding
    for (var z = 0u; z < 8u; z++) {
        for (var d = 0u; d < N_DFAS; d++) {
            states[d] = dfa_lookup(d, states[d], 0u);
        }
    }

    // Check if any DFA accepted
    for (var d = 0u; d < N_DFAS; d++) {
        if (states[d] == ACCEPT) { return true; }
    }
    return false;
}

// ── Main compute shader ─────────────────────────────────────────────

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let seed_offset = gid.x;
    if (seed_offset >= uni.n_seeds) { return; }

    let seed = uni.seed_base + seed_offset;
    let n_cells = uni.board_size * uni.board_size;
    var found = false;

    for (var ci = 0u; ci < n_cells; ci++) {
        if (found) { break; }
        let cell = generate_cell(seed, ci);
        if (run_dfas_on_cell(cell)) {
            found = true;
        }
    }

    if (found) {
        hits[seed_offset] = 1u;
    } else {
        hits[seed_offset] = 0u;
    }
}
