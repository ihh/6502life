// GPU cell hash shader: 6-bit parity hash per cell for grid display.
// Each bit = parity (XOR fold) of a memory region.
// Bit 5 (MSB) = $80-$F8, bit 4 = $10-$7F, bit 3 = $00-$0F (zero page identity)
// Bit 2 = $300-$3FF, bit 1 = $200-$2FF, bit 0 = $100-$1FF (stack)
// Result + 63 → ASCII 63-126. Excludes register bytes $F9-$FF.

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

// XOR all bytes in [base+lo, base+hi], fold to single parity bit
fn region_parity(base: u32, lo: u32, hi: u32) -> u32 {
    var x: u32 = 0u;
    for (var k = lo; k <= hi; k++) {
        x ^= read_byte(base + k);
    }
    x ^= x >> 4u;
    x ^= x >> 2u;
    x ^= x >> 1u;
    return x & 1u;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let ci = gid.x;
    if (ci >= uni.n_cells) { return; }

    let base = ci * uni.cell_size;

    let h = region_parity(base, 0x100u, 0x1FFu)         // bit 0: stack
          | (region_parity(base, 0x200u, 0x2FFu) << 1u)  // bit 1
          | (region_parity(base, 0x300u, 0x3FFu) << 2u)  // bit 2
          | (region_parity(base, 0x00u, 0x0Fu) << 3u)    // bit 3: zp low
          | (region_parity(base, 0x10u, 0x7Fu) << 4u)    // bit 4: zp mid
          | (region_parity(base, 0x80u, 0xF8u) << 5u);   // bit 5: zp high

    out_hashes[ci] = 63u + h;
}
