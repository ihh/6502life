// GPU cell hash shader: djb2 of bytes $00-$14 for grid display.
// These 21 bytes are stable after replicator spread (include the program,
// not modified by execution). 6-bit hash + 63 → ASCII 63-126.

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

    for (var k = 0u; k <= 0x14u; k++) {
        h = ((h * 33u) ^ read_byte(base + k));
    }

    out_hashes[ci] = 63u + (h & 63u);
}
