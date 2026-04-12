// Core Pattern Miner: BLAKE3 → Turtle's Tiers bias → 6-byte pattern scan
// Scans for replicator core sequences (no branch required).
// CPU-side simulation verifies whether accidental loops make them viable.

// Bindings:
//   group 0, binding 0: uniforms (seed_base, board_size, n_seeds)
//   group 0, binding 1: soup bias LUT [65536] as u32 (packed 4 bytes)
//   group 0, binding 2: output hits [n_seeds] as u32

struct Uniforms {
    seed_base: u32,
    board_size: u32,
    n_seeds: u32,
    _pad: u32,
};

@group(0) @binding(0) var<uniform> uni: Uniforms;
@group(0) @binding(1) var<storage, read> soup_lut: array<u32>;    // [16384] packed 4 bytes each
@group(0) @binding(2) var<storage, read_write> hits: array<u32>;

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
    var msg: array<u32, 16>;
    msg[0] = seed;
    msg[1] = cell_index;

    var s: array<u32, 16>;
    s[0] = B3_IV[0]; s[1] = B3_IV[1]; s[2] = B3_IV[2]; s[3] = B3_IV[3];
    s[4] = B3_IV[4]; s[5] = B3_IV[5]; s[6] = B3_IV[6]; s[7] = B3_IV[7];
    s[8] = B3_IV[0]; s[9] = B3_IV[1]; s[10] = B3_IV[2]; s[11] = B3_IV[3];
    s[12] = 0u;     // counter
    s[13] = 0u;     // counter high
    s[14] = 8u;     // block_len
    s[15] = 11u;    // flags: CHUNK_START(1) | CHUNK_END(2) | ROOT(8)

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

    var out: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) {
        out[i] = s[i] ^ s[i + 8u];
    }
    return out;
}

// ── Bias lookup ─────────────────────────────────────────────────────

fn soup_lookup(raw_byte: u32) -> u32 {
    let idx = min(raw_byte * 257u, 65535u);
    let word_idx = idx / 4u;
    let byte_idx = idx % 4u;
    let word = soup_lut[word_idx];
    return (word >> (byte_idx * 8u)) & 0xFFu;
}

// ── Generate biased cell (24 bytes → 6 u32 words) ──────────────────

fn generate_cell(seed: u32, cell_index: u32) -> array<u32, 6> {
    let raw = blake3_compress(seed, cell_index);
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

// ── 6-byte core pattern scan ────────────────────────────────────────
// Checks for replicator core patterns at any position in 24 biased bytes.
// 18 patterns: 6 variants × 3 rotations (X/Y × $0400/$03FF × inc/dec)
//
// Pattern encoding: each pattern is 6 bytes packed as lo (bytes 0-3) + hi (bytes 4-5).
// Stored as two constant arrays indexed by pattern number.

const N_PATTERNS: u32 = 18u;

// Bytes 0-3 of each pattern (little-endian u32)
const PAT_LO = array<u32, 18>(
    // X, $0400:  rot0         rot1         rot2
    0x009D00B5u, 0xCA04009Du, 0x9D00B5CAu,  // DEX
    0x009D00B5u, 0xE804009Du, 0x9D00B5E8u,  // INX
    // Y, $0400:
    0x009900B7u, 0x88040099u, 0x9900B788u,  // DEY
    0x009900B7u, 0xC8040099u, 0x9900B7C8u,  // INY
    // X, $03FF (INX only):
    0xFF9D00B5u, 0xE803FF9Du, 0x9D00B5E8u,  // INX3FF
    // Y, $03FF (INY only):
    0xFF9900B7u, 0xC803FF99u, 0x9900B7C8u,  // INY3FF
);

// Bytes 4-5 of each pattern (u16 in low bits)
const PAT_HI = array<u32, 18>(
    0xCA04u, 0x00B5u, 0x0400u,  // DEX
    0xE804u, 0x00B5u, 0x0400u,  // INX
    0x8804u, 0x00B7u, 0x0400u,  // DEY
    0xC804u, 0x00B7u, 0x0400u,  // INY
    0xE803u, 0x00B5u, 0x03FFu,  // INX3FF
    0xC803u, 0x00B7u, 0x03FFu,  // INY3FF
);

fn get_byte(cell: array<u32, 6>, pos: u32) -> u32 {
    return (cell[pos / 4u] >> ((pos % 4u) * 8u)) & 0xFFu;
}

// Extract 4 bytes starting at pos as a u32 (little-endian)
fn extract_u32_at(cell: array<u32, 6>, pos: u32) -> u32 {
    let w = pos / 4u;
    let b = pos % 4u;
    if (b == 0u) { return cell[w]; }
    return (cell[w] >> (b * 8u)) | (cell[w + 1u] << ((4u - b) * 8u));
}

// Extract 2 bytes starting at pos as a u16
fn extract_u16_at(cell: array<u32, 6>, pos: u32) -> u32 {
    let w = pos / 4u;
    let b = pos % 4u;
    if (b <= 2u) {
        return (cell[w] >> (b * 8u)) & 0xFFFFu;
    }
    // b == 3: straddles two words
    return ((cell[w] >> 24u) | (cell[w + 1u] << 8u)) & 0xFFFFu;
}

// Check for BCC/BVC + valid backward offset, or JMP to core
fn has_valid_loop(cell: array<u32, 6>, core_pos: u32) -> bool {
    // Scan from core position to end for BCC(0x90)/BVC(0x50) + offset 0xE0-0xF8
    for (var k = core_pos; k < 22u; k++) {
        let b = get_byte(cell, k);
        if ((b == 0x90u || b == 0x50u) && k + 1u < 24u) {
            let off = get_byte(cell, k + 1u);
            if (off >= 0xE0u && off <= 0xF8u) { return true; }
        }
        // JMP abs to address at or before the core
        if (b == 0x4Cu && k + 2u < 24u) {
            let target = get_byte(cell, k + 1u) | (get_byte(cell, k + 2u) << 8u);
            if (target <= core_pos + 5u) { return true; }
        }
    }
    return false;
}

fn scan_core_patterns(cell: array<u32, 6>) -> bool {
    for (var pos = 0u; pos <= 18u; pos++) {
        let lo = extract_u32_at(cell, pos);
        let hi = extract_u16_at(cell, pos + 4u);
        for (var p = 0u; p < N_PATTERNS; p++) {
            if (lo == PAT_LO[p] && hi == PAT_HI[p]) {
                if (has_valid_loop(cell, pos)) { return true; }
            }
        }
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
        if (scan_core_patterns(cell)) {
            found = true;
        }
    }

    if (found) {
        hits[seed_offset] = 1u;
    } else {
        hits[seed_offset] = 0u;
    }
}
