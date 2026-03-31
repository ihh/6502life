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

mode='core' (original):
  Total states: 9*4 + 1 = 37.

mode='full' (256-byte, three-region):
  Region 1: Core (bytes 0-3) — 5 insert states (I0..I4) + 4 match states (M1..M4)
  Region 2: Cargo (bytes ~4-248) — I4 insert state with long self-loop
  Region 3: Register save area (bytes 249-255) — 7 register match states (M9..M15)
  Total states: 5*4 + 7 + 1 = 28.

Insert emissions are per-position (P=5 active insert positions):
  I0: before LDA — must not clobber X or set carry
  I1: between LDA operand and STA — must not clobber A
  I2: between STA and INX — must not clobber A or X
  I3: between INX and branch — must not clobber flags
  I4: tail/cargo — weakest constraint, big cargo region

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

NUM_INSERT = 9   # I0..I8 (core mode uses all 9)
NUM_INSERT_FULL = 5  # I0..I4 (full mode uses only 5 active insert states)
NUM_MATCH = 8    # M1..M8
NUM_INSERT_POSITIONS = 5  # P: distinct insert emission distributions

# Insert position mapping: which insert position (0..P-1) each insert state uses
# I0 -> pos 0, I1 -> pos 1, I2 -> pos 2, I3 -> pos 3,
# I4..I8 -> pos 4 (tail/cargo)
INSERT_POS_MAP = [0, 1, 2, 3, 4, 4, 4, 4, 4]

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

# Number of register match states in full mode
NUM_REG_MATCH = 7  # M9..M15 for PCHI, PCLO, P, A, X, Y, S

# Expanded state indices (core mode)
# I_k        -> 4*k + 0   (k = 0..8)
# I_k_2a     -> 4*k + 1
# I_k_3a     -> 4*k + 2
# I_k_3b     -> 4*k + 3
# END        -> 36

NUM_STATES_CORE = NUM_INSERT * 4 + 1  # 37
NUM_STATES_FULL = NUM_INSERT_FULL * 4 + NUM_REG_MATCH + 1  # 28

# For backward compatibility, NUM_STATES defaults to core
NUM_STATES = NUM_STATES_CORE

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


def _reg_state(r):
    """Index of register match state r (0..6) in full mode.

    Register states come after the 20 insert/phantom states (5 active × 4):
    M9=20, M10=21, ..., M15=26.  END=27.
    """
    return NUM_INSERT_FULL * 4 + r


def _end_state(mode='core'):
    """Index of the END state."""
    if mode == 'full':
        return NUM_STATES_FULL - 1  # 43
    return NUM_STATES_CORE - 1  # 36


def num_states(mode='core'):
    """Total number of states for the given mode."""
    if mode == 'full':
        return NUM_STATES_FULL
    return NUM_STATES_CORE


# Backward compatibility
END_STATE = _end_state('core')  # 36


# ---------------------------------------------------------------------------
# Parameter pytree
# ---------------------------------------------------------------------------

class HMMParams(NamedTuple):
    """All trainable HMM parameters (unconstrained logits).

    Insert emission parameters are per-position (P = NUM_INSERT_POSITIONS = 5).
    """
    # Insert state self-loop logits (9,) -- sigmoid -> delta_k
    log_delta: jnp.ndarray            # [9]
    # Per-position 1-byte insert emission logits
    insert_1byte_logits: jnp.ndarray  # [P, 256]
    # Per-position 2-byte insert: N=3 classes
    insert_2byte_mix_logits: jnp.ndarray  # [P, 3]
    insert_2byte_logits: jnp.ndarray      # [P, 3, 2, 256]
    # Per-position 3-byte insert: N=3 classes
    insert_3byte_mix_logits: jnp.ndarray  # [P, 3]
    insert_3byte_logits: jnp.ndarray      # [P, 3, 3, 256]
    # Per-position path mixing logits [1-byte, 2-byte, 3-byte]
    path_mix_logits: jnp.ndarray      # [P, 3]
    # Match state emission logits (only M6 and M7 have choices)
    match6_logits: jnp.ndarray        # [2]   -- INX vs DEX
    match7_logits: jnp.ndarray        # [7]   -- branch opcodes
    # Register match state emission logits (full mode only, [7, 256])
    reg_emission_logits: jnp.ndarray  # [7, 256]


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

# Insert position map as JAX array for indexing
_INSERT_POS_MAP_JAX = jnp.array(INSERT_POS_MAP, dtype=jnp.int32)


def _build_logits_from_weights(weight_fn) -> np.ndarray:
    """Build unnormalised logits (256,) from a weight function.

    We store log(weight) so that softmax(logits) ~ normalised probs.
    """
    w = np.array([weight_fn(b) for b in range(256)], dtype=np.float32)
    # Store as log-weights (softmax will normalise later)
    return np.log(np.maximum(w, 1e-30)).astype(np.float32)


def _build_shared_2byte_logits():
    """Build the shared 2-byte insert logits [3, 2, 256]."""
    imm_set = set(_IMM_LOAD_OPCODES.tolist())
    zpg_set = set(_ZPG_OPCODES.tolist())
    undoc2_set = set(_UNDOC_2_OPCODES.tolist())

    c0_p0 = _build_logits_from_weights(lambda b: 5.0 if b in imm_set else 0.01)
    c0_p1 = _build_logits_from_weights(lambda b: 1.0)
    c1_p0 = _build_logits_from_weights(lambda b: 3.0 if b in zpg_set else 0.01)
    c1_p1 = _build_logits_from_weights(
        lambda b: 2.0 if b < 0x10 else (1.0 if b < 0x80 else 0.5))
    c2_p0 = _build_logits_from_weights(lambda b: 5.0 if b in undoc2_set else 0.01)
    c2_p1 = _build_logits_from_weights(lambda b: 1.0)

    return np.stack([
        np.stack([c0_p0, c0_p1]),
        np.stack([c1_p0, c1_p1]),
        np.stack([c2_p0, c2_p1]),
    ])  # [3, 2, 256]


def _build_shared_3byte_logits():
    """Build the shared 3-byte insert logits [3, 3, 256]."""
    abs_load_set = set(_ABS_LOAD_OPCODES.tolist())
    abs_store_set = set(_ABS_STORE_OPCODES.tolist())
    undoc3_set = set(_UNDOC_3_OPCODES.tolist())

    c0_3p0 = _build_logits_from_weights(lambda b: 5.0 if b in abs_load_set else 0.01)
    c0_3p1 = _build_logits_from_weights(lambda b: 1.0)
    c0_3p2 = _build_logits_from_weights(lambda b: 1.0)
    c1_3p0 = _build_logits_from_weights(lambda b: 5.0 if b in abs_store_set else 0.01)
    c1_3p1 = _build_logits_from_weights(lambda b: 1.0)
    c1_3p2 = _build_logits_from_weights(lambda b: 2.0 if b < 0x08 else 0.5)
    c2_3p0 = _build_logits_from_weights(lambda b: 5.0 if b in undoc3_set else 0.01)
    c2_3p1 = _build_logits_from_weights(lambda b: 1.0)
    c2_3p2 = _build_logits_from_weights(lambda b: 1.0)

    return np.stack([
        np.stack([c0_3p0, c0_3p1, c0_3p2]),
        np.stack([c1_3p0, c1_3p1, c1_3p2]),
        np.stack([c2_3p0, c2_3p1, c2_3p2]),
    ])  # [3, 3, 256]


def _build_default_reg_emission_logits():
    """Build default register emission logits [7, 256].

    Register states M9-M15 correspond to:
      M9  (r=0): PCHI at 0xF9 — peaked at 0x00
      M10 (r=1): PCLO at 0xFA — peaked at 0x00
      M11 (r=2): P at 0xFB — peaked at values with C=0 (bit 0 = 0)
      M12 (r=3): A at 0xFC — uniform (overwritten by first LDA)
      M13 (r=4): X at 0xFD — peaked at 0x00
      M14 (r=5): Y at 0xFE — uniform (not used by copy loop)
      M15 (r=6): S at 0xFF — peaked at 0x80-0xFF (valid stack pointers)
    """
    logits = np.zeros((7, 256), dtype=np.float32)

    # M9: PCHI peaked at 0x00
    logits[0] = _build_logits_from_weights(
        lambda b: 10.0 if b == 0x00 else 0.01)

    # M10: PCLO peaked at 0x00
    logits[1] = _build_logits_from_weights(
        lambda b: 10.0 if b == 0x00 else 0.01)

    # M11: P register — peaked at values with C=0 (bit 0 clear)
    # Typical reset P = 0x30 (I=0, B=1, unused=1, rest 0)
    logits[2] = _build_logits_from_weights(
        lambda b: (5.0 if b & 0x01 == 0 else 0.5))

    # M12: A — uniform
    logits[3] = _build_logits_from_weights(lambda b: 1.0)

    # M13: X peaked at 0x00
    logits[4] = _build_logits_from_weights(
        lambda b: 10.0 if b == 0x00 else 0.1)

    # M14: Y — uniform
    logits[5] = _build_logits_from_weights(lambda b: 1.0)

    # M15: S peaked at 0x80-0xFF (valid stack pointers)
    logits[6] = _build_logits_from_weights(
        lambda b: 5.0 if b >= 0x80 else 0.1)

    return logits


def default_params(mode='core') -> HMMParams:
    """Create default HMM parameters matching the JS constructor.

    Args:
        mode: 'core' for 8-byte model, 'full' for 256-byte three-region model.
    """
    P = NUM_INSERT_POSITIONS

    # delta defaults
    delta_init = np.array(
        [0.3, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.3], dtype=np.float32)
    # sigmoid^{-1}(delta)
    log_delta = np.log(delta_init / (1.0 - delta_init)).astype(np.float32)

    # 1-byte insert emission weights — shared base, replicated per position
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

    base_1byte = _build_logits_from_weights(p1_weight)
    insert_1byte_logits = np.tile(base_1byte, (P, 1))  # [P, 256]

    # 2-byte path: replicated per position
    base_2byte = _build_shared_2byte_logits()  # [3, 2, 256]
    insert_2byte_logits = np.tile(base_2byte, (P, 1, 1, 1))  # [P, 3, 2, 256]
    insert_2byte_mix_logits = np.zeros((P, 3), dtype=np.float32)

    # 3-byte path: replicated per position
    base_3byte = _build_shared_3byte_logits()  # [3, 3, 256]
    insert_3byte_logits = np.tile(base_3byte, (P, 1, 1, 1))  # [P, 3, 3, 256]
    insert_3byte_mix_logits = np.zeros((P, 3), dtype=np.float32)

    # Path mixing: [0.6, 0.3, 0.1] — replicated per position
    base_path_mix = np.log(np.array([0.6, 0.3, 0.1], dtype=np.float32))
    path_mix_logits = np.tile(base_path_mix, (P, 1))  # [P, 3]

    # Match6: uniform over 2 choices
    match6_logits = np.zeros(2, dtype=np.float32)

    # Match7: uniform over 7 choices
    match7_logits = np.zeros(7, dtype=np.float32)

    # Register emission logits
    reg_emission_logits = _build_default_reg_emission_logits()  # [7, 256]

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
        reg_emission_logits=jnp.array(reg_emission_logits),
    )


# ---------------------------------------------------------------------------
# Emission helpers
# ---------------------------------------------------------------------------

def _insert_1byte_log_prob(params: HMMParams, byte_val: jnp.ndarray,
                           insert_pos: int = 0):
    """Log P(byte | 1-byte insert path) for a given insert position.

    Args:
        byte_val: scalar int, byte value 0-255.
        insert_pos: insert position index (0..P-1).

    Returns:
        scalar log-probability.
    """
    log_probs = jax.nn.log_softmax(params.insert_1byte_logits[insert_pos])
    return log_probs[byte_val]


def _insert_2byte_log_prob(params: HMMParams,
                           b1: jnp.ndarray, b2: jnp.ndarray,
                           insert_pos: int = 0):
    """Log P((b1, b2) | 2-byte insert path) for a given insert position."""
    log_pi = jax.nn.log_softmax(params.insert_2byte_mix_logits[insert_pos])  # [3]
    log_probs = jax.nn.log_softmax(params.insert_2byte_logits[insert_pos], axis=-1)  # [3,2,256]
    per_class = log_pi + log_probs[:, 0, b1] + log_probs[:, 1, b2]  # [3]
    return jax.scipy.special.logsumexp(per_class)


def _insert_3byte_log_prob(params: HMMParams,
                           b1: jnp.ndarray, b2: jnp.ndarray,
                           b3: jnp.ndarray, insert_pos: int = 0):
    """Log P((b1, b2, b3) | 3-byte insert path) for a given insert position."""
    log_rho = jax.nn.log_softmax(params.insert_3byte_mix_logits[insert_pos])  # [3]
    log_probs = jax.nn.log_softmax(params.insert_3byte_logits[insert_pos], axis=-1)  # [3,3,256]
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
        is_e8 = (byte_val == 0xE8)
        is_ca = (byte_val == 0xCA)
        lp = jnp.where(is_e8, log_probs[0],
             jnp.where(is_ca, log_probs[1], _NEG_INF))
        return lp
    elif match_idx == 6:
        # M7: 7 branch opcodes
        log_probs = jax.nn.log_softmax(params.match7_logits)  # [7]
        is_match = (byte_val == _M7_BYTES_JAX)  # [7] bool
        lp = jnp.where(is_match, log_probs, _NEG_INF)
        return jax.scipy.special.logsumexp(lp)
    else:
        # M8: uniform emission log(1/256) — offset check is post-processing
        return -jnp.log(256.0)


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

    # M8: uniform emission log(1/256) — offset check is post-processing
    m8 = -jnp.log(256.0)

    return jnp.array([m1, m2, m3, m4, m5, m6, m7, m8])


def _make_reg_emission_table(params: HMMParams, byte_val: jnp.ndarray):
    """Compute log P(byte_val | reg_state_r) for r=0..6.

    Returns: [7] array of log-probabilities.
    """
    log_probs = jax.nn.log_softmax(params.reg_emission_logits, axis=-1)  # [7, 256]
    return log_probs[:, byte_val]  # [7]


def make_emission_matrix(params: HMMParams,
                         byte_t: jnp.ndarray,
                         byte_t1: jnp.ndarray,
                         byte_t2: jnp.ndarray,
                         pos: jnp.ndarray,
                         mode: str = 'core'):
    """Generate the [S, S] transition-emission matrix for position t.

    Each entry M[s, s'] is the log-probability of transitioning from state s
    to state s' while consuming byte_t at position t.

    M8 (branch offset) uses a uniform emission log(1/256). The branch offset
    is NOT checked by the HMM; it is handled as post-processing (overwritten
    during sampling, checked externally during scoring if needed).

    Args:
        params: HMMParams pytree.
        byte_t: current byte (scalar int).
        byte_t1: byte at t+1 (for 2-byte emission lookahead).
        byte_t2: byte at t+2 (for 3-byte emission lookahead).
        pos: position index t (scalar int).
        mode: 'core' or 'full'.

    Returns:
        [S, S] matrix in log-space.
    """
    S = num_states(mode)
    END = _end_state(mode)
    # Start with all -inf
    mat = jnp.full((S, S), _NEG_INF, dtype=jnp.float32)

    # Precompute shared quantities
    delta = jax.nn.sigmoid(params.log_delta)         # [9]
    log_delta = jnp.log(delta + 1e-30)               # [9]
    log_1m_delta = jnp.log(1.0 - delta + 1e-30)      # [9]

    # Per-position emission parameters
    # Precompute all P position log-softmax values
    log_path_mix_all = jax.nn.log_softmax(params.path_mix_logits, axis=-1)  # [P, 3]
    p1_log_all = jax.nn.log_softmax(params.insert_1byte_logits, axis=-1)    # [P, 256]
    p2_log_all = jax.nn.log_softmax(params.insert_2byte_logits, axis=-1)  # [P, 3, 2, 256]
    log_pi2_all = jax.nn.log_softmax(params.insert_2byte_mix_logits, axis=-1)  # [P, 3]
    p3_log_all = jax.nn.log_softmax(params.insert_3byte_logits, axis=-1)  # [P, 3, 3, 256]
    log_rho3_all = jax.nn.log_softmax(params.insert_3byte_mix_logits, axis=-1)  # [P, 3]

    # Match emission log-probs for byte_t
    match_lp = _make_match_emission_table(params, byte_t)  # [8]

    # Number of insert states depends on mode:
    # core: 9 insert states (I0..I8), full: 5 insert states (I0..I4)
    n_insert = NUM_INSERT_FULL if mode == 'full' else NUM_INSERT

    # Process each insert state
    for k in range(n_insert):
        ik = _ik(k)
        ik_2a = _ik_2a(k)
        ik_3a = _ik_3a(k)
        ik_3b = _ik_3b(k)

        # Get the insert position index for this insert state
        ip = INSERT_POS_MAP[k]

        log_path_mix = log_path_mix_all[ip]  # [3]
        log_emit_1 = p1_log_all[ip, byte_t]  # scalar

        # --- 1-byte insert self-loop: I_k -> I_k ---
        w_1byte = log_delta[k] + log_path_mix[0] + log_emit_1
        mat = mat.at[ik, ik].set(w_1byte)

        # --- 2-byte insert: I_k -> I_k_2a (start with full lookahead) ---
        log_p2_full = _insert_2byte_log_prob(params, byte_t, byte_t1, ip)
        w_2byte_start_full = log_delta[k] + log_path_mix[1] + log_p2_full
        mat = mat.at[ik, ik_2a].set(w_2byte_start_full)

        # Continuation: I_k_2a -> I_k (pass-through, weight = 1)
        mat = mat.at[ik_2a, ik].set(0.0)

        # --- 3-byte insert: I_k -> I_k_3a (start with full lookahead) ---
        log_p3_full = _insert_3byte_log_prob(params, byte_t, byte_t1, byte_t2, ip)
        w_3byte_start_full = log_delta[k] + log_path_mix[2] + log_p3_full
        mat = mat.at[ik, ik_3a].set(w_3byte_start_full)

        # Continuation: I_k_3a -> I_k_3b (pass-through)
        mat = mat.at[ik_3a, ik_3b].set(0.0)

        # Continuation: I_k_3b -> I_k (pass-through)
        mat = mat.at[ik_3b, ik].set(0.0)

        # --- Match transition: I_k -> I_{k+1} ---
        if k < n_insert - 1:
            mk1 = k  # match_lp index (0-based: M1=0, ..., M8=7)
            next_ik = _ik(k + 1)
            w_match = log_1m_delta[k] + match_lp[mk1]
            mat = mat.at[ik, next_ik].set(w_match)

    if mode == 'full':
        # --- Region 2->3 transition: I_4 -> first register state ---
        # I_4 (cargo) transitions directly to M9 (via (1-delta_4))
        reg_lp = _make_reg_emission_table(params, byte_t)  # [7]

        # I_4 -> M9 (consuming byte as register emission)
        last_insert = NUM_INSERT_FULL - 1  # 4
        reg0 = _reg_state(0)
        w_reg_start = log_1m_delta[last_insert] + reg_lp[0]
        mat = mat.at[_ik(last_insert), reg0].set(w_reg_start)

        # Register chain: M9 -> M10 -> ... -> M15 -> END
        for r in range(NUM_REG_MATCH - 1):
            rs = _reg_state(r)
            rs_next = _reg_state(r + 1)
            mat = mat.at[rs, rs_next].set(reg_lp[r + 1])

        # END state self-loop (absorbing)
        mat = mat.at[END, END].set(0.0)
    else:
        # Core mode: END state self-loop (absorbing)
        mat = mat.at[END, END].set(0.0)

    return mat


# Wrapped version for core mode (backward compatible)
def _make_emission_matrix_core(params, byte_t, byte_t1, byte_t2, pos):
    """Core-mode emission matrix (backward compatible)."""
    return make_emission_matrix(params, byte_t, byte_t1, byte_t2, pos,
                                mode='core')


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
    return jax.scipy.special.logsumexp(
        A[..., :, :, None] + B[..., None, :, :], axis=-2)


# ---------------------------------------------------------------------------
# Forward algorithm via associative scan
# ---------------------------------------------------------------------------

def _hmm_log_prob_core(params: HMMParams,
                       byte_seq: jnp.ndarray,
                       length: jnp.ndarray) -> jnp.ndarray:
    """Core mode: log P(seq | HMM) using associative scan."""
    S = NUM_STATES_CORE
    L = byte_seq.shape[0]
    positions = jnp.arange(L, dtype=jnp.int32)

    bytes_t = byte_seq
    bytes_t1 = jnp.concatenate([byte_seq[1:], jnp.zeros(1, dtype=jnp.int32)])
    bytes_t2 = jnp.concatenate([byte_seq[2:], jnp.zeros(2, dtype=jnp.int32)])

    all_matrices = jax.vmap(
        _make_emission_matrix_core, in_axes=(None, 0, 0, 0, 0)
    )(params, bytes_t, bytes_t1, bytes_t2, positions)

    mask = (positions < length)[:, None, None]
    identity = jnp.where(
        jnp.eye(S, dtype=jnp.bool_), 0.0, _NEG_INF)
    all_matrices = jnp.where(mask, all_matrices, identity[None, :, :])

    prefix_products = jax.lax.associative_scan(log_matmul, all_matrices, axis=0)
    final_product = prefix_products[length - 1]

    pi = jnp.full(S, _NEG_INF)
    pi = pi.at[_ik(0)].set(0.0)

    result = jax.scipy.special.logsumexp(
        pi[:, None] + final_product, axis=0)

    delta_8 = jax.nn.sigmoid(params.log_delta[8])
    log_1m_delta_8 = jnp.log(1.0 - delta_8 + 1e-30)

    return result[_ik(8)] + log_1m_delta_8


def _make_emission_matrix_full(params, byte_t, byte_t1, byte_t2, pos):
    """Full-mode emission matrix wrapper for vmap."""
    return make_emission_matrix(params, byte_t, byte_t1, byte_t2, pos,
                                mode='full')


def _hmm_log_prob_full(params: HMMParams,
                       byte_seq: jnp.ndarray,
                       length: jnp.ndarray) -> jnp.ndarray:
    """Full mode: log P(seq | HMM) using associative scan.

    Three regions:
      Region 1: Core (bytes 0-3) — 5 insert states + 4 match states
      Region 2: Cargo (I4 self-loop)
      Region 3: Register save area (last 7 bytes, M9-M15)
    """
    S = NUM_STATES_FULL
    END = _end_state('full')
    L = byte_seq.shape[0]
    positions = jnp.arange(L, dtype=jnp.int32)

    bytes_t = byte_seq
    bytes_t1 = jnp.concatenate([byte_seq[1:], jnp.zeros(1, dtype=jnp.int32)])
    bytes_t2 = jnp.concatenate([byte_seq[2:], jnp.zeros(2, dtype=jnp.int32)])

    all_matrices = jax.vmap(
        _make_emission_matrix_full, in_axes=(None, 0, 0, 0, 0)
    )(params, bytes_t, bytes_t1, bytes_t2, positions)

    mask = (positions < length)[:, None, None]
    identity = jnp.where(
        jnp.eye(S, dtype=jnp.bool_), 0.0, _NEG_INF)
    all_matrices = jnp.where(mask, all_matrices, identity[None, :, :])

    prefix_products = jax.lax.associative_scan(log_matmul, all_matrices, axis=0)
    final_product = prefix_products[length - 1]

    pi = jnp.full(S, _NEG_INF)
    pi = pi.at[_ik(0)].set(0.0)

    result = jax.scipy.special.logsumexp(
        pi[:, None] + final_product, axis=0)

    # In full mode, the chain ends at M15 -> END (non-emitting)
    # M15 is _reg_state(6)
    last_reg = _reg_state(NUM_REG_MATCH - 1)
    log_p = result[last_reg]

    return log_p


@partial(jax.jit, static_argnames=('mode',))
def hmm_log_prob(params: HMMParams,
                 byte_seq: jnp.ndarray,
                 length: jnp.ndarray,
                 mode: str = 'core') -> jnp.ndarray:
    """Compute log P(seq | HMM) using associative scan.

    M8 (branch offset) uses a uniform emission. The offset is NOT checked
    by the HMM; it is handled as post-processing.

    Args:
        params: HMMParams pytree.
        byte_seq: [L] int32 byte sequence (padded to max length).
        length: scalar int, actual sequence length.
        mode: 'core' or 'full'.

    Returns:
        scalar log-probability.
    """
    if mode == 'full':
        return _hmm_log_prob_full(params, byte_seq, length)
    return _hmm_log_prob_core(params, byte_seq, length)


@partial(jax.jit, static_argnames=('mode',))
def hmm_log_prob_marginal(params: HMMParams,
                          byte_seq: jnp.ndarray,
                          length: jnp.ndarray,
                          mode: str = 'core') -> jnp.ndarray:
    """Compute log P(seq | HMM).

    Backward-compatible wrapper — now equivalent to hmm_log_prob since M1
    position marginalization is no longer needed (M8 uses uniform emission).

    Args:
        params: HMMParams pytree.
        byte_seq: [L] int32 byte sequence (padded to max length).
        length: scalar int, actual sequence length.
        mode: 'core' or 'full'.

    Returns:
        scalar log-probability.
    """
    return hmm_log_prob(params, byte_seq, length, mode=mode)


# ---------------------------------------------------------------------------
# Discriminative loss
# ---------------------------------------------------------------------------

def _score_single(params: HMMParams,
                  seq: jnp.ndarray,
                  mask: jnp.ndarray) -> jnp.ndarray:
    """Score a single (padded) sequence (core mode).

    Returns log-odds: log P(x|HMM) + L * ln(256).
    """
    length = mask.sum().astype(jnp.int32)
    log_p = hmm_log_prob_marginal(params, seq, length, mode='core')
    null_log_p = -length.astype(jnp.float32) * jnp.log(256.0)
    return log_p - null_log_p


def _score_single_full(params: HMMParams,
                       seq: jnp.ndarray,
                       mask: jnp.ndarray) -> jnp.ndarray:
    """Score a single (padded) sequence (full mode).

    Returns log-odds: log P(x|HMM) + L * ln(256).
    """
    length = mask.sum().astype(jnp.int32)
    log_p = hmm_log_prob_marginal(params, seq, length, mode='full')
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
    """
    viable_scores = jax.vmap(_score_single, in_axes=(None, 0, 0))(
        params, viable_seqs, viable_masks)
    nonviable_scores = jax.vmap(_score_single, in_axes=(None, 0, 0))(
        params, nonviable_seqs, nonviable_masks)

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
    """Score a batch of sequences (core mode): log P(x|HMM) + L * ln(256).

    Args:
        byte_seqs: [B, L] int32.
        length_masks: [B, L] bool.

    Returns:
        [B] log-odds scores.
    """
    return jax.vmap(_score_single, in_axes=(None, 0, 0))(
        params, byte_seqs, length_masks)


@jax.jit
def hmm_score_batch_full(params: HMMParams,
                         byte_seqs: jnp.ndarray,
                         length_masks: jnp.ndarray) -> jnp.ndarray:
    """Score a batch of sequences (full mode): log P(x|HMM) + L * ln(256)."""
    return jax.vmap(_score_single_full, in_axes=(None, 0, 0))(
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
               rng_key: jnp.ndarray,
               mode: str = 'core') -> Optional[jnp.ndarray]:
    """Sample a sequence of given length from the HMM.

    Uses ancestral sampling:
    1. Sample insert counts for each slot (geometric distribution).
    2. Fill match bytes deterministically (except M6, M7, M8).
    3. Fill insert bytes from the mixture model.

    In full mode, the last 7 bytes are register save area.

    This is NOT JIT-compiled (uses Python control flow).

    Args:
        params: HMMParams.
        length: target sequence length.
        rng_key: JAX PRNG key.
        mode: 'core' or 'full'.

    Returns:
        [length] int32 array, or None if impossible.
    """
    if mode == 'full':
        return _hmm_sample_full(params, length, rng_key)
    return _hmm_sample_core(params, length, rng_key)


def _hmm_sample_core(params, length, rng_key):
    """Core mode sampler (original 8-byte model)."""
    if length < 8:
        return None

    insert_slots = length - 8  # total insert bytes needed

    delta = jax.nn.sigmoid(params.log_delta)  # [9]
    delta_np = np.array(delta)

    rng_key, subkey = jax.random.split(rng_key)
    counts = _sample_insert_counts(delta_np, insert_slots, subkey)
    if counts is None:
        return None

    result = np.zeros(length, dtype=np.int32)
    pos = 0
    rng_key_np = rng_key

    # I0 inserts
    rng_key_np, subkey = jax.random.split(rng_key_np)
    pos = _fill_insert_bytes(params, result, pos, counts[0], subkey,
                             insert_pos=0)

    # M1: 0xB5
    m1_pos = pos
    result[pos] = 0xB5
    pos += 1

    # M2..M8 with I1..I7 inserts between them
    for k in range(1, 8):
        rng_key_np, subkey = jax.random.split(rng_key_np)
        ip = INSERT_POS_MAP[k]
        pos = _fill_insert_bytes(params, result, pos, counts[k], subkey,
                                 insert_pos=ip)

        mk = k + 1
        if mk <= 5:
            result[pos] = MATCH_EMISSIONS[mk - 1][0]
            pos += 1
        elif mk == 6:
            rng_key_np, subkey = jax.random.split(rng_key_np)
            probs = jax.nn.softmax(params.match6_logits)
            idx = int(jax.random.categorical(subkey, jnp.log(probs)))
            result[pos] = _M6_BYTES[idx]
            pos += 1
        elif mk == 7:
            rng_key_np, subkey = jax.random.split(rng_key_np)
            probs = jax.nn.softmax(params.match7_logits)
            idx = int(jax.random.categorical(subkey, jnp.log(probs)))
            result[pos] = _M7_BYTES[idx]
            pos += 1
        elif mk == 8:
            offset = (-(pos - m1_pos + 1)) & 0xFF
            result[pos] = offset
            pos += 1

    # I8 inserts
    rng_key_np, subkey = jax.random.split(rng_key_np)
    pos = _fill_insert_bytes(params, result, pos, counts[8], subkey,
                             insert_pos=INSERT_POS_MAP[8])

    if pos != length:
        return None

    return jnp.array(result, dtype=jnp.int32)


def _hmm_sample_full(params, length, rng_key):
    """Full mode sampler (256-byte, three-region model).

    Structure:
      Region 1: Core (4 match bytes M1-M4 + inserts I0-I3)
      Region 2: Cargo (I4 self-loop fills remaining bytes)
      Region 3: Last 7 bytes are register save area (M9-M15)
    """
    if length < 11:  # 4 core match + 7 register bytes minimum
        return None

    # The last 7 bytes are registers, so core + cargo = length - 7
    core_cargo_len = length - NUM_REG_MATCH
    insert_slots = core_cargo_len - 4  # 4 core match bytes (M1-M4)

    if insert_slots < 0:
        return None

    delta = jax.nn.sigmoid(params.log_delta)
    delta_np = np.array(delta)

    rng_key, subkey = jax.random.split(rng_key)
    counts = _sample_insert_counts_full(delta_np, insert_slots, subkey)
    if counts is None:
        return None

    result = np.zeros(length, dtype=np.int32)
    pos = 0
    rng_key_np = rng_key

    # --- Region 1: Core match bytes M1-M4 with inserts I0-I3 ---
    # I0 inserts
    rng_key_np, subkey = jax.random.split(rng_key_np)
    pos = _fill_insert_bytes(params, result, pos, counts[0], subkey,
                             insert_pos=0)

    # M1: 0xB5 (LDA zpx)
    result[pos] = 0xB5
    pos += 1

    # I1 inserts + M2
    for k in range(1, 4):
        rng_key_np, subkey = jax.random.split(rng_key_np)
        ip = INSERT_POS_MAP[k]
        pos = _fill_insert_bytes(params, result, pos, counts[k], subkey,
                                 insert_pos=ip)

        mk = k + 1  # M2, M3, M4
        result[pos] = MATCH_EMISSIONS[mk - 1][0]
        pos += 1

    # --- Region 2: I4 cargo inserts ---
    rng_key_np, subkey = jax.random.split(rng_key_np)
    pos = _fill_insert_bytes(params, result, pos, counts[4], subkey,
                             insert_pos=INSERT_POS_MAP[4])

    # --- Region 3: Register save area (7 bytes) ---
    reg_log_probs = jax.nn.log_softmax(params.reg_emission_logits, axis=-1)  # [7, 256]
    for r in range(NUM_REG_MATCH):
        rng_key_np, subkey = jax.random.split(rng_key_np)
        b = int(jax.random.categorical(subkey, reg_log_probs[r]))
        result[pos] = b
        pos += 1

    if pos != length:
        return None

    return jnp.array(result, dtype=jnp.int32)


def _sample_insert_counts(delta_np, total, rng_key):
    """Sample insert byte counts for 9 slots summing to total (core mode)."""
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
        n = 0
        while n < remaining:
            rng_key, subkey = jax.random.split(rng_key)
            u = float(jax.random.uniform(subkey))
            if u >= d:
                break
            n += 1
        counts[k] = n
        remaining -= n

    if remaining > 0:
        counts[8] += remaining

    return counts


def _sample_insert_counts_full(delta_np, total, rng_key):
    """Sample insert byte counts for 5 slots summing to total (full mode)."""
    counts = [0] * 5
    remaining = total

    for k in range(5):
        if remaining == 0:
            counts[k] = 0
            continue
        d = float(delta_np[k])
        if d == 0:
            counts[k] = 0
            continue
        n = 0
        while n < remaining:
            rng_key, subkey = jax.random.split(rng_key)
            u = float(jax.random.uniform(subkey))
            if u >= d:
                break
            n += 1
        counts[k] = n
        remaining -= n

    if remaining > 0:
        counts[4] += remaining

    return counts


def _fill_insert_bytes(params, result, pos, count, rng_key, insert_pos=0):
    """Fill insert bytes into result array using per-position emissions.

    Args:
        params: HMMParams.
        result: output array to fill.
        pos: current position in result.
        count: number of insert bytes to emit.
        rng_key: JAX PRNG key.
        insert_pos: insert position index (0..P-1).

    Returns:
        new position.
    """
    emitted = 0
    while emitted < count:
        remaining = count - emitted
        rng_key, path_key, class_key, byte_key = jax.random.split(rng_key, 4)

        path_probs = jax.nn.softmax(params.path_mix_logits[insert_pos])
        path = int(jax.random.categorical(path_key, jnp.log(path_probs)))

        if path == 0 or remaining < 2:
            probs = jax.nn.softmax(params.insert_1byte_logits[insert_pos])
            b = int(jax.random.categorical(byte_key, jnp.log(probs)))
            result[pos] = b
            pos += 1
            emitted += 1
        elif path == 1 and remaining >= 2:
            log_pi = jax.nn.log_softmax(params.insert_2byte_mix_logits[insert_pos])
            cls = int(jax.random.categorical(class_key, log_pi))
            log_p = jax.nn.log_softmax(params.insert_2byte_logits[insert_pos, cls],
                                        axis=-1)
            rng_key, k1, k2 = jax.random.split(rng_key, 3)
            b1 = int(jax.random.categorical(k1, log_p[0]))
            b2 = int(jax.random.categorical(k2, log_p[1]))
            result[pos] = b1
            result[pos + 1] = b2
            pos += 2
            emitted += 2
        elif path == 2 and remaining >= 3:
            log_rho = jax.nn.log_softmax(params.insert_3byte_mix_logits[insert_pos])
            cls = int(jax.random.categorical(class_key, log_rho))
            log_p = jax.nn.log_softmax(params.insert_3byte_logits[insert_pos, cls],
                                        axis=-1)
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
            probs = jax.nn.softmax(params.insert_1byte_logits[insert_pos])
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
                            mode: str = 'core') -> jnp.ndarray:
    """Compute log P(seq | HMM) by sequential matrix multiplication.

    Same semantics as hmm_log_prob but uses a simple loop instead of
    associative scan.  Useful as a reference for testing.
    """
    S = num_states(mode)
    END = _end_state(mode)
    L = byte_seq.shape[0]

    bytes_t = byte_seq
    bytes_t1 = jnp.concatenate([byte_seq[1:], jnp.zeros(1, dtype=jnp.int32)])
    bytes_t2 = jnp.concatenate([byte_seq[2:], jnp.zeros(2, dtype=jnp.int32)])

    alpha = jnp.full(S, _NEG_INF)
    alpha = alpha.at[_ik(0)].set(0.0)

    for t in range(L):
        if t >= int(length):
            break
        mat = make_emission_matrix(
            params, bytes_t[t], bytes_t1[t], bytes_t2[t],
            jnp.int32(t), mode=mode)
        alpha = jax.scipy.special.logsumexp(
            alpha[:, None] + mat, axis=0)

    if mode == 'full':
        last_reg = _reg_state(NUM_REG_MATCH - 1)
        return alpha[last_reg]
    else:
        delta_8 = jax.nn.sigmoid(params.log_delta[8])
        log_1m_delta_8 = jnp.log(1.0 - delta_8 + 1e-30)
        return alpha[_ik(8)] + log_1m_delta_8


# ---------------------------------------------------------------------------
# Utility: count parameters
# ---------------------------------------------------------------------------

def count_params(params: HMMParams) -> int:
    """Count total number of trainable scalar parameters."""
    return sum(p.size for p in jax.tree.leaves(params))
