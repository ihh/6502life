// K-mer soup GPU generator: BLAKE3 XOF → k-mer LUT → cell memory
//
// One workgroup thread per cell.  Each thread generates enough BLAKE3
// random u16 values to fill 0xF9 bytes of its cell via the k-mer LUT,
// leaving the register save area (0xF9-0xFF) zeroed.
//
// Bindings:
//   group 0, binding 0: uniforms { seed, board_size, n_kmers, _pad }
//   group 0, binding 1: kmer_lut   — u32[32768]: 65536 u16 entries packed 2 per u32
//   group 0, binding 2: kmer_data  — u32[n_kmers]: packed k-mer records
//                        bits [1:0]  = length-1 (0/1/2)
//                        bits [9:2]  = byte 0
//                        bits [17:10]= byte 1
//                        bits [25:18]= byte 2
//   group 0, binding 3: storage    — u32[]: board memory (read-write)

struct Uniforms {
    seed: u32,
    board_size: u32,
    n_kmers: u32,
    _pad: u32,
};

@group(0) @binding(0) var<uniform> uni: Uniforms;
@group(0) @binding(1) var<storage, read> kmer_lut: array<u32>;
@group(0) @binding(2) var<storage, read> kmer_data: array<u32>;
@group(0) @binding(3) var<storage, read_write> board_mem: array<u32>;

// ── BLAKE3 ─────────────────────────────────────────────────────────────

const B3_IV = array<u32, 8>(
    0x6A09E667u, 0xBB67AE85u, 0x3C6EF372u, 0xA54FF53Au,
    0x510E527Fu, 0x9B05688Cu, 0x1F83D9ABu, 0x5BE0CD19u
);

fn rotl32(x: u32, n: u32) -> u32 { return (x << n) | (x >> (32u - n)); }

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

fn b3_round(s: ptr<function, array<u32, 16>>, msg: ptr<function, array<u32, 16>>, r: u32) {
    var m: array<u32, 16>;
    switch r {
        case 0u { m = array<u32,16>((*msg)[0],(*msg)[1],(*msg)[2],(*msg)[3],(*msg)[4],(*msg)[5],(*msg)[6],(*msg)[7],(*msg)[8],(*msg)[9],(*msg)[10],(*msg)[11],(*msg)[12],(*msg)[13],(*msg)[14],(*msg)[15]); }
        case 1u { m = array<u32,16>((*msg)[2],(*msg)[6],(*msg)[3],(*msg)[10],(*msg)[7],(*msg)[0],(*msg)[4],(*msg)[13],(*msg)[1],(*msg)[11],(*msg)[12],(*msg)[5],(*msg)[9],(*msg)[14],(*msg)[15],(*msg)[8]); }
        case 2u { m = array<u32,16>((*msg)[3],(*msg)[4],(*msg)[10],(*msg)[12],(*msg)[13],(*msg)[2],(*msg)[7],(*msg)[14],(*msg)[6],(*msg)[5],(*msg)[9],(*msg)[0],(*msg)[11],(*msg)[15],(*msg)[8],(*msg)[1]); }
        case 3u { m = array<u32,16>((*msg)[10],(*msg)[7],(*msg)[12],(*msg)[9],(*msg)[14],(*msg)[3],(*msg)[13],(*msg)[15],(*msg)[4],(*msg)[0],(*msg)[11],(*msg)[2],(*msg)[5],(*msg)[8],(*msg)[1],(*msg)[6]); }
        case 4u { m = array<u32,16>((*msg)[12],(*msg)[13],(*msg)[9],(*msg)[11],(*msg)[15],(*msg)[10],(*msg)[14],(*msg)[8],(*msg)[7],(*msg)[2],(*msg)[5],(*msg)[3],(*msg)[0],(*msg)[1],(*msg)[6],(*msg)[4]); }
        case 5u { m = array<u32,16>((*msg)[9],(*msg)[14],(*msg)[11],(*msg)[5],(*msg)[8],(*msg)[12],(*msg)[15],(*msg)[1],(*msg)[13],(*msg)[3],(*msg)[0],(*msg)[10],(*msg)[2],(*msg)[6],(*msg)[4],(*msg)[7]); }
        default { m = array<u32,16>((*msg)[11],(*msg)[15],(*msg)[5],(*msg)[0],(*msg)[1],(*msg)[9],(*msg)[8],(*msg)[6],(*msg)[14],(*msg)[10],(*msg)[2],(*msg)[12],(*msg)[3],(*msg)[4],(*msg)[7],(*msg)[13]); }
    }
    b3_g(s, 0,4,8,12,  m[0], m[1]);
    b3_g(s, 1,5,9,13,  m[2], m[3]);
    b3_g(s, 2,6,10,14, m[4], m[5]);
    b3_g(s, 3,7,11,15, m[6], m[7]);
    b3_g(s, 0,5,10,15, m[8], m[9]);
    b3_g(s, 1,6,11,12, m[10],m[11]);
    b3_g(s, 2,7,8,13,  m[12],m[13]);
    b3_g(s, 3,4,9,14,  m[14],m[15]);
}

// BLAKE3 compress: returns 32 bytes (8 u32) for the given seed+cell+counter.
fn blake3_compress(seed: u32, cell_index: u32, counter: u32) -> array<u32, 8> {
    var msg: array<u32, 16>;
    msg[0] = seed;
    msg[1] = cell_index;

    var s: array<u32, 16>;
    s[0] = B3_IV[0]; s[1] = B3_IV[1]; s[2] = B3_IV[2]; s[3] = B3_IV[3];
    s[4] = B3_IV[4]; s[5] = B3_IV[5]; s[6] = B3_IV[6]; s[7] = B3_IV[7];
    s[8] = B3_IV[0]; s[9] = B3_IV[1]; s[10] = B3_IV[2]; s[11] = B3_IV[3];
    s[12] = counter;
    s[13] = 0u;
    s[14] = 8u;    // block_len
    s[15] = 11u;   // flags: CHUNK_START|CHUNK_END|ROOT

    for (var r = 0u; r < 7u; r++) {
        b3_round(&s, &msg, r);
    }

    var out: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) { out[i] = s[i] ^ s[i + 8u]; }
    return out;
}

// ── K-mer LUT lookup ───────────────────────────────────────────────────

fn kmer_lookup(r16: u32) -> u32 {
    // kmer_lut packs two u16 per u32
    let word = kmer_lut[r16 >> 1u];
    return (word >> ((r16 & 1u) * 16u)) & 0xFFFFu;
}

// Write a single byte into storage (u32-packed, little-endian)
fn store_byte(base_word: u32, offset: u32, val: u32) {
    let word_idx = base_word + (offset >> 2u);
    let shift = (offset & 3u) * 8u;
    let mask = 0xFFu << shift;
    board_mem[word_idx] = (board_mem[word_idx] & ~mask) | ((val & 0xFFu) << shift);
}

// ── Main ───────────────────────────────────────────────────────────────

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let ci = gid.x;
    let n_cells = uni.board_size * uni.board_size;
    if (ci >= n_cells) { return; }

    let M = 1024u;
    let base_word = (ci * M) >> 2u;  // u32 offset in storage

    // Fill entire cell with k-mer soup
    var pos = 0u;
    var blake_ctr = 0u;
    var raw: array<u32, 8>;
    var raw_idx = 16u;  // force first BLAKE3 call

    while (pos < M) {
        // Refill 32 random bytes when exhausted (16 u16 values)
        if (raw_idx >= 16u) {
            raw = blake3_compress(uni.seed, ci, blake_ctr);
            blake_ctr++;
            raw_idx = 0u;
        }

        // Extract a 16-bit random value
        let word = raw[raw_idx >> 1u];
        let r16 = (word >> ((raw_idx & 1u) * 16u)) & 0xFFFFu;
        raw_idx++;

        // Look up k-mer
        let kmer_idx = kmer_lookup(r16);
        let kd = kmer_data[kmer_idx];
        let klen = (kd & 3u) + 1u;
        let b0 = (kd >> 2u) & 0xFFu;
        let b1 = (kd >> 10u) & 0xFFu;
        let b2 = (kd >> 18u) & 0xFFu;

        // Emit k-mer bytes
        if (pos < M) { store_byte(base_word, pos, b0); pos++; }
        if (klen >= 2u && pos < M) { store_byte(base_word, pos, b1); pos++; }
        if (klen >= 3u && pos < M) { store_byte(base_word, pos, b2); pos++; }
    }

    // Zero register save area (0xF9-0xFF)
    // 0xF8/4 = 62, byte offset 0 within that word → zero high byte of word 62,
    // all of word 63 (0xFC-0xFF)
    // Use store_byte for simplicity (only 7 bytes)
    for (var z = 0xF9u; z < 0x100u; z++) {
        store_byte(base_word, z, 0u);
    }
}
