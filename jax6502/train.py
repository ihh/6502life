"""
NCE training pipeline for the profile HMM replicator generator.

Generates candidates from the HMM, evaluates them through a cascade of
oracles (HMM score -> neural oracle -> JAX 6502 simulator), and updates
the HMM discriminatively via noise-contrastive estimation.

The simulation oracle uses the JAX 6502 emulator (cpu.py + batch.py)
with checkerboard scheduling (fast_board.py) for GPU-parallel evaluation.
"""

import argparse
import time
from functools import partial
from typing import Any, Dict, List, Optional, Tuple

import jax
import jax.numpy as jnp
import jax.random as jr
import numpy as np
import optax

from .hmm import (
    HMMParams,
    NUM_STATES,
    NUM_INSERT_POSITIONS,
    _score_single,
    _score_single_full,
    default_params,
    hmm_log_prob_marginal,
    hmm_sample,
    hmm_score_batch,
    hmm_score_batch_full,
    count_params,
)
from .fast_board import FastBoard, _run_one_quantum, _run_pass, run_rounds
from .chacha20 import chacha20_stream, seed_to_key, derive_nonce


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CELL_SIZE = 1024
REG_PCHI = 0xF9
REG_PCLO = 0xFA
REG_P = 0xFB
REG_A = 0xFC
REG_X = 0xFD
REG_Y = 0xFE
REG_S = 0xFF


# ---------------------------------------------------------------------------
# 0. ChaCha20 negatives generator
# ---------------------------------------------------------------------------

def generate_chacha20_negatives(num_cells, rng_key, cell_bytes=256,
                                board_size=16):
    """Generate random cell contents via ChaCha20.

    Pick a random seed, generate a board, extract cell zero pages.
    These are IID uniform bytes -- the null model for NCE.

    Args:
        num_cells: number of cell zero pages to generate.
        rng_key: JAX PRNG key (used to pick the seed).
        cell_bytes: number of bytes per cell to extract (default 256).
        board_size: board dimension (board_size x board_size cells).

    Returns:
        (sequences, masks) ready for HMM scoring.
        sequences: int32[num_cells, cell_bytes]
        masks: bool[num_cells, cell_bytes]
    """
    # Pick a random seed integer
    seed_int = int(jr.randint(rng_key, (), 0, 2**30))
    seed_str = str(seed_int)

    key = seed_to_key(seed_str)
    nonce = derive_nonce(board_size)
    total_cells = board_size * board_size

    # Generate only the bytes we need: cell_bytes per cell.
    # Each cell is 1024 bytes in the full board, but we only need the first
    # cell_bytes. We generate the full board stream and extract zero pages.
    # Optimization: generate only 4 ChaCha20 blocks per cell (256 bytes)
    # instead of 16 (1024 bytes) when cell_bytes <= 256.
    if cell_bytes <= 256:
        # Generate full board (we need contiguous blocks per cell at stride 1024)
        # ChaCha20 is a stream cipher -- bytes at offset i*1024 require
        # generating the intervening blocks. So generate the full stream
        # but only keep the first cell_bytes of each 1024-byte cell.
        num_blocks = (total_cells * 1024 + 63) // 64
        stream = chacha20_stream(key, nonce, num_blocks)
        stream = stream[:total_cells * 1024]

        # Extract zero pages (first cell_bytes of each 1024-byte cell)
        storage = stream.reshape(total_cells, 1024)
        zero_pages = storage[:, :cell_bytes]  # [total_cells, cell_bytes]
    else:
        num_blocks = (total_cells * 1024 + 63) // 64
        stream = chacha20_stream(key, nonce, num_blocks)
        stream = stream[:total_cells * 1024]
        storage = stream.reshape(total_cells, 1024)
        zero_pages = storage[:, :cell_bytes]

    # Select num_cells from the total (cycling if needed)
    if num_cells <= total_cells:
        selected = zero_pages[:num_cells]
    else:
        # Generate additional boards if needed
        all_pages = [zero_pages]
        remaining = num_cells - total_cells
        while remaining > 0:
            rng_key, subkey = jr.split(rng_key)
            seed_int = int(jr.randint(subkey, (), 0, 2**30))
            key2 = seed_to_key(str(seed_int))
            stream2 = chacha20_stream(key2, nonce, num_blocks)
            stream2 = stream2[:total_cells * 1024]
            storage2 = stream2.reshape(total_cells, 1024)
            batch = storage2[:min(remaining, total_cells), :cell_bytes]
            all_pages.append(batch)
            remaining -= total_cells
        selected = jnp.concatenate(all_pages, axis=0)[:num_cells]

    sequences = selected.astype(jnp.int32)
    masks = jnp.ones((num_cells, cell_bytes), dtype=jnp.bool_)

    return sequences, masks


# ---------------------------------------------------------------------------
# 1. Simulation oracle (ground truth)
# ---------------------------------------------------------------------------

def simulate_candidate(byte_seq, board_size=8, num_quanta=None, rng_key=None):
    """Test if a byte sequence is a viable replicator.

    1. Initialize board_size x board_size board with random bytes.
    2. Inject byte_seq into cell (0,0) at offset 0.
    3. Set PC=0 in cell (0,0)'s register save area.
    4. Run num_quanta scheduling quanta (checkerboard passes).
    5. Count how many cells contain a copy of the program.

    Args:
        byte_seq: 1-D int array of byte values (length L).
        board_size: side length of the square board.
        num_quanta: number of checkerboard rounds to run.
        rng_key: JAX PRNG key (default: PRNGKey(42)).

    Returns:
        dict with 'spread' (int) and 'viable' (bool).
    """
    if rng_key is None:
        rng_key = jr.PRNGKey(42)
    if num_quanta is None:
        # Need enough rounds for a replicator to spread across the board.
        # ~20 rounds per board dimension works empirically.
        num_quanta = board_size * board_size * 20

    byte_seq = np.asarray(byte_seq, dtype=np.uint8)
    L = len(byte_seq)
    B = board_size
    M = CELL_SIZE

    board = FastBoard(size=B, seed=int(jr.randint(rng_key, (), 0, 2**30)))

    # Randomize the board
    k1, k2 = jr.split(rng_key)
    board.storage = jr.randint(k1, (B * B * M,), 0, 256).astype(jnp.uint8)

    # Inject candidate into cell (0,0)
    board.write_cell(0, 0, 0, byte_seq)
    # Set registers: PC=0, P=$30, S=$FF
    board.write_cell(0, 0, REG_PCHI, [0x00])
    board.write_cell(0, 0, REG_PCLO, [0x00])
    board.write_cell(0, 0, REG_P, [0x30])
    board.write_cell(0, 0, REG_S, [0xFF])

    # Run simulation (each round = 2 checkerboard passes = B*B quanta)
    n_rounds = max(1, num_quanta // (B * B))
    board.key = k2
    board.run_rounds(n_rounds)

    # Count spread: how many cells have an exact copy of byte_seq
    storage_np = np.asarray(board.storage, dtype=np.uint8)
    spread = 0
    # Compare only the core program bytes (first 8). The cargo (bytes 8-248)
    # drifts on multi-cell boards as cells overwrite each other, and the
    # register area (0xF9-0xFF) changes during execution. The replicator's
    # identity is its first 8 bytes.
    compare_len = min(L, 8)
    for ci in range(B):
        for cj in range(B):
            base = (ci * B + cj) * M
            cell_bytes = storage_np[base:base + compare_len]
            if np.array_equal(cell_bytes, byte_seq[:compare_len]):
                spread += 1

    viable = spread > board_size
    return {'spread': spread, 'viable': viable}


def simulate_batch_python(byte_seqs_list, board_size=8, num_quanta=200, rng_key=None):
    """Simulate a batch of candidates sequentially.

    Each candidate gets its own board and simulation run.

    Args:
        byte_seqs_list: list of 1-D arrays/lists of byte values.
        board_size: side length of the square board.
        num_quanta: number of checkerboard rounds.
        rng_key: JAX PRNG key.

    Returns:
        np.ndarray of spread counts, shape (B,).
    """
    if rng_key is None:
        rng_key = jr.PRNGKey(42)

    spreads = []
    for i, seq in enumerate(byte_seqs_list):
        rng_key, subkey = jr.split(rng_key)
        result = simulate_candidate(seq, board_size=board_size,
                                    num_quanta=num_quanta, rng_key=subkey)
        spreads.append(result['spread'])

    return np.array(spreads, dtype=np.int32)


# ---------------------------------------------------------------------------
# 2. Oracle cascade
# ---------------------------------------------------------------------------

class OracleCascade:
    """Multi-level oracle with active learning.

    Level 0: HMM score (analytical, free)
    Level 1: Neural oracle (GPU batch, ~0.2us/seq)
    Level 2: JAX simulator (GPU batch, ~50us/seq)

    Each level filters candidates for the next.
    Active learning selects the most uncertain examples at each level.
    """

    def __init__(self, hmm_params, oracle_state=None, simulate_fn=None,
                 hmm_threshold=20.0,
                 oracle_budget=1000,
                 sim_budget=100,
                 mode='core'):
        """
        Args:
            hmm_params: HMMParams for level-0 scoring.
            oracle_state: Flax TrainState for neural oracle (optional).
            simulate_fn: callable(byte_seqs_list, rng_key) -> spread counts.
            hmm_threshold: filter candidates where |s_theta(x)| < threshold.
            oracle_budget: max neural oracle evaluations per cascade call.
            sim_budget: max simulation evaluations per cascade call.
            mode: 'core' or 'full'.
        """
        self.hmm_params = hmm_params
        self.oracle_state = oracle_state
        self.simulate_fn = simulate_fn or simulate_batch_python
        self.hmm_threshold = hmm_threshold
        self.oracle_budget = oracle_budget
        self.sim_budget = sim_budget
        self.mode = mode

    def evaluate(self, candidates_seqs, candidates_masks, rng_key,
                 board_size=8, num_quanta=200):
        """Run candidates through the cascade.

        Args:
            candidates_seqs: (N, L) int32 padded byte sequences.
            candidates_masks: (N, L) bool masks.
            rng_key: JAX PRNG key.
            board_size: board size for simulation.
            num_quanta: quanta for simulation.

        Returns:
            dict with:
                'hmm_scores': (N,) float32 log-odds scores.
                'labels': (N,) float32 labels (0 or 1, NaN if not simulated).
                'sim_indices': indices of candidates that were simulated.
                'spreads': spread counts for simulated candidates.
        """
        N = candidates_seqs.shape[0]

        # Level 0: HMM scoring (all candidates)
        if self.mode == 'full':
            # Score one at a time to avoid OOM on long sequences
            hmm_scores = np.array([
                float(_score_single_full(
                    self.hmm_params, candidates_seqs[i], candidates_masks[i]))
                for i in range(N)
            ], dtype=np.float32)
        else:
            hmm_scores = np.asarray(hmm_score_batch(
                self.hmm_params, candidates_seqs, candidates_masks))

        # Initialize labels as NaN (unknown)
        labels = np.full(N, np.nan, dtype=np.float32)

        # Obvious negatives: very low HMM score
        obvious_neg = hmm_scores < -self.hmm_threshold
        labels[obvious_neg] = 0.0

        # Candidates that pass HMM filter (uncertain or positive)
        uncertain_mask = np.abs(hmm_scores) < self.hmm_threshold
        positive_mask = hmm_scores >= self.hmm_threshold
        uncertain_indices = np.where(uncertain_mask)[0]
        positive_indices = np.where(positive_mask)[0]

        # Level 1: Neural oracle (if available)
        oracle_scores = np.full(N, 0.5, dtype=np.float32)
        if self.oracle_state is not None and len(uncertain_indices) > 0:
            from .oracle import predict_batch as oracle_predict
            eval_indices = uncertain_indices[:self.oracle_budget]
            eval_seqs = candidates_seqs[eval_indices]
            eval_masks = candidates_masks[eval_indices]
            probs, _ = oracle_predict(self.oracle_state, eval_seqs, eval_masks)
            oracle_scores[eval_indices] = np.asarray(probs)
            uncertain_indices = eval_indices

        # Level 2: Simulation
        # Always simulate a random subset of HMM-positive samples (on-policy
        # ground truth) PLUS the most uncertain samples. This ensures the model
        # gets simulator feedback on its own outputs, not just on borderline cases.
        sim_candidates = []
        # Half the sim budget goes to random on-policy samples
        n_onpolicy = min(len(positive_indices), self.sim_budget // 2)
        if n_onpolicy > 0:
            rng = np.random.RandomState(int(rng_key[0]) % 2**31 if rng_key is not None else 42)
            onpolicy = rng.choice(positive_indices, n_onpolicy, replace=False)
            sim_candidates.append(onpolicy)
        # Other half goes to most uncertain
        remaining_budget = self.sim_budget - n_onpolicy
        if len(uncertain_indices) > 0 and remaining_budget > 0:
            uncertainties = np.abs(oracle_scores[uncertain_indices] - 0.5)
            sort_order = np.argsort(uncertainties)
            sim_candidates.append(uncertain_indices[sort_order[:remaining_budget]])

        sim_indices = np.concatenate(sim_candidates) if sim_candidates else np.array([], dtype=np.int32)

        # Run simulations
        spreads = np.zeros(N, dtype=np.int32)
        if len(sim_indices) > 0:
            # Extract raw byte sequences for simulation
            sim_seqs_list = []
            for idx in sim_indices:
                length = int(candidates_masks[idx].sum())
                seq = np.asarray(candidates_seqs[idx, :length], dtype=np.uint8)
                sim_seqs_list.append(seq)

            rng_key, subkey = jr.split(rng_key)
            sim_spreads = self.simulate_fn(
                sim_seqs_list, board_size=board_size,
                num_quanta=num_quanta, rng_key=subkey)

            for i, idx in enumerate(sim_indices):
                spreads[idx] = sim_spreads[i]
                labels[idx] = 1.0 if sim_spreads[i] > board_size else 0.0

        return {
            'hmm_scores': hmm_scores,
            'oracle_scores': oracle_scores,
            'labels': labels,
            'sim_indices': sim_indices,
            'spreads': spreads,
        }


# ---------------------------------------------------------------------------
# 3. NCE training step
# ---------------------------------------------------------------------------

def _compute_hmm_log_prob(params, seq, mask):
    """Compute log P(x | HMM) for a single sequence (core mode)."""
    length = mask.sum().astype(jnp.int32)
    return hmm_log_prob_marginal(params, seq, length)


def _compute_hmm_log_prob_full(params, seq, mask):
    """Compute log P(x | HMM) for a single sequence (full mode)."""
    length = mask.sum().astype(jnp.int32)
    return hmm_log_prob_marginal(params, seq, length, mode='full')


_batch_log_prob = jax.vmap(_compute_hmm_log_prob, in_axes=(None, 0, 0))
_batch_log_prob_full = jax.vmap(_compute_hmm_log_prob_full, in_axes=(None, 0, 0))


@partial(jax.jit, static_argnames=())
def nce_train_step(hmm_params, opt_state, batch_seqs, batch_masks,
                   batch_labels, batch_weights, optimizer):
    """One NCE training step with importance-weighted replay.

    Loss = -sum_i w_i * [y_i * log sigma(s(x_i)) + (1-y_i) * log(1-sigma(s(x_i)))]

    where s(x) = log P(x|HMM) + L * ln(256) (log-odds vs null).

    Args:
        hmm_params: HMMParams pytree.
        opt_state: optimizer state.
        batch_seqs: (B, L) int32.
        batch_masks: (B, L) bool.
        batch_labels: (B,) float32 (0 or 1).
        batch_weights: (B,) float32 importance weights.
        optimizer: optax optimizer (static).

    Returns:
        (new_params, new_opt_state, loss).
    """
    def loss_fn(params):
        scores = jax.vmap(_score_single, in_axes=(None, 0, 0))(
            params, batch_seqs, batch_masks)

        # Weighted binary cross-entropy
        log_sigmoid_pos = jax.nn.log_sigmoid(scores)
        log_sigmoid_neg = jax.nn.log_sigmoid(-scores)

        per_sample_loss = -(
            batch_labels * log_sigmoid_pos +
            (1.0 - batch_labels) * log_sigmoid_neg
        )

        # Apply importance weights
        weighted_loss = (batch_weights * per_sample_loss).sum() / batch_weights.sum()
        return weighted_loss

    loss, grads = jax.value_and_grad(loss_fn)(hmm_params)
    updates, new_opt_state = optimizer.update(grads, opt_state, hmm_params)
    new_params = optax.apply_updates(hmm_params, updates)
    new_params = HMMParams(*new_params)
    return new_params, new_opt_state, loss


# Non-JIT wrapper that handles the static optimizer argument
def nce_train_step_wrapper(hmm_params, opt_state, batch_seqs, batch_masks,
                           batch_labels, batch_weights, optimizer):
    """Wrapper that calls the JIT-compiled step with optimizer as a static arg."""
    return _nce_step_inner(optimizer, hmm_params, opt_state,
                           batch_seqs, batch_masks, batch_labels, batch_weights)


NCE_TEMPERATURE = 10.0  # Prevents gradient saturation when scores are extreme


@partial(jax.jit, static_argnames=('optimizer',))
def _nce_step_inner(optimizer, hmm_params, opt_state,
                    batch_seqs, batch_masks, batch_labels, batch_weights):
    """JIT-compiled NCE step with optimizer as static argument (core mode)."""
    def loss_fn(params):
        # Use lax.map + checkpoint to avoid OOM from vmap materializing
        # all intermediate scan matrices simultaneously
        score_fn = jax.checkpoint(lambda args: _score_single(params, args[0], args[1]))
        scores = jax.lax.map(score_fn, (batch_seqs, batch_masks))
        # Temperature scaling: divide by τ to prevent sigmoid saturation
        tempered = scores / NCE_TEMPERATURE
        log_sigmoid_pos = jax.nn.log_sigmoid(tempered)
        log_sigmoid_neg = jax.nn.log_sigmoid(-tempered)
        per_sample_loss = -(
            batch_labels * log_sigmoid_pos +
            (1.0 - batch_labels) * log_sigmoid_neg
        )
        weighted_loss = (batch_weights * per_sample_loss).sum() / batch_weights.sum()
        return weighted_loss

    loss, grads = jax.value_and_grad(loss_fn)(hmm_params)
    updates, new_opt_state = optimizer.update(grads, opt_state, hmm_params)
    new_params = optax.apply_updates(hmm_params, updates)
    new_params = HMMParams(*new_params)
    return new_params, new_opt_state, loss


@partial(jax.jit, static_argnames=('optimizer',))
def _nce_step_inner_full(optimizer, hmm_params, opt_state,
                         batch_seqs, batch_masks, batch_labels, batch_weights):
    """JIT-compiled NCE step for full mode. Uses fori_loop-based Forward
    which compiles fast (seconds, not minutes)."""
    def loss_fn(params):
        score_fn = jax.checkpoint(lambda args: _score_single_full(params, args[0], args[1]))
        scores = jax.lax.map(score_fn, (batch_seqs, batch_masks))
        tempered = scores / NCE_TEMPERATURE
        log_sigmoid_pos = jax.nn.log_sigmoid(tempered)
        log_sigmoid_neg = jax.nn.log_sigmoid(-tempered)
        per_sample_loss = -(
            batch_labels * log_sigmoid_pos +
            (1.0 - batch_labels) * log_sigmoid_neg
        )
        weighted_loss = (batch_weights * per_sample_loss).sum() / batch_weights.sum()
        return weighted_loss

    loss, grads = jax.value_and_grad(loss_fn)(hmm_params)
    updates, new_opt_state = optimizer.update(grads, opt_state, hmm_params)
    new_params = optax.apply_updates(hmm_params, updates)
    new_params = HMMParams(*new_params)
    return new_params, new_opt_state, loss


# ---------------------------------------------------------------------------
# 4. Replay buffer with importance weighting
# ---------------------------------------------------------------------------

class ReplayBuffer:
    """Stores (sequence, mask, label, log_prob_when_sampled) tuples.

    Supports importance-weighted sampling:
    - When sampling a minibatch, compute current log_prob for each
    - Importance weight = exp(current_log_prob - stored_log_prob)
    - Clip weights PPO-style to prevent stale samples from dominating
    - Optionally evict samples with extreme weights (too stale)
    """

    def __init__(self, max_size=10000, max_len=32, mode='core'):
        self.max_size = max_size
        self.max_len = max_len
        self.mode = mode
        self.sequences = np.zeros((max_size, max_len), dtype=np.int32)
        self.masks = np.zeros((max_size, max_len), dtype=bool)
        self.labels = np.zeros(max_size, dtype=np.float32)
        self.log_probs = np.zeros(max_size, dtype=np.float32)
        self.size = 0
        self.write_pos = 0

    def add(self, sequences, masks, labels, log_probs):
        """Add examples to the buffer.

        Args:
            sequences: (N, L) int32.
            masks: (N, L) bool.
            labels: (N,) float32.
            log_probs: (N,) float32 log P(x|HMM) at time of sampling.
        """
        sequences = np.asarray(sequences)
        masks = np.asarray(masks)
        labels = np.asarray(labels)
        log_probs = np.asarray(log_probs)

        N = len(labels)
        L = sequences.shape[1]

        for i in range(N):
            pos = self.write_pos % self.max_size
            self.sequences[pos, :L] = sequences[i, :L]
            self.sequences[pos, L:] = 0
            self.masks[pos, :L] = masks[i, :L]
            self.masks[pos, L:] = False
            self.labels[pos] = labels[i]
            self.log_probs[pos] = log_probs[i]
            self.write_pos += 1
            self.size = min(self.size + 1, self.max_size)

    def sample_batch(self, hmm_params, batch_size=64, rng_key=None,
                     clip_lo=0.2, clip_hi=5.0):
        """Sample a minibatch with importance weights.

        Args:
            hmm_params: current HMM params (for computing importance weights).
            batch_size: minibatch size.
            rng_key: JAX PRNG key.
            clip_lo: lower clip for importance weights.
            clip_hi: upper clip for importance weights.

        Returns:
            dict with 'sequences', 'masks', 'labels', 'weights' as arrays.
        """
        if rng_key is None:
            rng_key = jr.PRNGKey(0)

        if self.size == 0:
            return None

        actual_batch = min(batch_size, self.size)

        # Random sample indices
        indices = np.asarray(jr.randint(rng_key, (actual_batch,), 0, self.size))

        seqs = jnp.array(self.sequences[indices])
        msks = jnp.array(self.masks[indices])
        lbls = jnp.array(self.labels[indices])
        old_lps = self.log_probs[indices]

        # Compute current log probs (use correct mode)
        if self.mode == 'full':
            # Score one at a time to avoid OOM on long sequences
            current_lps = np.array([
                float(_compute_hmm_log_prob_full(hmm_params, seqs[i], msks[i]))
                for i in range(actual_batch)
            ], dtype=np.float32)
        else:
            current_lps = np.asarray(_batch_log_prob(hmm_params, seqs, msks))

        # Importance weights: exp(current - old), clipped
        log_ratios = current_lps - old_lps
        weights = np.clip(np.exp(log_ratios), clip_lo, clip_hi)

        return {
            'sequences': seqs,
            'masks': msks,
            'labels': lbls,
            'weights': jnp.array(weights, dtype=jnp.float32),
        }

    def viable_count(self):
        """Count viable examples in the buffer."""
        return int(self.labels[:self.size].sum())


# ---------------------------------------------------------------------------
# 5. Sampling helpers
# ---------------------------------------------------------------------------

def _pad_sequences(byte_arrays, max_len=32):
    """Pad variable-length byte arrays to fixed length.

    Returns:
        (sequences, masks) as numpy arrays.
    """
    N = len(byte_arrays)
    seq_np = np.zeros((N, max_len), dtype=np.int32)
    mask_np = np.zeros((N, max_len), dtype=bool)

    for i, arr in enumerate(byte_arrays):
        if arr is None:
            continue
        length = min(len(arr), max_len)
        seq_np[i, :length] = np.asarray(arr[:length], dtype=np.int32)
        mask_np[i, :length] = True

    return seq_np, mask_np


def sample_from_hmm(hmm_params, n_samples, lengths, rng_key, max_len=32,
                    mode='core'):
    """Sample n_samples candidates from the HMM at various lengths.

    Args:
        hmm_params: HMMParams.
        n_samples: total number of samples.
        lengths: list of target lengths to sample.
        rng_key: JAX PRNG key.
        max_len: max padded length.
        mode: 'core' or 'full'.

    Returns:
        (sequences, masks) as jnp arrays of shape (n_samples, max_len).
    """
    samples_per_length = max(1, n_samples // len(lengths))
    all_samples = []

    for target_len in lengths:
        for _ in range(samples_per_length):
            rng_key, subkey = jr.split(rng_key)
            sample = hmm_sample(hmm_params, target_len, subkey, mode=mode)
            all_samples.append(sample)

    # Pad to n_samples if needed
    while len(all_samples) < n_samples:
        rng_key, subkey = jr.split(rng_key)
        target_len = lengths[len(all_samples) % len(lengths)]
        sample = hmm_sample(hmm_params, target_len, subkey, mode=mode)
        all_samples.append(sample)

    all_samples = all_samples[:n_samples]
    seq_np, mask_np = _pad_sequences(all_samples, max_len=max_len)
    return jnp.array(seq_np), jnp.array(mask_np)


# ---------------------------------------------------------------------------
# 6. Mixture EMA update (hybrid with gradient)
# ---------------------------------------------------------------------------

def ema_mixture_update(hmm_params, viable_seqs, viable_masks, alpha=0.01):
    """Exponential moving average update on insert emission statistics.

    For each viable sequence, increment counts for the bytes that appear
    in insert positions. This provides a smoother update path than pure
    gradient descent on the mixture logits.

    Args:
        hmm_params: current HMMParams.
        viable_seqs: (N, L) int32 viable sequences.
        viable_masks: (N, L) bool masks.
        alpha: EMA decay rate.

    Returns:
        Updated HMMParams with new emission distributions.
    """
    N = viable_seqs.shape[0]
    if N == 0:
        return hmm_params

    # Accumulate byte frequency from viable sequences
    # This is a simplified version that treats all positions as potential inserts
    viable_seqs_np = np.asarray(viable_seqs)
    viable_masks_np = np.asarray(viable_masks)

    # Count byte frequencies across all viable sequences
    byte_counts = np.zeros(256, dtype=np.float64)
    total = 0
    for i in range(N):
        length = int(viable_masks_np[i].sum())
        for pos in range(length):
            b = viable_seqs_np[i, pos]
            byte_counts[b] += 1.0
            total += 1

    if total == 0:
        return hmm_params

    # Normalize to log-probabilities
    byte_probs = byte_counts / total
    byte_log_probs = np.log(np.maximum(byte_probs, 1e-30))

    # EMA update on 1-byte insert logits (all positions get the same update)
    old_logits = np.asarray(hmm_params.insert_1byte_logits)  # [P, 256]
    new_logits = (1.0 - alpha) * old_logits + alpha * byte_log_probs.astype(np.float32)[None, :]

    return hmm_params._replace(
        insert_1byte_logits=jnp.array(new_logits)
    )


# ---------------------------------------------------------------------------
# 7. Metrics and logging
# ---------------------------------------------------------------------------

def compute_metrics(hmm_params, replay_buffer, epoch):
    """Compute training metrics.

    Args:
        hmm_params: current HMMParams.
        replay_buffer: ReplayBuffer with training data.
        epoch: current epoch number.

    Returns:
        dict of metrics.
    """
    metrics = {'epoch': epoch}

    if replay_buffer.size == 0:
        metrics['beff'] = float('inf')
        metrics['viable_rate'] = 0.0
        metrics['insert_entropy'] = 0.0
        metrics['buffer_size'] = 0
        return metrics

    # Viable rate: fraction of buffered examples that are viable
    viable_count = replay_buffer.viable_count()
    metrics['viable_rate'] = viable_count / max(1, replay_buffer.size)
    metrics['buffer_size'] = replay_buffer.size

    # B_eff estimate: effective bits to find a viable sequence
    # B_eff = -log2(P(viable | HMM))
    # Estimated via the empirical viable rate from simulation
    viable_rate = metrics['viable_rate']
    if viable_rate > 0:
        metrics['beff'] = -np.log2(viable_rate)
    else:
        metrics['beff'] = float('inf')

    # Insert emission entropy (average across positions)
    log_probs = jax.nn.log_softmax(hmm_params.insert_1byte_logits, axis=-1)  # [P, 256]
    probs = jnp.exp(log_probs)
    entropy = -float(jnp.sum(probs * log_probs) / probs.shape[0])
    metrics['insert_entropy'] = entropy

    # Score statistics on buffer contents
    sample_size = min(100, replay_buffer.size)
    seqs = jnp.array(replay_buffer.sequences[:sample_size])
    msks = jnp.array(replay_buffer.masks[:sample_size])
    scores = np.asarray(hmm_score_batch(hmm_params, seqs, msks))
    metrics['score_mean'] = float(np.mean(scores))
    metrics['score_std'] = float(np.std(scores))

    return metrics


# ---------------------------------------------------------------------------
# 8. Full training loop
# ---------------------------------------------------------------------------


# Known viable 8-byte replicator core variants.
# Only BCC works in mode B (register save) because carry flag behavior
# is correct across quantum boundaries: carry is clear during the copy
# loop and only gets set on the final INX/DEX wrap (X: 0xFF->0x00 or 0x00->0xFF).
# Other branches (BNE, BPL, BMI, BVS, BCS, BVC) fail because their flag
# conditions don't survive register save/restore correctly.
KNOWN_VIABLE_CORES = [
    [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8],  # BCC, INX
    [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xCA, 0x90, 0xF8],  # BCC, DEX
]


def train_hmm_nce(hmm_params, oracle_state=None,
                  board_size=8, num_epochs=100,
                  samples_per_epoch=1000, sim_budget_per_epoch=100,
                  oracle_budget_per_epoch=500,
                  learning_rate=1e-3, replay_buffer_size=10000,
                  rng_seed=42, lengths=None, max_len=32,
                  num_quanta=200, verbose=True,
                  mode='core', chacha_ratio=0.3,
                  seed_with_known=True):
    """Full NCE training loop with ChaCha20-sourced negatives.

    Each epoch:
      1. Sample N_hmm candidates from HMM -> simulate -> labeled.
      2. Generate N_chacha cells from ChaCha20 -> all labeled negative
         (unless one passes simulation, which is a jackpot).
      3. Combine into one batch for NCE gradient step.
      4. Sample minibatch from replay buffer with importance weights.
      5. NCE gradient step on HMM params (through associative scan).
      6. Periodically apply EMA mixture update on viable examples.
      7. Log metrics.

    Args:
        hmm_params: initial HMMParams.
        oracle_state: optional neural oracle TrainState.
        board_size: board size for simulation.
        num_epochs: number of training epochs.
        samples_per_epoch: total candidates per epoch (HMM + ChaCha20).
        sim_budget_per_epoch: max simulations per epoch.
        oracle_budget_per_epoch: max oracle evaluations per epoch.
        learning_rate: AdamW learning rate.
        replay_buffer_size: max replay buffer size.
        rng_seed: random seed.
        lengths: list of target sequence lengths (default [8, 10, 12]).
        max_len: max padded length for sequences.
        num_quanta: quanta per simulation.
        verbose: print progress.
        mode: 'core' (L=8) or 'full' (L=256).
        chacha_ratio: fraction of samples from ChaCha20 (default 0.3).

    Returns:
        (trained_params, history, replay_buffer).
    """
    if mode == 'full':
        if lengths is None:
            lengths = [256]
        if max_len < 256:
            max_len = 256

    if lengths is None:
        lengths = [8, 10, 12]

    # Select mode-appropriate functions
    score_fn = _score_single_full if mode == 'full' else _score_single
    nce_step_fn = _nce_step_inner_full if mode == 'full' else _nce_step_inner
    batch_lp_fn = _batch_log_prob_full if mode == 'full' else _batch_log_prob
    cell_bytes = max_len if mode == 'full' else max_len

    # Compute sample counts
    n_chacha = max(1, int(samples_per_epoch * chacha_ratio))
    n_hmm = samples_per_epoch - n_chacha

    rng_key = jr.PRNGKey(rng_seed)

    # Set up optimizer
    optimizer = optax.adamw(learning_rate, weight_decay=0.01)
    opt_state = optimizer.init(hmm_params)

    # Set up replay buffer
    buffer = ReplayBuffer(max_size=replay_buffer_size, max_len=max_len, mode=mode)

    # Seed with known viable replicators (bootstrap the NCE training)
    if seed_with_known:
        n_seed = len(KNOWN_VIABLE_CORES)
        seed_seqs = np.zeros((n_seed, max_len), dtype=np.int32)
        seed_masks = np.zeros((n_seed, max_len), dtype=np.float32)
        for i, core in enumerate(KNOWN_VIABLE_CORES):
            L = len(core)
            seed_seqs[i, :L] = core
            seed_masks[i, :L] = 1.0
        seed_labels = np.ones(n_seed, dtype=np.float32)  # all viable
        seed_lps = np.asarray(batch_lp_fn(
            hmm_params,
            jnp.array(seed_seqs),
            jnp.array(seed_masks)))
        buffer.add(seed_seqs, seed_masks, seed_labels, seed_lps)
        if verbose:
            print(f"Seeded replay buffer with {n_seed} known viable replicators")

    # Set up oracle cascade
    cascade = OracleCascade(
        hmm_params=hmm_params,
        oracle_state=oracle_state,
        simulate_fn=partial(simulate_batch_python,
                            board_size=board_size,
                            num_quanta=num_quanta),
        hmm_threshold=20.0,
        oracle_budget=oracle_budget_per_epoch,
        sim_budget=sim_budget_per_epoch,
        mode=mode,
    )

    history = []

    for epoch in range(num_epochs):
        t0 = time.time()

        rng_key, sample_key, chacha_key, cascade_key, buffer_key = jr.split(rng_key, 5)

        # 1. Sample candidates from HMM
        hmm_seqs, hmm_masks = sample_from_hmm(
            hmm_params, n_hmm, lengths, sample_key, max_len=max_len,
            mode=mode)

        # 2. Generate ChaCha20 negatives
        chacha_seqs, chacha_masks = generate_chacha20_negatives(
            n_chacha, chacha_key, cell_bytes=max_len,
            board_size=board_size if board_size >= 4 else 4)
        # Truncate/pad to max_len if needed
        if chacha_seqs.shape[1] != max_len:
            if chacha_seqs.shape[1] > max_len:
                chacha_seqs = chacha_seqs[:, :max_len]
                chacha_masks = chacha_masks[:, :max_len]
            else:
                pad_w = max_len - chacha_seqs.shape[1]
                chacha_seqs = jnp.pad(chacha_seqs, ((0, 0), (0, pad_w)))
                chacha_masks = jnp.pad(chacha_masks, ((0, 0), (0, pad_w)))

        # 3. Run HMM candidates through oracle cascade
        cascade.hmm_params = hmm_params
        result = cascade.evaluate(hmm_seqs, hmm_masks, cascade_key,
                                  board_size=board_size,
                                  num_quanta=num_quanta)

        # 4. Add labeled HMM examples to replay buffer
        labeled_mask = ~np.isnan(result['labels'])
        if labeled_mask.any():
            labeled_indices = np.where(labeled_mask)[0]
            labeled_seqs = np.asarray(hmm_seqs[labeled_indices])
            labeled_masks = np.asarray(hmm_masks[labeled_indices])
            labeled_labels = result['labels'][labeled_indices]
            if mode == 'full' and len(labeled_indices) > 0:
                labeled_lps = np.array([
                    float(_compute_hmm_log_prob_full(
                        hmm_params,
                        jnp.array(labeled_seqs[i]),
                        jnp.array(labeled_masks[i])))
                    for i in range(len(labeled_indices))
                ], dtype=np.float32)
            else:
                labeled_lps = np.asarray(batch_lp_fn(
                    hmm_params,
                    jnp.array(labeled_seqs),
                    jnp.array(labeled_masks)))
            buffer.add(labeled_seqs, labeled_masks, labeled_labels, labeled_lps)

        # 5. Add ChaCha20 negatives to replay buffer (all labeled 0)
        chacha_labels = np.zeros(n_chacha, dtype=np.float32)
        if mode == 'full' and n_chacha > 0:
            # Score one at a time to avoid OOM on long sequences
            chacha_lps = np.array([
                float(_compute_hmm_log_prob_full(
                    hmm_params, chacha_seqs[i], chacha_masks[i]))
                for i in range(n_chacha)
            ], dtype=np.float32)
        else:
            chacha_lps = np.asarray(batch_lp_fn(
                hmm_params, chacha_seqs, chacha_masks))
        buffer.add(np.asarray(chacha_seqs), np.asarray(chacha_masks),
                   chacha_labels, chacha_lps)

        # 6. Sample minibatch from replay buffer and do NCE step
        if buffer.size >= 8:
            nce_batch_size = 16 if mode == 'full' else 64
            batch = buffer.sample_batch(hmm_params, batch_size=nce_batch_size,
                                        rng_key=buffer_key)
            if batch is not None:
                hmm_params, opt_state, loss = nce_step_fn(
                    optimizer, hmm_params, opt_state,
                    batch['sequences'], batch['masks'],
                    batch['labels'], batch['weights'])
                loss_val = float(loss)
            else:
                loss_val = float('nan')
        else:
            loss_val = float('nan')

        # 7. Periodically apply EMA mixture update
        if (epoch + 1) % 5 == 0 and buffer.viable_count() > 0:
            viable_idx = np.where(buffer.labels[:buffer.size] > 0.5)[0]
            if len(viable_idx) > 0:
                viable_seqs_buf = jnp.array(buffer.sequences[viable_idx])
                viable_masks_buf = jnp.array(buffer.masks[viable_idx])
                hmm_params = ema_mixture_update(
                    hmm_params, viable_seqs_buf, viable_masks_buf, alpha=0.01)
                opt_state = optimizer.init(hmm_params)

        # 8. Compute and log metrics
        metrics = compute_metrics(hmm_params, buffer, epoch)
        metrics['loss'] = loss_val
        metrics['time'] = time.time() - t0
        metrics['sim_count'] = len(result.get('sim_indices', []))
        metrics['n_chacha'] = n_chacha
        metrics['n_hmm'] = n_hmm
        metrics['mode'] = mode

        if labeled_mask.any():
            new_viable = int((result['labels'][labeled_mask] > 0.5).sum())
            metrics['new_viable'] = new_viable
        else:
            metrics['new_viable'] = 0

        history.append(metrics)

        if verbose:
            print(f"Epoch {epoch:4d}: loss={loss_val:8.4f}  "
                  f"B_eff={metrics['beff']:6.1f}  "
                  f"viable_rate={metrics['viable_rate']:.4f}  "
                  f"new_viable={metrics['new_viable']}  "
                  f"buffer={buffer.size}  "
                  f"entropy={metrics['insert_entropy']:.2f}  "
                  f"chacha={n_chacha}  "
                  f"time={metrics['time']:.1f}s")

    return hmm_params, history, buffer


# ---------------------------------------------------------------------------
# 9. IS-based B_eff estimation
# ---------------------------------------------------------------------------

def estimate_beff_is(hmm_params, num_samples=1000, mode='full', rng_seed=42,
                     board_size=8, num_quanta=200, lengths=None, max_len=256,
                     verbose=False):
    """Importance sampling estimate of B_eff.

    Sample from HMM, simulate each, compute:
    P(viable) ~ (1/N) sum_{viable} 2^{-s_theta(x)}

    where s_theta(x) = log P(x|HMM) + 8L is the log-odds vs uniform.

    B_eff = -log2(P(viable))
    H(X|viable) = 8L - B_eff

    Also compute effective sample size (ESS) and confidence interval.

    Args:
        hmm_params: trained HMMParams.
        num_samples: number of IS samples.
        mode: 'core' or 'full'.
        rng_seed: random seed.
        board_size: board size for simulation.
        num_quanta: quanta per simulation.
        lengths: target lengths to sample.
        max_len: max padded length.
        verbose: print progress.

    Returns:
        dict with 'beff', 'p_viable', 'ess', 'n_viable', 'ci_lo', 'ci_hi',
        'entropy_given_viable'.
    """
    if mode == 'full':
        if lengths is None:
            lengths = [256]
        if max_len < 256:
            max_len = 256
    else:
        if lengths is None:
            lengths = [8, 10, 12]

    rng_key = jr.PRNGKey(rng_seed)

    # Sample from HMM
    rng_key, sample_key = jr.split(rng_key)
    seqs, masks = sample_from_hmm(hmm_params, num_samples, lengths,
                                   sample_key, max_len=max_len, mode=mode)

    # Compute log-odds scores s_theta(x)
    score_fn = hmm_score_batch_full if mode == 'full' else hmm_score_batch
    scores = np.asarray(score_fn(hmm_params, seqs, masks))

    # Simulate all samples
    rng_key, sim_key = jr.split(rng_key)
    seqs_list = []
    for i in range(num_samples):
        length = int(masks[i].sum())
        seq = np.asarray(seqs[i, :length], dtype=np.uint8)
        seqs_list.append(seq)

    spreads = simulate_batch_python(seqs_list, board_size=board_size,
                                     num_quanta=num_quanta, rng_key=sim_key)
    viable = spreads > board_size

    # IS weights: w_i = 2^{-s_theta(x_i)} = exp(-s_theta(x_i) * ln(2))
    # For viable samples only
    log2_weights = -scores / np.log(2.0)

    n_viable = int(viable.sum())
    if n_viable == 0:
        return {
            'beff': float('inf'),
            'p_viable': 0.0,
            'ess': 0.0,
            'n_viable': 0,
            'ci_lo': float('inf'),
            'ci_hi': float('inf'),
            'entropy_given_viable': 0.0,
            'num_samples': num_samples,
        }

    # P(viable) ~ (1/N) sum_{viable} 2^{-s(x)}
    viable_log2_weights = log2_weights[viable]
    # Use logsumexp for numerical stability
    max_lw = viable_log2_weights.max()
    log2_p = max_lw + np.log2(np.exp2(viable_log2_weights - max_lw).sum()) - np.log2(num_samples)
    p_viable = 2.0 ** log2_p
    beff = -log2_p

    # Effective sample size
    weights = np.exp2(viable_log2_weights)
    ess = (weights.sum() ** 2) / (weights ** 2).sum()

    # Confidence interval (bootstrap-style via weight variance)
    w_mean = weights.mean()
    w_std = weights.std()
    if w_mean > 0:
        cv = w_std / w_mean  # coefficient of variation
        ci_half = 1.96 * cv / np.sqrt(n_viable)
        ci_lo = beff - ci_half / np.log(2.0) if p_viable > 0 else float('inf')
        ci_hi = beff + ci_half / np.log(2.0) if p_viable > 0 else float('inf')
    else:
        ci_lo = ci_hi = float('inf')

    # Entropy: H(X|viable) = 8*L - B_eff
    L = int(masks[0].sum())
    entropy = 8.0 * L - beff

    result = {
        'beff': float(beff),
        'p_viable': float(p_viable),
        'ess': float(ess),
        'n_viable': n_viable,
        'ci_lo': float(ci_lo),
        'ci_hi': float(ci_hi),
        'entropy_given_viable': float(entropy),
        'num_samples': num_samples,
    }

    if verbose:
        print(f"IS B_eff estimate: {beff:.2f} bits")
        print(f"  P(viable) = {p_viable:.2e}")
        print(f"  ESS = {ess:.1f} / {n_viable} viable / {num_samples} total")
        print(f"  95% CI: [{ci_lo:.2f}, {ci_hi:.2f}]")
        print(f"  H(X|viable) = {entropy:.1f} bits")

    return result


# ---------------------------------------------------------------------------
# 10. Save/load
# ---------------------------------------------------------------------------

def save_params(hmm_params, path):
    """Save HMM params to .npz file."""
    np.savez(path, **{
        name: np.asarray(val) for name, val in zip(hmm_params._fields, hmm_params)
    })


def load_params(path):
    """Load HMM params from .npz file."""
    data = np.load(path)
    return HMMParams(**{name: jnp.array(data[name]) for name in HMMParams._fields})


# ---------------------------------------------------------------------------
# 12. Entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Train HMM replicator generator via NCE')
    parser.add_argument('--epochs', type=int, default=100)
    parser.add_argument('--board-size', type=int, default=8)
    parser.add_argument('--samples', type=int, default=1000)
    parser.add_argument('--sim-budget', type=int, default=100)
    parser.add_argument('--lengths', type=int, nargs='+', default=None)
    parser.add_argument('--lr', type=float, default=1e-3)
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--num-quanta', type=int, default=200)
    parser.add_argument('--save', type=str, default='hmm_trained.npz')
    parser.add_argument('--mode', type=str, default='core',
                        choices=['core', 'full'],
                        help='HMM mode: core (L=8) or full (L=256)')
    parser.add_argument('--chacha-ratio', type=float, default=0.3,
                        help='Fraction of samples from ChaCha20 negatives')
    args = parser.parse_args()

    # Set defaults based on mode
    if args.lengths is None:
        if args.mode == 'full':
            args.lengths = [256]
        else:
            args.lengths = [8, 10, 12]

    max_len = 256 if args.mode == 'full' else 32

    # Initialize
    hmm_params = default_params(mode=args.mode)
    n_params = count_params(hmm_params)
    print(f"HMM parameters: {n_params}")
    print(f"Mode: {args.mode}")
    print(f"Training for {args.epochs} epochs, "
          f"{args.samples} samples/epoch, "
          f"{args.sim_budget} sims/epoch")
    print(f"Lengths: {args.lengths}")
    print(f"ChaCha20 ratio: {args.chacha_ratio:.0%}")
    print()

    # Train
    hmm_params, history, buffer = train_hmm_nce(
        hmm_params,
        board_size=args.board_size,
        num_epochs=args.epochs,
        samples_per_epoch=args.samples,
        sim_budget_per_epoch=args.sim_budget,
        lengths=args.lengths,
        learning_rate=args.lr,
        rng_seed=args.seed,
        num_quanta=args.num_quanta,
        mode=args.mode,
        chacha_ratio=args.chacha_ratio,
        max_len=max_len,
    )

    # Save
    save_params(hmm_params, args.save)
    print(f"\nTrained HMM saved to {args.save}")

    # Report
    print("\nFinal epochs:")
    for h in history[-5:]:
        print(f"  Epoch {h['epoch']}: B_eff={h['beff']:.1f}, "
              f"viable_rate={h['viable_rate']:.4f}, "
              f"loss={h['loss']:.4f}")
