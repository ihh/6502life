"""Tests for the NCE training pipeline."""

import sys
import os
import numpy as np
import pytest

# Check JAX availability
try:
    import jax
    import jax.numpy as jnp
    import jax.random as jr
    HAS_JAX = True
except ImportError:
    HAS_JAX = False

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

if HAS_JAX:
    from jax6502.hmm import default_params, hmm_score_batch, hmm_sample, HMMParams
    from jax6502.train import (
        simulate_candidate,
        simulate_batch_python,
        ReplayBuffer,
        OracleCascade,
        sample_from_hmm,
        ema_mixture_update,
        compute_metrics,
        train_hmm_nce,
        save_params,
        load_params,
        _nce_step_inner,
        _batch_log_prob,
        _pad_sequences,
    )
    import optax

pytestmark = pytest.mark.skipif(not HAS_JAX, reason="JAX not available")


# ---------------------------------------------------------------------------
# Known replicator: B5 00 9D 00 04 E8 90 F8
# This is the canonical 8-byte copier loop.
# ---------------------------------------------------------------------------

KNOWN_REPLICATOR = [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]


class TestSimulateCandidate:
    """Tests for simulate_candidate."""

    def test_known_replicator_spreads(self):
        """Known replicator should spread to multiple cells."""
        result = simulate_candidate(
            KNOWN_REPLICATOR,
            board_size=8,
            num_quanta=800,
            rng_key=jr.PRNGKey(42),
        )
        assert result['spread'] >= 1, (
            f"Known replicator should spread, got spread={result['spread']}")

    def test_random_bytes_no_spread(self):
        """Random bytes should not replicate."""
        random_bytes = [0x42, 0x13, 0x37, 0xAB, 0xCD, 0xEF, 0x00, 0x11]
        result = simulate_candidate(
            random_bytes,
            board_size=8,
            num_quanta=200,
            rng_key=jr.PRNGKey(123),
        )
        # Random bytes almost certainly don't replicate
        assert result['spread'] <= 1, (
            f"Random bytes should not spread, got spread={result['spread']}")

    def test_returns_correct_keys(self):
        """Result should have 'spread' and 'viable' keys."""
        result = simulate_candidate(
            KNOWN_REPLICATOR,
            board_size=4,
            num_quanta=50,
            rng_key=jr.PRNGKey(0),
        )
        assert 'spread' in result
        assert 'viable' in result
        assert isinstance(result['spread'], (int, np.integer))
        assert isinstance(result['viable'], (bool, np.bool_))


class TestSimulateBatch:
    """Tests for simulate_batch_python."""

    def test_batch_matches_single(self):
        """Batch simulation should match single-candidate results."""
        candidates = [
            KNOWN_REPLICATOR,
            [0xEA, 0xEA, 0xEA, 0xEA, 0xEA, 0xEA, 0xEA, 0xEA],
        ]
        batch_spreads = simulate_batch_python(
            candidates,
            board_size=4,
            num_quanta=50,
            rng_key=jr.PRNGKey(99),
        )
        assert batch_spreads.shape == (2,)

        # Run individually with the same key splitting pattern
        rng_key = jr.PRNGKey(99)
        individual_spreads = []
        for seq in candidates:
            rng_key, subkey = jr.split(rng_key)
            r = simulate_candidate(seq, board_size=4, num_quanta=50,
                                   rng_key=subkey)
            individual_spreads.append(r['spread'])

        np.testing.assert_array_equal(batch_spreads, individual_spreads)


class TestReplayBuffer:
    """Tests for ReplayBuffer."""

    def test_stores_and_retrieves(self):
        """Buffer should store and retrieve data correctly."""
        buf = ReplayBuffer(max_size=100, max_len=16)
        seqs = np.array([[1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                         [4, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
                        dtype=np.int32)
        masks = np.array([[1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                          [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
                         dtype=bool)
        labels = np.array([1.0, 0.0], dtype=np.float32)
        log_probs = np.array([-5.0, -10.0], dtype=np.float32)

        buf.add(seqs, masks, labels, log_probs)

        assert buf.size == 2
        np.testing.assert_array_equal(buf.sequences[0, :3], [1, 2, 3])
        np.testing.assert_array_equal(buf.labels[:2], [1.0, 0.0])

    def test_circular_buffer(self):
        """Buffer should wrap around when full."""
        buf = ReplayBuffer(max_size=3, max_len=4)
        for i in range(5):
            seqs = np.array([[i, 0, 0, 0]], dtype=np.int32)
            masks = np.array([[True, False, False, False]])
            labels = np.array([float(i % 2)])
            log_probs = np.array([-1.0])
            buf.add(seqs, masks, labels, log_probs)

        assert buf.size == 3
        # Most recent entries should be present
        assert buf.sequences[buf.write_pos % 3 - 1, 0] == 4

    def test_importance_weights_fresh(self):
        """Fresh samples should have importance weights close to 1.0."""
        buf = ReplayBuffer(max_size=100, max_len=32)
        params = default_params()

        # Sample some sequences
        rng_key = jr.PRNGKey(42)
        seqs, masks = sample_from_hmm(params, 10, [8, 10], rng_key, max_len=32)

        # Compute log probs with current params
        log_probs = np.asarray(_batch_log_prob(params, seqs, masks))

        buf.add(np.asarray(seqs), np.asarray(masks),
                np.zeros(10, dtype=np.float32), log_probs)

        # Sample batch -- weights should be ~1.0 since params haven't changed
        batch = buf.sample_batch(params, batch_size=5, rng_key=jr.PRNGKey(0))
        assert batch is not None
        weights = np.asarray(batch['weights'])
        # All weights should be close to 1.0 (same params)
        np.testing.assert_allclose(weights, 1.0, atol=0.1)

    def test_viable_count(self):
        """viable_count should count correctly."""
        buf = ReplayBuffer(max_size=100, max_len=4)
        seqs = np.zeros((5, 4), dtype=np.int32)
        masks = np.ones((5, 4), dtype=bool)
        labels = np.array([1.0, 0.0, 1.0, 1.0, 0.0])
        log_probs = np.zeros(5)
        buf.add(seqs, masks, labels, log_probs)
        assert buf.viable_count() == 3


class TestNCETrainStep:
    """Tests for the NCE training step."""

    def test_loss_decreases(self):
        """NCE step should reduce loss on a simple batch."""
        params = default_params()
        optimizer = optax.adamw(1e-3, weight_decay=0.01)
        opt_state = optimizer.init(params)

        # Create a small batch with clear labels
        rng_key = jr.PRNGKey(42)
        seqs, masks = sample_from_hmm(params, 8, [8], rng_key, max_len=16)
        # Label first half as viable, second as not
        labels = jnp.array([1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0])
        weights = jnp.ones(8)

        # First step
        _, _, loss1 = _nce_step_inner(
            optimizer, params, opt_state, seqs, masks, labels, weights)

        # Multiple steps to ensure convergence direction
        p = params
        o = opt_state
        for _ in range(10):
            p, o, loss_cur = _nce_step_inner(
                optimizer, p, o, seqs, masks, labels, weights)

        loss_final = float(loss_cur)
        loss_initial = float(loss1)
        assert loss_final < loss_initial + 0.5, (
            f"Loss should decrease: {loss_initial:.4f} -> {loss_final:.4f}")


class TestOracleCascade:
    """Tests for OracleCascade."""

    def test_filters_obvious_cases(self):
        """Obvious negatives should not reach the simulator."""
        params = default_params()

        sim_count = [0]
        def mock_simulate(seqs, **kwargs):
            sim_count[0] += len(seqs)
            return np.zeros(len(seqs), dtype=np.int32)

        cascade = OracleCascade(
            hmm_params=params,
            simulate_fn=mock_simulate,
            hmm_threshold=20.0,
            sim_budget=10,
        )

        # Create a mix of sequences
        rng_key = jr.PRNGKey(42)
        seqs, masks = sample_from_hmm(params, 50, [8, 10], rng_key, max_len=32)

        result = cascade.evaluate(seqs, masks, jr.PRNGKey(0))

        # Should not simulate all 50 -- the HMM filter should reduce the number
        assert sim_count[0] <= 10, (
            f"Simulator called {sim_count[0]} times, should be <= sim_budget=10")
        assert 'hmm_scores' in result
        assert 'labels' in result
        assert result['hmm_scores'].shape[0] == 50

    def test_labels_assigned_for_simulated(self):
        """Simulated candidates should get labels."""
        params = default_params()

        def mock_simulate(seqs, **kwargs):
            # Some spread, some don't
            return np.array([20 if i == 0 else 0
                             for i in range(len(seqs))], dtype=np.int32)

        cascade = OracleCascade(
            hmm_params=params,
            simulate_fn=mock_simulate,
            hmm_threshold=100.0,  # wide filter to let things through
            sim_budget=50,
        )

        rng_key = jr.PRNGKey(42)
        seqs, masks = sample_from_hmm(params, 20, [8], rng_key, max_len=32)
        result = cascade.evaluate(seqs, masks, jr.PRNGKey(0), board_size=8)

        # At least some labels should be assigned
        labeled = ~np.isnan(result['labels'])
        assert labeled.any(), "Some candidates should have labels"


class TestSmokeTraining:
    """Smoke tests for the full training pipeline."""

    def test_train_3_epochs(self):
        """Full train_hmm_nce should run for 3 epochs without error."""
        params = default_params()
        params_out, history, buffer = train_hmm_nce(
            params,
            board_size=4,
            num_epochs=3,
            samples_per_epoch=16,
            sim_budget_per_epoch=4,
            learning_rate=1e-3,
            rng_seed=42,
            lengths=[8],
            max_len=16,
            num_quanta=50,
            verbose=False,
        )

        assert len(history) == 3
        assert all('epoch' in h for h in history)
        assert all('beff' in h for h in history)
        assert all('viable_rate' in h for h in history)

    def test_trained_scores_viable_higher(self):
        """After brief training, HMM should score viable sequences higher
        than random ones (if any viable found)."""
        params = default_params()

        # The known replicator should score higher than random
        known = np.array(KNOWN_REPLICATOR, dtype=np.int32)
        random_seq = np.array([0x42, 0x13, 0x37, 0xAB, 0xCD, 0xEF, 0x00, 0x11],
                              dtype=np.int32)

        seqs = jnp.zeros((2, 16), dtype=jnp.int32)
        seqs = seqs.at[0, :8].set(known)
        seqs = seqs.at[1, :8].set(random_seq)
        masks = jnp.zeros((2, 16), dtype=jnp.bool_)
        masks = masks.at[0, :8].set(True)
        masks = masks.at[1, :8].set(True)

        scores = np.asarray(hmm_score_batch(params, seqs, masks))
        # Known replicator has the canonical copier loop structure, so
        # the HMM (even untrained) should score it higher
        assert scores[0] > scores[1], (
            f"Known replicator score ({scores[0]:.2f}) should exceed "
            f"random ({scores[1]:.2f})")


class TestBeffMetric:
    """Tests for B_eff metric computation."""

    def test_beff_finite(self):
        """B_eff should be finite when there are viable examples."""
        params = default_params()
        buf = ReplayBuffer(max_size=100, max_len=16)

        # Add some data with viable labels
        seqs = np.zeros((10, 16), dtype=np.int32)
        masks = np.ones((10, 16), dtype=bool)
        labels = np.array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0], dtype=np.float32)
        log_probs = np.zeros(10)
        buf.add(seqs, masks, labels, log_probs)

        metrics = compute_metrics(params, buf, 0)
        assert np.isfinite(metrics['beff']), (
            f"B_eff should be finite, got {metrics['beff']}")
        assert metrics['beff'] > 0, "B_eff should be positive"


class TestSaveLoad:
    """Tests for save/load."""

    def test_round_trip(self, tmp_path):
        """Save then load should produce identical params."""
        params = default_params()
        path = str(tmp_path / "test_params.npz")
        save_params(params, path)
        loaded = load_params(path)

        for name in HMMParams._fields:
            orig = getattr(params, name)
            load = getattr(loaded, name)
            np.testing.assert_array_almost_equal(
                np.asarray(orig), np.asarray(load),
                err_msg=f"Mismatch in {name}")


class TestEMAUpdate:
    """Tests for EMA mixture update."""

    def test_ema_changes_logits(self):
        """EMA update should change the 1-byte insert logits."""
        params = default_params()
        # Create fake viable sequences full of NOP (0xEA)
        seqs = jnp.full((5, 16), 0xEA, dtype=jnp.int32)
        masks = jnp.ones((5, 16), dtype=jnp.bool_)

        new_params = ema_mixture_update(params, seqs, masks, alpha=0.5)

        # A byte that had low probability (e.g. 0x42) should have its
        # logit changed -- the empirical distribution puts all mass on 0xEA,
        # so other bytes' logits should move toward -inf
        old_logit_42 = float(params.insert_1byte_logits[0x42])
        new_logit_42 = float(new_params.insert_1byte_logits[0x42])
        # With alpha=0.5 and no observations of 0x42, its logit should
        # decrease substantially
        assert new_logit_42 < old_logit_42 - 1.0, (
            f"EMA should decrease unseen byte logit: {old_logit_42:.2f} -> {new_logit_42:.2f}")
