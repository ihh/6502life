"""Tests for the Flax Transformer+RoPE neural oracle."""

import pytest
import sys

try:
    import jax
    import jax.numpy as jnp
    HAS_JAX = True
except ImportError:
    HAS_JAX = False

pytestmark = pytest.mark.skipif(not HAS_JAX, reason="JAX/Flax/Optax not installed")


@pytest.fixture(scope="module")
def model_and_state():
    """Create model and training state once for the module."""
    from jax6502.oracle import ReplicatorOracle, create_train_state
    model = ReplicatorOracle(max_len=32)
    rng = jax.random.PRNGKey(42)
    state = create_train_state(rng, model, learning_rate=1e-3)
    return model, state


# ---------------------------------------------------------------------------
# Test 1: Model initialization and forward pass shapes
# ---------------------------------------------------------------------------

def test_forward_pass_shapes(model_and_state):
    model, state = model_and_state
    B, L = 4, 32
    sequences = jnp.zeros((B, L), dtype=jnp.int32)
    masks = jnp.ones((B, L), dtype=jnp.bool_)

    logits, attn_weights = model.apply(state.params, sequences, masks)

    assert logits.shape == (B,), f"Expected logits shape (4,), got {logits.shape}"
    assert len(attn_weights) == 2, f"Expected 2 attention layers, got {len(attn_weights)}"
    for i, aw in enumerate(attn_weights):
        assert aw.shape == (B, 4, L, L), f"Layer {i} attn shape {aw.shape}"


# ---------------------------------------------------------------------------
# Test 2: RoPE produces different representations for different positions
# ---------------------------------------------------------------------------

def test_rope_position_sensitivity():
    from jax6502.oracle import RotaryEmbedding, apply_rotary_emb

    rope = RotaryEmbedding(dim=16)
    rng = jax.random.PRNGKey(0)
    params = rope.init(rng, 8)
    cos, sin = rope.apply(params, 8)

    # Same vector at different positions should get different rotations
    vec = jnp.ones((1, 1, 8, 16))  # (B, H, L, dim)
    rotated = apply_rotary_emb(vec, cos, sin)

    # Check positions 0 and 4 produce different outputs
    pos0 = rotated[0, 0, 0, :]
    pos4 = rotated[0, 0, 4, :]
    diff = jnp.abs(pos0 - pos4).sum()
    assert diff > 0.1, f"RoPE should produce different outputs at different positions, diff={diff}"


# ---------------------------------------------------------------------------
# Test 3: Training step reduces loss
# ---------------------------------------------------------------------------

def test_training_reduces_loss(model_and_state):
    from jax6502.oracle import create_train_state, ReplicatorOracle, train_step

    model = ReplicatorOracle(max_len=16)
    rng = jax.random.PRNGKey(123)
    state = create_train_state(rng, model, learning_rate=1e-2)

    # Simple dataset: all-zeros -> viable, all-ones -> not viable
    B = 8
    seq0 = jnp.zeros((B // 2, 16), dtype=jnp.int32)
    seq1 = jnp.ones((B // 2, 16), dtype=jnp.int32)
    sequences = jnp.concatenate([seq0, seq1], axis=0)
    masks = jnp.ones((B, 16), dtype=jnp.bool_)
    labels = jnp.array([1.0] * (B // 2) + [0.0] * (B // 2))

    # Get initial loss
    state, loss0 = train_step(state, sequences, masks, labels)

    # Train for several steps
    for _ in range(50):
        state, loss = train_step(state, sequences, masks, labels)

    assert loss < loss0, f"Loss should decrease: {loss0:.4f} -> {loss:.4f}"


# ---------------------------------------------------------------------------
# Test 4: Attention blame sums to ~1 per sequence
# ---------------------------------------------------------------------------

def test_attention_blame_sums_to_one(model_and_state):
    from jax6502.oracle import predict_batch, attention_blame

    _, state = model_and_state
    B, L = 3, 32
    sequences = jax.random.randint(jax.random.PRNGKey(0), (B, L), 0, 256)
    # Variable lengths: 8, 16, 32
    import numpy as np
    mask_np = np.zeros((B, L), dtype=bool)
    mask_np[0, :8] = True
    mask_np[1, :16] = True
    mask_np[2, :32] = True
    masks = jnp.array(mask_np)

    _, attn_weights = predict_batch(state, sequences, masks)
    blame = attention_blame(attn_weights, masks)

    assert blame.shape == (B, L)
    sums = blame.sum(axis=-1)
    for i in range(B):
        assert abs(float(sums[i]) - 1.0) < 0.01, (
            f"Blame for seq {i} sums to {sums[i]:.4f}, expected ~1.0"
        )


# ---------------------------------------------------------------------------
# Test 5: Gradient blame produces finite per-position scores
# ---------------------------------------------------------------------------

def test_gradient_blame_finite(model_and_state):
    from jax6502.oracle import gradient_blame

    _, state = model_and_state
    B, L = 2, 32
    sequences = jax.random.randint(jax.random.PRNGKey(1), (B, L), 0, 256)
    masks = jnp.ones((B, L), dtype=jnp.bool_)

    blame = gradient_blame(state, sequences, masks)

    assert blame.shape == (B, L)
    assert jnp.all(jnp.isfinite(blame)), "Gradient blame should be finite"
    assert jnp.all(blame >= 0), "Gradient blame should be non-negative"


# ---------------------------------------------------------------------------
# Test 6: Padding correctly masked
# ---------------------------------------------------------------------------

def test_padding_does_not_affect_output(model_and_state):
    model, state = model_and_state

    # Same 8-byte sequence, padded to 32 with different padding values
    import numpy as np
    real_bytes = [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]

    seq1 = np.zeros(32, dtype=np.int32)
    seq1[:8] = real_bytes

    seq2 = np.full(32, 255, dtype=np.int32)
    seq2[:8] = real_bytes

    sequences = jnp.array([seq1, seq2])
    masks = jnp.array([
        [True] * 8 + [False] * 24,
        [True] * 8 + [False] * 24,
    ])

    logits, _ = model.apply(state.params, sequences, masks)

    diff = abs(float(logits[0]) - float(logits[1]))
    assert diff < 0.01, (
        f"Padding values should not affect output: logits differ by {diff:.6f}"
    )


# ---------------------------------------------------------------------------
# Test 7: Variable-length sequences handled correctly
# ---------------------------------------------------------------------------

def test_variable_length_sequences():
    from jax6502.oracle import pad_sequences

    arrays = [
        [0xA9, 0x01, 0x8D, 0x10, 0x00, 0x60, 0x00, 0x00],  # 8 bytes
        list(range(16)),  # 16 bytes
        list(range(32)),  # 32 bytes
    ]

    sequences, masks = pad_sequences(arrays, max_len=32)

    assert sequences.shape == (3, 32)
    assert masks.shape == (3, 32)

    # Check lengths
    assert bool(masks[0, 7]) == True
    assert bool(masks[0, 8]) == False
    assert bool(masks[1, 15]) == True
    assert bool(masks[1, 16]) == False
    assert bool(masks[2, 31]) == True

    # Check values
    assert int(sequences[0, 0]) == 0xA9
    assert int(sequences[0, 8]) == 0  # padding


# ---------------------------------------------------------------------------
# Test 8: Known viable sequence scores higher than random after training
# ---------------------------------------------------------------------------

def test_known_viable_vs_random():
    from jax6502.oracle import (
        ReplicatorOracle, create_train_state, train_step,
        predict_batch, pad_sequences,
    )
    import numpy as np

    model = ReplicatorOracle(max_len=16)
    rng = jax.random.PRNGKey(99)
    state = create_train_state(rng, model, learning_rate=3e-3)

    # Known viable: LDA $00,X; STA $0400,X; INX; BCC $F8
    viable = [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]

    # Generate random negative examples
    rng_data = np.random.RandomState(42)
    negatives = [rng_data.randint(0, 256, size=8).tolist() for _ in range(20)]

    # Training data: viable + its slight variants as positive, randoms as negative
    positives = [viable]
    # Add slight mutations of the viable sequence
    for _ in range(9):
        mut = list(viable)
        idx = rng_data.randint(0, len(mut))
        mut[idx] = (mut[idx] + rng_data.randint(1, 5)) % 256
        positives.append(mut)

    all_seqs = positives + negatives
    all_labels = [1.0] * len(positives) + [0.0] * len(negatives)

    sequences, masks = pad_sequences(all_seqs, max_len=16)
    labels = jnp.array(all_labels)

    # Train
    for _ in range(200):
        state, loss = train_step(state, sequences, masks, labels)

    # Predict on viable vs a random sequence
    test_seqs = [viable, rng_data.randint(0, 256, size=8).tolist()]
    test_sequences, test_masks = pad_sequences(test_seqs, max_len=16)
    probs, _ = predict_batch(state, test_sequences, test_masks)

    viable_prob = float(probs[0])
    random_prob = float(probs[1])

    assert viable_prob > random_prob, (
        f"Viable sequence should score higher ({viable_prob:.4f}) "
        f"than random ({random_prob:.4f})"
    )


# ---------------------------------------------------------------------------
# Test: Parameter count ~120K
# ---------------------------------------------------------------------------

def test_parameter_count(model_and_state):
    _, state = model_and_state
    n_params = sum(p.size for p in jax.tree.leaves(state.params))
    # Should be approximately 120K
    assert 50_000 < n_params < 200_000, (
        f"Expected ~120K params, got {n_params:,}"
    )


# ---------------------------------------------------------------------------
# Test: prepare_dataset utility
# ---------------------------------------------------------------------------

def test_prepare_dataset():
    from jax6502.oracle import prepare_dataset

    examples = [
        {'bytes': [0xA9, 0x01], 'viable': True, 'spread': 40},
        {'bytes': [0x00, 0x00, 0x00], 'viable': False, 'spread': 0},
    ]

    dataset = prepare_dataset(examples)
    assert dataset['sequences'].shape == (2, 32)
    assert dataset['masks'].shape == (2, 32)
    assert dataset['labels'].shape == (2,)
    assert float(dataset['labels'][0]) == 1.0
    assert float(dataset['labels'][1]) == 0.0
