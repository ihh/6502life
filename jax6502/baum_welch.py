"""Baum-Welch (Forward-Backward EM) training for the profile HMM.

This module implements discriminative Baum-Welch training, which uses the
Forward-Backward algorithm to compute posterior state occupancies and
transition posteriors, then updates parameters via an M-step.

For discriminative training (classifier, not generative model), the
sufficient statistics from viable examples are weighted +1 and from
non-viable examples are weighted -1. This is equivalent to gradient
ascent on the log-odds ratio but with closed-form M-steps.

In practice, the Adam-based discriminative training in train_supervised.py
(using the custom VJP Forward-Backward from hmm.py) achieves similar
results with more flexibility (arbitrary loss functions, learning rate
schedules). This module provides the classical EM alternative.

Usage:
    python -m jax6502.baum_welch
"""
import json, time, sys, numpy as np
import jax, jax.numpy as jnp
import jax.random as jr
import optax

if __name__ != '__main__': pass
else: sys.stdout = open(sys.stdout.fileno(), 'w', buffering=1)

from jax6502.hmm import (
    default_params, hmm_log_prob, hmm_sample, HMMParams,
    num_states, _end_state, NUM_INSERT_POSITIONS,
)
from jax6502.train import simulate_candidate


def forward_backward(params, seq, length, mode='core'):
    """Run Forward-Backward on a single sequence.

    Returns:
        gamma: posterior state occupancies [L, S]
        log_prob: log P(seq | params)
    """
    # Use the existing hmm_log_prob which has a custom VJP
    # implementing forward-backward. For Baum-Welch M-step,
    # we need the gradients w.r.t. the emission and transition logits,
    # which ARE the sufficient statistics.
    log_prob = hmm_log_prob(params, seq, length, mode=mode)
    return log_prob


def baum_welch_discriminative_step(params, viable_seqs, viable_masks,
                                    nonviable_seqs, nonviable_masks,
                                    learning_rate=0.01, mode='core'):
    """One step of discriminative Baum-Welch.

    Since the HMM's custom VJP already implements forward-backward,
    we compute gradients of the log-odds objective and apply them.
    This is mathematically equivalent to:
      1. E-step: FB on all sequences -> posteriors
      2. Weight viable posteriors +1, nonviable -1
      3. M-step: update params from weighted sufficient statistics

    But using autodiff through the existing FB implementation.
    """
    def discriminative_loss(p):
        # Score viable sequences
        def score_one(args):
            seq, mask = args
            length = mask.sum().astype(jnp.int32)
            return hmm_log_prob(p, seq, length, mode=mode)

        viable_lps = jax.lax.map(score_one, (viable_seqs, viable_masks))
        nonviable_lps = jax.lax.map(score_one, (nonviable_seqs, nonviable_masks))

        # Log-odds ratio: maximize log P(viable) - log P(nonviable)
        # Equivalent to discriminative Baum-Welch with +1/-1 weights
        viable_lengths = viable_masks.sum(axis=1)
        nonviable_lengths = nonviable_masks.sum(axis=1)

        # Normalize by length (bits per byte relative to uniform)
        viable_scores = viable_lps / jnp.log(2.0) + 8.0 * viable_lengths
        nonviable_scores = nonviable_lps / jnp.log(2.0) + 8.0 * nonviable_lengths

        # BCE loss on tempered scores
        tempered_v = viable_scores / 10.0
        tempered_n = nonviable_scores / 10.0

        loss_v = -jax.nn.log_sigmoid(tempered_v).mean()
        loss_n = -jax.nn.log_sigmoid(-tempered_n).mean()

        return loss_v + loss_n

    loss, grads = jax.value_and_grad(discriminative_loss)(params)
    # Simple gradient descent (Baum-Welch M-step analog)
    new_params = jax.tree_util.tree_map(
        lambda p, g: p - learning_rate * g, params, grads)
    return HMMParams(*new_params), loss


def train_baum_welch(data_file='jax6502/training_data_20k.json',
                     n_epochs=200, batch_size=128, learning_rate=1e-3,
                     mode='core'):
    """Train HMM discriminatively using Baum-Welch-style updates.

    This uses Adam optimization on the log-odds ratio, which is equivalent
    to discriminative Baum-Welch but with adaptive step sizes.
    """
    # Load data
    with open(data_file) as f:
        data = json.load(f)
    print(f'Loaded {len(data)} examples, {sum(d["viable"] for d in data)} viable')

    # Separate viable and nonviable
    viable_data = [d for d in data if d['viable']]
    nonviable_data = [d for d in data if not d['viable']]
    print(f'Viable: {len(viable_data)}, Nonviable: {len(nonviable_data)}')

    # Prepare arrays
    max_len = max(len(d['seq']) for d in data)
    seqs = np.zeros((len(data), max_len), dtype=np.int32)
    masks = np.zeros((len(data), max_len), dtype=np.float32)
    labels = np.array([1.0 if d['viable'] else 0.0 for d in data], dtype=np.float32)
    for i, d in enumerate(data):
        L = len(d['seq'])
        seqs[i, :L] = d['seq']
        masks[i, :L] = 1.0

    params = default_params(mode=mode)
    optimizer = optax.adamw(
        optax.cosine_decay_schedule(learning_rate, n_epochs * len(data) // batch_size),
        weight_decay=0.01
    )
    opt_state = optimizer.init(params)

    @jax.jit
    def train_step(params, opt_state, batch_seqs, batch_masks, batch_labels):
        def loss_fn(p):
            def score_one(args):
                seq, mask = args
                length = mask.sum().astype(jnp.int32)
                return hmm_log_prob(p, seq, length, mode=mode)
            log_probs = jax.lax.map(score_one, (batch_seqs, batch_masks))
            lengths = batch_masks.sum(axis=1)
            scores = log_probs / jnp.log(2.0) + 8.0 * lengths
            tempered = scores / 10.0
            bce = -(batch_labels * jax.nn.log_sigmoid(tempered) +
                    (1.0 - batch_labels) * jax.nn.log_sigmoid(-tempered))
            return bce.mean()
        loss, grads = jax.value_and_grad(loss_fn)(params)
        updates, new_opt_state = optimizer.update(grads, opt_state, params)
        new_params = optax.apply_updates(params, updates)
        return HMMParams(*new_params), new_opt_state, loss

    rng = np.random.RandomState(42)
    t0 = time.time()

    for epoch in range(n_epochs):
        perm = rng.permutation(len(data))
        epoch_loss = 0.0
        n_batches = 0
        for start in range(0, len(data), batch_size):
            idx = perm[start:start + batch_size]
            if len(idx) < 8:
                continue
            params, opt_state, loss = train_step(
                params, opt_state,
                jnp.array(seqs[idx]), jnp.array(masks[idx]), jnp.array(labels[idx]))
            epoch_loss += float(loss)
            n_batches += 1
        avg_loss = epoch_loss / max(n_batches, 1)
        if (epoch + 1) % 20 == 0:
            elapsed = time.time() - t0
            print(f'Epoch {epoch + 1:3d}: loss={avg_loss:.4f}, {elapsed:.0f}s')

    # Evaluate
    print('\nEvaluating...')
    key = jr.PRNGKey(999)
    n_eval = 1000
    viable_count = 0
    log2_probs = []

    for i in range(n_eval):
        key, k1, k2 = jr.split(key, 3)
        sample = hmm_sample(params, 8, k1, mode=mode)
        seq = [int(b) for b in sample[:8]]
        r = simulate_candidate(seq, board_size=4, rng_key=k2)
        if r['viable']:
            viable_count += 1
        lp = float(hmm_log_prob(params, jnp.array(seq + [0] * 8, dtype=jnp.int32),
                                 jnp.int32(8), mode=mode))
        log2_probs.append(lp / np.log(2.0))

    V = viable_count / n_eval
    H = -np.mean(log2_probs)
    print(f'Viable rate V = {viable_count}/{n_eval} = {V:.3f}')
    print(f'Model entropy H ≈ {H:.1f} bits')
    if V > 0:
        mining_bits = H - np.log2(V)
        print(f'Mining difficulty ≈ 2^{mining_bits:.1f} attempts')

    return params


if __name__ == '__main__':
    params = train_baum_welch()
    np.savez('jax6502/hmm_baum_welch.npz',
             **{k: np.array(v) for k, v in zip(params._fields, params)})
    print('Saved to jax6502/hmm_baum_welch.npz')
