"""
Fused BLAKE3 board init + 7-byte replicator scan.

For each seed, generates the first 7 bytes of every cell on a 64×64
board using BLAKE3(seed || cell_index), then checks for the BRK-reset
replicator core: B5 00 9D 00 04 {E8|CA} 00.

Usage:
    python -m jax6502.mine_blake3 --seeds 100000
"""

from functools import partial

import jax
import jax.numpy as jnp
import jax.random as jr
import numpy as np
import time
import sys

sys.stdout = open(sys.stdout.fileno(), 'w', buffering=1)


# ── BLAKE3 compression function in JAX ────────────────────────────────
#
# BLAKE3 uses a 16-word (512-bit) state, processes 64-byte message blocks.
# For our use: message = seed (4 bytes) || cell_index (4 bytes), padded to
# one block. Output = first 32 bytes of hash, we use first 7.
#
# Simplified: single-block BLAKE3 (no chunking, no tree structure).

# BLAKE3 IV (same as BLAKE2s)
IV = jnp.array([
    0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
    0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
], dtype=jnp.uint32)

# BLAKE3 message permutation schedule (7 rounds)
MSG_SCHEDULE = jnp.array([
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8],
    [3, 4, 10, 12, 13, 2, 7, 14, 6, 5, 9, 0, 11, 15, 8, 1],
    [10, 7, 12, 9, 14, 3, 13, 15, 4, 0, 11, 2, 5, 8, 1, 6],
    [12, 13, 9, 11, 15, 10, 14, 8, 7, 2, 5, 3, 0, 1, 6, 4],
    [9, 14, 11, 5, 8, 12, 15, 1, 13, 3, 0, 10, 2, 6, 4, 7],
    [11, 15, 5, 0, 1, 9, 8, 6, 14, 10, 2, 12, 3, 4, 7, 13],
], dtype=jnp.int32)

# BLAKE3 flags
CHUNK_START = jnp.uint32(1)
CHUNK_END = jnp.uint32(2)
ROOT = jnp.uint32(8)


def _rotl32(x, n):
    return (x >> jnp.uint32(32 - n)) | (x << jnp.uint32(n))


def _g(state, a, b, c, d, mx, my):
    """BLAKE3 quarter-round (G function)."""
    state = state.at[a].set(state[a] + state[b] + mx)
    state = state.at[d].set(_rotl32(state[d] ^ state[a], 16))
    state = state.at[c].set(state[c] + state[d])
    state = state.at[b].set(_rotl32(state[b] ^ state[c], 12))
    state = state.at[a].set(state[a] + state[b] + my)
    state = state.at[d].set(_rotl32(state[d] ^ state[a], 8))
    state = state.at[c].set(state[c] + state[d])
    state = state.at[b].set(_rotl32(state[b] ^ state[c], 7))
    return state


def _round(state, msg, schedule_row):
    """One round of BLAKE3 compression."""
    m = msg[schedule_row]
    # Column step
    state = _g(state, 0, 4,  8, 12, m[0],  m[1])
    state = _g(state, 1, 5,  9, 13, m[2],  m[3])
    state = _g(state, 2, 6, 10, 14, m[4],  m[5])
    state = _g(state, 3, 7, 11, 15, m[6],  m[7])
    # Diagonal step
    state = _g(state, 0, 5, 10, 15, m[8],  m[9])
    state = _g(state, 1, 6, 11, 12, m[10], m[11])
    state = _g(state, 2, 7,  8, 13, m[12], m[13])
    state = _g(state, 3, 4,  9, 14, m[14], m[15])
    return state


def blake3_compress(msg_words, key_words, counter, block_len, flags):
    """BLAKE3 single-block compression.

    Args:
        msg_words: uint32[16] — message block
        key_words: uint32[8] — chaining value (IV for first block)
        counter: uint32 — block counter (0 for single block)
        block_len: uint32 — number of message bytes
        flags: uint32 — BLAKE3 flags

    Returns:
        uint32[8] — output chaining value (first 8 words of state XOR'd)
    """
    state = jnp.concatenate([
        key_words,
        IV[:4],
        jnp.array([counter, jnp.uint32(0), block_len, flags], dtype=jnp.uint32),
    ])  # uint32[16]

    # Build permuted message blocks for all 7 rounds
    msg_permuted = msg_words[MSG_SCHEDULE]  # [7, 16]

    # 7 rounds
    def body(i, s):
        return _round(s, msg_permuted, i)
    state = jax.lax.fori_loop(0, 7, body, state)

    # Output: XOR first 8 with last 8
    out = state[:8] ^ state[8:]
    return out


def blake3_hash_8bytes(seed, cell_index):
    """Hash seed||cell_index via BLAKE3, return first 8 bytes.

    Args:
        seed: uint32 scalar
        cell_index: uint32 scalar

    Returns:
        uint8[8] — first 8 bytes of BLAKE3 hash
    """
    # Message: seed (4 bytes) + cell_index (4 bytes) + padding zeros
    msg = jnp.zeros(16, dtype=jnp.uint32)
    msg = msg.at[0].set(seed)
    msg = msg.at[1].set(cell_index)

    flags = CHUNK_START | CHUNK_END | ROOT
    out = blake3_compress(msg, IV, jnp.uint32(0), jnp.uint32(8), flags)

    # Convert first 2 uint32 words to 8 bytes (little-endian)
    return out[:2].view(jnp.uint8)


# ── Replicator pattern matching ───────────────────────────────────────

# BRK-reset core: B5 00 9D 00 04 {E8|CA} 00
PATTERN = jnp.array([0xB5, 0x00, 0x9D, 0x00, 0x04, 0x00, 0x00], dtype=jnp.uint8)
MASK =    jnp.array([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0xFF], dtype=jnp.uint8)
# Position 5: must be E8 or CA (checked separately)


def check_cell(cell_bytes):
    """Check if 7 bytes match the BRK-reset replicator core."""
    b = cell_bytes[:7]
    # Fixed bytes match
    fixed_match = jnp.all((b & MASK) == (PATTERN & MASK))
    # Position 5: E8 (INX) or CA (DEX)
    inc_match = (b[5] == 0xE8) | (b[5] == 0xCA)
    return fixed_match & inc_match


# ── Fused scan: all cells of one seed ─────────────────────────────────

def scan_board(seed, board_size=64):
    """Generate and check all cells of a board for the replicator pattern.

    Args:
        seed: uint32 scalar

    Returns:
        bool — True if any cell matches
    """
    n_cells = board_size * board_size
    cell_indices = jnp.arange(n_cells, dtype=jnp.uint32)

    # Generate first 8 bytes of each cell via BLAKE3
    cell_bytes = jax.vmap(lambda ci: blake3_hash_8bytes(seed, ci))(cell_indices)
    # cell_bytes: [n_cells, 8]

    # Check each cell for the replicator pattern
    matches = jax.vmap(check_cell)(cell_bytes)
    # matches: [n_cells] bool

    return jnp.any(matches)


# ── Batched scan: multiple seeds at once ──────────────────────────────

@partial(jax.jit, static_argnames=('board_size',))
def scan_seeds_batch(seeds, board_size=64):
    """Check a batch of seeds for replicator matches.

    Args:
        seeds: uint32[B] — batch of seeds

    Returns:
        bool[B] — True for each seed that contains a match
    """
    return jax.vmap(lambda s: scan_board(s, board_size))(seeds)


# ── Main: benchmark and mine ──────────────────────────────────────────

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='BLAKE3 replicator mining benchmark')
    parser.add_argument('--seeds', type=int, default=100000,
                        help='Total seeds to scan')
    parser.add_argument('--batch', type=int, default=1024,
                        help='Seeds per GPU batch')
    parser.add_argument('--board-size', type=int, default=64,
                        help='Board dimension (board_size × board_size)')
    parser.add_argument('--start', type=int, default=0,
                        help='Starting seed value')
    args = parser.parse_args()

    B = args.board_size
    n_cells = B * B
    total_seeds = args.seeds
    batch_size = args.batch

    print(f'Board: {B}×{B} = {n_cells} cells')
    print(f'Pattern: B5 00 9D 00 04 {{E8|CA}} 00 (BRK-reset core)')
    print(f'Scanning {total_seeds} seeds in batches of {batch_size}')
    print(f'B_eff ≈ 54.4 bits, expected ~1 match per 2^{{54.4 - {2*int(np.log2(B))}}} = 2^{54.4 - 2*np.log2(B):.1f} seeds')
    print()

    # Warmup JIT
    print('JIT warmup...', end=' ')
    warmup_seeds = jnp.arange(batch_size, dtype=jnp.uint32)
    _ = scan_seeds_batch(warmup_seeds, B)
    jax.block_until_ready(_)
    print('done')

    # Benchmark
    found_seeds = []
    total_scanned = 0
    t0 = time.time()

    for start in range(args.start, args.start + total_seeds, batch_size):
        seeds = jnp.arange(start, min(start + batch_size, args.start + total_seeds),
                           dtype=jnp.uint32)
        matches = scan_seeds_batch(seeds, B)
        jax.block_until_ready(matches)

        match_indices = np.where(np.asarray(matches))[0]
        for idx in match_indices:
            found_seed = int(seeds[idx])
            found_seeds.append(found_seed)
            elapsed = time.time() - t0
            rate = total_scanned / max(elapsed, 0.001)
            print(f'  MATCH at seed {found_seed} '
                  f'({total_scanned} scanned, {elapsed:.1f}s, {rate:.0f} seeds/s)')

        total_scanned += len(seeds)

        if total_scanned % (batch_size * 10) == 0 or total_scanned >= total_seeds:
            elapsed = time.time() - t0
            rate = total_scanned / max(elapsed, 0.001)
            expected_seeds = 2 ** (54.4 - 2 * np.log2(B))
            eta_seconds = (expected_seeds - total_scanned) / max(rate, 1)
            print(f'  Scanned {total_scanned}/{total_seeds} seeds, '
                  f'{rate:.0f} seeds/s, '
                  f'ETA to first match: {eta_seconds/3600:.1f} hours')

    elapsed = time.time() - t0
    rate = total_scanned / max(elapsed, 0.001)
    print(f'\nDone: {total_scanned} seeds in {elapsed:.1f}s ({rate:.0f} seeds/s)')
    print(f'Found {len(found_seeds)} matches: {found_seeds[:20]}')
    print(f'Expected seeds for 1 match: 2^{54.4 - 2*np.log2(B):.1f} = {2**(54.4-2*np.log2(B)):.2e}')
    print(f'At {rate:.0f} seeds/s: {2**(54.4-2*np.log2(B))/rate/3600:.1f} hours')
