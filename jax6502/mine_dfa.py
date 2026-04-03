"""
Mine with 18 parallel DFAs on GPU. Consistent BLAKE3 PRNG throughout.

Pipeline:
  1. BLAKE3(seed || cell_index) → 24 raw bytes (GPU)
  2. Bias lookup → 24 soup bytes (GPU)
  3. 18 parallel DFAs → bool (GPU)
  4. Hits: regenerate + simulate on CPU
"""

from functools import partial
import jax
import jax.numpy as jnp
import numpy as np
import time
import sys

from .mine_blake3 import blake3_compress, IV, CHUNK_START, CHUNK_END, ROOT
from .mine_turtles_tiers import SOUP_WEIGHTS, build_soup_lookup
from .replicator_dfa import run_dfas, ALL_DFAS_JAX, ACCEPT

CELL_LEN = 32


# ── BLAKE3 + bias (consistent PRNG for both GPU and CPU) ─────────────

def blake3_24(seed, cell_index):
    """BLAKE3(seed || cell_index) → 24 bytes."""
    msg = jnp.zeros(16, dtype=jnp.uint32)
    msg = msg.at[0].set(seed)
    msg = msg.at[1].set(cell_index)
    flags = CHUNK_START | CHUNK_END | ROOT
    out = blake3_compress(msg, IV, jnp.uint32(0), jnp.uint32(8), flags)
    return out[:6].view(jnp.uint8)


def apply_bias(raw, lookup):
    idx = raw.astype(jnp.uint32) * 257
    idx = jnp.clip(idx, 0, 65535)
    return lookup[idx]


def generate_cell(seed, cell_index, lookup):
    """Generate one 32-byte biased cell. Same PRNG for GPU and CPU."""
    raw = blake3_24(seed, cell_index)
    biased = apply_bias(raw, lookup)
    padded = jnp.zeros(CELL_LEN, dtype=jnp.uint8)
    padded = padded.at[:24].set(biased)
    return padded


# ── GPU scan ──────────────────────────────────────────────────────────

@partial(jax.jit, static_argnames=('board_size',))
def scan_board_dfa(seed, lookup, board_size=64):
    """Run 18 DFAs on all cells of a board."""
    n_cells = board_size * board_size
    def check_cell(ci):
        cell = generate_cell(seed, ci, lookup)
        return run_dfas(cell)
    return jax.vmap(check_cell)(jnp.arange(n_cells, dtype=jnp.uint32))


@partial(jax.jit, static_argnames=('board_size',))
def scan_batch_dfa(seeds, lookup, board_size=64):
    """Batch of seeds: any hit per seed?"""
    def check_seed(s):
        hits = scan_board_dfa(s, lookup, board_size)
        return jnp.any(hits)
    return jax.vmap(check_seed)(seeds)


# ── CPU verification (same PRNG!) ─────────────────────────────────────

def cpu_verify(seed, cell_index, lookup_np):
    """Regenerate cell with same BLAKE3 PRNG and run CPU scanner."""
    raw = np.array(blake3_24(jnp.uint32(seed), jnp.uint32(cell_index)))
    biased = lookup_np[(raw.astype(np.uint32) * 257).clip(0, 65535)]
    # Pad to 32
    cell = np.zeros(32, dtype=np.uint8)
    cell[:len(biased)] = biased

    from .mine_turtles_tiers import scan_cell
    return scan_cell(cell), cell


# ── Main ──────────────────────────────────────────────────────────────

if __name__ == '__main__':
    try:
        sys.stdout = open(sys.stdout.fileno(), 'w', buffering=1)
    except OSError:
        pass

    lookup = build_soup_lookup()
    lookup_np = np.array(lookup)
    B = 64
    BATCH = 32

    print("DFA GPU Miner (18 parallel DFAs, BLAKE3 PRNG)", flush=True)

    # JIT warmup
    print("JIT warmup...", end=' ', flush=True)
    t_jit = time.time()
    _ = scan_batch_dfa(jnp.arange(BATCH, dtype=jnp.uint32), lookup, B)
    jax.block_until_ready(_)
    print(f"done ({time.time()-t_jit:.1f}s)", flush=True)

    # Verify PRNG consistency: generate cell on GPU and CPU, compare
    test_cell_gpu = np.array(generate_cell(jnp.uint32(42), jnp.uint32(100), lookup))
    test_raw = np.array(blake3_24(jnp.uint32(42), jnp.uint32(100)))
    test_cell_cpu = lookup_np[(test_raw.astype(np.uint32) * 257).clip(0, 65535)]
    assert np.array_equal(test_cell_gpu[:24], test_cell_cpu), "PRNG MISMATCH!"
    print("PRNG consistency verified ✓", flush=True)

    # Quick GPU benchmark
    print("Benchmarking...", end=' ', flush=True)
    t_bench = time.time()
    for i in range(100):
        _ = scan_batch_dfa(jnp.arange(i*BATCH, (i+1)*BATCH, dtype=jnp.uint32), lookup, B)
        jax.block_until_ready(_)
    bench_time = time.time() - t_bench
    gpu_rate = 100 * BATCH / bench_time
    print(f"{gpu_rate:.0f} seeds/sec (pure GPU)", flush=True)

    from .train import simulate_candidate

    # Mine
    t0 = time.time()
    total_seeds = 0
    total_hits = 0
    total_viable = 0

    for batch_start in range(0, 10000000, BATCH):
        seeds = jnp.arange(batch_start, batch_start + BATCH, dtype=jnp.uint32)
        batch_any = scan_batch_dfa(seeds, lookup, B)
        jax.block_until_ready(batch_any)

        for idx in np.where(np.asarray(batch_any))[0]:
            seed_val = int(seeds[idx])
            # Find which cells hit
            cell_hits = scan_board_dfa(jnp.uint32(seed_val), lookup, B)
            jax.block_until_ready(cell_hits)

            for ci in np.where(np.asarray(cell_hits))[0][:5]:
                total_hits += 1
                match, cell_bytes = cpu_verify(seed_val, int(ci), lookup_np)
                if match is None:
                    continue

                result = simulate_candidate(match['program'], board_size=4)
                elapsed = time.time() - t0
                hp = ' '.join(f'{b:02X}' for b in match['program'][:16])

                if result['viable']:
                    total_viable += 1
                    print(f"⭐ VIABLE seed={seed_val} ({int(ci)//B},{int(ci)%B}) "
                          f"{match['variant']}/{match['branch']} L={match['length']} "
                          f"[{hp}] spread={result['spread']} {elapsed:.1f}s", flush=True)
                elif total_hits <= 10:
                    print(f"   miss #{total_hits} seed={seed_val} ({int(ci)//B},{int(ci)%B}) "
                          f"{match['variant']}/{match['branch']} L={match['length']} "
                          f"[{hp}] {elapsed:.1f}s", flush=True)

        total_seeds += BATCH
        if total_seeds % (BATCH * 100) == 0:
            elapsed = time.time() - t0
            print(f"  {total_seeds} seeds, {total_seeds/elapsed:.0f}/s, "
                  f"{total_hits} hits, {total_viable} viable, {elapsed:.0f}s", flush=True)
