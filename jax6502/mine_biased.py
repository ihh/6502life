"""
GPU-based mining with biased BLAKE3 init + DFA matching + simulation.

1. BLAKE3(seed || cell_index) → 16 raw bytes per cell
2. Map raw bytes through biased distribution (biasWeight + biasBytes)
3. Run DFA on the 16 biased bytes to detect replicator cores + inserts
4. Simulate any DFA matches on a small board to confirm spread

Usage:
    python -m jax6502.mine_biased --bias 64 --board-size 64 --seeds 100000
"""

from functools import partial
import jax
import jax.numpy as jnp
import numpy as np
import time
import sys
import argparse

try:
    sys.stdout = open(sys.stdout.fileno(), 'w', buffering=1)
except OSError:
    pass

from .mine_blake3 import blake3_hash_8bytes, blake3_compress, IV, CHUNK_START, CHUNK_END, ROOT

# ── Biased byte distribution ─────────────────────────────────────────

DEFAULT_ELEVATED = [
    0x00, 0x04, 0x08, 0x18, 0x1A, 0x3A, 0x48, 0x50,
    0x58, 0x5A, 0x78, 0x7A, 0x88, 0x90, 0x99, 0x9A,
    0x9D, 0xA0, 0xA8, 0xB5, 0xB7, 0xB8, 0xC8, 0xCA,
    0xD8, 0xDA, 0xE8, 0xEA, 0xF8, 0xFA,
]


def build_bias_table(bias_weight, elevated_bytes=None):
    """Build a 256-entry CDF for biased byte sampling.

    Returns a lookup table: for each of 256 uniform input values (0-255),
    the corresponding biased output byte.

    This is inverse-CDF sampling quantized to 256 levels.
    """
    if elevated_bytes is None:
        elevated_bytes = DEFAULT_ELEVATED
    elevated_set = set(elevated_bytes)
    N1 = len(elevated_set)
    N0 = 256 - N1

    total_weight = N1 * bias_weight + N0
    p_elevated = bias_weight / total_weight
    p_background = 1 / total_weight

    # Build CDF
    cdf = []
    cumulative = 0.0
    for b in range(256):
        p = p_elevated if b in elevated_set else p_background
        cumulative += p
        cdf.append(cumulative)

    # Build inverse CDF lookup: 65536 entries for finer resolution
    RESOLUTION = 65536
    lookup = np.zeros(RESOLUTION, dtype=np.uint8)
    bi = 0
    for i in range(RESOLUTION):
        target = (i + 0.5) / RESOLUTION
        while bi < 255 and cdf[bi] < target:
            bi += 1
        lookup[i] = bi

    return jnp.array(lookup, dtype=jnp.uint8)


# ── BLAKE3 → 16 biased bytes ─────────────────────────────────────────

def blake3_hash_16bytes(seed, cell_index):
    """BLAKE3(seed || cell_index) → first 16 bytes (4 uint32 words)."""
    msg = jnp.zeros(16, dtype=jnp.uint32)
    msg = msg.at[0].set(seed)
    msg = msg.at[1].set(cell_index)
    flags = CHUNK_START | CHUNK_END | ROOT
    out = blake3_compress(msg, IV, jnp.uint32(0), jnp.uint32(8), flags)
    return out[:4].view(jnp.uint8)  # 16 bytes


def bias_bytes(raw_bytes, lookup_table):
    """Map raw uniform bytes through the biased distribution."""
    # Use raw bytes as indices into the 65536-entry lookup
    # Combine pairs of raw bytes for 16-bit resolution
    indices = raw_bytes.astype(jnp.uint16) * 256 + jnp.roll(raw_bytes, 1).astype(jnp.uint16)
    # Actually simpler: just use each byte as an 8-bit index into a 256-entry table
    # But we have 65536 entries for finer resolution
    indices16 = raw_bytes.astype(jnp.uint32) * 257  # map 0-255 to 0-65535 roughly
    indices16 = jnp.clip(indices16, 0, 65535)
    return lookup_table[indices16]


# ── DFA matching on 16 bytes ──────────────────────────────────────────

# Safe single-byte inserts
SAFE_1BYTE = frozenset([
    0xEA,             # NOP
    0x18, 0x58, 0x78, # CLC, CLI, SEI
    0xB8, 0xD8, 0xF8, # CLV, CLD, SED
    0x48, 0x08,       # PHA, PHP
    # Undocumented single-byte NOPs
    0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA,
    # NOTE: Removed A8 (TAY), 9A (TXS), C8 (INY), 88 (DEY)
    # TAY clobbers Y (breaks Y-indexed family)
    # C8/88 are core opcodes, not safe inserts (would confuse DFA)
    # TXS modifies stack pointer (risky)
])

# Build DFA transition table as a JAX array for GPU execution.
# States: 0=I0, 1=SEEN_LDA, 2=SEEN_ADDR, 3=I1, 4=SEEN_STA,
#         5=SEEN_STA_LO, 6=SEEN_STA_HI, 7=I2, 8=SEEN_INC,
#         9=I3, 10=SEEN_BRANCH, 11=ACCEPT, 12=DEAD
#
# Simplified DFA (no multi-byte inserts for speed):
#   I0: safe→I0, B5→SEEN_LDA, B7→SEEN_LDA
#   SEEN_LDA: 00→SEEN_ADDR
#   SEEN_ADDR: →I1
#   I1: safe→I1, 9D→SEEN_STA, 99→SEEN_STA
#   SEEN_STA: 00→SEEN_STA_LO
#   SEEN_STA_LO: 04→SEEN_STA_HI
#   SEEN_STA_HI: →I2
#   I2: safe→I2, E8|CA|C8|88→SEEN_INC
#   SEEN_INC: →I3
#   I3: safe→I3, 90|50→SEEN_BRANCH
#   SEEN_BRANCH: any→ACCEPT (offset byte, always valid)
#   ACCEPT: absorbing
#   DEAD: absorbing

def build_dfa_table():
    """Build DFA with separate X/Y family tracks (16 states)."""
    S_DEAD = 15
    table = np.full((16, 256), S_DEAD, dtype=np.int32)

    S_I0 = 0
    S_LDA_X = 1; S_LDA_Y = 2
    S_I1_X = 3; S_I1_Y = 4
    S_STA_X = 5; S_STA_Y = 6
    S_STA_LO_X = 7; S_STA_LO_Y = 8
    S_I2_X = 9; S_I2_Y = 10
    S_INC = 11; S_I3 = 12; S_BRANCH = 13
    S_ACCEPT = 14; S_DEAD2 = 15

    for b in SAFE_1BYTE:
        table[S_I0, b] = S_I0
    table[S_I0, 0xB5] = S_LDA_X
    table[S_I0, 0xB7] = S_LDA_Y

    table[S_LDA_X, 0x00] = S_I1_X
    table[S_LDA_Y, 0x00] = S_I1_Y

    for b in SAFE_1BYTE:
        table[S_I1_X, b] = S_I1_X
        table[S_I1_Y, b] = S_I1_Y
    table[S_I1_X, 0x9D] = S_STA_X
    table[S_I1_Y, 0x99] = S_STA_Y

    table[S_STA_X, 0x00] = S_STA_LO_X
    table[S_STA_Y, 0x00] = S_STA_LO_Y

    table[S_STA_LO_X, 0x04] = S_I2_X
    table[S_STA_LO_Y, 0x04] = S_I2_Y

    # I2_X: safe → I2_X, E8|CA → INC
    for b in SAFE_1BYTE:
        table[S_I2_X, b] = S_I2_X
    table[S_I2_X, 0xE8] = S_INC  # INX
    table[S_I2_X, 0xCA] = S_INC  # DEX

    # I2_Y: safe → I2_Y, C8|88 → INC
    for b in SAFE_1BYTE:
        table[S_I2_Y, b] = S_I2_Y
    table[S_I2_Y, 0xC8] = S_INC  # INY
    table[S_I2_Y, 0x88] = S_INC  # DEY

    # INC: safe → I3, 90|50 → BRANCH
    # BRK path disabled — BRK-reset not implemented in simulator yet
    # table[S_INC, 0x00] = S_ACCEPT
    for b in SAFE_1BYTE:
        table[S_INC, b] = S_I3
    table[S_INC, 0x90] = S_BRANCH
    table[S_INC, 0x50] = S_BRANCH

    # I3: safe → I3, 90|50 → BRANCH
    for b in SAFE_1BYTE:
        table[S_I3, b] = S_I3
    table[S_I3, 0x90] = S_BRANCH
    table[S_I3, 0x50] = S_BRANCH

    # BRANCH: any → ACCEPT
    table[S_BRANCH, :] = S_ACCEPT

    # ACCEPT: absorbing
    table[S_ACCEPT, :] = S_ACCEPT

    return jnp.array(table, dtype=jnp.int32), S_ACCEPT


DFA_TABLE, DFA_ACCEPT = build_dfa_table()


def run_dfa_on_cell(biased_bytes, dfa_table):
    """Run DFA on up to 16 biased bytes. Returns True if ACCEPT reached."""
    def step(state, byte):
        next_state = dfa_table[state, byte.astype(jnp.int32)]
        return next_state, None

    final_state, _ = jax.lax.scan(step, jnp.int32(0), biased_bytes)
    return final_state == DFA_ACCEPT


# ── Fused pipeline: BLAKE3 → bias → DFA ──────────────────────────────

def check_cell(seed, cell_index, lookup_table, dfa_table):
    """Generate 16 biased bytes for one cell and run DFA."""
    raw = blake3_hash_16bytes(seed, cell_index)
    biased = bias_bytes(raw, lookup_table)
    return run_dfa_on_cell(biased, dfa_table)


@partial(jax.jit, static_argnames=('board_size',))
def scan_board_biased(seed, lookup_table, dfa_table, board_size=64):
    """Check all cells of a board for DFA matches."""
    n_cells = board_size * board_size
    cell_indices = jnp.arange(n_cells, dtype=jnp.uint32)
    matches = jax.vmap(lambda ci: check_cell(seed, ci, lookup_table, dfa_table))(cell_indices)
    return jnp.any(matches), matches


@partial(jax.jit, static_argnames=('board_size',))
def scan_seeds_biased(seeds, lookup_table, dfa_table, board_size=64):
    """Check a batch of seeds."""
    def check_one(seed):
        hit, _ = scan_board_biased(seed, lookup_table, dfa_table, board_size)
        return hit
    return jax.vmap(check_one)(seeds)


# ── Simulation confirmation ───────────────────────────────────────────

def confirm_match(seed, cell_index, lookup_table, board_size, bias_weight):
    """Generate the biased cell bytes and simulate to confirm spread."""
    # Regenerate the biased bytes for this cell
    raw = np.array(blake3_hash_16bytes(jnp.uint32(seed), jnp.uint32(cell_index)))
    lookup_np = np.array(lookup_table)
    biased = lookup_np[(raw.astype(np.uint32) * 257).clip(0, 65535)]

    # Extract the program (the DFA-matched prefix)
    program = list(biased[:16])

    # Try to simulate
    from .train import simulate_candidate
    result = simulate_candidate(program, board_size=4)
    return result, program


# ── Main ──────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Biased BLAKE3 mining with DFA')
    parser.add_argument('--bias', type=int, default=64, help='biasWeight')
    parser.add_argument('--board-size', type=int, default=64)
    parser.add_argument('--seeds', type=int, default=1000000)
    parser.add_argument('--batch', type=int, default=32)
    parser.add_argument('--start', type=int, default=0)
    parser.add_argument('--check-bytes', type=int, default=16)
    args = parser.parse_args()

    B = args.board_size
    n_cells = B * B
    bias_weight = args.bias

    # Build lookup table
    lookup = build_bias_table(bias_weight)
    dfa = DFA_TABLE

    print(f'Board: {B}×{B} = {n_cells} cells')
    print(f'biasWeight: {bias_weight}')
    print(f'Check bytes: {args.check_bytes}')
    print(f'Scanning {args.seeds} seeds in batches of {args.batch}')

    # Compute expected rate
    print()

    # Warmup
    print('JIT warmup...', end=' ')
    warmup = jnp.arange(args.batch, dtype=jnp.uint32)
    _ = scan_seeds_biased(warmup, lookup, dfa, B)
    jax.block_until_ready(_)
    print('done')

    # Mine
    found = []
    total_scanned = 0
    t0 = time.time()

    for start in range(args.start, args.start + args.seeds, args.batch):
        seeds = jnp.arange(start, min(start + args.batch, args.start + args.seeds),
                           dtype=jnp.uint32)
        hits = scan_seeds_biased(seeds, lookup, dfa, B)
        jax.block_until_ready(hits)

        hit_indices = np.where(np.asarray(hits))[0]
        for idx in hit_indices:
            seed_val = int(seeds[idx])
            elapsed = time.time() - t0
            rate = total_scanned / max(elapsed, 0.001)

            # Find which cell matched
            _, cell_matches = scan_board_biased(jnp.uint32(seed_val), lookup, dfa, B)
            match_cells = np.where(np.asarray(cell_matches))[0]

            for ci in match_cells[:3]:  # show up to 3 matches per seed
                result, program = confirm_match(seed_val, ci, lookup, B, bias_weight)
                hex_prog = ' '.join(f'{b:02x}' for b in program[:12])
                cell_i, cell_j = int(ci) // B, int(ci) % B
                print(f'  MATCH seed={seed_val} cell=({cell_i},{cell_j}) '
                      f'program=[{hex_prog}] '
                      f'spread={result["spread"]} viable={result["viable"]} '
                      f'({total_scanned} scanned, {rate:.0f}/s, {elapsed:.1f}s)')

            found.append({'seed': seed_val, 'cells': [int(c) for c in match_cells]})

        total_scanned += len(seeds)

        if total_scanned % (args.batch * 100) == 0:
            elapsed = time.time() - t0
            rate = total_scanned / max(elapsed, 0.001)
            print(f'  {total_scanned}/{args.seeds} seeds, {rate:.0f}/s, '
                  f'{len(found)} matches, {elapsed:.1f}s')

    elapsed = time.time() - t0
    rate = total_scanned / max(elapsed, 0.001)
    print(f'\nDone: {total_scanned} seeds in {elapsed:.1f}s ({rate:.0f}/s)')
    print(f'Found {len(found)} DFA matches')
    if found:
        print(f'First match at seed {found[0]["seed"]} after {elapsed:.1f}s')
