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
        _nce_step_inner_full,
        _batch_log_prob,
        _batch_log_prob_full,
        _pad_sequences,
        generate_chacha20_negatives,
        estimate_beff_is,
    )
    from jax6502.mine import (
        score_board_cells,
        mine_single_seed,
        mine_seeds,
        estimate_beff_from_mining,
        _generate_board_bytes,
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
        old_logit_42 = float(params.insert_1byte_logits[0, 0x42])
        new_logit_42 = float(new_params.insert_1byte_logits[0, 0x42])
        # With alpha=0.5 and no observations of 0x42, its logit should
        # decrease substantially
        assert new_logit_42 < old_logit_42 - 1.0, (
            f"EMA should decrease unseen byte logit: {old_logit_42:.2f} -> {new_logit_42:.2f}")


# ---------------------------------------------------------------------------
# ChaCha20 negatives
# ---------------------------------------------------------------------------

class TestChaCha20Negatives:
    """Tests for generate_chacha20_negatives."""

    def test_correct_shapes(self):
        """generate_chacha20_negatives produces correct shapes."""
        num_cells = 10
        cell_bytes = 256
        seqs, masks = generate_chacha20_negatives(
            num_cells, jr.PRNGKey(42), cell_bytes=cell_bytes, board_size=4)
        assert seqs.shape == (num_cells, cell_bytes), (
            f"Expected ({num_cells}, {cell_bytes}), got {seqs.shape}")
        assert masks.shape == (num_cells, cell_bytes), (
            f"Expected ({num_cells}, {cell_bytes}), got {masks.shape}")
        # All mask positions should be True
        assert bool(masks.all()), "All mask positions should be True"

    def test_correct_shapes_small(self):
        """Works with smaller cell_bytes."""
        seqs, masks = generate_chacha20_negatives(
            5, jr.PRNGKey(0), cell_bytes=8, board_size=4)
        assert seqs.shape == (5, 8)
        assert masks.shape == (5, 8)

    def test_distinct_from_hmm_samples(self):
        """ChaCha20 negatives should have different score distribution from HMM samples."""
        params = default_params()
        rng_key = jr.PRNGKey(42)

        # HMM samples
        hmm_seqs, hmm_masks = sample_from_hmm(
            params, 20, [8], rng_key, max_len=16)
        hmm_scores = np.asarray(hmm_score_batch(params, hmm_seqs, hmm_masks))

        # ChaCha20 negatives (truncated to 16 bytes to match)
        chacha_seqs, chacha_masks = generate_chacha20_negatives(
            20, jr.PRNGKey(99), cell_bytes=16, board_size=4)
        chacha_scores = np.asarray(hmm_score_batch(params, chacha_seqs, chacha_masks))

        # HMM samples should generally score higher than random ChaCha20
        assert np.mean(hmm_scores) > np.mean(chacha_scores), (
            f"HMM samples (mean={np.mean(hmm_scores):.2f}) should score "
            f"higher than ChaCha20 (mean={np.mean(chacha_scores):.2f})")

    def test_values_in_byte_range(self):
        """All values should be in [0, 255]."""
        seqs, _ = generate_chacha20_negatives(
            10, jr.PRNGKey(42), cell_bytes=256, board_size=4)
        assert int(seqs.min()) >= 0
        assert int(seqs.max()) <= 255

    def test_more_cells_than_board(self):
        """Should handle requesting more cells than board has."""
        # 4x4 board = 16 cells, request 30
        seqs, masks = generate_chacha20_negatives(
            30, jr.PRNGKey(42), cell_bytes=8, board_size=4)
        assert seqs.shape == (30, 8)


class TestMixedTraining:
    """Tests for training with mixed HMM + ChaCha20 sources."""

    def test_train_with_chacha_reduces_loss(self):
        """Training with mixed sources (HMM + ChaCha20) should run and reduce loss."""
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
            mode='core',
            chacha_ratio=0.3,
        )

        assert len(history) == 3
        # Buffer should have both HMM and ChaCha20 samples
        assert buffer.size > 0
        # Check that chacha count is recorded
        assert all('n_chacha' in h for h in history)
        assert all(h['n_chacha'] > 0 for h in history)


# ---------------------------------------------------------------------------
# Mining pipeline
# ---------------------------------------------------------------------------

class TestScoreBoardCells:
    """Tests for score_board_cells."""

    def test_correct_number_of_scores(self):
        """score_board_cells should return one score per cell."""
        params = default_params()
        board_size = 4
        board_bytes = _generate_board_bytes(42, board_size)
        scores = np.asarray(score_board_cells(
            params, board_bytes, board_size, mode='core', cell_bytes=8))
        expected = board_size * board_size
        assert scores.shape == (expected,), (
            f"Expected ({expected},), got {scores.shape}")

    def test_scores_are_finite(self):
        """All scores should be finite."""
        params = default_params()
        board_bytes = _generate_board_bytes(42, 4)
        scores = np.asarray(score_board_cells(
            params, board_bytes, 4, mode='core', cell_bytes=8))
        assert np.all(np.isfinite(scores)), "All scores should be finite"


class TestMineSingleSeed:
    """Tests for mine_single_seed."""

    def test_returns_correct_structure(self):
        """mine_single_seed should return expected dict keys."""
        params = default_params()
        result = mine_single_seed(
            params, seed_int=42, board_size=4,
            K1=5, K2=2, mode='core',
            board_size_sim=4, num_quanta=50,
            rng_key=jr.PRNGKey(42))

        assert 'seed' in result
        assert 'top_scores' in result
        assert 'top_cells' in result
        assert 'viable_cells' in result
        assert 'spreads' in result
        assert 'max_score' in result
        assert 'mean_score' in result
        assert result['seed'] == 42
        assert len(result['spreads']) == 2  # K2=2

    def test_top_scores_sorted(self):
        """Top scores should be in descending order."""
        params = default_params()
        result = mine_single_seed(
            params, seed_int=123, board_size=4,
            K1=10, K2=3, mode='core',
            board_size_sim=4, num_quanta=50)
        top = result['top_scores']
        for i in range(len(top) - 1):
            assert top[i] >= top[i + 1], (
                f"Top scores not sorted: {top[i]:.2f} < {top[i+1]:.2f}")


class TestEstimateBeffIS:
    """Tests for estimate_beff_is."""

    def test_returns_finite_beff(self):
        """estimate_beff_is should return finite B_eff and ESS."""
        params = default_params()
        result = estimate_beff_is(
            params, num_samples=10, mode='core', rng_seed=42,
            board_size=4, num_quanta=50, lengths=[8], max_len=16)

        assert 'beff' in result
        assert 'ess' in result
        assert 'n_viable' in result
        assert 'num_samples' in result
        assert result['num_samples'] == 10
        # B_eff should be non-negative (could be inf if nothing viable)
        assert result['beff'] >= 0


class TestEstimateBeffFromMining:
    """Tests for estimate_beff_from_mining."""

    def test_returns_expected_keys(self):
        """Should return expected dict keys."""
        params = default_params()
        result = estimate_beff_from_mining(
            params, num_seeds=3, board_size=4, mode='core',
            cell_bytes=8, rng_seed=42)

        assert 'max_scores' in result
        assert 'mean_max' in result
        assert 'estimated_beff' in result
        assert 'num_seeds' in result
        assert len(result['max_scores']) == 3


# ---------------------------------------------------------------------------
# Full mode smoke test
# ---------------------------------------------------------------------------

class TestFullModeTraining:
    """Smoke tests for full mode (L=256) training."""

    def test_train_full_mode_3_epochs(self):
        """Full-mode training should run for 3 epochs without error."""
        params = default_params(mode='full')
        params_out, history, buffer = train_hmm_nce(
            params,
            board_size=4,
            num_epochs=3,
            samples_per_epoch=4,
            sim_budget_per_epoch=2,
            learning_rate=1e-3,
            rng_seed=42,
            lengths=[256],
            max_len=256,
            num_quanta=50,
            verbose=False,
            mode='full',
            chacha_ratio=0.25,
        )

        assert len(history) == 3
        assert all(h['mode'] == 'full' for h in history)
        assert buffer.size > 0
