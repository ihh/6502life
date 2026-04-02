"""
Turtle's Tiers: fast GPU mining with linear-time replicator scanning.

The scanner walks instruction boundaries from byte 0, tracking:
- Which bytes we've seen (LDA/LAX, STA, INC/DEC) and their addresses
- Which variants are still viable at each point
- Safe-to-clobber flags (A, X, Y) based on what's been consumed
- Opcode boundaries for branch offset validation

When we hit a backward branch, we check if all components of ANY
variant are present in the loop body with correct addresses and offset.

Soup: "Turtle's Tiers" — DEX > INX > INY > DEY with shifted variants
as rare discoveries.
"""

from functools import partial
import jax
import jax.numpy as jnp
import numpy as np
import time
import sys

from .mine_blake3 import blake3_compress, IV, CHUNK_START, CHUNK_END, ROOT

# ── Turtle's Tiers soup weights ──────────────────────────────────────

SOUP_WEIGHTS = np.ones(256, dtype=np.float32)
SOUP_WEIGHTS[0x00] = 400   # zero/address
SOUP_WEIGHTS[0x04] = 100   # STA page
for b in [0xB5, 0x9D]: SOUP_WEIGHTS[b] = 200  # X load/store
for b in [0xB7, 0x99]: SOUP_WEIGHTS[b] = 63   # Y load/store
SOUP_WEIGHTS[0xCA] = 200   # DEX (common)
SOUP_WEIGHTS[0xE8] = 40    # INX
SOUP_WEIGHTS[0x88] = 7     # DEY
SOUP_WEIGHTS[0xC8] = 2     # INY
for b in [0x03, 0xFF]: SOUP_WEIGHTS[b] = 5  # shifted
for b in [0x10,0x30,0x50,0x70,0x90,0xB0,0xD0,0xF0]: SOUP_WEIGHTS[b] = 40  # branches
# Safe inserts
SAFE_INSERTS = [
    0xEA,0x1A,0x3A,0x5A,0x7A,0xDA,0xFA,  # NOPs
    0x08,0x48,0x58,0x78,0x9A,0xD8,0xF8,   # PHA PHP CLI SEI TXS CLD SED
    0x18,0x38,0xB8,                         # CLC SEC CLV
    0xA8,0xAA,0xBA,                         # TAY TAX TSX
    0x98,0x8A,0x68,                         # TYA TXA PLA
    0x80,0x82,0x89,0xC2,0xE2,              # undoc 2-byte NOPs imm
    0x44,0x64,                              # undoc 2-byte NOPs zpg
    0x14,0x34,0x54,0x74,0xD4,0xF4,         # undoc 2-byte NOPs zpx
    0xA0,0xA2,0xA9,                         # LDY# LDX# LDA#
    0x0C,0x1C,0x3C,0x5C,0x7C,0xDC,0xFC,   # undoc 3-byte NOPs
]
for b in SAFE_INSERTS:
    if SOUP_WEIGHTS[b] < 11:
        SOUP_WEIGHTS[b] = 11


def build_soup_lookup():
    """Build inverse-CDF lookup table from per-byte weights."""
    total = float(SOUP_WEIGHTS.sum())
    cdf = np.cumsum(SOUP_WEIGHTS / total)
    lut = np.zeros(65536, dtype=np.uint8)
    bi = 0
    for i in range(65536):
        while bi < 255 and cdf[bi] < (i + 0.5) / 65536:
            bi += 1
        lut[i] = bi
    return jnp.array(lut, dtype=jnp.uint8)


# ── BLAKE3 ────────────────────────────────────────────────────────────

def blake3_cell(seed, cell_index):
    """BLAKE3(seed || cell_index) → 32 bytes (8 uint32 words)."""
    msg = jnp.zeros(16, dtype=jnp.uint32)
    msg = msg.at[0].set(seed)
    msg = msg.at[1].set(cell_index)
    flags = CHUNK_START | CHUNK_END | ROOT
    out = blake3_compress(msg, IV, jnp.uint32(0), jnp.uint32(8), flags)
    return out.view(jnp.uint8)  # 32 bytes


def apply_soup(raw_bytes, lookup):
    """Map raw BLAKE3 bytes through soup distribution."""
    indices = raw_bytes.astype(jnp.uint32) * 257
    indices = jnp.clip(indices, 0, 65535)
    return lookup[indices]


# ── Instruction length table ─────────────────────────────────────────

_ilen = np.ones(256, dtype=np.int32)
# 2-byte
for op in [0x09,0x29,0x49,0x69,0xA0,0xA2,0xA9,0xC0,0xC9,0xE0,0xE9,
           0x05,0x06,0x24,0x25,0x26,0x45,0x46,0x65,0x66,0x84,0x85,
           0x86,0xA4,0xA5,0xA6,0xC4,0xC5,0xC6,0xE4,0xE5,0xE6,
           0x15,0x16,0x35,0x36,0x55,0x56,0x75,0x76,0x94,0x95,
           0xB4,0xB5,0xD5,0xD6,0xF5,0xF6,0x96,0xB6,
           0x10,0x30,0x50,0x70,0x90,0xB0,0xD0,0xF0,
           0x01,0x21,0x41,0x61,0x81,0xA1,0xC1,0xE1,
           0x11,0x31,0x51,0x71,0x91,0xB1,0xD1,0xF1,
           0x80,0x82,0x89,0xC2,0xE2,0x04,0x44,0x64,
           0x14,0x34,0x54,0x74,0xD4,0xF4,
           0xA7,0xB7,0x87,0x97,0xC7,0xD7,0xC3,0xD3,
           0xE7,0xF7,0xE3,0xF3,0x07,0x17,0x03,0x13,
           0x27,0x37,0x23,0x33,0x47,0x57,0x43,0x53,
           0x67,0x77,0x63,0x73,0x0B,0x2B,0x4B,0x6B,
           0xAB,0x8B,0xCB,0xEB,0x00]: _ilen[op] = 2
for op in [0x0D,0x0E,0x20,0x2C,0x2D,0x2E,0x4C,0x4D,0x4E,0x6C,
           0x6D,0x6E,0x8C,0x8D,0x8E,0xAC,0xAD,0xAE,0xCC,0xCD,
           0xCE,0xEC,0xED,0xEE,0x1D,0x1E,0x3D,0x3E,0x5D,0x5E,
           0x7D,0x7E,0x9D,0xBC,0xBD,0xDD,0xDE,0xFD,0xFE,
           0x19,0x39,0x59,0x79,0x99,0xB9,0xBE,0xD9,0xF9,
           0x0C,0x1C,0x3C,0x5C,0x7C,0xDC,0xFC,
           0x0F,0x1F,0x1B,0x2F,0x3F,0x3B,0x4F,0x5F,0x5B,
           0x6F,0x7F,0x7B,0xAF,0xBF,0xB3,0x8F,0x83,
           0xCF,0xDF,0xDB,0xEF,0xFF,0xFB,
           0x9F,0x93,0x9B,0x9C,0x9E,0xBB]: _ilen[op] = 3
for op in [0x02,0x12,0x22,0x32,0x42,0x52,0x62,0x72,
           0x92,0xB2,0xD2,0xF2]: _ilen[op] = 0
ILEN = _ilen


# ── CPU scanner: linear-time replicator detection ─────────────────────

BRANCH_SET = {0x10,0x30,0x50,0x70,0x90,0xB0,0xD0,0xF0}

def scan_cell(cell):
    """Walk instruction boundaries, detect all viable replicator cores.

    Returns the first match found, or None.

    At each backward branch, checks whether the loop body contains
    a complete copy-loop core (any of 6 variants × 3 rotations)
    with correct LDA/STA addresses and matching branch offset.
    """
    L = len(cell)

    # Parse instructions
    pc = 0
    instrs = []  # (pos, opcode, length)
    while pc < L:
        op = cell[pc]
        il = ILEN[op]
        if il == 0:
            break  # JAM
        if pc + il > L:
            break
        instrs.append((pc, op, il))
        pc += il

    # Safe insert opcodes (1-byte): harmless regardless of variant
    ALWAYS_SAFE_1B = {0xEA, 0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA,  # NOPs
                      0x08, 0x48, 0x58, 0x78, 0x9A, 0xD8, 0xF8}  # PHA PHP CLI SEI TXS CLD SED
    # Safe for X-family only (can clobber Y)
    SAFE_X_EXTRA = {0xA8, 0xC8, 0x88}  # TAY, INY, DEY
    # Safe for Y-family only (can clobber X)
    SAFE_Y_EXTRA = {0xAA, 0xBA, 0xE8, 0xCA}  # TAX, TSX, INX, DEX
    # Conditionally safe (kills specific branch types)
    SAFE_NO_BCS = {0x18}  # CLC — kills BCS
    SAFE_NO_BCC = {0x38}  # SEC — kills BCC
    SAFE_NO_BVS = {0xB8}  # CLV — kills BVS
    # 2-byte safe prefixes (consume next byte harmlessly)
    SAFE_2B_PREFIX = {0x80, 0x82, 0x89, 0xC2, 0xE2,  # undoc imm NOPs
                      0x04, 0x44, 0x64,              # undoc zpg NOPs
                      0x14, 0x34, 0x54, 0x74, 0xD4, 0xF4,  # undoc zpx NOPs
                      0xA0}  # LDY# (safe for X, clobbers Y)
    SAFE_2B_Y_ONLY = {0xA2}  # LDX# (clobbers X, safe for Y)
    # 3-byte safe prefixes
    SAFE_3B_PREFIX = {0x0C, 0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC}

    def is_insert_safe(op, il, family, branch_op):
        """Check if a non-core opcode is safe as an insert."""
        if op in ALWAYS_SAFE_1B:
            return True
        if family == 'X' and op in SAFE_X_EXTRA:
            return True
        if family == 'Y' and op in SAFE_Y_EXTRA:
            return True
        if op in SAFE_NO_BCS and branch_op != 0xB0:
            return True
        if op in SAFE_NO_BCC and branch_op != 0x90:
            return True
        if op in SAFE_NO_BVS and branch_op != 0x70:
            return True
        if il == 2 and op in SAFE_2B_PREFIX:
            return True
        if il == 2 and op in SAFE_2B_Y_ONLY and family == 'Y':
            return True
        if il == 3 and op in SAFE_3B_PREFIX:
            return True
        return False

    # At each backward branch, analyze the loop
    for idx, (pos, op, il) in enumerate(instrs):
        if op not in BRANCH_SET:
            continue
        if pos + 1 >= L:
            continue
        offset_byte = cell[pos + 1]
        signed_off = offset_byte - 256 if offset_byte >= 128 else offset_byte
        target = pos + 2 + signed_off
        if target < 0 or target >= pos:
            continue  # not backward

        # Collect loop body instructions
        loop_body = [(p, o, il2) for p, o, il2 in instrs if target <= p <= pos]

        # Check all variant families
        for lda_op, sta_op, inc_ops, family in [
            (0xB5, 0x9D, {0xE8, 0xCA}, 'X'),
            (0xB7, 0x99, {0xC8, 0x88}, 'Y'),
        ]:
            core_ops = {lda_op, sta_op} | inc_ops

            # Find components (any order = any rotation)
            lda_positions = []
            sta_positions = []
            inc_positions = []

            for p, o, il2 in loop_body:
                if o == lda_op and il2 == 2 and p + 1 < L:
                    lda_positions.append((p, cell[p + 1]))
                elif o == sta_op and il2 == 3 and p + 2 < L:
                    sta_positions.append((p, cell[p + 1], cell[p + 2]))
                elif o in inc_ops:
                    inc_positions.append((p, o))

            for lda_pos, lda_addr in lda_positions:
                for sta_pos, sta_lo, sta_hi in sta_positions:
                    for inc_pos, inc_op in inc_positions:
                        # Check addresses
                        addr_ok = False
                        shifted = False
                        if lda_addr == 0x00 and sta_lo == 0x00 and sta_hi == 0x04:
                            addr_ok = True
                        elif lda_addr == 0x00 and sta_lo == 0xFF and sta_hi == 0x03:
                            addr_ok = True
                            shifted = True
                        if not addr_ok:
                            continue

                        loop_start = target
                        earliest = min(lda_pos, sta_pos, inc_pos)
                        if loop_start > earliest:
                            continue

                        # Check insert safety with rotation-aware A-clobber check.
                        # In the cyclic loop, A must survive from LDA to STA.
                        # Between STA and LDA (the other arc), A can be clobbered.
                        # Also: nothing should clobber the index register (X or Y).
                        CLOBBERS_A = {0x98, 0x8A, 0x68, 0xA9,  # TYA TXA PLA LDA#
                                      0xB5, 0xB7,              # LDA zpx, LAX zpy (re-loads)
                                      0x69, 0xE9, 0x29, 0x09, 0x49}  # ADC SBC AND ORA EOR
                        CLOBBERS_X = {0xAA, 0xBA, 0xA2, 0xCA, 0xE8}  # TAX TSX LDX# DEX INX
                        CLOBBERS_Y = {0xA8, 0xA0, 0xC8, 0x88}  # TAY LDY# INY DEY

                        # Determine which positions are "between LDA and STA" cyclically
                        # In the loop body sorted by position, the cyclic order is:
                        # [...lda...sta...] or [...sta...lda...] depending on rotation
                        loop_positions = sorted(p2 for p2, _, _ in loop_body)

                        def is_between_cyclic(test_pos, start, end, positions):
                            """Is test_pos between start and end going forward cyclically?"""
                            if start <= end:
                                return start < test_pos < end
                            else:  # wraps around
                                return test_pos > start or test_pos < end

                        core_positions = {lda_pos, sta_pos, inc_pos}
                        all_safe = True
                        for p2, o2, il2 in loop_body:
                            if p2 in core_positions or p2 == pos:
                                continue
                            if not is_insert_safe(o2, il2, family, op):
                                all_safe = False
                                break
                            # Check A-clobber: fatal only between LDA→STA (the arc where A carries data)
                            # The matched LDA itself is excluded (it's in core_positions)
                            # But OTHER LDA/LAX instructions between our LDA and STA kill the value
                            if o2 in CLOBBERS_A:
                                if is_between_cyclic(p2, lda_pos, sta_pos, loop_positions):
                                    all_safe = False
                                    break
                            # Check index register clobber (always fatal)
                            if family == 'X' and o2 in CLOBBERS_X and o2 not in inc_ops:
                                all_safe = False
                                break
                            if family == 'Y' and o2 in CLOBBERS_Y and o2 not in inc_ops:
                                all_safe = False
                                break
                        if not all_safe:
                            continue

                        inc_name = {0xE8:'INX',0xCA:'DEX',0xC8:'INY',0x88:'DEY'}[inc_op]
                        branch_name = {0x10:'BPL',0x30:'BMI',0x50:'BVC',0x70:'BVS',
                                       0x90:'BCC',0xB0:'BCS',0xD0:'BNE',0xF0:'BEQ'}[op]
                        prog = list(cell[target:pos + 2])
                        suffix = '-3FF' if shifted else ''
                        return {
                            'variant': f'{family}-{inc_name}{suffix}',
                            'branch': branch_name,
                            'program': prog,
                            'length': len(prog),
                            'pos': target,
                            'family': family,
                        }

    return None


# ── GPU screening + CPU verification pipeline ─────────────────────────

# GPU: generate 32 biased bytes per cell, quick-check for core byte density
CORE_MASK = np.zeros(256, dtype=np.bool_)
for b in [0x00,0x04,0xB5,0x9D,0xB7,0x99,0xE8,0xCA,0xC8,0x88,0x03,0xFF]:
    CORE_MASK[b] = True
CORE_MASK_JAX = jnp.array(CORE_MASK)


@partial(jax.jit, static_argnames=('board_size',))
def gpu_screen_board(seed, lookup, board_size=64):
    """GPU: generate biased cells, check for ≥5 core bytes in first 32."""
    n_cells = board_size * board_size

    def check_cell(ci):
        raw = blake3_cell(seed, ci)
        biased = apply_soup(raw, lookup)
        core_count = jnp.sum(CORE_MASK_JAX[biased.astype(jnp.int32)])
        return core_count >= 5

    matches = jax.vmap(check_cell)(jnp.arange(n_cells, dtype=jnp.uint32))
    return matches


# ── Main ──────────────────────────────────────────────────────────────

if __name__ == '__main__':
    try:
        sys.stdout = open(sys.stdout.fileno(), 'w', buffering=1)
    except OSError:
        pass

    import argparse
    parser = argparse.ArgumentParser(description="Turtle's Tiers replicator miner")
    parser.add_argument('--seeds', type=int, default=10000000)
    parser.add_argument('--board-size', type=int, default=64)
    parser.add_argument('--batch', type=int, default=32)
    args = parser.parse_args()

    B = args.board_size
    lookup = build_soup_lookup()
    lookup_np = np.array(lookup)

    print(f"Turtle's Tiers Miner")
    print(f"  Board: {B}×{B}, scanning {args.seeds} seeds")
    print(f"  Soup: wz=400 wf=100 wx=200 wy=63 wdx=200 wix=40 wdy=7 wiy=2 wb=40 wh=5 ws=11")
    print()

    # JIT warmup
    print('JIT warmup...', end=' ', flush=True)
    _ = gpu_screen_board(jnp.uint32(0), lookup, B)
    jax.block_until_ready(_)
    print('done', flush=True)

    t0 = time.time()
    total_seeds = 0
    total_gpu_hits = 0
    total_cpu_checks = 0
    total_viable = 0

    for start in range(0, args.seeds, args.batch):
        batch_end = min(start + args.batch, args.seeds)

        for seed in range(start, batch_end):
            # GPU screen
            matches = gpu_screen_board(jnp.uint32(seed), lookup, B)
            jax.block_until_ready(matches)
            hit_cells = np.where(np.asarray(matches))[0]
            total_gpu_hits += len(hit_cells)

            # CPU verify each GPU hit
            for ci in hit_cells:
                # Regenerate biased bytes for this cell
                raw = np.array(blake3_cell(jnp.uint32(seed), jnp.uint32(int(ci))))
                biased = lookup_np[(raw.astype(np.uint32) * 257).clip(0, 65535)]

                total_cpu_checks += 1
                match = scan_cell(biased)

                if match is not None:
                    elapsed = time.time() - t0
                    hex_prog = ' '.join(f'{b:02X}' for b in match['program'][:16])
                    ci_row, ci_col = int(ci) // B, int(ci) % B

                    # Simulate to confirm spread
                    from .train import simulate_candidate
                    result = simulate_candidate(match['program'], board_size=4)

                    status = 'VIABLE!' if result['viable'] else 'no spread'
                    print(f"  {'⭐' if result['viable'] else '  '} seed={seed} cell=({ci_row},{ci_col}) "
                          f"{match['variant']}/{match['branch']} L={match['length']} "
                          f"[{hex_prog}] spread={result['spread']} {status} "
                          f"({elapsed:.1f}s)", flush=True)

                    if result['viable']:
                        total_viable += 1
                        print(f"\n  ⭐⭐⭐ TURTLE'S TIERS: VIABLE REPLICATOR ⭐⭐⭐")
                        print(f"  Seed:    {seed}")
                        print(f"  Cell:    ({ci_row},{ci_col})")
                        print(f"  Variant: {match['variant']}")
                        print(f"  Branch:  {match['branch']}")
                        print(f"  Length:  {match['length']} bytes")
                        print(f"  Program: {hex_prog}")
                        print(f"  Spread:  {result['spread']}")
                        print(f"  Time:    {elapsed:.1f}s")
                        print(f"  Seeds:   {total_seeds}")
                        print()

            total_seeds += 1

        elapsed = time.time() - t0
        if (start // args.batch) % 100 == 0 and start > 0:
            rate = total_seeds / elapsed
            print(f"  {total_seeds} seeds, {rate:.0f}/s, "
                  f"{total_gpu_hits} GPU hits, {total_cpu_checks} CPU checks, "
                  f"{total_viable} viable, {elapsed:.0f}s", flush=True)

    elapsed = time.time() - t0
    print(f"\nDone: {total_seeds} seeds in {elapsed:.0f}s ({total_seeds/elapsed:.0f}/s)")
    print(f"GPU hits: {total_gpu_hits}, CPU checks: {total_cpu_checks}, Viable: {total_viable}")
