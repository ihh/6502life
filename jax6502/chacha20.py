"""
ChaCha20 stream cipher in pure JAX.

Byte-for-byte compatible with coin/chacha20.js (the JavaScript reference
implementation).  All core functions are JIT-compatible — no Python loops
or host callbacks during stream generation.

Byte-order note
---------------
ChaCha20 (RFC 7539) serialises its uint32 state to bytes in **little-endian**
order.  The JS implementation relies on Uint32Array → Uint8Array (LE on all
modern platforms).  JAX's ``jnp.uint32.view(jnp.uint8)`` is likewise LE on
x86 and ARM, so the two implementations agree byte-for-byte.
"""

import hashlib
import json

import jax
import jax.numpy as jnp

# ── ChaCha20 constants ("expand 32-byte k") ──────────────────────────
SIGMA = jnp.array(
    [0x61707865, 0x3320646E, 0x79622D32, 0x6B206574], dtype=jnp.uint32
)


# ── Primitives ────────────────────────────────────────────────────────

def rotl32(v, n):
    """32-bit left rotation.  *v* must be ``jnp.uint32``."""
    return (v << n) | (v >> jnp.uint32(32 - n))


def quarter_round(state, a, b, c, d):
    """ChaCha20 quarter-round operating on a ``uint32[16]`` state vector."""
    state = state.at[a].set(state[a] + state[b])
    state = state.at[d].set(rotl32(state[d] ^ state[a], jnp.uint32(16)))

    state = state.at[c].set(state[c] + state[d])
    state = state.at[b].set(rotl32(state[b] ^ state[c], jnp.uint32(12)))

    state = state.at[a].set(state[a] + state[b])
    state = state.at[d].set(rotl32(state[d] ^ state[a], jnp.uint32(8)))

    state = state.at[c].set(state[c] + state[d])
    state = state.at[b].set(rotl32(state[b] ^ state[c], jnp.uint32(7)))

    return state


def _double_round(state):
    """One double-round (column + diagonal)."""
    # Column rounds
    state = quarter_round(state, 0, 4, 8, 12)
    state = quarter_round(state, 1, 5, 9, 13)
    state = quarter_round(state, 2, 6, 10, 14)
    state = quarter_round(state, 3, 7, 11, 15)
    # Diagonal rounds
    state = quarter_round(state, 0, 5, 10, 15)
    state = quarter_round(state, 1, 6, 11, 12)
    state = quarter_round(state, 2, 7, 8, 13)
    state = quarter_round(state, 3, 4, 9, 14)
    return state


# ── Block generation ──────────────────────────────────────────────────

@jax.jit
def chacha20_block(key, counter, nonce):
    """Generate one 64-byte ChaCha20 block.

    Parameters
    ----------
    key : uint32[8]
        256-bit key as eight little-endian 32-bit words.
    counter : uint32 scalar
        Block counter.
    nonce : uint32[3]
        96-bit nonce as three little-endian 32-bit words.

    Returns
    -------
    uint8[64]
    """
    initial = jnp.concatenate([
        SIGMA,
        key,
        jnp.array([counter], dtype=jnp.uint32),
        nonce,
    ])  # uint32[16]

    def body(_, s):
        return _double_round(s)

    working = jax.lax.fori_loop(0, 10, body, initial)
    final = working + initial
    return final.view(jnp.uint8)  # 64 bytes, little-endian


def _block_for_counter(counter, key, nonce):
    """Helper for vmap: generate block at *counter*."""
    return chacha20_block(key, counter, nonce)


def chacha20_stream(key, nonce, num_blocks):
    """Generate *num_blocks* x 64 bytes of ChaCha20 key stream.

    Uses ``jax.vmap`` over the counter dimension so all blocks are
    computed embarrassingly in parallel on GPU.

    *num_blocks* must be a concrete (non-traced) Python int because
    ``jnp.arange`` needs a static size.  The vmap'd block function
    is still JIT-compiled.

    Parameters
    ----------
    key : uint32[8]
    nonce : uint32[3]
    num_blocks : int
        Number of 64-byte blocks (concrete Python int).

    Returns
    -------
    uint8[num_blocks * 64]
    """
    num_blocks = int(num_blocks)
    counters = jnp.arange(num_blocks, dtype=jnp.uint32)
    blocks = jax.vmap(lambda c: chacha20_block(key, c, nonce))(counters)
    return blocks.reshape(-1)


# ── Board-init helpers (host-side, not JIT'd) ─────────────────────────

def seed_to_key(seed_string):
    """SHA-256 of *seed_string* → ``uint32[8]`` (LE words).

    Matches ``coin/chacha20.js  seedToKey()``.
    """
    data = str(seed_string).encode("utf-8")
    digest = hashlib.sha256(data).digest()           # 32 bytes
    return jnp.frombuffer(digest, dtype=jnp.uint32)  # 8 × LE uint32


def derive_nonce(size, salt_with_params=False, board_params=None, difficulty=None):
    """SHA-256 of params → ``uint32[3]`` (first 12 bytes, LE words).

    Matches ``coin/chacha20.js  deriveNonce()``.
    """
    parts = [str(size)]
    if salt_with_params:
        if board_params is not None:
            parts.append(json.dumps(board_params, separators=(",", ":")))
        if difficulty is not None:
            parts.append(f"d={difficulty}")
    data = "|".join(parts).encode("utf-8")
    digest = hashlib.sha256(data).digest()
    return jnp.frombuffer(digest[:12], dtype=jnp.uint32)  # 3 × LE uint32


def generate_board_init(seed, size, **opts):
    """Full board initialisation matching ``coin/chacha20.js  generateBoardInit()``.

    Parameters
    ----------
    seed : str | int
        Board seed (converted to string for hashing).
    size : int
        Board dimension (size × size cells, 1024 bytes each).
    **opts
        Forwarded to :func:`derive_nonce` (``salt_with_params``,
        ``board_params``, ``difficulty``).

    Returns
    -------
    uint8[size * size * 1024]
    """
    key = seed_to_key(seed)
    nonce = derive_nonce(size, **opts)
    total_bytes = size * size * 1024
    num_blocks = (total_bytes + 63) // 64
    stream = chacha20_stream(key, nonce, num_blocks)
    return stream[:total_bytes]
