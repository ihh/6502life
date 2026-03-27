"""
All-JAX bare sim board, optimized for GPU.

The entire simulation loop — scheduling, gather, execution, scatter —
runs in JIT-compiled JAX. No Python interpreter overhead during sim.
Board storage stays on device. Only census() transfers to host.
"""

import jax
import jax.numpy as jnp
import jax.random as jr
import numpy as np
from functools import partial
from .cpu import step_one_instruction, ADDR_MASK


# Register save area offsets
REG_PCHI = 0xF9
REG_PCLO = 0xFA
REG_P    = 0xFB
REG_A    = 0xFC
REG_X    = 0xFD
REG_Y    = 0xFE
REG_S    = 0xFF

MAX_STEPS = 350  # instructions per quantum (covers ~95% of quanta)


def _run_one_quantum(memory, cycle_budget, has_register_save=True):
    """Run one cell for one quantum. Pure JAX, no host calls."""
    if has_register_save:
        pc = (memory[REG_PCHI].astype(jnp.int32) << 8) | memory[REG_PCLO].astype(jnp.int32)
        a = memory[REG_A].astype(jnp.int32)
        x = memory[REG_X].astype(jnp.int32)
        y = memory[REG_Y].astype(jnp.int32)
        s = memory[REG_S].astype(jnp.int32)
        p = memory[REG_P].astype(jnp.int32)
    else:
        # Cold boot: PC=0, clean registers
        pc = jnp.int32(0)
        a = jnp.int32(0)
        x = jnp.int32(0)
        y = jnp.int32(0)
        s = jnp.int32(0xFF)
        p = jnp.int32(0x30)

    def scan_fn(carry, _):
        pc, a, x, y, s, p, mem, cyc_used, brk_op, done = carry
        new_pc, new_a, new_x, new_y, new_s, new_p, new_mem, cyc, brk, halted = \
            step_one_instruction(
                pc.astype(jnp.uint16), a.astype(jnp.uint8),
                x.astype(jnp.uint8), y.astype(jnp.uint8),
                s.astype(jnp.uint8), p.astype(jnp.uint8), mem)
        new_cyc = cyc_used + cyc
        accept = ~done & (new_cyc < cycle_budget)
        done_now = done | (new_cyc >= cycle_budget) | (brk >= 0) | halted
        # Select: accept new state or keep old
        out = (
            jnp.where(accept, new_pc.astype(jnp.int32), pc),
            jnp.where(accept, new_a.astype(jnp.int32), a),
            jnp.where(accept, new_x.astype(jnp.int32), x),
            jnp.where(accept, new_y.astype(jnp.int32), y),
            jnp.where(accept, new_s.astype(jnp.int32), s),
            jnp.where(accept, new_p.astype(jnp.int32), p),
            jnp.where(accept, new_mem, mem),
            jnp.where(accept, new_cyc, cyc_used),
            jnp.where(accept & (brk >= 0), brk, brk_op),
            done_now,
        )
        return out, None

    init = (pc, a, x, y, s, p, memory,
            jnp.int32(0), jnp.int16(-1), jnp.bool_(False))
    (pc_f, a_f, x_f, y_f, s_f, p_f, mem_f, _, _, _), _ = \
        jax.lax.scan(scan_fn, init, None, length=MAX_STEPS)

    # Save registers (only if enabled)
    if has_register_save:
        mem_f = mem_f.at[REG_PCHI].set(((pc_f >> 8) & 0xFF).astype(jnp.uint8))
        mem_f = mem_f.at[REG_PCLO].set((pc_f & 0xFF).astype(jnp.uint8))
        mem_f = mem_f.at[REG_P].set(p_f.astype(jnp.uint8))
        mem_f = mem_f.at[REG_A].set(a_f.astype(jnp.uint8))
    mem_f = mem_f.at[REG_X].set(x_f.astype(jnp.uint8))
    mem_f = mem_f.at[REG_Y].set(y_f.astype(jnp.uint8))
    mem_f = mem_f.at[REG_S].set(s_f.astype(jnp.uint8))
    return mem_f


def _sample_budgets(key, n):
    """Sample n cycle budgets from the geometric-exponential distribution."""
    k1, k2 = jr.split(key)
    # Geometric: count trailing 1-bits in random int
    bits = jr.randint(k1, (n,), 0, 2**31 - 1, dtype=jnp.int32)
    # Count trailing ones: use bit tricks
    # ~bits gives 0s where 1s were; (bits+1) & ~bits isolates lowest 0-bit
    # Position of lowest 0-bit = number of trailing 1s
    inverted = ~bits
    lowest_zero = inverted & (-inverted)  # isolate lowest set bit in inverted
    # log2 of lowest_zero = position = trailing 1-count
    # Use integer bit counting: clz(lowest_zero) on [1..2^31]
    # Approximate: floor(log2(x)) via float conversion
    half_lives = jnp.floor(jnp.log2(jnp.maximum(lowest_zero.astype(jnp.float32), 1.0))).astype(jnp.int32)
    half_lives = jnp.minimum(half_lives, 31)
    # Fractional part
    frac = jr.uniform(k2, (n,))
    budgets = jnp.ceil(16 * 177 * (half_lives + frac)).astype(jnp.int32)
    return jnp.maximum(budgets, 1)


def _build_pairs_jax(key, B, M):
    """Build checkerboard pairs entirely in JAX. Returns [N, 2] index array."""
    k1, k2, k3 = jr.split(key, 3)
    rv = jr.randint(k1, (), 0, 8)
    tiling = rv & 1
    offset_i = (rv >> 1) & 1
    offset_j = (rv >> 2) & 1

    N = (B * B) // 2
    role_bits = jr.randint(k2, (N,), 0, 2)

    # Precompute all pair coordinates for both tilings
    # Tiling 0 (X): pair along i-axis
    pairs_x = jnp.zeros((N, 2), dtype=jnp.int32)
    idx = 0
    # Build with numpy then convert (pair topology is static for given B)
    pairs_x_np = np.zeros((N, 4), dtype=np.int32)  # [ci, cj, ni, nj]
    pairs_y_np = np.zeros((N, 4), dtype=np.int32)
    idx = 0
    for k in range(B // 2):
        for j in range(B):
            i0, i1 = 2 * k, 2 * k + 1
            pairs_x_np[idx] = [i0, j, i1, j]
            idx += 1
    idx = 0
    for i in range(B):
        for k in range(B // 2):
            j0, j1 = 2 * k, 2 * k + 1
            pairs_y_np[idx] = [i, j0, i, j1]
            idx += 1

    pairs_x_static = jnp.array(pairs_x_np, dtype=jnp.int32)
    pairs_y_static = jnp.array(pairs_y_np, dtype=jnp.int32)

    # Select tiling
    pairs_base = jnp.where(tiling, pairs_y_static, pairs_x_static)

    # Apply offsets (wrapping)
    ci = (pairs_base[:, 0] + offset_i) % B
    cj = (pairs_base[:, 1] + offset_j) % B
    ni = (pairs_base[:, 2] + offset_i) % B
    nj = (pairs_base[:, 3] + offset_j) % B

    # Apply role: swap cell and neighbor when role=1
    ci_out = jnp.where(role_bits == 0, ci, ni)
    cj_out = jnp.where(role_bits == 0, cj, nj)
    ni_out = jnp.where(role_bits == 0, ni, ci)
    nj_out = jnp.where(role_bits == 0, nj, cj)

    # Convert to flat storage bases
    cell_bases = (ci_out * B + cj_out) * M
    nbr_bases = (ni_out * B + nj_out) * M

    return jnp.stack([cell_bases, nbr_bases], axis=1)  # [N, 2]


@partial(jax.jit, static_argnums=(1, 2))
def _run_pass(storage, B, M, key):
    """Run one checkerboard pass. All JAX, no Python."""
    k1, k2, k3 = jr.split(key, 3)

    pair_indices = _build_pairs_jax(k1, B, M)
    N = pair_indices.shape[0]
    budgets = _sample_budgets(k2, N)
    offsets = jnp.arange(M, dtype=jnp.int32)

    # Vectorized gather
    cell_idx = pair_indices[:, 0:1] + offsets[None, :]  # [N, M]
    nbr_idx = pair_indices[:, 1:2] + offsets[None, :]   # [N, M]
    mem_batch = jnp.concatenate([storage[cell_idx], storage[nbr_idx]], axis=1)  # [N, 2048]

    # Run all quanta in parallel
    result_batch = jax.vmap(_run_one_quantum)(mem_batch, budgets)  # [N, 2048]

    # Vectorized scatter (GPU-optimal: single .at[].set() call)
    all_idx = jnp.concatenate([cell_idx.ravel(), nbr_idx.ravel()])
    all_vals = jnp.concatenate([result_batch[:, :M].ravel(),
                                 result_batch[:, M:].ravel()])
    storage = storage.at[all_idx].set(all_vals)

    return storage, k3


@partial(jax.jit, static_argnums=(1, 2, 3))
def run_rounds(storage, B, M, n_rounds, key):
    """Run n_rounds complete rounds (2 passes each). Fully JIT'd."""
    def body(i, state):
        storage, key = state
        k1, k2, key = jr.split(key, 3)
        storage, _ = _run_pass(storage, B, M, k1)
        storage, _ = _run_pass(storage, B, M, k2)
        return storage, key
    storage, key = jax.lax.fori_loop(0, n_rounds, body, (storage, key))
    return storage, key


class FastBoard:
    """All-JAX board — storage on device, simulation fully JIT-compiled."""

    def __init__(self, size=16, seed=42):
        self.B = size
        self.M = 1024
        self.storage = jnp.zeros(size * size * 1024, dtype=jnp.uint8)
        self.key = jr.PRNGKey(seed)
        self.total_quanta = 0

    def write_cell(self, i, j, offset, data):
        base = (i * self.B + j) * self.M + offset
        data_arr = jnp.array(list(data), dtype=jnp.uint8)
        self.storage = self.storage.at[base:base + len(data)].set(data_arr)

    def read_cell(self, i, j):
        base = (i * self.B + j) * self.M
        return np.asarray(self.storage[base: base + self.M], dtype=np.uint8)

    def run_pass(self):
        self.key, subkey = jr.split(self.key)
        self.storage, _ = _run_pass(self.storage, self.B, self.M, subkey)
        self.total_quanta += (self.B * self.B) // 2

    def run_rounds(self, n):
        """Run n full rounds (2 passes each). Single JIT call."""
        self.key, subkey = jr.split(self.key)
        self.storage, self.key = run_rounds(self.storage, self.B, self.M, n, subkey)
        self.total_quanta += n * self.B * self.B

    def census(self):
        s = np.asarray(self.storage, dtype=np.uint8)
        B, M = self.B, self.M
        functional = 0
        loop_sigs = {}
        for ci in range(B * B):
            base = ci * M
            cell = s[base:base + M]
            if (cell[0] == 0xB5 and cell[2] == 0x9D and cell[3] == 0x00 and
                cell[4] == 0x04 and cell[5] in (0xE8, 0xCA) and
                cell[6] in (0xD0, 0x90, 0x50, 0x10, 0x30, 0xB0, 0x70)):
                functional += 1
                sig = bytes(cell[:8]).hex()
                loop_sigs[sig] = loop_sigs.get(sig, 0) + 1
        return {
            'functional': functional,
            'total': B * B,
            'loop_variants': len(loop_sigs),
            'top_loops': sorted(loop_sigs.items(), key=lambda x: -x[1])[:5],
        }
