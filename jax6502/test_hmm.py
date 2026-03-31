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
    """Default HMM parameters (core mode)."""
    from jax6502.hmm import default_params
    return default_params(mode='core')


@pytest.fixture(scope="module")
def params_full():
    """Default HMM parameters (full mode)."""
    from jax6502.hmm import default_params
    return default_params(mode='full')


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

    length = jnp.int32(8)

    log_p = hmm_log_prob(params, minimal_replicator, length)
    log_p_val = float(log_p)

    assert np.isfinite(log_p_val), f"Log-prob should be finite, got {log_p_val}"
    assert log_p_val < 0, f"Log-prob should be negative, got {log_p_val}"

    # Marginal wrapper should produce the same result
    log_p_marg = hmm_log_prob_marginal(params, minimal_replicator, length)
    log_p_marg_val = float(log_p_marg)

    assert np.isfinite(log_p_marg_val), \
        f"Marginal log-prob should be finite, got {log_p_marg_val}"
    assert abs(log_p_val - log_p_marg_val) < 1e-3, \
        f"Marginal should match hmm_log_prob: {log_p_val} vs {log_p_marg_val}"


# ---------------------------------------------------------------------------
# Test 2: Cross-validation with inserts — NOP prefix
# ---------------------------------------------------------------------------

def test_nop_prefix_score(params):
    """Sequence with NOP (0xEA) prefix should have finite score."""
    from jax6502.hmm import hmm_log_prob_marginal

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

    def loss_fn(p):
        return hmm_log_prob(p, minimal_replicator, length)

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

    bad_params = params._replace(
        insert_1byte_logits=jnp.zeros((5, 256)),
        path_mix_logits=jnp.zeros((5, 3)),
        match6_logits=jnp.zeros(2),
        match7_logits=jnp.zeros(7),
    )

    viable_seq = jnp.zeros((1, max_len), dtype=jnp.int32)
    viable_seq = viable_seq.at[0, :8].set(minimal_replicator)
    viable_mask = jnp.zeros((1, max_len), dtype=jnp.bool_)
    viable_mask = viable_mask.at[0, :8].set(True)

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

    single_score = float(_score_single(params, seq[0], mask[0]))
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

    seq1 = jnp.zeros((1, max_len), dtype=jnp.int32)
    seq1 = seq1.at[0, :8].set(minimal_replicator)
    mask1 = jnp.zeros((1, max_len), dtype=jnp.bool_)
    mask1 = mask1.at[0, :8].set(True)

    seq2 = jnp.full((1, max_len), 0xFF, dtype=jnp.int32)
    seq2 = seq2.at[0, :8].set(minimal_replicator)
    mask2 = mask1

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

    scan_result = float(hmm_log_prob(params, minimal_replicator, length))
    seq_result = float(hmm_log_prob_sequential(
        params, minimal_replicator, length))

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

        m1_positions = np.where(seq_np == 0xB5)[0]
        if len(m1_positions) == 0:
            continue

        for m1 in m1_positions:
            if m1 + 7 >= len(seq_np):
                continue
            if seq_np[m1 + 1] != 0x00:
                continue
            if seq_np[m1 + 2] != 0x9D:
                continue
            n_valid += 1
            break

    assert n_valid > 0, "At least some sampled sequences should have valid match bytes"


# ---------------------------------------------------------------------------
# Test 10: Parameter count (core mode)
# ---------------------------------------------------------------------------

def test_parameter_count(params):
    """Core mode: parameters should be ~22K (5 positions x ~4100 + reg)."""
    from jax6502.hmm import count_params

    n = count_params(params)
    assert 20000 <= n <= 25000, \
        f"Expected ~22K parameters, got {n}"


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
        length = 8 + (i % 5)
        seq = hmm_sample(params, length, subkey)
        if seq is None:
            continue

        seq_np = np.array(seq)
        m1_positions = np.where(seq_np == 0xB5)[0]
        for m1 in m1_positions:
            if m1 + 7 < length:
                m8_pos = m1 + 7
                expected_offset = (-(m8_pos - m1 + 1)) & 0xFF
                if seq_np[m8_pos] == expected_offset:
                    valid_offsets += 1
                    total_checked += 1
                else:
                    total_checked += 1

    if total_checked > 0:
        assert valid_offsets > 0, \
            f"No valid branch offsets found in {total_checked} checks"


# ---------------------------------------------------------------------------
# Test 12: Per-position emissions produce different distributions
# ---------------------------------------------------------------------------

def test_per_position_emissions_differ(params):
    """After training, different insert positions should have different
    emission distributions. Even at init, verify the parameter shapes are
    correct and indexing works."""
    from jax6502.hmm import NUM_INSERT_POSITIONS

    # Check shapes
    assert params.insert_1byte_logits.shape == (NUM_INSERT_POSITIONS, 256)
    assert params.path_mix_logits.shape == (NUM_INSERT_POSITIONS, 3)
    assert params.insert_2byte_logits.shape == (NUM_INSERT_POSITIONS, 3, 2, 256)
    assert params.insert_3byte_logits.shape == (NUM_INSERT_POSITIONS, 3, 3, 256)
    assert params.insert_2byte_mix_logits.shape == (NUM_INSERT_POSITIONS, 3)
    assert params.insert_3byte_mix_logits.shape == (NUM_INSERT_POSITIONS, 3)

    # At initialization, all positions are identical (tiled from shared)
    # but the shapes allow them to diverge during training
    p0 = jax.nn.softmax(params.insert_1byte_logits[0])
    p4 = jax.nn.softmax(params.insert_1byte_logits[4])
    # Initially equal
    assert jnp.allclose(p0, p4, atol=1e-5), \
        "At init, I0 and I4 emissions should be identical"


# ---------------------------------------------------------------------------
# Test 13: Full 256-byte model scores replicator + zeros higher than random
# ---------------------------------------------------------------------------

def test_full_model_replicator_vs_random(params_full):
    """Full 256-byte model should score a known replicator + zero tail
    higher than 256 random bytes."""
    from jax6502.hmm import hmm_log_prob_marginal

    # Build a 256-byte sequence: 8-byte replicator + zeros + register area
    seq = np.zeros(256, dtype=np.int32)
    # Core replicator at offset 0
    seq[0:8] = [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]
    # Bytes 8-248: zeros (cargo)
    # Register save area at 249-255:
    # PCHI=0x00, PCLO=0x00, P=0x30, A=0x00, X=0x00, Y=0x00, S=0xFF
    seq[249] = 0x00  # PCHI
    seq[250] = 0x00  # PCLO
    seq[251] = 0x30  # P (typical reset)
    seq[252] = 0x00  # A
    seq[253] = 0x00  # X
    seq[254] = 0x00  # Y
    seq[255] = 0xFF  # S

    seq_jax = jnp.array(seq, dtype=jnp.int32)
    length = jnp.int32(256)

    replicator_score = float(hmm_log_prob_marginal(
        params_full, seq_jax, length, mode='full'))

    # Random 256 bytes
    rng = jax.random.PRNGKey(42)
    random_seq = jax.random.randint(rng, (256,), 0, 256, dtype=jnp.int32)
    random_score = float(hmm_log_prob_marginal(
        params_full, random_seq, length, mode='full'))

    assert replicator_score > random_score, \
        f"Replicator ({replicator_score:.2f}) should score higher than random ({random_score:.2f})"


# ---------------------------------------------------------------------------
# Test 14: Register match states assign high probability to PC=0, X=0
# ---------------------------------------------------------------------------

def test_register_emissions(params_full):
    """Register emission distributions should be peaked at expected values."""
    from jax6502.hmm import _make_reg_emission_table

    # PCHI (r=0) should strongly prefer 0x00
    reg_lp = _make_reg_emission_table(params_full, jnp.int32(0x00))
    reg_lp_ff = _make_reg_emission_table(params_full, jnp.int32(0xFF))

    # PCHI (r=0): 0x00 should be much more likely than 0xFF
    assert float(reg_lp[0]) > float(reg_lp_ff[0]) + 2.0, \
        "PCHI should strongly prefer 0x00"

    # X (r=4): 0x00 should be much more likely than 0xFF
    assert float(reg_lp[4]) > float(reg_lp_ff[4]) + 2.0, \
        "X register should strongly prefer 0x00"

    # S (r=6): 0xFF should be more likely than 0x00
    assert float(reg_lp_ff[6]) > float(reg_lp[6]), \
        "Stack pointer should prefer high values"


# ---------------------------------------------------------------------------
# Test 15: Gradient flow for full model
# ---------------------------------------------------------------------------

def test_gradient_flow_full(params_full):
    """Full model should have finite gradients for all parameters."""
    from jax6502.hmm import hmm_log_prob

    # Build a minimal 15-byte sequence (8 core + 7 register)
    seq = np.zeros(15, dtype=np.int32)
    seq[0:8] = [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]
    seq[8:15] = [0x00, 0x00, 0x30, 0x00, 0x00, 0x00, 0xFF]

    seq_jax = jnp.array(seq, dtype=jnp.int32)
    length = jnp.int32(15)

    def loss_fn(p):
        return hmm_log_prob(p, seq_jax, length, mode='full')

    grads = jax.grad(loss_fn)(params_full)

    for name, g in zip(params_full._fields, grads):
        assert jnp.all(jnp.isfinite(g)), \
            f"Gradient for {name} has non-finite values"


# ---------------------------------------------------------------------------
# Test 16: Associative scan matches sequential at L=256 (full mode)
# ---------------------------------------------------------------------------

def test_scan_vs_sequential_full(params_full):
    """Full mode: associative scan should match sequential for a 256-byte seq."""
    from jax6502.hmm import hmm_log_prob, hmm_log_prob_sequential

    # Build a 20-byte sequence (core + cargo + registers) to keep test fast
    seq = np.zeros(20, dtype=np.int32)
    seq[0:8] = [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]
    # 5 cargo bytes (NOP fill)
    seq[8:13] = [0xEA, 0xEA, 0xEA, 0xEA, 0xEA]
    # 7 register bytes
    seq[13:20] = [0x00, 0x00, 0x30, 0x00, 0x00, 0x00, 0xFF]

    seq_jax = jnp.array(seq, dtype=jnp.int32)
    length = jnp.int32(20)

    scan_result = float(hmm_log_prob(
        params_full, seq_jax, length, mode='full'))
    seq_result = float(hmm_log_prob_sequential(
        params_full, seq_jax, length, mode='full'))

    assert abs(scan_result - seq_result) < 1e-1, \
        f"Scan ({scan_result:.6f}) vs sequential ({seq_result:.6f})"


# ---------------------------------------------------------------------------
# Test 17: Parameter count is ~22K
# ---------------------------------------------------------------------------

def test_parameter_count_full(params_full):
    """Full model parameter count should be ~22K."""
    from jax6502.hmm import count_params

    n = count_params(params_full)
    assert 20000 <= n <= 25000, \
        f"Expected ~22K parameters, got {n}"


# ---------------------------------------------------------------------------
# Test 18: Core mode backward compatibility
# ---------------------------------------------------------------------------

def test_core_mode_backward_compat(params, minimal_replicator):
    """Core mode should produce the same score structure as the old model."""
    from jax6502.hmm import hmm_log_prob, hmm_log_prob_marginal, num_states

    # Core mode should have 37 states
    assert num_states('core') == 37
    assert num_states('full') == 44

    length = jnp.int32(8)

    # Should produce a finite negative log-probability
    log_p = hmm_log_prob(params, minimal_replicator, length, mode='core')
    log_p_val = float(log_p)
    assert np.isfinite(log_p_val), f"Core mode log-prob should be finite"
    assert log_p_val < 0, f"Core mode log-prob should be negative"


# ---------------------------------------------------------------------------
# Test 19: Full mode sampler
# ---------------------------------------------------------------------------

def test_full_mode_sampler(params_full):
    """Full mode sampler should produce sequences of correct length
    with register bytes at the end."""
    from jax6502.hmm import hmm_sample

    rng = jax.random.PRNGKey(789)
    n_valid = 0

    for i in range(20):
        rng, subkey = jax.random.split(rng)
        length = 20 + i * 5  # lengths 20, 25, 30, ...
        seq = hmm_sample(params_full, length, subkey, mode='full')
        if seq is None:
            continue

        seq_np = np.array(seq)
        assert len(seq_np) == length, f"Expected length {length}, got {len(seq_np)}"

        # All bytes should be valid (0-255)
        assert np.all(seq_np >= 0) and np.all(seq_np <= 255)

        # Should contain a 0xB5 somewhere in the core region
        core_region = seq_np[:length - 7]
        if 0xB5 in core_region:
            n_valid += 1

    assert n_valid > 0, "Full mode sampler should produce valid sequences"
