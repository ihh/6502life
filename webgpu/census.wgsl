// GPU cell hash shader: computes a 1-byte hash per cell for grid display.
// Hashes non-volatile memory (page 0 $00-$EF, pages 2-3 $200-$3FF),
// skipping registers ($F0-$FF) and stack ($100-$1FF).
// Output: one u32 per cell (only low byte used), packed for CPU readback.

struct CensusUniforms {
    n_cells: u32,
    cell_size: u32,
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> uni: CensusUniforms;
@group(0) @binding(1) var<storage, read> board: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_hashes: array<u32>;

fn read_byte(addr: u32) -> u32 {
    let word = board[addr / 4u];
    return (word >> ((addr % 4u) * 8u)) & 0xFFu;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let ci = gid.x;
    if (ci >= uni.n_cells) { return; }

    let base = ci * uni.cell_size;
    var h: u32 = 5381u;

    // Hash page 0: $00-$EF (240 bytes)
    for (var k = 0u; k < 240u; k++) {
        h = ((h * 33u) ^ read_byte(base + k));
    }
    // Hash pages 2-3: $200-$3FF (512 bytes)
    for (var k = 512u; k < 1024u; k++) {
        h = ((h * 33u) ^ read_byte(base + k));
    }

    out_hashes[ci] = 33u + (h % 94u);
}
