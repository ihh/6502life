"""Simple supervised discriminative training of the profile HMM.

Load labeled (sequence, viable) pairs from training_data.json,
train the HMM to discriminate viable from non-viable via BCE on
the log-odds score, then evaluate: sample from the trained model,
measure viability rate V and model entropy H, estimate mining difficulty.
"""
import json, time, sys, numpy as np
import jax, jax.numpy as jnp
import jax.random as jr
import optax

if __name__ != '__main__': pass
else: sys.stdout = open(sys.stdout.fileno(), 'w', buffering=1)

from jax6502.hmm import default_params, hmm_log_prob, hmm_sample, HMMParams
from jax6502.train import simulate_candidate

# Load labeled data
with open('jax6502/training_data.json') as f:
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
optimizer = optax.adamw(1e-3, weight_decay=0.01)
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
batch_size = 64
n_epochs = 200
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
print('\nEvaluating trained model...')
key = jr.PRNGKey(999)
n_eval = 500
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

V = viable_count / n_eval
H = -np.mean(log2_probs)
print(f'Viable rate V = {viable_count}/{n_eval} = {V:.3f}')
print(f'Model entropy H ≈ {H:.1f} bits')
if V > 0:
    mining_bits = H - np.log2(V)
    print(f'Mining difficulty ≈ 2^{mining_bits:.1f} attempts')
    print(f'On a phone (~1000 evals/sec): ~{2**mining_bits / 1000:.0f} seconds')
else:
    print('V=0, cannot estimate mining difficulty')

np.savez('jax6502/hmm_trained.npz',
         **{k: np.array(v) for k, v in zip(params._fields, params)})
print('Saved to jax6502/hmm_trained.npz')
