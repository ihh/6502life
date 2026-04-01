"""
NOP Soup Miner: find viable replicators in BLAKE3-seeded biased boards.

Soup specification:
  - BLAKE3(seed || cell_index) → 24 raw bytes per cell
  - Each raw byte mapped through biased distribution:
    13 elevated bytes at weight W, 243 background bytes at weight 1
  - Elevated set ("NOP soup"): the 12 core opcode bytes + F8 (SED/offset)
  - DFA walks instruction boundaries, finds backward branches, checks
    for complete copy-loop cores with correct branch offset
  - Simulation confirms spread on 4×4 board

The NOP Soup elevated byte set (13 bytes):
  0x00  BRK / address operand (appears 2× in core)
  0x04  STA high address byte (page 4)
  0x50  BVC (branch opcode)
  0x88  DEY (Y-family decrement)
  0x90  BCC (branch opcode)
  0x99  STA abs,Y (Y-family store)
  0x9D  STA abs,X (X-family store)
  0xB5  LDA zpx (X-family load)
  0xB7  LAX zpy (Y-family load)
  0xC8  INY (Y-family increment)
  0xCA  DEX (X-family decrement)
  0xE8  INX (X-family increment)
  0xF8  SED (branch offset for bare 8-byte core = 0xF8 = -8)

Usage:
  python -m jax6502.mine_nopsoup [--bias 255] [--seeds 1000000]
"""

from functools import partial
import jax
import jax.numpy as jnp
import numpy as np
import time
import sys
import argparse

from .mine_blake3 import blake3_compress, IV, CHUNK_START, CHUNK_END, ROOT

# ── NOP Soup specification ────────────────────────────────────────────

# Rich NOP Soup: 42 elevated bytes
# Core opcodes (12): 00 04 50 88 90 99 9D B5 B7 C8 CA E8
# Safe inserts (12): EA 08 18 48 58 78 A8 B8 D8 F8 9A A0
# Undocumented NOPs (6): 1A 3A 5A 7A DA FA
# Branch offset bytes for cores up to 20 bytes (12): EB-F8 minus F2(JAM)
#   F8=L8, F7=L9, F6=L10, ..., F0=L16, EF=L17, EE=L18, ED=L19, EC=L20, EB=L21
NOP_SOUP_ELEVATED = sorted(set([
    # Core opcodes
    0x00, 0x04, 0x50, 0x88, 0x90, 0x99, 0x9D, 0xB5, 0xB7, 0xC8, 0xCA, 0xE8,
    # Safe inserts
    0x08, 0x18, 0x48, 0x58, 0x78, 0x9A, 0xA0, 0xA8, 0xB8, 0xD8, 0xEA, 0xF8,
    # Undocumented NOPs
    0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA,
    # Offset bytes for 9-21 byte cores (F7 down to EB, skip F2=JAM)
    0xF7, 0xF6, 0xF5, 0xF4, 0xF3, 0xF1, 0xF0, 0xEF, 0xEE, 0xED, 0xEC, 0xEB,
]))
NOP_SOUP_ELEVATED_SET = frozenset(NOP_SOUP_ELEVATED)
DEFAULT_BIAS_WEIGHT = 255


def build_lookup_table(bias_weight=DEFAULT_BIAS_WEIGHT, elevated=None):
    """Build inverse-CDF lookup for biased byte sampling (65536 entries)."""
    if elevated is None:
        elevated = NOP_SOUP_ELEVATED
    elev_set = set(elevated)
    N1 = len(elev_set)
    N0 = 256 - N1

    total = N1 * bias_weight + N0
    cdf = []
    cum = 0.0
    for b in range(256):
        p = bias_weight / total if b in elev_set else 1 / total
        cum += p
        cdf.append(cum)

    RESOLUTION = 65536
    lookup = np.zeros(RESOLUTION, dtype=np.uint8)
    bi = 0
    for i in range(RESOLUTION):
        target = (i + 0.5) / RESOLUTION
        while bi < 255 and cdf[bi] < target:
            bi += 1
        lookup[i] = bi
    return jnp.array(lookup, dtype=jnp.uint8)


# ── BLAKE3 → biased bytes ────────────────────────────────────────────

def blake3_24bytes(seed, cell_index):
    """BLAKE3(seed || cell_index) → 24 bytes."""
    msg = jnp.zeros(16, dtype=jnp.uint32)
    msg = msg.at[0].set(seed)
    msg = msg.at[1].set(cell_index)
    flags = CHUNK_START | CHUNK_END | ROOT
    out = blake3_compress(msg, IV, jnp.uint32(0), jnp.uint32(8), flags)
    return out[:6].view(jnp.uint8)  # 6 words = 24 bytes


def apply_bias(raw_bytes, lookup):
    """Map raw bytes through biased distribution."""
    indices = raw_bytes.astype(jnp.uint32) * 257
    indices = jnp.clip(indices, 0, 65535)
    return lookup[indices]


# ── DFA: reachable-loop core matcher ──────────────────────────────────
#
# The DFA walks instruction boundaries from PC=0 and tracks whether
# we've seen the components of a copy loop core (in any order within
# the current loop). When we see a backward branch, we check if all
# components are present with correct addresses and offset.
#
# For GPU efficiency, we use a simplified 2-pass approach:
# Pass 1 (GPU): check if the 8-byte bare core appears at any position
#   accessible from PC=0 via valid instruction boundaries
# Pass 2 (CPU): verify offset and simulate (only for pass-1 matches)

# 6502 instruction lengths (0 = JAM)
INST_LEN = np.zeros(256, dtype=np.int32)
INST_LEN[:] = 1  # default: 1-byte implied
# 2-byte instructions
for op in [0x09,0x29,0x49,0x69,0xA0,0xA2,0xA9,0xC0,0xC9,0xE0,0xE9,
           0x05,0x06,0x24,0x25,0x26,0x45,0x46,0x65,0x66,0x84,0x85,
           0x86,0xA4,0xA5,0xA6,0xC4,0xC5,0xC6,0xE4,0xE5,0xE6,
           0x15,0x16,0x35,0x36,0x55,0x56,0x75,0x76,0x94,0x95,
           0xB4,0xB5,0xD5,0xD6,0xF5,0xF6, 0x96,0xB6,
           0x10,0x30,0x50,0x70,0x90,0xB0,0xD0,0xF0,
           0x01,0x21,0x41,0x61,0x81,0xA1,0xC1,0xE1,
           0x11,0x31,0x51,0x71,0x91,0xB1,0xD1,0xF1,
           0x80,0x82,0x89,0xC2,0xE2, 0x04,0x44,0x64,
           0x14,0x34,0x54,0x74,0xD4,0xF4,
           0xA7,0xB7,0x87,0x97,0xC7,0xD7,0xC3,0xD3,
           0xE7,0xF7,0xE3,0xF3,0x07,0x17,0x03,0x13,
           0x27,0x37,0x23,0x33,0x47,0x57,0x43,0x53,
           0x67,0x77,0x63,0x73,0x0B,0x2B,0x4B,0x6B,
           0xAB,0x8B,0xCB,0xEB,0x00]:
    INST_LEN[op] = 2
# 3-byte instructions
for op in [0x0D,0x0E,0x20,0x2C,0x2D,0x2E,0x4C,0x4D,0x4E,0x6C,
           0x6D,0x6E,0x8C,0x8D,0x8E,0xAC,0xAD,0xAE,0xCC,0xCD,
           0xCE,0xEC,0xED,0xEE,
           0x1D,0x1E,0x3D,0x3E,0x5D,0x5E,0x7D,0x7E,0x9D,0xBC,
           0xBD,0xDD,0xDE,0xFD,0xFE,
           0x19,0x39,0x59,0x79,0x99,0xB9,0xBE,0xD9,0xF9,
           0x0C,0x1C,0x3C,0x5C,0x7C,0xDC,0xFC,
           0x0F,0x1F,0x1B,0x2F,0x3F,0x3B,0x4F,0x5F,0x5B,
           0x6F,0x7F,0x7B,0xAF,0xBF,0xB3,0x8F,0x83,
           0xCF,0xDF,0xDB,0xEF,0xFF,0xFB,
           0x9F,0x93,0x9B,0x9C,0x9E,0xBB]:
    INST_LEN[op] = 3
# JAM opcodes
for op in [0x02,0x12,0x22,0x32,0x42,0x52,0x62,0x72,0x92,0xB2,0xD2,0xF2]:
    INST_LEN[op] = 0

INST_LEN_JAX = jnp.array(INST_LEN, dtype=jnp.int32)
BRANCH_OPS = frozenset([0x10,0x30,0x50,0x70,0x90,0xB0,0xD0,0xF0])


def check_cell_cpu(biased_bytes):
    """Walk instruction boundaries from PC=0. At each backward branch,
    check if the loop body contains a complete copy-loop core (any rotation,
    any family, with safe inserts)."""
    cell = np.array(biased_bytes, dtype=np.uint8)
    L = len(cell)

    # Step 1: walk instruction boundaries, record each instruction
    instrs = []  # (pos, opcode, length)
    pc = 0
    while pc < L:
        op = cell[pc]
        ilen = INST_LEN[op]
        if ilen == 0:
            break
        if pc + ilen > L:
            break
        instrs.append((pc, op, ilen))
        pc += ilen

    # Step 2: at each backward branch, analyze the loop body
    INC_NAMES = {0xE8:'INX', 0xCA:'DEX', 0xC8:'INY', 0x88:'DEY'}
    BRANCH_NAMES = {0x10:'BPL',0x30:'BMI',0x50:'BVC',0x70:'BVS',
                    0x90:'BCC',0xB0:'BCS',0xD0:'BNE',0xF0:'BEQ'}

    for i, (pos, op, ilen) in enumerate(instrs):
        if op not in BRANCH_OPS:
            continue
        if pos + 1 >= L:
            continue
        offset_byte = cell[pos + 1]
        signed_off = offset_byte - 256 if offset_byte >= 128 else offset_byte
        target = pos + 2 + signed_off
        if target < 0 or target >= pos:
            continue  # not a backward branch

        # Extract loop body instructions
        loop_instrs = [(p, o, il) for p, o, il in instrs if p >= target and p <= pos]

        # Check for core components in the loop body
        for lda_op, sta_op, inc_ops, family in [
            (0xB5, 0x9D, (0xE8, 0xCA), 'X'),
            (0xB7, 0x99, (0xC8, 0x88), 'Y'),
        ]:
            has_lda = None  # (pos, operand)
            has_sta = None  # (pos, addr_lo, addr_hi)
            has_inc = None  # (pos, opcode)

            for p, o, il in loop_instrs:
                if o == lda_op and il == 2:
                    operand = cell[p + 1] if p + 1 < L else None
                    if operand == 0x00:
                        has_lda = p
                if o == sta_op and il == 3:
                    lo = cell[p + 1] if p + 1 < L else None
                    hi = cell[p + 2] if p + 2 < L else None
                    if lo == 0x00 and hi == 0x04:
                        has_sta = p
                if o in inc_ops:
                    has_inc = (p, o)

            if has_lda is not None and has_sta is not None and has_inc is not None:
                # Complete core found! The branch target just needs to be at
                # or before the earliest core instruction. Safe inserts (NOPs etc)
                # between the target and the first core opcode form a "NOP slide."
                earliest_core = min(has_lda, has_sta, has_inc[0])
                if target <= earliest_core:
                    inc_name = INC_NAMES[has_inc[1]]
                    branch_name = BRANCH_NAMES[op]
                    loop_bytes = list(cell[target:pos + 2])
                    return {
                        'pos': target,
                        'family': family,
                        'program': loop_bytes,
                        'inc': inc_name,
                        'branch': branch_name,
                        'offset': offset_byte,
                        'length': pos + 2 - target,
                        'lda_pos': has_lda,
                        'sta_pos': has_sta,
                        'inc_pos': has_inc[0],
                    }
    return None


# ── GPU-accelerated screening ─────────────────────────────────────────

# Simple 7-byte pattern match on GPU (catches rotation 0 bare cores)
PATTERN_BYTES = jnp.array([0xB5, 0x00, 0x9D, 0x00, 0x04], dtype=jnp.uint8)


# Bitmask: is this byte value a core opcode?
_core_mask = np.zeros(256, dtype=np.bool_)
for b in [0xB5, 0xB7, 0x9D, 0x99, 0x04, 0x00, 0xE8, 0xCA, 0xC8, 0x88, 0x90, 0x50]:
    _core_mask[b] = True
CORE_MASK = jnp.array(_core_mask)

def gpu_quick_check(biased_bytes):
    """GPU-side: does this cell have ≥5 core opcode bytes in first 24?
    Uses a lookup table instead of nested vmap."""
    core_count = jnp.sum(CORE_MASK[biased_bytes.astype(jnp.int32)])
    return core_count >= 5


@partial(jax.jit, static_argnames=('board_size',))
def scan_board_gpu(seed, lookup, board_size=64):
    """GPU: generate biased bytes for all cells, quick-check for core prefix."""
    n_cells = board_size * board_size
    cell_indices = jnp.arange(n_cells, dtype=jnp.uint32)

    def check_cell(ci):
        raw = blake3_24bytes(seed, ci)
        biased = apply_bias(raw, lookup)
        return gpu_quick_check(biased)

    matches = jax.vmap(check_cell)(cell_indices)
    return jnp.any(matches), matches


@partial(jax.jit, static_argnames=('board_size',))
def scan_batch_gpu(seeds, lookup, board_size=64):
    """GPU: check batch of seeds."""
    def check_one(seed):
        hit, _ = scan_board_gpu(seed, lookup, board_size)
        return hit
    return jax.vmap(check_one)(seeds)


# ── Main mining loop ──────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='NOP Soup replicator miner')
    parser.add_argument('--bias', type=int, default=255)
    parser.add_argument('--board-size', type=int, default=64)
    parser.add_argument('--seeds', type=int, default=10000000)
    parser.add_argument('--batch', type=int, default=64)
    parser.add_argument('--start', type=int, default=0)
    args = parser.parse_args()

    B = args.board_size
    lookup = build_lookup_table(args.bias, NOP_SOUP_ELEVATED)

    print(f'NOP Soup Miner')
    print(f'  Board: {B}×{B} = {B*B} cells')
    print(f'  biasWeight: {args.bias}')
    print(f'  Elevated bytes ({len(NOP_SOUP_ELEVATED)}): {" ".join(f"{b:02X}" for b in NOP_SOUP_ELEVATED)}')
    print(f'  Scanning {args.seeds} seeds from {args.start}')
    print()

    # JIT warmup
    print('JIT warmup...', end=' ', flush=True)
    _ = scan_batch_gpu(jnp.arange(args.batch, dtype=jnp.uint32), lookup, B)
    jax.block_until_ready(_)
    print('done')

    # Precompute numpy lookup for CPU-side checks
    lookup_np = np.array(lookup)

    found_viable = []
    total_scanned = 0
    gpu_hits = 0
    t0 = time.time()

    for start in range(args.start, args.start + args.seeds, args.batch):
        seeds = jnp.arange(start, min(start + args.batch, args.start + args.seeds),
                           dtype=jnp.uint32)
        batch_hits = scan_batch_gpu(seeds, lookup, B)
        jax.block_until_ready(batch_hits)

        hit_indices = np.where(np.asarray(batch_hits))[0]

        for idx in hit_indices:
            seed_val = int(seeds[idx])
            gpu_hits += 1

            # CPU-side: regenerate cells and do full check
            _, cell_matches = scan_board_gpu(jnp.uint32(seed_val), lookup, B)
            match_cells = np.where(np.asarray(cell_matches))[0]

            for ci_flat in match_cells[:10]:
                # Regenerate biased bytes
                raw = np.array(blake3_24bytes(jnp.uint32(seed_val), jnp.uint32(int(ci_flat))))
                biased = lookup_np[(raw.astype(np.uint32) * 257).clip(0, 65535)]

                # Full CPU check with offset verification
                match = check_cell_cpu(biased)
                if match is None:
                    continue

                ci, cj = int(ci_flat) // B, int(ci_flat) % B
                elapsed = time.time() - t0
                rate = total_scanned / max(elapsed, 0.001)
                hex_prog = ' '.join(f'{b:02X}' for b in match['program'])

                # Simulate!
                from .train import simulate_candidate
                result = simulate_candidate(match['program'], board_size=4)

                status = '⭐ VIABLE!' if result['viable'] else '✗ no spread'
                print(f'  [{elapsed:.1f}s] seed={seed_val} cell=({ci},{cj}) '
                      f'{match["family"]}-family {match["inc"]}/{match["branch"]} '
                      f'rot={match.get("rotation", 0)} '
                      f'[{hex_prog}] '
                      f'spread={result["spread"]} {status} '
                      f'({total_scanned} scanned, {rate:.0f}/s, {gpu_hits} GPU hits)')

                if result['viable']:
                    found_viable.append({
                        'seed': seed_val,
                        'cell': (ci, cj),
                        'cell_flat': int(ci_flat),
                        'program': match['program'],
                        'family': match['family'],
                        'inc': match['inc'],
                        'branch': match['branch'],
                        'spread': result['spread'],
                    })
                    print(f'\n  ⭐⭐⭐ VIABLE REPLICATOR FOUND ⭐⭐⭐')
                    print(f'  Seed: {seed_val}')
                    print(f'  Cell: ({ci},{cj}) (flat index {ci_flat})')
                    print(f'  Program: {hex_prog}')
                    print(f'  Family: {match["family"]}-indexed')
                    print(f'  Loop: {match["inc"]}/{match["branch"]}')
                    print(f'  Spread: {result["spread"]} cells')
                    print()

        total_scanned += len(seeds)

        if total_scanned % (args.batch * 100) == 0:
            elapsed = time.time() - t0
            rate = total_scanned / max(elapsed, 0.001)
            print(f'  {total_scanned}/{args.seeds} seeds, {rate:.0f}/s, '
                  f'{gpu_hits} GPU hits, {len(found_viable)} viable, '
                  f'{elapsed:.1f}s', flush=True)

        if found_viable:
            break

    elapsed = time.time() - t0
    rate = total_scanned / max(elapsed, 0.001)
    print(f'\nDone: {total_scanned} seeds in {elapsed:.1f}s ({rate:.0f}/s)')
    print(f'GPU hits: {gpu_hits}')
    print(f'Viable: {len(found_viable)}')

    if found_viable:
        v = found_viable[0]
        print(f'\n{"="*60}')
        print(f'NOP SOUP REPLICATOR')
        print(f'{"="*60}')
        print(f'Seed:    {v["seed"]}')
        print(f'Cell:    ({v["cell"][0]},{v["cell"][1]})')
        print(f'Program: {" ".join(f"{b:02X}" for b in v["program"])}')
        print(f'Family:  {v["family"]}-indexed')
        print(f'Loop:    {v["inc"]}/{v["branch"]}')
        print(f'Spread:  {v["spread"]} cells')
        print(f'{"="*60}')
        print(f'\nSoup spec:')
        print(f'  Hash: BLAKE3(seed={v["seed"]} || cell_index={v["cell"][0]*B+v["cell"][1]})')
        print(f'  Bias: weight={args.bias}, elevated={{{", ".join(f"0x{b:02X}" for b in NOP_SOUP_ELEVATED)}}}')
        print(f'  Board: {B}×{B}')
