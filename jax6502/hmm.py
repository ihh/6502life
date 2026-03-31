"""
Profile HMM for replicator generation and scoring — pure JAX implementation.

Mirrors dfa/profile-hmm.js: 9 insert states (I0..I8), 8 match states
(M1..M8), and 1 end state.  Match states are folded into the transition
weights between insert states (I_k -> I_{k+1} emits the M_{k+1} byte).

Multi-byte insert emissions (2-byte and 3-byte paths) are handled by
expanding the state space with phantom continuation states:

  - I_k        : ready to start a new insert emission or transition out
  - I_k_2a     : consumed byte 1 of a 2-byte emission (awaiting byte 2)
  - I_k_3a     : consumed byte 1 of a 3-byte emission (awaiting bytes 2,3)
  - I_k_3b     : consumed byte 2 of a 3-byte emission (awaiting byte 3)

Total states: 9*4 + 1 = 37.  This keeps every position-t matrix the same
shape and enables associative-scan reduction.

The forward probability is:

    log P(x | HMM) = log(pi . M(x_0) . M(x_1) . ... . M(x_{L-1}) . f)

where pi is the initial distribution (start in I_0) and f selects the END
state.  The associative scan computes the prefix product in O(log L) depth.

Cross-validated against the JS ``hmmForwardExact`` for correctness.
"""

from functools import partial
from typing import Dict, NamedTuple, Optional, Tuple

import jax
import jax.numpy as jnp
import numpy as np
import optax


# ---------------------------------------------------------------------------
# Constants (mirroring dfa/profile-hmm.js)
# ---------------------------------------------------------------------------

NUM_INSERT = 9   # I0..I8
NUM_MATCH = 8    # M1..M8

# Match state emission constraints (M1..M8).
# Each entry is a tuple of allowed byte values, or None for M8 (deterministic).
MATCH_EMISSIONS = (
    (0xB5,),                                        # M1: LDA zpx
    (0x00,),                                        # M2: zpx address
    (0x9D,),                                        # M3: STA abs,X
    (0x00,),                                        # M4: abs address low
    (0x04,),                                        # M5: abs address high
    (0xE8, 0xCA),                                   # M6: INX or DEX
    (0x90, 0xD0, 0x10, 0x30, 0x50, 0x70, 0xB0),    # M7: branch opcodes
    None,                                           # M8: branch offset
)

# Expanded state indices
# I_k        -> 4*k + 0   (k = 0..8)
# I_k_2a     -> 4*k + 1
# I_k_3a     -> 4*k + 2
# I_k_3b     -> 4*k + 3
# END        -> 36

NUM_STATES = NUM_INSERT * 4 + 1  # 37
END_STATE = NUM_STATES - 1       # 36

_NEG_INF = -1e30  # practical -inf for log-space (avoids NaN in gradients)


def _ik(k):
    """Index of insert state I_k (k=0..8)."""
    return 4 * k


def _ik_2a(k):
    """Index of phantom state: byte 1 of 2-byte emission at I_k."""
    return 4 * k + 1


def _ik_3a(k):
    """Index of phantom state: byte 1 of 3-byte emission at I_k."""
    return 4 * k + 2


def _ik_3b(k):
    """Index of phantom state: byte 2 of 3-byte emission at I_k."""
    return 4 * k + 3


# ---------------------------------------------------------------------------
# Parameter pytree
# ---------------------------------------------------------------------------

class HMMParams(NamedTuple):
    """All trainable HMM parameters (unconstrained logits)."""
    # Insert state self-loop logits (9,) -- sigmoid -> delta_k
    log_delta: jnp.ndarray            # [9]
    # 1-byte insert emission logits
    insert_1byte_logits: jnp.ndarray  # [256]
    # 2-byte insert: N=3 classes
    insert_2byte_mix_logits: jnp.ndarray  # [3]
    insert_2byte_logits: jnp.ndarray      # [3, 2, 256]
    # 3-byte insert: N=3 classes
    insert_3byte_mix_logits: jnp.ndarray  # [3]
    insert_3byte_logits: jnp.ndarray      # [3, 3, 256]
    # Path mixing logits [1-byte, 2-byte, 3-byte]
    path_mix_logits: jnp.ndarray      # [3]
    # Match state emission logits (only M6 and M7 have choices)
    match6_logits: jnp.ndarray        # [2]   -- INX vs DEX
    match7_logits: jnp.ndarray        # [7]   -- branch opcodes


# ---------------------------------------------------------------------------
# Default parameters (matching JS InsertEmission defaults)
# ---------------------------------------------------------------------------

# Safe single-byte opcodes and their priors
_SAFE_SINGLE = np.array([
    0xEA, 0xD8, 0xF8, 0xC8, 0x88, 0xA8, 0x98, 0x18, 0x38, 0xB8,
    0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA,
], dtype=np.int32)

_SAFE_TWO_BYTE_PREFIXES = np.array([0xA0, 0xA2, 0xE0, 0xC0], dtype=np.int32)

_RISKY_SINGLE = np.array([
    0x85, 0xAA, 0x8A, 0x48, 0x68, 0x08, 0x28, 0x9A, 0xBA,
], dtype=np.int32)

# Opcode sets for 2-byte classes
_IMM_LOAD_OPCODES = np.array([0xA0, 0xA2, 0xE0, 0xC0], dtype=np.int32)
_ZPG_OPCODES = np.array([
    0x85, 0xA5, 0x24, 0x45, 0x65, 0x84, 0xA4, 0xC4, 0xE4, 0x05, 0x25,
], dtype=np.int32)
_UNDOC_2_OPCODES = np.array([0x80, 0x82, 0x89, 0xC2, 0xE2], dtype=np.int32)

# Opcode sets for 3-byte classes
_ABS_LOAD_OPCODES = np.array([0xAD, 0xAE, 0xAC], dtype=np.int32)
_ABS_STORE_OPCODES = np.array([0x8D, 0x8E, 0x8C], dtype=np.int32)
_UNDOC_3_OPCODES = np.array([0x0C, 0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC],
                            dtype=np.int32)

# M6 allowed bytes: [INX=0xE8, DEX=0xCA]
_M6_BYTES = np.array([0xE8, 0xCA], dtype=np.int32)

# M7 allowed bytes: branch opcodes
_M7_BYTES = np.array([0x90, 0xD0, 0x10, 0x30, 0x50, 0x70, 0xB0],
                      dtype=np.int32)

# Pre-computed lookup tables (JAX constants)
_M6_BYTES_JAX = jnp.array(_M6_BYTES)
_M7_BYTES_JAX = jnp.array(_M7_BYTES)


def _build_logits_from_weights(weight_fn) -> np.ndarray:
    """Build unnormalised logits (256,) from a weight function.

    We store log(weight) so that softmax(logits) ~ normalised probs.
    """
    w = np.array([weight_fn(b) for b in range(256)], dtype=np.float32)
    # Store as log-weights (softmax will normalise later)
    return np.log(np.maximum(w, 1e-30)).astype(np.float32)


def default_params() -> HMMParams:
    """Create default HMM parameters matching the JS constructor."""

    # delta defaults
    delta_init = np.array(
        [0.3, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.3], dtype=np.float32)
    # sigmoid^{-1}(delta)
    log_delta = np.log(delta_init / (1.0 - delta_init)).astype(np.float32)

    # 1-byte insert emission weights
    safe_set = set(_SAFE_SINGLE.tolist())
    two_byte_set = set(_SAFE_TWO_BYTE_PREFIXES.tolist())
    risky_set = set(_RISKY_SINGLE.tolist())

    def p1_weight(b):
        if b in safe_set:
            return 1.0
        if b in two_byte_set:
            return 0.8
        if b in risky_set:
            return 0.1
        return 0.01

    insert_1byte_logits = _build_logits_from_weights(p1_weight)

    # 2-byte path: 3 classes x 2 positions x 256 bytes
    imm_set = set(_IMM_LOAD_OPCODES.tolist())
    zpg_set = set(_ZPG_OPCODES.tolist())
    undoc2_set = set(_UNDOC_2_OPCODES.tolist())

    # Class 0: immediate loads
    c0_p0 = _build_logits_from_weights(
        lambda b: 5.0 if b in imm_set else 0.01)
    c0_p1 = _build_logits_from_weights(lambda b: 1.0)

    # Class 1: zero-page ops
    c1_p0 = _build_logits_from_weights(
        lambda b: 3.0 if b in zpg_set else 0.01)
    c1_p1 = _build_logits_from_weights(
        lambda b: 2.0 if b < 0x10 else (1.0 if b < 0x80 else 0.5))

    # Class 2: undocumented 2-byte NOPs
    c2_p0 = _build_logits_from_weights(
        lambda b: 5.0 if b in undoc2_set else 0.01)
    c2_p1 = _build_logits_from_weights(lambda b: 1.0)

    insert_2byte_logits = np.stack([
        np.stack([c0_p0, c0_p1]),
        np.stack([c1_p0, c1_p1]),
        np.stack([c2_p0, c2_p1]),
    ])  # [3, 2, 256]
    insert_2byte_mix_logits = np.zeros(3, dtype=np.float32)  # uniform

    # 3-byte path: 3 classes x 3 positions x 256 bytes
    abs_load_set = set(_ABS_LOAD_OPCODES.tolist())
    abs_store_set = set(_ABS_STORE_OPCODES.tolist())
    undoc3_set = set(_UNDOC_3_OPCODES.tolist())

    # Class 0: absolute loads
    c0_3p0 = _build_logits_from_weights(
        lambda b: 5.0 if b in abs_load_set else 0.01)
    c0_3p1 = _build_logits_from_weights(lambda b: 1.0)
    c0_3p2 = _build_logits_from_weights(lambda b: 1.0)

    # Class 1: absolute stores
    c1_3p0 = _build_logits_from_weights(
        lambda b: 5.0 if b in abs_store_set else 0.01)
    c1_3p1 = _build_logits_from_weights(lambda b: 1.0)
    c1_3p2 = _build_logits_from_weights(
        lambda b: 2.0 if b < 0x08 else 0.5)

    # Class 2: undocumented 3-byte NOPs
    c2_3p0 = _build_logits_from_weights(
        lambda b: 5.0 if b in undoc3_set else 0.01)
    c2_3p1 = _build_logits_from_weights(lambda b: 1.0)
    c2_3p2 = _build_logits_from_weights(lambda b: 1.0)

    insert_3byte_logits = np.stack([
        np.stack([c0_3p0, c0_3p1, c0_3p2]),
        np.stack([c1_3p0, c1_3p1, c1_3p2]),
        np.stack([c2_3p0, c2_3p1, c2_3p2]),
    ])  # [3, 3, 256]
    insert_3byte_mix_logits = np.zeros(3, dtype=np.float32)

    # Path mixing: [0.6, 0.3, 0.1]
    path_mix_logits = np.log(np.array([0.6, 0.3, 0.1], dtype=np.float32))

    # Match6: uniform over 2 choices
    match6_logits = np.zeros(2, dtype=np.float32)

    # Match7: uniform over 7 choices
    match7_logits = np.zeros(7, dtype=np.float32)

    return HMMParams(
        log_delta=jnp.array(log_delta),
        insert_1byte_logits=jnp.array(insert_1byte_logits),
        insert_2byte_mix_logits=jnp.array(insert_2byte_mix_logits),
        insert_2byte_logits=jnp.array(insert_2byte_logits),
        insert_3byte_mix_logits=jnp.array(insert_3byte_mix_logits),
        insert_3byte_logits=jnp.array(insert_3byte_logits),
        path_mix_logits=jnp.array(path_mix_logits),
        match6_logits=jnp.array(match6_logits),
        match7_logits=jnp.array(match7_logits),
    )


# ---------------------------------------------------------------------------
# Emission helpers
# ---------------------------------------------------------------------------

def _insert_1byte_log_prob(params: HMMParams, byte_val: jnp.ndarray):
    """Log P(byte | 1-byte insert path).

    Args:
        byte_val: scalar int, byte value 0-255.

    Returns:
        scalar log-probability.
    """
    log_probs = jax.nn.log_softmax(params.insert_1byte_logits)
    return log_probs[byte_val]


def _insert_2byte_log_prob(params: HMMParams,
                           b1: jnp.ndarray, b2: jnp.ndarray):
    """Log P((b1, b2) | 2-byte insert path) = logsumexp_k pi_k P(b1|k,0) P(b2|k,1)."""
    log_pi = jax.nn.log_softmax(params.insert_2byte_mix_logits)  # [3]
    # Per-class, per-position log-softmax
    log_probs = jax.nn.log_softmax(params.insert_2byte_logits, axis=-1)  # [3,2,256]
    # log P(b1|k,0) + log P(b2|k,1)
    per_class = log_pi + log_probs[:, 0, b1] + log_probs[:, 1, b2]  # [3]
    return jax.scipy.special.logsumexp(per_class)


def _insert_3byte_log_prob(params: HMMParams,
                           b1: jnp.ndarray, b2: jnp.ndarray,
                           b3: jnp.ndarray):
    """Log P((b1, b2, b3) | 3-byte insert path)."""
    log_rho = jax.nn.log_softmax(params.insert_3byte_mix_logits)  # [3]
    log_probs = jax.nn.log_softmax(params.insert_3byte_logits, axis=-1)  # [3,3,256]
    per_class = (log_rho
                 + log_probs[:, 0, b1]
                 + log_probs[:, 1, b2]
                 + log_probs[:, 2, b3])  # [3]
    return jax.scipy.special.logsumexp(per_class)


def _match_log_prob(params: HMMParams, match_idx: int, byte_val: jnp.ndarray):
    """Log P(byte | match state match_idx).

    match_idx 0..7 corresponds to M1..M8.
    M1..M5 are point masses (single allowed byte).
    M6 has 2 choices, M7 has 7 choices.
    M8 is handled separately (deterministic offset).
    """
    if match_idx <= 4:
        # Point mass: P = 1 if byte matches, else 0
        allowed = MATCH_EMISSIONS[match_idx][0]
        return jnp.where(byte_val == allowed, 0.0, _NEG_INF)
    elif match_idx == 5:
        # M6: INX (0xE8) or DEX (0xCA)
        log_probs = jax.nn.log_softmax(params.match6_logits)  # [2]
        # Map byte_val to index: 0xE8 -> 0, 0xCA -> 1
        is_e8 = (byte_val == 0xE8)
        is_ca = (byte_val == 0xCA)
        lp = jnp.where(is_e8, log_probs[0],
             jnp.where(is_ca, log_probs[1], _NEG_INF))
        return lp
    elif match_idx == 6:
        # M7: 7 branch opcodes
        log_probs = jax.nn.log_softmax(params.match7_logits)  # [7]
        # Check each allowed byte
        is_match = (byte_val == _M7_BYTES_JAX)  # [7] bool
        # logsumexp over matches (at most one is True)
        lp = jnp.where(is_match, log_probs, _NEG_INF)
        return jax.scipy.special.logsumexp(lp)
    else:
        # M8: handled separately (returns 0.0, offset check is external)
        return 0.0


# ---------------------------------------------------------------------------
# Transition-emission matrix construction
# ---------------------------------------------------------------------------

def _make_match_emission_table(params: HMMParams, byte_val: jnp.ndarray):
    """Compute log P(byte_val | M_k) for k=1..8 (indices 0..7).

    Returns: [8] array of log-probabilities.
    """
    # M1..M5: point masses
    m1 = jnp.where(byte_val == 0xB5, 0.0, _NEG_INF)
    m2 = jnp.where(byte_val == 0x00, 0.0, _NEG_INF)
    m3 = jnp.where(byte_val == 0x9D, 0.0, _NEG_INF)
    m4 = jnp.where(byte_val == 0x00, 0.0, _NEG_INF)
    m5 = jnp.where(byte_val == 0x04, 0.0, _NEG_INF)

    # M6: INX or DEX
    m6_log_probs = jax.nn.log_softmax(params.match6_logits)
    m6 = jnp.where(byte_val == 0xE8, m6_log_probs[0],
         jnp.where(byte_val == 0xCA, m6_log_probs[1], _NEG_INF))

    # M7: branch opcodes
    m7_log_probs = jax.nn.log_softmax(params.match7_logits)
    m7_matches = (byte_val == _M7_BYTES_JAX)  # [7]
    m7_lps = jnp.where(m7_matches, m7_log_probs, _NEG_INF)
    m7 = jax.scipy.special.logsumexp(m7_lps)

    # M8: offset check done externally, emission is 1.0 (log = 0)
    m8 = 0.0

    return jnp.array([m1, m2, m3, m4, m5, m6, m7, m8])


def make_emission_matrix(params: HMMParams,
                         byte_t: jnp.ndarray,
                         byte_t1: jnp.ndarray,
                         byte_t2: jnp.ndarray,
                         pos: jnp.ndarray,
                         m1_pos: jnp.ndarray):
    """Generate the [S, S] transition-emission matrix for position t.

    Each entry M[s, s'] is the log-probability of transitioning from state s
    to state s' while consuming byte_t at position t.

    Multi-byte insert emissions use phantom continuation states:
    - 1-byte: I_k -> I_k (self-loop)
    - 2-byte: I_k -> I_k_2a (byte 1), then I_k_2a -> I_k (byte 2)
    - 3-byte: I_k -> I_k_3a (byte 1), I_k_3a -> I_k_3b (byte 2),
              I_k_3b -> I_k (byte 3)

    Match transitions: I_k -> I_{k+1} (consuming the M_{k+1} byte).

    Args:
        params: HMMParams pytree.
        byte_t: current byte (scalar int).
        byte_t1: byte at t+1 (for 2-byte emission initiation check; not
                 consumed here but used for the emission weight at t).
        byte_t2: byte at t+2 (for 3-byte emission initiation check).
        pos: position index t (scalar int).
        m1_pos: position of M1 in the sequence (scalar int), needed for
                M8 branch offset check.

    Returns:
        [S, S] matrix in log-space.
    """
    S = NUM_STATES
    # Start with all -inf
    mat = jnp.full((S, S), _NEG_INF, dtype=jnp.float32)

    # Precompute shared quantities
    delta = jax.nn.sigmoid(params.log_delta)         # [9]
    log_delta = jnp.log(delta + 1e-30)               # [9]
    log_1m_delta = jnp.log(1.0 - delta + 1e-30)      # [9]

    log_path_mix = jax.nn.log_softmax(params.path_mix_logits)  # [3]

    # 1-byte emission log-probs
    p1_log = jax.nn.log_softmax(params.insert_1byte_logits)    # [256]
    log_emit_1 = p1_log[byte_t]  # scalar

    # 2-byte emission: byte_t is position 0
    p2_log = jax.nn.log_softmax(params.insert_2byte_logits, axis=-1)  # [3,2,256]
    log_pi2 = jax.nn.log_softmax(params.insert_2byte_mix_logits)       # [3]

    # 3-byte emission: byte_t is position 0
    p3_log = jax.nn.log_softmax(params.insert_3byte_logits, axis=-1)  # [3,3,256]
    log_rho3 = jax.nn.log_softmax(params.insert_3byte_mix_logits)      # [3]

    # Match emission log-probs for byte_t
    match_lp = _make_match_emission_table(params, byte_t)  # [8]

    # M8 offset check: expected offset for M8 at this position
    # If M8 is at position pos, offset = -(pos - m1_pos + 1) & 0xFF
    expected_offset = (-(pos - m1_pos + 1)) & 0xFF
    m8_offset_ok = (byte_t == expected_offset).astype(jnp.float32)

    # Process each insert state k = 0..8
    for k in range(NUM_INSERT):
        ik = _ik(k)
        ik_2a = _ik_2a(k)
        ik_3a = _ik_3a(k)
        ik_3b = _ik_3b(k)

        # --- 1-byte insert self-loop: I_k -> I_k ---
        # weight = delta_k * alpha_1 * P1(byte_t)
        w_1byte = log_delta[k] + log_path_mix[0] + log_emit_1
        mat = mat.at[ik, ik].set(w_1byte)

        # --- 2-byte insert: I_k -> I_k_2a (start) ---
        # At position t, we START a 2-byte emission.
        # Weight at this step: delta_k * alpha_2 * P2_class_marginal(byte_t at pos 0)
        # The class-marginal: logsumexp_k' pi_k' * P2(byte_t | k', 0)
        log_p2_pos0 = jax.scipy.special.logsumexp(
            log_pi2 + p2_log[:, 0, byte_t])  # scalar
        w_2byte_start = log_delta[k] + log_path_mix[1] + log_p2_pos0
        mat = mat.at[ik, ik_2a].set(w_2byte_start)

        # --- 2-byte continuation: I_k_2a -> I_k ---
        # At position t, byte_t is the SECOND byte of the 2-byte emission.
        # Weight: P2(byte_t | class, pos 1) / P2_class_marginal(pos 0 byte)
        # But we don't know the pos-0 byte here. The weight was already
        # split: at start we put P2(b0|*,0), here we put P2(b_t|*,1).
        # The class posterior weights from step t-1 are implicit in the
        # matrix product. Actually, the proper factorisation:
        #   I_k -> I_k_2a:  delta * alpha_2 * sum_k' pi_k' * P(b_t | k', 0)
        #   I_k_2a -> I_k:  need conditional on class.
        # But we marginalised over classes at the start, so we can't
        # condition here. The correct approach:
        #   expand I_k_2a into N sub-states (one per class).
        # That would add 9*3 = 27 more states (total 64). Alternatively:
        #   At the START of a 2-byte emission, put the FULL 2-byte weight
        #   (including both bytes via lookahead), and make the continuation
        #   deterministic (weight 1).
        # This is valid because at position t when we START a 2-byte
        # emission, we know byte_t AND byte_{t+1} via lookahead.
        # So: I_k -> I_k_2a weight includes P2(byte_t, byte_{t+1}).
        # I_k_2a -> I_k weight is 0 (log 1).
        # We need to RECOMPUTE the start weight using lookahead.

        # Actually, let's do it properly with lookahead:
        # I_k -> I_k_2a: delta_k * alpha_2 * P2(byte_t, byte_{t+1})
        # I_k_2a -> I_k: 0.0 (log 1, deterministic pass-through)
        log_p2_full = _insert_2byte_log_prob(params, byte_t, byte_t1)
        w_2byte_start_full = log_delta[k] + log_path_mix[1] + log_p2_full
        mat = mat.at[ik, ik_2a].set(w_2byte_start_full)

        # Continuation: I_k_2a -> I_k (pass-through, weight = 1)
        mat = mat.at[ik_2a, ik].set(0.0)

        # --- 3-byte insert: I_k -> I_k_3a (start with full lookahead) ---
        log_p3_full = _insert_3byte_log_prob(params, byte_t, byte_t1, byte_t2)
        w_3byte_start_full = log_delta[k] + log_path_mix[2] + log_p3_full
        mat = mat.at[ik, ik_3a].set(w_3byte_start_full)

        # Continuation: I_k_3a -> I_k_3b (pass-through)
        mat = mat.at[ik_3a, ik_3b].set(0.0)

        # Continuation: I_k_3b -> I_k (pass-through)
        mat = mat.at[ik_3b, ik].set(0.0)

        # --- Match transition: I_k -> I_{k+1} ---
        # Consuming byte_t as the M_{k+1} emission.
        if k < 8:
            mk1 = k  # match_lp index (0-based: M1=0, ..., M8=7)
            next_ik = _ik(k + 1)

            if mk1 < 7:
                # M1..M7: standard match emission
                w_match = log_1m_delta[k] + match_lp[mk1]
                mat = mat.at[ik, next_ik].set(w_match)
            else:
                # M8 (mk1 == 7): branch offset must match
                w_match = log_1m_delta[k] + jnp.where(
                    m8_offset_ok > 0.5, 0.0, _NEG_INF)
                mat = mat.at[ik, next_ik].set(w_match)

        # --- I_8 -> END (non-emitting transition) ---
        # This is tricky: I_8 -> END is non-emitting, meaning at position t
        # in state I_8, we can transition to END without consuming a byte.
        # But in the matrix formulation every position consumes a byte.
        # Solution: we handle the final I_8 -> END transition outside the
        # scan, in the "final vector" f.

    # END state self-loop (absorbing)
    mat = mat.at[END_STATE, END_STATE].set(0.0)

    return mat


# ---------------------------------------------------------------------------
# Log-semiring matrix multiply for associative scan
# ---------------------------------------------------------------------------

def log_matmul(A: jnp.ndarray, B: jnp.ndarray) -> jnp.ndarray:
    """Matrix multiply in log-semiring.

    C[..., i, j] = logsumexp_k(A[..., i, k] + B[..., k, j])

    Supports arbitrary leading batch dimensions (as required by
    ``jax.lax.associative_scan`` which batches calls internally).

    Args:
        A: [..., S, S] log-space matrix.
        B: [..., S, S] log-space matrix.

    Returns:
        [..., S, S] log-space product.
    """
    # A[..., :, :, None] + B[..., None, :, :] -> [..., S, S, S]
    # logsumexp over axis -2
    return jax.scipy.special.logsumexp(
        A[..., :, :, None] + B[..., None, :, :], axis=-2)


# ---------------------------------------------------------------------------
# Forward algorithm via associative scan
# ---------------------------------------------------------------------------

@partial(jax.jit, static_argnames=())
def hmm_log_prob(params: HMMParams,
                 byte_seq: jnp.ndarray,
                 length: jnp.ndarray,
                 m1_pos: jnp.ndarray) -> jnp.ndarray:
    """Compute log P(seq | HMM) using associative scan.

    Args:
        params: HMMParams pytree.
        byte_seq: [L] int32 byte sequence (padded to max length).
        length: scalar int, actual sequence length.
        m1_pos: scalar int, position of M1 (LDA zpx = 0xB5) in the sequence.

    Returns:
        scalar log-probability.
    """
    L = byte_seq.shape[0]
    positions = jnp.arange(L, dtype=jnp.int32)

    # Lookahead bytes (with zero-padding at boundaries)
    bytes_t = byte_seq
    bytes_t1 = jnp.concatenate([byte_seq[1:], jnp.zeros(1, dtype=jnp.int32)])
    bytes_t2 = jnp.concatenate([byte_seq[2:], jnp.zeros(2, dtype=jnp.int32)])

    # Generate all [L, S, S] matrices via vmap
    all_matrices = jax.vmap(
        make_emission_matrix, in_axes=(None, 0, 0, 0, 0, None)
    )(params, bytes_t, bytes_t1, bytes_t2, positions, m1_pos)
    # shape: [L, S, S]

    # Mask: positions >= length get identity matrix (log-space: 0 on diagonal)
    mask = (positions < length)[:, None, None]  # [L, 1, 1]
    identity = jnp.where(
        jnp.eye(NUM_STATES, dtype=jnp.bool_), 0.0, _NEG_INF)
    all_matrices = jnp.where(mask, all_matrices, identity[None, :, :])

    # Associative scan to compute prefix products
    prefix_products = jax.lax.associative_scan(log_matmul, all_matrices, axis=0)
    # prefix_products[t] = M(x_0) . M(x_1) . ... . M(x_t)

    # Extract the final product (at position length-1)
    final_product = prefix_products[length - 1]  # [S, S]

    # Initial vector: start in I_0
    pi = jnp.full(NUM_STATES, _NEG_INF)
    pi = pi.at[_ik(0)].set(0.0)

    # Result after full product: pi . product
    # result[s'] = logsumexp_s(pi[s] + product[s, s'])
    result = jax.scipy.special.logsumexp(
        pi[:, None] + final_product, axis=0)  # [S]

    # Final: transition from I_8 to END (non-emitting)
    delta_8 = jax.nn.sigmoid(params.log_delta[8])
    log_1m_delta_8 = jnp.log(1.0 - delta_8 + 1e-30)

    # log P = result[I_8] + log(1 - delta_8)
    log_p = result[_ik(8)] + log_1m_delta_8

    return log_p


def hmm_log_prob_marginal(params: HMMParams,
                          byte_seq: jnp.ndarray,
                          length: jnp.ndarray) -> jnp.ndarray:
    """Compute log P(seq | HMM) marginalised over all possible M1 positions.

    This mirrors the JS ``hmmForwardExact`` which sums over all M1 positions.

    Args:
        params: HMMParams pytree.
        byte_seq: [L] int32 byte sequence (padded to max length).
        length: scalar int, actual sequence length.

    Returns:
        scalar log-probability.
    """
    L = byte_seq.shape[0]

    # For each possible M1 position, compute log_prob and logsumexp
    m1_candidates = jnp.arange(L, dtype=jnp.int32)

    def score_m1(m1_pos):
        # Only valid if byte_seq[m1_pos] == 0xB5 and m1_pos <= length - 8
        valid = (byte_seq[m1_pos] == 0xB5) & (m1_pos <= length - 8)
        lp = hmm_log_prob(params, byte_seq, length, m1_pos)
        return jnp.where(valid, lp, _NEG_INF)

    all_lps = jax.vmap(score_m1)(m1_candidates)  # [L]
    return jax.scipy.special.logsumexp(all_lps)


# ---------------------------------------------------------------------------
# Discriminative loss
# ---------------------------------------------------------------------------

def _score_single(params: HMMParams,
                  seq: jnp.ndarray,
                  mask: jnp.ndarray) -> jnp.ndarray:
    """Score a single (padded) sequence.

    Returns log-odds: log P(x|HMM) + L * ln(256).
    """
    length = mask.sum().astype(jnp.int32)
    log_p = hmm_log_prob_marginal(params, seq, length)
    # Null model: uniform IID, log P(x|null) = -L * ln(256)
    # log-odds = log P(x|HMM) - log P(x|null) = log P(x|HMM) + L * ln(256)
    null_log_p = -length.astype(jnp.float32) * jnp.log(256.0)
    return log_p - null_log_p


def discriminative_loss(params: HMMParams,
                        viable_seqs: jnp.ndarray,
                        viable_masks: jnp.ndarray,
                        nonviable_seqs: jnp.ndarray,
                        nonviable_masks: jnp.ndarray) -> jnp.ndarray:
    """Discriminative Baum-Welch loss (binary cross-entropy on log-odds).

    Loss = -mean_viable log sigma(score) - mean_nonviable log sigma(-score)

    where score = log P(x|HMM) + L * ln(256).

    Args:
        viable_seqs: [B_v, L] int32.
        viable_masks: [B_v, L] bool.
        nonviable_seqs: [B_n, L] int32.
        nonviable_masks: [B_n, L] bool.

    Returns:
        scalar loss.
    """
    # Score viable sequences
    viable_scores = jax.vmap(_score_single, in_axes=(None, 0, 0))(
        params, viable_seqs, viable_masks)  # [B_v]

    # Score non-viable sequences
    nonviable_scores = jax.vmap(_score_single, in_axes=(None, 0, 0))(
        params, nonviable_seqs, nonviable_masks)  # [B_n]

    # Binary cross-entropy
    # -log sigma(s) = softplus(-s)
    # -log sigma(-s) = softplus(s)
    viable_loss = jax.nn.softplus(-viable_scores).mean()
    nonviable_loss = jax.nn.softplus(nonviable_scores).mean()

    return viable_loss + nonviable_loss


# ---------------------------------------------------------------------------
# Batch scoring
# ---------------------------------------------------------------------------

@jax.jit
def hmm_score_batch(params: HMMParams,
                    byte_seqs: jnp.ndarray,
                    length_masks: jnp.ndarray) -> jnp.ndarray:
    """Score a batch of sequences: log P(x|HMM) + L * ln(256).

    Args:
        byte_seqs: [B, L] int32.
        length_masks: [B, L] bool.

    Returns:
        [B] log-odds scores.
    """
    return jax.vmap(_score_single, in_axes=(None, 0, 0))(
        params, byte_seqs, length_masks)


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def create_optimizer(lr: float = 1e-3):
    """Create AdamW optimizer."""
    return optax.adamw(lr)


def _make_train_step(optimizer):
    """Create a JIT-compiled training step for the given optimizer."""

    @jax.jit
    def step(params, opt_state, viable_batch, viable_masks,
             nonviable_batch, nonviable_masks):
        loss, grads = jax.value_and_grad(discriminative_loss)(
            params, viable_batch, viable_masks,
            nonviable_batch, nonviable_masks)
        updates, new_opt_state = optimizer.update(grads, opt_state, params)
        new_params = optax.apply_updates(params, updates)
        return HMMParams(*new_params), new_opt_state, loss

    return step


def train(params: HMMParams,
          viable_seqs: jnp.ndarray,
          viable_masks: jnp.ndarray,
          nonviable_seqs: jnp.ndarray,
          nonviable_masks: jnp.ndarray,
          epochs: int = 100,
          lr: float = 1e-3):
    """Full training loop.

    Args:
        params: initial HMMParams.
        viable_seqs: [N_v, L] int32.
        viable_masks: [N_v, L] bool.
        nonviable_seqs: [N_n, L] int32.
        nonviable_masks: [N_n, L] bool.
        epochs: number of training iterations.
        lr: learning rate.

    Returns:
        (final_params, losses).
    """
    optimizer = create_optimizer(lr)
    opt_state = optimizer.init(params)
    step_fn = _make_train_step(optimizer)
    losses = []

    for epoch in range(epochs):
        params, opt_state, loss = step_fn(
            params, opt_state,
            viable_seqs, viable_masks,
            nonviable_seqs, nonviable_masks)
        losses.append(float(loss))

    return params, losses


# ---------------------------------------------------------------------------
# Sampler (ancestral sampling)
# ---------------------------------------------------------------------------

def hmm_sample(params: HMMParams,
               length: int,
               rng_key: jnp.ndarray) -> Optional[jnp.ndarray]:
    """Sample a sequence of given length from the HMM.

    Uses ancestral sampling:
    1. Sample insert counts for each slot (geometric distribution).
    2. Fill match bytes deterministically (except M6, M7, M8).
    3. Fill insert bytes from the mixture model.

    This is NOT JIT-compiled (uses Python control flow).

    Args:
        params: HMMParams.
        length: target sequence length.
        rng_key: JAX PRNG key.

    Returns:
        [length] int32 array, or None if impossible.
    """
    if length < 8:
        return None

    insert_slots = length - 8  # total insert bytes needed

    delta = jax.nn.sigmoid(params.log_delta)  # [9]
    delta_np = np.array(delta)

    # Sample insert counts for each slot
    rng_key, subkey = jax.random.split(rng_key)
    counts = _sample_insert_counts(delta_np, insert_slots, subkey)
    if counts is None:
        return None

    result = np.zeros(length, dtype=np.int32)
    pos = 0
    rng_key_np = rng_key

    # I0 inserts
    rng_key_np, subkey = jax.random.split(rng_key_np)
    pos = _fill_insert_bytes(params, result, pos, counts[0], subkey)

    # M1: 0xB5
    m1_pos = pos
    result[pos] = 0xB5
    pos += 1

    # M2..M8 with I1..I7 inserts between them
    for k in range(1, 8):
        # I_k inserts
        rng_key_np, subkey = jax.random.split(rng_key_np)
        pos = _fill_insert_bytes(params, result, pos, counts[k], subkey)

        # M_{k+1}
        mk = k + 1  # match index (1-based)
        if mk <= 5:
            # Point mass
            result[pos] = MATCH_EMISSIONS[mk - 1][0]
            pos += 1
        elif mk == 6:
            # M6: sample INX or DEX
            rng_key_np, subkey = jax.random.split(rng_key_np)
            probs = jax.nn.softmax(params.match6_logits)
            idx = int(jax.random.categorical(subkey, jnp.log(probs)))
            result[pos] = _M6_BYTES[idx]
            pos += 1
        elif mk == 7:
            # M7: sample branch opcode
            rng_key_np, subkey = jax.random.split(rng_key_np)
            probs = jax.nn.softmax(params.match7_logits)
            idx = int(jax.random.categorical(subkey, jnp.log(probs)))
            result[pos] = _M7_BYTES[idx]
            pos += 1
        elif mk == 8:
            # M8: deterministic branch offset
            offset = (-(pos - m1_pos + 1)) & 0xFF
            result[pos] = offset
            pos += 1

    # I8 inserts
    rng_key_np, subkey = jax.random.split(rng_key_np)
    pos = _fill_insert_bytes(params, result, pos, counts[8], subkey)

    if pos != length:
        return None

    return jnp.array(result, dtype=jnp.int32)


def _sample_insert_counts(delta_np, total, rng_key):
    """Sample insert byte counts for 9 slots summing to total."""
    counts = [0] * 9
    remaining = total

    for k in range(9):
        if remaining == 0:
            counts[k] = 0
            continue
        d = float(delta_np[k])
        if d == 0:
            counts[k] = 0
            continue
        # Sample geometric
        n = 0
        while n < remaining:
            rng_key, subkey = jax.random.split(rng_key)
            u = float(jax.random.uniform(subkey))
            if u >= d:
                break
            n += 1
        counts[k] = n
        remaining -= n

    # Distribute remaining to last slot
    if remaining > 0:
        counts[8] += remaining

    return counts


def _fill_insert_bytes(params, result, pos, count, rng_key):
    """Fill insert bytes into result array. Returns new position."""
    emitted = 0
    while emitted < count:
        remaining = count - emitted
        rng_key, path_key, class_key, byte_key = jax.random.split(rng_key, 4)

        # Sample path
        path_probs = jax.nn.softmax(params.path_mix_logits)
        path = int(jax.random.categorical(path_key, jnp.log(path_probs)))

        if path == 0 or remaining < 2:
            # 1-byte
            probs = jax.nn.softmax(params.insert_1byte_logits)
            b = int(jax.random.categorical(byte_key, jnp.log(probs)))
            result[pos] = b
            pos += 1
            emitted += 1
        elif path == 1 and remaining >= 2:
            # 2-byte
            log_pi = jax.nn.log_softmax(params.insert_2byte_mix_logits)
            cls = int(jax.random.categorical(class_key, log_pi))
            log_p = jax.nn.log_softmax(params.insert_2byte_logits[cls], axis=-1)
            rng_key, k1, k2 = jax.random.split(rng_key, 3)
            b1 = int(jax.random.categorical(k1, log_p[0]))
            b2 = int(jax.random.categorical(k2, log_p[1]))
            result[pos] = b1
            result[pos + 1] = b2
            pos += 2
            emitted += 2
        elif path == 2 and remaining >= 3:
            # 3-byte
            log_rho = jax.nn.log_softmax(params.insert_3byte_mix_logits)
            cls = int(jax.random.categorical(class_key, log_rho))
            log_p = jax.nn.log_softmax(params.insert_3byte_logits[cls], axis=-1)
            rng_key, k1, k2, k3 = jax.random.split(rng_key, 4)
            b1 = int(jax.random.categorical(k1, log_p[0]))
            b2 = int(jax.random.categorical(k2, log_p[1]))
            b3 = int(jax.random.categorical(k3, log_p[2]))
            result[pos] = b1
            result[pos + 1] = b2
            result[pos + 2] = b3
            pos += 3
            emitted += 3
        else:
            # Fallback: 1-byte
            probs = jax.nn.softmax(params.insert_1byte_logits)
            b = int(jax.random.categorical(byte_key, jnp.log(probs)))
            result[pos] = b
            pos += 1
            emitted += 1

    return pos


# ---------------------------------------------------------------------------
# Sequential forward (for cross-validation with associative scan)
# ---------------------------------------------------------------------------

def hmm_log_prob_sequential(params: HMMParams,
                            byte_seq: jnp.ndarray,
                            length: jnp.ndarray,
                            m1_pos: jnp.ndarray) -> jnp.ndarray:
    """Compute log P(seq | HMM) by sequential matrix multiplication.

    Same semantics as hmm_log_prob but uses a simple loop instead of
    associative scan.  Useful as a reference for testing.
    """
    L = byte_seq.shape[0]

    bytes_t = byte_seq
    bytes_t1 = jnp.concatenate([byte_seq[1:], jnp.zeros(1, dtype=jnp.int32)])
    bytes_t2 = jnp.concatenate([byte_seq[2:], jnp.zeros(2, dtype=jnp.int32)])

    # Initial state vector (log-space)
    alpha = jnp.full(NUM_STATES, _NEG_INF)
    alpha = alpha.at[_ik(0)].set(0.0)

    for t in range(L):
        if t >= int(length):
            break
        mat = make_emission_matrix(
            params, bytes_t[t], bytes_t1[t], bytes_t2[t],
            jnp.int32(t), m1_pos)
        # alpha' = alpha . M  (in log-space)
        alpha = jax.scipy.special.logsumexp(
            alpha[:, None] + mat, axis=0)

    delta_8 = jax.nn.sigmoid(params.log_delta[8])
    log_1m_delta_8 = jnp.log(1.0 - delta_8 + 1e-30)

    return alpha[_ik(8)] + log_1m_delta_8


# ---------------------------------------------------------------------------
# Utility: count parameters
# ---------------------------------------------------------------------------

def count_params(params: HMMParams) -> int:
    """Count total number of trainable scalar parameters."""
    return sum(p.size for p in jax.tree.leaves(params))
