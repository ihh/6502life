"""Supervised discriminative training of the profile HMM on 20K examples.

Load labeled (sequence, viable) pairs from training_data_20k.json,
train the HMM discriminatively via Adam with cosine decay on BCE loss,
then evaluate: sample from the trained model, measure viability rate V
and model entropy H, estimate mining difficulty.

Usage:
    python -m jax6502.train_supervised_20k
"""
import json, time, sys, numpy as np
import jax, jax.numpy as jnp
import jax.random as jr
import optax

sys.stdout = open(sys.stdout.fileno(), 'w', buffering=1)

from jax6502.hmm import default_params, hmm_log_prob, hmm_sample, HMMParams
from jax6502.train import simulate_candidate

# Load labeled data
print('Loading training data...')
with open('jax6502/training_data_20k.json') as f:
    data = json.load(f)
print(f'Loaded {len(data)} examples, {sum(d["viable"] for d in data)} viable')

# Prepare arrays
max_len = max(len(d['seq']) for d in data)
seqs = np.zeros((len(data), max_len), dtype=np.int32)
masks = np.zeros((len(data), max_len), dtype=np.float32)
labels = np.array([1.0 if d['viable'] else 0.0 for d in data], dtype=np.float32)
for i, d in enumerate(data):
    L = len(d['seq'])
    seqs[i, :L] = d['seq']
    masks[i, :L] = 1.0

params = default_params(mode='core')

# Cosine decay learning rate schedule
n_epochs = 500
batch_size = 256
steps_per_epoch = max(1, len(data) // batch_size)
total_steps = n_epochs * steps_per_epoch

schedule = optax.cosine_decay_schedule(
    init_value=1e-3,
    decay_steps=total_steps,
    alpha=1e-5,  # minimum LR ratio
)
optimizer = optax.adamw(schedule, weight_decay=0.01)
opt_state = optimizer.init(params)


@jax.jit
def train_step(params, opt_state, batch_seqs, batch_masks, batch_labels):
    def loss_fn(p):
        def score_one(args):
            seq, mask = args
            length = mask.sum().astype(jnp.int32)
            return hmm_log_prob(p, seq, length, mode='core')
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


# Train
rng = np.random.RandomState(42)
t0 = time.time()

print(f'\nTraining: {n_epochs} epochs, batch_size={batch_size}, '
      f'{steps_per_epoch} steps/epoch, {total_steps} total steps')
print(f'Learning rate: cosine decay 1e-3 -> ~1e-8\n')

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
    if (epoch + 1) % 50 == 0:
        elapsed = time.time() - t0
        print(f'Epoch {epoch + 1:3d}/{n_epochs}: loss={avg_loss:.4f}, {elapsed:.0f}s')

elapsed = time.time() - t0
print(f'\nTraining complete in {elapsed:.0f}s')

# Evaluate with 1000 samples
print('\nEvaluating trained model (1000 samples)...')
key = jr.PRNGKey(999)
n_eval = 1000
viable_count = 0
log2_probs = []

for i in range(n_eval):
    key, k1, k2 = jr.split(key, 3)
    sample = hmm_sample(params, 8, k1, mode='core')
    seq = [int(b) for b in sample[:8]]
    r = simulate_candidate(seq, board_size=4, rng_key=k2)
    if r['viable']:
        viable_count += 1
    lp = float(hmm_log_prob(params, jnp.array(seq + [0] * 8, dtype=jnp.int32),
                             jnp.int32(8), mode='core'))
    log2_probs.append(lp / np.log(2.0))

    if (i + 1) % 200 == 0:
        print(f'  Evaluated {i+1}/{n_eval}, viable so far: {viable_count}')

V = viable_count / n_eval
H = -np.mean(log2_probs)
print(f'\nResults:')
print(f'  Viable rate V = {viable_count}/{n_eval} = {V:.3f}')
print(f'  Model entropy H ≈ {H:.1f} bits')
if V > 0:
    mining_bits = H - np.log2(V)
    print(f'  Mining difficulty ≈ 2^{mining_bits:.1f} attempts')
    print(f'  On a phone (~1000 evals/sec): ~{2**mining_bits / 1000:.0f} seconds')
else:
    print('  V=0, cannot estimate mining difficulty')

np.savez('jax6502/hmm_trained_20k.npz',
         **{k: np.array(v) for k, v in zip(params._fields, params)})
print(f'\nSaved trained params to jax6502/hmm_trained_20k.npz')
