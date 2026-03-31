"""
Flax Transformer + RoPE neural oracle for predicting replicator viability.

Replaces the log-linear oracle in dfa/neural-oracle.js with a proper
neural network. Input: variable-length byte sequences (8-32 bytes).
Output: P(viable replicator).

Architecture: 2-layer pre-norm Transformer with Rotary Position Embeddings,
masked mean pooling, and a classification head. ~120K parameters.

Integration: JSON-over-stdin server for use from the JS WFST training loop.
"""

import json
import sys
from functools import partial
from typing import Any, List, Optional, Tuple

import jax
import jax.numpy as jnp
import flax.linen as nn
import optax
from flax.training import train_state


# ---------------------------------------------------------------------------
# Rotary Position Embeddings (Su et al. 2021)
# ---------------------------------------------------------------------------

class RotaryEmbedding(nn.Module):
    """Precompute RoPE rotation frequencies."""
    dim: int

    @nn.compact
    def __call__(self, seq_len: int) -> Tuple[jnp.ndarray, jnp.ndarray]:
        # inv_freq: (dim/2,)
        half_dim = self.dim // 2
        inv_freq = 1.0 / (10000.0 ** (jnp.arange(0, half_dim, dtype=jnp.float32) / half_dim))
        # positions: (seq_len,)
        positions = jnp.arange(seq_len, dtype=jnp.float32)
        # angles: (seq_len, dim/2)
        angles = jnp.outer(positions, inv_freq)
        # cos, sin: (seq_len, dim) — repeat for pairs
        cos_vals = jnp.concatenate([jnp.cos(angles), jnp.cos(angles)], axis=-1)
        sin_vals = jnp.concatenate([jnp.sin(angles), jnp.sin(angles)], axis=-1)
        return cos_vals, sin_vals


def apply_rotary_emb(x: jnp.ndarray, cos: jnp.ndarray, sin: jnp.ndarray) -> jnp.ndarray:
    """Apply rotary embeddings to x of shape (..., seq_len, dim).

    Rotates pairs: for each pair (x_{2i}, x_{2i+1}), apply 2D rotation.
    """
    d = x.shape[-1]
    half = d // 2
    x1 = x[..., :half]
    x2 = x[..., half:]
    # Rotate: [x1, x2] -> [x1*cos - x2*sin, x2*cos + x1*sin]
    cos_half = cos[..., :half]
    sin_half = sin[..., :half]
    rotated = jnp.concatenate([
        x1 * cos_half - x2 * sin_half,
        x2 * cos_half + x1 * sin_half,
    ], axis=-1)
    return rotated


# ---------------------------------------------------------------------------
# Multi-Head Attention with RoPE
# ---------------------------------------------------------------------------

class RoPEAttention(nn.Module):
    """Multi-head attention with rotary position embeddings on Q and K."""
    num_heads: int = 4
    head_dim: int = 16

    @nn.compact
    def __call__(self, x: jnp.ndarray, mask: Optional[jnp.ndarray] = None):
        """
        Args:
            x: (B, L, D)
            mask: (B, L) bool — True for real tokens
        Returns:
            output: (B, L, D)
            attn_weights: (B, H, L, L)
        """
        B, L, D = x.shape
        total_dim = self.num_heads * self.head_dim

        # Project to Q, K, V
        qkv = nn.Dense(3 * total_dim, use_bias=False, name='qkv')(x)
        q, k, v = jnp.split(qkv, 3, axis=-1)

        # Reshape to (B, H, L, head_dim)
        q = q.reshape(B, L, self.num_heads, self.head_dim).transpose(0, 2, 1, 3)
        k = k.reshape(B, L, self.num_heads, self.head_dim).transpose(0, 2, 1, 3)
        v = v.reshape(B, L, self.num_heads, self.head_dim).transpose(0, 2, 1, 3)

        # RoPE on Q and K
        rope = RotaryEmbedding(dim=self.head_dim)
        cos, sin = rope(L)
        # cos, sin: (L, head_dim) -> broadcast over (B, H, L, head_dim)
        q = apply_rotary_emb(q, cos, sin)
        k = apply_rotary_emb(k, cos, sin)

        # Scaled dot-product attention
        scale = jnp.sqrt(jnp.float32(self.head_dim))
        attn_logits = jnp.matmul(q, k.transpose(0, 1, 3, 2)) / scale  # (B, H, L, L)

        # Apply padding mask: mask out attention to padded positions
        if mask is not None:
            # mask: (B, L) -> (B, 1, 1, L) for key masking
            key_mask = mask[:, None, None, :]  # (B, 1, 1, L)
            attn_logits = jnp.where(key_mask, attn_logits, jnp.float32(-1e9))

        attn_weights = jax.nn.softmax(attn_logits, axis=-1)

        # Weighted sum
        out = jnp.matmul(attn_weights, v)  # (B, H, L, head_dim)
        out = out.transpose(0, 2, 1, 3).reshape(B, L, total_dim)

        # Output projection
        out = nn.Dense(D, use_bias=False, name='out_proj')(out)
        return out, attn_weights


# ---------------------------------------------------------------------------
# Transformer Block (pre-norm)
# ---------------------------------------------------------------------------

class TransformerBlock(nn.Module):
    """Pre-norm transformer block with residual connections."""
    num_heads: int = 4
    head_dim: int = 16
    mlp_dim: int = 256

    @nn.compact
    def __call__(self, x: jnp.ndarray, mask: Optional[jnp.ndarray] = None):
        D = x.shape[-1]

        # Pre-norm attention
        residual = x
        x_norm = nn.LayerNorm()(x)
        attn_out, attn_weights = RoPEAttention(
            num_heads=self.num_heads,
            head_dim=self.head_dim,
        )(x_norm, mask)
        x = residual + attn_out

        # Pre-norm MLP
        residual = x
        x_norm = nn.LayerNorm()(x)
        mlp_out = nn.Dense(self.mlp_dim)(x_norm)
        mlp_out = nn.gelu(mlp_out)
        mlp_out = nn.Dense(D)(mlp_out)
        x = residual + mlp_out

        return x, attn_weights


# ---------------------------------------------------------------------------
# ReplicatorOracle
# ---------------------------------------------------------------------------

class ReplicatorOracle(nn.Module):
    """Transformer oracle predicting P(viable replicator) from byte sequences."""
    embed_dim: int = 64
    num_layers: int = 2
    num_heads: int = 4
    vocab_size: int = 256
    max_len: int = 32

    @nn.compact
    def __call__(self, byte_seq: jnp.ndarray, length_mask: jnp.ndarray):
        """
        Args:
            byte_seq: (B, L) int32 — batch of byte sequences
            length_mask: (B, L) bool — True for real tokens, False for padding

        Returns:
            logits: (B,) — raw logits, apply sigmoid for P(viable)
            attn_weights: list of (B, H, L, L) attention weight matrices
        """
        B, L = byte_seq.shape
        head_dim = self.embed_dim // self.num_heads

        # 1. Byte embedding (no positional embedding — RoPE handles position)
        x = nn.Embed(num_embeddings=self.vocab_size, features=self.embed_dim)(byte_seq)

        # 2. Transformer blocks
        all_attn_weights = []
        for i in range(self.num_layers):
            x, attn_w = TransformerBlock(
                num_heads=self.num_heads,
                head_dim=head_dim,
                mlp_dim=self.embed_dim * 4,
            )(x, length_mask)
            all_attn_weights.append(attn_w)

        # 3. Final LayerNorm
        x = nn.LayerNorm()(x)

        # 4. Masked mean pooling
        mask_expanded = length_mask[:, :, None].astype(jnp.float32)  # (B, L, 1)
        x = (x * mask_expanded).sum(axis=1) / mask_expanded.sum(axis=1).clip(min=1)  # (B, D)

        # 5. Classification head
        x = nn.Dense(128)(x)
        x = nn.gelu(x)
        logits = nn.Dense(1)(x).squeeze(-1)  # (B,)

        return logits, all_attn_weights


# ---------------------------------------------------------------------------
# Training utilities
# ---------------------------------------------------------------------------

def create_train_state(rng, model, learning_rate=1e-3):
    """Initialize model + AdamW optimizer."""
    dummy_seq = jnp.zeros((1, model.max_len), dtype=jnp.int32)
    dummy_mask = jnp.ones((1, model.max_len), dtype=jnp.bool_)
    params = model.init(rng, dummy_seq, dummy_mask)
    tx = optax.adamw(learning_rate, weight_decay=0.01)
    return train_state.TrainState.create(
        apply_fn=model.apply,
        params=params,
        tx=tx,
    )


def focal_bce_loss(logits, labels, gamma=2.0):
    """Binary cross-entropy with focal loss weighting (Lin et al. 2017).

    focal_loss = -alpha_t * (1 - p_t)^gamma * log(p_t)
    where p_t = sigmoid(logit) if label=1, else 1-sigmoid(logit).
    """
    # Numerically stable BCE
    # log_sigmoid(x) = -softplus(-x)
    # log(1 - sigmoid(x)) = -softplus(x)
    log_p = jax.nn.log_sigmoid(logits)
    log_1_minus_p = jax.nn.log_sigmoid(-logits)

    # p_t for focal weighting
    p = jax.nn.sigmoid(logits)
    p_t = jnp.where(labels, p, 1.0 - p)

    # BCE per example
    bce = -(labels * log_p + (1.0 - labels) * log_1_minus_p)

    # Focal weight
    focal_weight = (1.0 - p_t) ** gamma

    return (focal_weight * bce).mean()


@jax.jit
def train_step(state, sequences, masks, labels):
    """One training step with focal BCE loss.

    Args:
        state: TrainState
        sequences: (B, L) int32
        masks: (B, L) bool
        labels: (B,) float32 — 0 or 1

    Returns:
        (new_state, loss)
    """
    def loss_fn(params):
        logits, _ = state.apply_fn(params, sequences, masks)
        return focal_bce_loss(logits, labels)

    loss, grads = jax.value_and_grad(loss_fn)(state.params)
    new_state = state.apply_gradients(grads=grads)
    return new_state, loss


@jax.jit
def predict_batch(state, sequences, masks):
    """Batch inference.

    Returns:
        probs: (B,) — predicted P(viable)
        attn_weights: list of (B, H, L, L)
    """
    logits, attn_weights = state.apply_fn(state.params, sequences, masks)
    probs = jax.nn.sigmoid(logits)
    return probs, attn_weights


# ---------------------------------------------------------------------------
# Blame attribution
# ---------------------------------------------------------------------------

def attention_blame(attn_weights: List, length_mask: jnp.ndarray) -> jnp.ndarray:
    """Per-position blame scores from attention weights.

    Averages attention across heads and layers, then normalizes per sequence.

    Args:
        attn_weights: list of (B, H, L, L) arrays
        length_mask: (B, L) bool

    Returns:
        blame: (B, L) — per-position blame scores summing to ~1 per sequence
    """
    # Average across layers: (B, H, L, L)
    stacked = jnp.stack(attn_weights, axis=0)  # (num_layers, B, H, L, L)
    avg = stacked.mean(axis=0)  # (B, H, L, L)

    # Average across heads: (B, L, L)
    avg = avg.mean(axis=1)  # (B, L, L)

    # Sum attention received by each position (column sum = how much others attend to pos j)
    blame = avg.sum(axis=1)  # (B, L) — sum over query positions

    # Mask padding
    blame = blame * length_mask.astype(jnp.float32)

    # Normalize per sequence
    blame = blame / blame.sum(axis=-1, keepdims=True).clip(min=1e-8)

    return blame


def gradient_blame(state, sequences, masks):
    """Gradient-based per-position blame via input embedding gradient norms.

    Computes the gradient of the output logit w.r.t. the embedding layer,
    then takes the L2 norm per position.

    Args:
        state: TrainState
        sequences: (B, L) int32
        masks: (B, L) bool

    Returns:
        blame: (B, L) — per-position gradient magnitude
    """
    def logit_sum(params):
        logits, _ = state.apply_fn(params, sequences, masks)
        return logits.sum()

    grads = jax.grad(logit_sum)(state.params)

    # Extract embedding gradients
    # The embedding table gradient has shape (vocab_size, embed_dim)
    # We need per-position gradients, so we gather from the gradient table
    embed_grad = grads['params']['Embed_0']['embedding']  # (vocab_size, embed_dim)

    # Gather per-position: for each (b, l), take embed_grad[sequences[b, l]]
    per_pos_grad = embed_grad[sequences]  # (B, L, embed_dim)

    # L2 norm per position
    blame = jnp.sqrt((per_pos_grad ** 2).sum(axis=-1))  # (B, L)

    # Mask padding
    blame = blame * masks.astype(jnp.float32)

    return blame


# ---------------------------------------------------------------------------
# Data utilities
# ---------------------------------------------------------------------------

def pad_sequences(byte_arrays, max_len=32):
    """Pad variable-length byte arrays to fixed length.

    Args:
        byte_arrays: list of array-like (each element 0-255)

    Returns:
        sequences: (N, max_len) int32 jnp array
        masks: (N, max_len) bool jnp array
    """
    N = len(byte_arrays)
    sequences = jnp.zeros((N, max_len), dtype=jnp.int32)
    masks = jnp.zeros((N, max_len), dtype=jnp.bool_)

    # Build as numpy then convert (JAX arrays are immutable)
    import numpy as np
    seq_np = np.zeros((N, max_len), dtype=np.int32)
    mask_np = np.zeros((N, max_len), dtype=bool)

    for i, arr in enumerate(byte_arrays):
        length = min(len(arr), max_len)
        seq_np[i, :length] = list(arr[:length])
        mask_np[i, :length] = True

    return jnp.array(seq_np), jnp.array(mask_np)


def prepare_dataset(examples):
    """Convert list of {bytes, viable, spread} dicts to batched JAX arrays.

    Args:
        examples: list of dicts with 'bytes' (array-like), 'viable' (bool),
                  and optionally 'spread' (int)

    Returns:
        dict with 'sequences', 'masks', 'labels' as jnp arrays
    """
    byte_arrays = [ex['bytes'] for ex in examples]
    sequences, masks = pad_sequences(byte_arrays)
    labels = jnp.array([1.0 if ex['viable'] else 0.0 for ex in examples], dtype=jnp.float32)
    return {
        'sequences': sequences,
        'masks': masks,
        'labels': labels,
    }


# ---------------------------------------------------------------------------
# JSON-over-stdin server
# ---------------------------------------------------------------------------

def run_server():
    """Read JSON commands from stdin, write JSON responses to stdout.

    Keeps model state alive across calls for JIT cache reuse.

    Commands:
        init: {cmd: "init", max_len: 32, learning_rate: 1e-3, seed: 42}
        predict_batch: {cmd: "predict_batch", sequences: [[...], ...]}
        train: {cmd: "train", sequences: [[...], ...], labels: [0, 1, ...], epochs: 1}
        blame: {cmd: "blame", sequences: [[...], ...], method: "attention"|"gradient"}
        save: {cmd: "save", path: "model.msgpack"}
        load: {cmd: "load", path: "model.msgpack"}
    """
    import flax.serialization as serialization

    model = None
    state = None

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as e:
            _respond({"error": f"JSON parse error: {e}"})
            continue

        try:
            action = cmd.get("cmd", "")

            if action == "init":
                max_len = cmd.get("max_len", 32)
                lr = cmd.get("learning_rate", 1e-3)
                seed = cmd.get("seed", 42)
                model = ReplicatorOracle(max_len=max_len)
                rng = jax.random.PRNGKey(seed)
                state = create_train_state(rng, model, learning_rate=lr)
                n_params = sum(p.size for p in jax.tree.leaves(state.params))
                _respond({"ok": True, "params": int(n_params)})

            elif action == "predict_batch":
                if state is None:
                    _respond({"error": "Model not initialized"})
                    continue
                seqs = cmd["sequences"]
                sequences, masks = pad_sequences(seqs, max_len=model.max_len)
                probs, _ = predict_batch(state, sequences, masks)
                _respond({"probs": probs.tolist()})

            elif action == "train":
                if state is None:
                    _respond({"error": "Model not initialized"})
                    continue
                seqs = cmd["sequences"]
                labels = cmd["labels"]
                epochs = cmd.get("epochs", 1)
                sequences, masks = pad_sequences(seqs, max_len=model.max_len)
                labels_arr = jnp.array(labels, dtype=jnp.float32)
                loss_val = 0.0
                for _ in range(epochs):
                    state, loss_val = train_step(state, sequences, masks, labels_arr)
                _respond({"ok": True, "loss": float(loss_val)})

            elif action == "blame":
                if state is None:
                    _respond({"error": "Model not initialized"})
                    continue
                seqs = cmd["sequences"]
                method = cmd.get("method", "attention")
                sequences, masks = pad_sequences(seqs, max_len=model.max_len)
                if method == "attention":
                    _, attn_weights = predict_batch(state, sequences, masks)
                    blame_scores = attention_blame(attn_weights, masks)
                else:
                    blame_scores = gradient_blame(state, sequences, masks)
                _respond({"blame": blame_scores.tolist()})

            elif action == "save":
                if state is None:
                    _respond({"error": "Model not initialized"})
                    continue
                path = cmd["path"]
                with open(path, "wb") as f:
                    f.write(serialization.to_bytes(state.params))
                _respond({"ok": True, "path": path})

            elif action == "load":
                if state is None:
                    _respond({"error": "Model not initialized"})
                    continue
                path = cmd["path"]
                with open(path, "rb") as f:
                    params = serialization.from_bytes(state.params, f.read())
                state = state.replace(params=params)
                _respond({"ok": True, "path": path})

            else:
                _respond({"error": f"Unknown command: {action}"})

        except Exception as e:
            _respond({"error": str(e)})


def _respond(obj):
    """Write a JSON line to stdout and flush."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    run_server()
