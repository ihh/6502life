"""Tests for the JAX profile HMM implementation."""

import pytest
import subprocess
import json

try:
    import jax
    import jax.numpy as jnp
    import numpy as np
    HAS_JAX = True
except ImportError:
    HAS_JAX = False

pytestmark = pytest.mark.skipif(not HAS_JAX, reason="JAX/Optax not installed")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def params():
    """Default HMM parameters."""
    from jax6502.hmm import default_params
    return default_params()


@pytest.fixture(scope="module")
def minimal_replicator():
    """The minimal 8-byte replicator: B5 00 9D 00 04 E8 90 F8."""
    return jnp.array([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8],
                     dtype=jnp.int32)


# ---------------------------------------------------------------------------
# Test 1: Cross-validation — minimal replicator
# ---------------------------------------------------------------------------

def test_minimal_replicator_score(params, minimal_replicator):
    """JAX log-probability for the minimal replicator should be finite
    and negative (it's a log-probability)."""
    from jax6502.hmm import hmm_log_prob, hmm_log_prob_marginal

    # M1 is at position 0 for the minimal replicator
    length = jnp.int32(8)
    m1_pos = jnp.int32(0)

    log_p = hmm_log_prob(params, minimal_replicator, length, m1_pos)
    log_p_val = float(log_p)

    assert np.isfinite(log_p_val), f"Log-prob should be finite, got {log_p_val}"
    assert log_p_val < 0, f"Log-prob should be negative, got {log_p_val}"

    # Marginal should also work (and equal the single-M1 result since
    # there's only one 0xB5 byte)
    log_p_marg = hmm_log_prob_marginal(params, minimal_replicator, length)
    log_p_marg_val = float(log_p_marg)

    assert np.isfinite(log_p_marg_val), \
        f"Marginal log-prob should be finite, got {log_p_marg_val}"
    assert abs(log_p_val - log_p_marg_val) < 1e-3, \
        f"Marginal should match single-M1: {log_p_val} vs {log_p_marg_val}"


# ---------------------------------------------------------------------------
# Test 2: Cross-validation with inserts — NOP prefix
# ---------------------------------------------------------------------------

def test_nop_prefix_score(params):
    """Sequence with NOP (0xEA) prefix should have finite score."""
    from jax6502.hmm import hmm_log_prob_marginal

    # NOP + minimal replicator = 9 bytes, M1 at position 1
    seq = jnp.array([0xEA, 0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF7],
                    dtype=jnp.int32)
    # Branch offset: -(8 - 1 + 1) = -8 = 0xF8... wait, let me recalculate.
    # M1 is at position 1. M8 is at position 8.
    # offset = -(pos_M8 - m1_pos + 1) & 0xFF = -(8 - 1 + 1) & 0xFF
    #        = -8 & 0xFF = 0xF8
    # But in the JS code, the offset for M8 at position p, M1 at m1:
    # offset = -(p - m1 + 1) & 0xFF
    # For the matrix: I_7 -> I_8 transition at position p with M8,
    # expected_offset = -(p - m1_pos + 1) & 0xFF
    # p = 8, m1 = 1: -(8 - 1 + 1) = -8 = 0xF8
    seq = jnp.array([0xEA, 0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8],
                    dtype=jnp.int32)

    length = jnp.int32(9)
    log_p = hmm_log_prob_marginal(params, seq, length)
    log_p_val = float(log_p)

    assert np.isfinite(log_p_val), f"NOP-prefix log-prob should be finite, got {log_p_val}"
    assert log_p_val < 0, f"Log-prob should be negative, got {log_p_val}"


# ---------------------------------------------------------------------------
# Test 3: Gradient flow
# ---------------------------------------------------------------------------

def test_gradient_flow(params, minimal_replicator):
    """jax.grad should produce finite gradients for all parameters."""
    from jax6502.hmm import hmm_log_prob

    length = jnp.int32(8)
    m1_pos = jnp.int32(0)

    def loss_fn(p):
        return hmm_log_prob(p, minimal_replicator, length, m1_pos)

    grads = jax.grad(loss_fn)(params)

    for name, g in zip(params._fields, grads):
        assert jnp.all(jnp.isfinite(g)), \
            f"Gradient for {name} has non-finite values: {g}"


# ---------------------------------------------------------------------------
# Test 4: Discriminative loss decreases
# ---------------------------------------------------------------------------

def test_loss_decreases(params, minimal_replicator):
    """After training steps, discriminative loss should decrease."""
    from jax6502.hmm import train, discriminative_loss, HMMParams

    max_len = 16

    # Start with uniform insert emission logits so the model can't
    # distinguish viable from non-viable sequences well.
    bad_params = params._replace(
        insert_1byte_logits=jnp.zeros(256),
        path_mix_logits=jnp.zeros(3),
        match6_logits=jnp.zeros(2),
        match7_logits=jnp.zeros(7),
    )

    # Viable: minimal replicator (B5 00 9D 00 04 E8 90 F8)
    viable_seq = jnp.zeros((1, max_len), dtype=jnp.int32)
    viable_seq = viable_seq.at[0, :8].set(minimal_replicator)
    viable_mask = jnp.zeros((1, max_len), dtype=jnp.bool_)
    viable_mask = viable_mask.at[0, :8].set(True)

    # Non-viable: same structure but uses DEX instead of INX, and BCS
    # instead of BCC. Both are valid under the HMM but with different
    # match emissions at M6 and M7.
    # B5 00 9D 00 04 CA(DEX) B0(BCS) F8
    nonviable_data = jnp.array([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xCA, 0xB0, 0xF8],
                               dtype=jnp.int32)
    nonviable_seq = jnp.zeros((1, max_len), dtype=jnp.int32)
    nonviable_seq = nonviable_seq.at[0, :8].set(nonviable_data)
    nonviable_mask = jnp.zeros((1, max_len), dtype=jnp.bool_)
    nonviable_mask = nonviable_mask.at[0, :8].set(True)

    final_params, losses = train(
        bad_params, viable_seq, viable_mask,
        nonviable_seq, nonviable_mask,
        epochs=50, lr=1e-1)

    # Loss should decrease (compare first 5 vs last 5)
    early_loss = np.mean(losses[:5])
    late_loss = np.mean(losses[-5:])
    assert late_loss < early_loss, \
        f"Loss should decrease: early={early_loss:.4f}, late={late_loss:.4f}"


# ---------------------------------------------------------------------------
# Test 5: Score ordering
# ---------------------------------------------------------------------------

def test_score_ordering(params, minimal_replicator):
    """Trained model should score viable sequence higher than random."""
    from jax6502.hmm import train, hmm_score_batch

    max_len = 16
    viable_seq = jnp.zeros((1, max_len), dtype=jnp.int32)
    viable_seq = viable_seq.at[0, :8].set(minimal_replicator)
    viable_mask = jnp.zeros((1, max_len), dtype=jnp.bool_)
    viable_mask = viable_mask.at[0, :8].set(True)

    rng = jax.random.PRNGKey(99)
    nonviable_seq = jax.random.randint(rng, (1, max_len), 0, 256,
                                        dtype=jnp.int32)
    nonviable_mask = jnp.ones((1, max_len), dtype=jnp.bool_)

    trained_params, _ = train(
        params, viable_seq, viable_mask,
        nonviable_seq, nonviable_mask,
        epochs=100, lr=1e-2)

    # Score both sequences
    all_seqs = jnp.concatenate([viable_seq, nonviable_seq], axis=0)
    all_masks = jnp.concatenate([viable_mask, nonviable_mask], axis=0)
    scores = hmm_score_batch(trained_params, all_seqs, all_masks)

    viable_score = float(scores[0])
    random_score = float(scores[1])
    assert viable_score > random_score, \
        f"Viable score ({viable_score:.4f}) should exceed random ({random_score:.4f})"


# ---------------------------------------------------------------------------
# Test 6: Batch consistency
# ---------------------------------------------------------------------------

def test_batch_consistency(params, minimal_replicator):
    """Single sequence score should match its score within a batch."""
    from jax6502.hmm import hmm_score_batch, _score_single

    max_len = 16
    seq = jnp.zeros((1, max_len), dtype=jnp.int32)
    seq = seq.at[0, :8].set(minimal_replicator)
    mask = jnp.zeros((1, max_len), dtype=jnp.bool_)
    mask = mask.at[0, :8].set(True)

    # Single score
    single_score = float(_score_single(params, seq[0], mask[0]))

    # Batch score (batch of 1)
    batch_scores = hmm_score_batch(params, seq, mask)
    batch_score = float(batch_scores[0])

    assert abs(single_score - batch_score) < 1e-3, \
        f"Single ({single_score:.6f}) vs batch ({batch_score:.6f})"


# ---------------------------------------------------------------------------
# Test 7: Masking
# ---------------------------------------------------------------------------

def test_masking(params, minimal_replicator):
    """Padded positions should not affect the score."""
    from jax6502.hmm import hmm_score_batch

    max_len = 16

    # Sequence padded with zeros
    seq1 = jnp.zeros((1, max_len), dtype=jnp.int32)
    seq1 = seq1.at[0, :8].set(minimal_replicator)
    mask1 = jnp.zeros((1, max_len), dtype=jnp.bool_)
    mask1 = mask1.at[0, :8].set(True)

    # Same sequence padded with 0xFF
    seq2 = jnp.full((1, max_len), 0xFF, dtype=jnp.int32)
    seq2 = seq2.at[0, :8].set(minimal_replicator)
    mask2 = mask1  # same mask

    score1 = float(hmm_score_batch(params, seq1, mask1)[0])
    score2 = float(hmm_score_batch(params, seq2, mask2)[0])

    assert abs(score1 - score2) < 1e-3, \
        f"Padding should not matter: {score1:.6f} vs {score2:.6f}"


# ---------------------------------------------------------------------------
# Test 8: Associative scan vs sequential scan
# ---------------------------------------------------------------------------

def test_scan_vs_sequential(params, minimal_replicator):
    """Associative scan should produce the same result as sequential."""
    from jax6502.hmm import hmm_log_prob, hmm_log_prob_sequential

    length = jnp.int32(8)
    m1_pos = jnp.int32(0)

    scan_result = float(hmm_log_prob(params, minimal_replicator, length, m1_pos))
    seq_result = float(hmm_log_prob_sequential(
        params, minimal_replicator, length, m1_pos))

    assert abs(scan_result - seq_result) < 1e-2, \
        f"Scan ({scan_result:.6f}) vs sequential ({seq_result:.6f})"


# ---------------------------------------------------------------------------
# Test 9: Sampler produces valid sequences
# ---------------------------------------------------------------------------

def test_sampler_valid(params):
    """Sampled sequences should contain correct match bytes and valid offset."""
    from jax6502.hmm import hmm_sample

    rng = jax.random.PRNGKey(123)
    n_valid = 0

    for i in range(20):
        rng, subkey = jax.random.split(rng)
        seq = hmm_sample(params, 10, subkey)
        if seq is None:
            continue

        seq_np = np.array(seq)
        assert len(seq_np) == 10, f"Expected length 10, got {len(seq_np)}"

        # Find M1 (0xB5)
        m1_positions = np.where(seq_np == 0xB5)[0]
        if len(m1_positions) == 0:
            continue

        # Check at least one valid alignment exists
        for m1 in m1_positions:
            if m1 + 7 >= len(seq_np):
                continue
            # Check M2 = 0x00
            if seq_np[m1 + 1] != 0x00:
                continue
            # Check M3 = 0x9D
            if seq_np[m1 + 2] != 0x9D:
                continue
            # We found a valid start of the match pattern
            n_valid += 1
            break

    assert n_valid > 0, "At least some sampled sequences should have valid match bytes"


# ---------------------------------------------------------------------------
# Test 10: Parameter count
# ---------------------------------------------------------------------------

def test_parameter_count(params):
    """Total parameters should be in the 4K-5K range."""
    from jax6502.hmm import count_params

    n = count_params(params)
    assert 3000 <= n <= 6000, \
        f"Expected ~4K-5K parameters, got {n}"


# ---------------------------------------------------------------------------
# Test 11: Sampler branch offset
# ---------------------------------------------------------------------------

def test_sampler_branch_offset(params):
    """Sampled sequences should have a valid branch offset at M8."""
    from jax6502.hmm import hmm_sample

    rng = jax.random.PRNGKey(456)
    valid_offsets = 0
    total_checked = 0

    for i in range(50):
        rng, subkey = jax.random.split(rng)
        length = 8 + (i % 5)  # lengths 8-12
        seq = hmm_sample(params, length, subkey)
        if seq is None:
            continue

        seq_np = np.array(seq)
        # The sampler places M1 at position = (number of I0 inserts).
        # Find 0xB5 and check offset
        m1_positions = np.where(seq_np == 0xB5)[0]
        for m1 in m1_positions:
            # Try to find M8 at position m1+7 (minimal) or later
            # The match bytes should be at m1, m1+1+inserts, etc.
            # For the simple case with no inserts between matches:
            if m1 + 7 < length:
                m8_pos = m1 + 7
                # Check if the preceding bytes match M1..M7 pattern
                expected_offset = (-(m8_pos - m1 + 1)) & 0xFF
                if seq_np[m8_pos] == expected_offset:
                    valid_offsets += 1
                    total_checked += 1
                else:
                    total_checked += 1

    # At least some should have valid offsets
    if total_checked > 0:
        assert valid_offsets > 0, \
            f"No valid branch offsets found in {total_checked} checks"
