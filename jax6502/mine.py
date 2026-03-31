"""
Seed mining: find ChaCha20 seeds whose boards contain viable replicators.

Uses the trained HMM as a fast classifier to screen ChaCha20 output,
then simulates the top candidates for ground-truth verification.
"""

import argparse
import time
from functools import partial

import jax
import jax.numpy as jnp
import jax.random as jr
import numpy as np

from .chacha20 import chacha20_stream, seed_to_key, derive_nonce
from .hmm import (
    HMMParams,
    hmm_score_batch,
    hmm_score_batch_full,
    _score_single,
    _score_single_full,
)
from .train import (
    simulate_candidate,
    simulate_batch_python,
    save_params,
    load_params,
)


# ---------------------------------------------------------------------------
# Board cell scoring
# ---------------------------------------------------------------------------

def score_board_cells(hmm_params, board_bytes, board_size, mode='full',
                      cell_bytes=256):
    """Score all cells in a ChaCha20 board through the HMM.

    Args:
        hmm_params: trained HMMParams.
        board_bytes: uint8[board_size^2 * 1024] -- full board storage.
        board_size: side length of the square board.
        mode: 'core' or 'full'.
        cell_bytes: number of bytes per cell to score (default 256).

    Returns:
        float32[board_size^2] -- HMM score for each cell.
    """
    total_cells = board_size * board_size
    M = 1024

    # Extract zero pages
    storage = board_bytes.reshape(total_cells, M)
    zero_pages = storage[:, :cell_bytes].astype(jnp.int32)
    masks = jnp.ones((total_cells, cell_bytes), dtype=jnp.bool_)

    # Score through HMM
    if mode == 'full':
        scores = hmm_score_batch_full(hmm_params, zero_pages, masks)
    else:
        scores = hmm_score_batch(hmm_params, zero_pages, masks)

    return scores


def _generate_board_bytes(seed_int, board_size):
    """Generate a ChaCha20 board from an integer seed.

    Returns:
        uint8[board_size^2 * 1024]
    """
    key = seed_to_key(str(seed_int))
    nonce = derive_nonce(board_size)
    total_bytes = board_size * board_size * 1024
    num_blocks = (total_bytes + 63) // 64
    stream = chacha20_stream(key, nonce, num_blocks)
    return stream[:total_bytes]


# ---------------------------------------------------------------------------
# Single-seed mining
# ---------------------------------------------------------------------------

def mine_single_seed(hmm_params, seed_int, board_size=16,
                     K1=100, K2=10, mode='full',
                     board_size_sim=8, num_quanta=200,
                     oracle_state=None, rng_key=None):
    """Try one seed. Generate board via ChaCha20, score all cells,
    simulate the top-K candidates.

    Args:
        hmm_params: trained HMMParams.
        seed_int: integer seed for ChaCha20.
        board_size: board dimension for ChaCha20 generation.
        K1: number of top cells to keep after HMM scoring.
        K2: number of top cells to simulate.
        mode: 'core' or 'full'.
        board_size_sim: board size for simulation.
        num_quanta: quanta for simulation.
        oracle_state: optional neural oracle (not yet used).
        rng_key: JAX PRNG key for simulation.

    Returns:
        dict with seed, top_scores, top_cells, viable_cells, spreads.
    """
    if rng_key is None:
        rng_key = jr.PRNGKey(seed_int % (2**31))

    cell_bytes = 256 if mode == 'full' else 8

    # 1. Generate board
    board_bytes = _generate_board_bytes(seed_int, board_size)

    # 2. Score all cells
    scores = np.asarray(score_board_cells(
        hmm_params, board_bytes, board_size, mode=mode,
        cell_bytes=cell_bytes))

    total_cells = board_size * board_size
    K1_actual = min(K1, total_cells)
    K2_actual = min(K2, K1_actual)

    # 3. Top-K1 by HMM score
    top_k1_indices = np.argsort(scores)[-K1_actual:][::-1]
    top_k1_scores = scores[top_k1_indices]

    # 4. Top-K2 for simulation
    sim_indices = top_k1_indices[:K2_actual]
    sim_scores = top_k1_scores[:K2_actual]

    # 5. Extract cell bytes for simulation
    M = 1024
    storage_np = np.asarray(board_bytes, dtype=np.uint8)
    sim_seqs = []
    for idx in sim_indices:
        base = int(idx) * M
        cell = storage_np[base:base + cell_bytes]
        sim_seqs.append(cell)

    # 6. Simulate
    rng_key, sim_key = jr.split(rng_key)
    spreads = simulate_batch_python(
        sim_seqs, board_size=board_size_sim,
        num_quanta=num_quanta, rng_key=sim_key)

    # 7. Identify viable
    viable_mask = spreads > board_size_sim
    viable_cells = []
    for k, idx in enumerate(sim_indices):
        if viable_mask[k]:
            i = int(idx) // board_size
            j = int(idx) % board_size
            viable_cells.append({
                'seed': seed_int,
                'cell_index': int(idx),
                'i': i, 'j': j,
                'score': float(sim_scores[k]),
                'spread': int(spreads[k]),
            })

    return {
        'seed': seed_int,
        'top_scores': top_k1_scores.tolist()[:10],
        'top_cells': top_k1_indices.tolist()[:10],
        'viable_cells': viable_cells,
        'spreads': spreads.tolist(),
        'max_score': float(scores.max()),
        'mean_score': float(scores.mean()),
    }


# ---------------------------------------------------------------------------
# Multi-seed mining
# ---------------------------------------------------------------------------

def mine_seeds(hmm_params, oracle_state=None,
               num_seeds=1000, board_size=16,
               K1=100, K2=10, mode='full',
               rng_seed=42, verbose=True,
               board_size_sim=8, num_quanta=200):
    """Mine multiple seeds, report any viable ones found.

    For each seed:
      1. ChaCha20 -> board (all on GPU)
      2. HMM score all cells (associative scan, all on GPU)
      3. Top-K1 by HMM score
      4. (Optional) Neural oracle on K1 survivors
      5. Top-K2 by combined score
      6. Simulate K2 on 8x8 boards
      7. Report any viable

    Prints progress: seeds tried, best scores seen, estimated B_eff.

    Args:
        hmm_params: trained HMMParams.
        oracle_state: optional neural oracle state.
        num_seeds: number of seeds to try.
        board_size: board dimension for ChaCha20.
        K1: HMM top-K filter.
        K2: simulation budget per seed.
        mode: 'core' or 'full'.
        rng_seed: starting seed for RNG.
        verbose: print progress.
        board_size_sim: board size for simulation.
        num_quanta: quanta for simulation.

    Returns:
        dict with viable_seeds, all_max_scores, seeds_tried, throughput.
    """
    rng_key = jr.PRNGKey(rng_seed)
    all_viable = []
    all_max_scores = []
    t_start = time.time()

    for i in range(num_seeds):
        rng_key, seed_key, sim_key = jr.split(rng_key, 3)
        seed_int = int(jr.randint(seed_key, (), 0, 2**30))

        result = mine_single_seed(
            hmm_params, seed_int, board_size=board_size,
            K1=K1, K2=K2, mode=mode,
            board_size_sim=board_size_sim, num_quanta=num_quanta,
            oracle_state=oracle_state, rng_key=sim_key)

        all_max_scores.append(result['max_score'])
        all_viable.extend(result['viable_cells'])

        if verbose and ((i + 1) % max(1, num_seeds // 20) == 0 or
                        len(result['viable_cells']) > 0):
            elapsed = time.time() - t_start
            rate = (i + 1) / elapsed
            cells_per_sec = rate * board_size * board_size
            print(f"  [{i+1}/{num_seeds}] "
                  f"{rate:.1f} seeds/s, "
                  f"{cells_per_sec:.0f} cells/s, "
                  f"max_score={max(all_max_scores):.2f}, "
                  f"viable={len(all_viable)}")

    elapsed = time.time() - t_start
    throughput = num_seeds / elapsed if elapsed > 0 else 0

    if verbose:
        print(f"\nMining complete: {num_seeds} seeds in {elapsed:.1f}s "
              f"({throughput:.1f} seeds/s)")
        print(f"Viable seeds found: {len(all_viable)}")

    return {
        'viable_seeds': all_viable,
        'all_max_scores': all_max_scores,
        'seeds_tried': num_seeds,
        'throughput': throughput,
        'elapsed': elapsed,
    }


# ---------------------------------------------------------------------------
# B_eff estimation from mining
# ---------------------------------------------------------------------------

def estimate_beff_from_mining(hmm_params, num_seeds=100, board_size=16,
                              mode='full', cell_bytes=256, rng_seed=42,
                              verbose=False):
    """Estimate B_eff by scoring ChaCha20 boards.

    Generate boards, compute max HMM score per board.
    The distribution of max scores tells you how rare viable-looking
    cells are under uniform random.

    B_eff ~ -log2(P(max_score > threshold))

    Args:
        hmm_params: trained HMMParams.
        num_seeds: number of boards to score.
        board_size: board dimension.
        mode: 'core' or 'full'.
        cell_bytes: bytes per cell to score.
        rng_seed: starting seed.
        verbose: print details.

    Returns:
        dict with max_scores, mean_max, std_max, estimated_beff.
    """
    rng_key = jr.PRNGKey(rng_seed)
    max_scores = []

    for i in range(num_seeds):
        rng_key, subkey = jr.split(rng_key)
        seed_int = int(jr.randint(subkey, (), 0, 2**30))

        board_bytes = _generate_board_bytes(seed_int, board_size)
        scores = np.asarray(score_board_cells(
            hmm_params, board_bytes, board_size, mode=mode,
            cell_bytes=cell_bytes))
        max_scores.append(float(scores.max()))

    max_scores = np.array(max_scores)

    # Estimate tail probability: fraction of boards with max_score > 0
    # (positive log-odds means HMM thinks it's more likely than uniform)
    frac_positive = float((max_scores > 0).mean())
    if frac_positive > 0:
        beff_estimate = -np.log2(frac_positive)
    else:
        beff_estimate = float('inf')

    result = {
        'max_scores': max_scores.tolist(),
        'mean_max': float(max_scores.mean()),
        'std_max': float(max_scores.std()),
        'median_max': float(np.median(max_scores)),
        'frac_positive': frac_positive,
        'estimated_beff': beff_estimate,
        'num_seeds': num_seeds,
        'board_size': board_size,
    }

    if verbose:
        print(f"B_eff estimation from {num_seeds} ChaCha20 boards:")
        print(f"  Max score: mean={result['mean_max']:.2f}, "
              f"std={result['std_max']:.2f}, "
              f"median={result['median_max']:.2f}")
        print(f"  P(max_score > 0) = {frac_positive:.4f}")
        print(f"  Estimated B_eff ~ {beff_estimate:.1f} bits")

    return result


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Mine ChaCha20 seeds for viable replicators')
    parser.add_argument('--model', type=str, required=True,
                        help='Trained HMM params file (.npz)')
    parser.add_argument('--seeds', type=int, default=1000)
    parser.add_argument('--board-size', type=int, default=16)
    parser.add_argument('--K1', type=int, default=100)
    parser.add_argument('--K2', type=int, default=10)
    parser.add_argument('--seed', type=int, default=42,
                        help='RNG seed for mining')
    parser.add_argument('--mode', type=str, default='full',
                        choices=['core', 'full'])
    parser.add_argument('--verbose', action='store_true')
    args = parser.parse_args()

    params = load_params(args.model)
    results = mine_seeds(params, num_seeds=args.seeds, board_size=args.board_size,
                         K1=args.K1, K2=args.K2, rng_seed=args.seed,
                         verbose=args.verbose, mode=args.mode)

    print(f"\nMined {args.seeds} seeds")
    print(f"Viable seeds found: {len(results['viable_seeds'])}")
    for vs in results['viable_seeds']:
        print(f"  Seed {vs['seed']}: cell ({vs['i']},{vs['j']}), "
              f"spread={vs['spread']}")
