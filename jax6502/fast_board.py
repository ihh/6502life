"""
All-JAX bare sim board. Storage stays on device (GPU/CPU).
No numpy transfers during simulation — only for initialization and census.

The board storage is a flat jnp.uint8 array of shape [B*B*M].
Each pass: build index arrays for cell/neighbor pairs, gather 2KB
chunks, run all quanta via vmap, scatter results back.
"""

import jax
import jax.numpy as jnp
import numpy as np
from functools import partial
from .batch import run_one_quantum


@partial(jax.jit, static_argnums=(1, 2))
def _run_pass(storage, B, M, pair_indices, budgets):
    """Run one checkerboard pass entirely in JAX.

    Args:
        storage: uint8[B*B*M] — flat board storage
        B: board size (static)
        M: bytes per cell (static, 1024)
        pair_indices: int32[N, 2] — (cell_flat_base, neighbor_flat_base) for each pair
        budgets: int32[N] — cycle budget per pair

    Returns:
        storage: updated uint8[B*B*M]
    """
    offsets = jnp.arange(M, dtype=jnp.int32)  # [0..1023]

    # Vectorized gather: build [N, 2048] from storage using fancy indexing
    cell_idx = pair_indices[:, 0:1] + offsets[None, :]  # [N, M]
    nbr_idx = pair_indices[:, 1:2] + offsets[None, :]   # [N, M]
    cell_mem = storage[cell_idx]   # [N, M]
    nbr_mem = storage[nbr_idx]     # [N, M]
    mem_batch = jnp.concatenate([cell_mem, nbr_mem], axis=1)  # [N, 2048]

    # Run all quanta in parallel
    result_batch, _, _ = jax.vmap(run_one_quantum)(mem_batch, budgets)  # [N, 2048]

    # Scatter: write results back via fori_loop (cache-friendly on CPU)
    # On GPU, replace with vectorized .at[].set() for bandwidth
    def scatter_body(i, storage):
        cell_base = pair_indices[i, 0]
        nbr_base = pair_indices[i, 1]
        storage = jax.lax.dynamic_update_slice(storage, result_batch[i, :M], (cell_base,))
        storage = jax.lax.dynamic_update_slice(storage, result_batch[i, M:], (nbr_base,))
        return storage
    storage = jax.lax.fori_loop(0, pair_indices.shape[0], scatter_body, storage)

    return storage


class FastBoard:
    """All-JAX board — storage stays on device."""

    def __init__(self, size=16, seed=42):
        self.B = size
        self.M = 1024
        self.storage = jnp.zeros(size * size * 1024, dtype=jnp.uint8)
        self.rng = np.random.RandomState(seed)
        self.total_quanta = 0

    def write_cell(self, i, j, offset, data):
        """Write bytes to a cell (host-side, for initialization)."""
        base = (i * self.B + j) * self.M + offset
        data_arr = jnp.array(list(data), dtype=jnp.uint8)
        self.storage = self.storage.at[base:base + len(data)].set(data_arr)

    def _build_pass(self):
        """Build pair indices and budgets for one checkerboard pass."""
        B = self.B
        M = self.M
        rv = self.rng.randint(0, 8)
        tiling = rv & 1
        offset_i = (rv >> 1) & 1
        offset_j = (rv >> 2) & 1

        pairs = []
        budgets = []

        if tiling == 0:
            for k in range(B // 2):
                for j in range(B):
                    role = self.rng.randint(0, 2)
                    i0 = (2 * k + offset_i) % B
                    i1 = (2 * k + 1 + offset_i) % B
                    jj = (j + offset_j) % B
                    if role == 0:
                        ci, cj, ni, nj = i0, jj, i1, jj
                    else:
                        ci, cj, ni, nj = i1, jj, i0, jj
                    pairs.append(((ci * B + cj) * M, (ni * B + nj) * M))
                    # Sample budget
                    r = int(self.rng.randint(0, 2**31))
                    hl = 0
                    while hl < 32 and (r & 1):
                        r >>= 1
                        hl += 1
                    frac = self.rng.random()
                    budgets.append(max(1, int(np.ceil(16 * 177 * (hl + frac)))))
        else:
            for i in range(B):
                for k in range(B // 2):
                    role = self.rng.randint(0, 2)
                    ii = (i + offset_i) % B
                    j0 = (2 * k + offset_j) % B
                    j1 = (2 * k + 1 + offset_j) % B
                    if role == 0:
                        ci, cj, ni, nj = ii, j0, ii, j1
                    else:
                        ci, cj, ni, nj = ii, j1, ii, j0
                    pairs.append(((ci * B + cj) * M, (ni * B + nj) * M))
                    r = int(self.rng.randint(0, 2**31))
                    hl = 0
                    while hl < 32 and (r & 1):
                        r >>= 1
                        hl += 1
                    frac = self.rng.random()
                    budgets.append(max(1, int(np.ceil(16 * 177 * (hl + frac)))))

        return (jnp.array(pairs, dtype=jnp.int32),
                jnp.array(budgets, dtype=jnp.int32))

    def run_pass(self):
        """Run one checkerboard pass (B²/2 quanta) entirely in JAX."""
        pair_indices, budgets = self._build_pass()
        self.storage = _run_pass(self.storage, self.B, self.M, pair_indices, budgets)
        self.total_quanta += pair_indices.shape[0]

    def run_rounds(self, n):
        """Run n full rounds (2 passes each)."""
        for _ in range(n):
            self.run_pass()
            self.run_pass()

    def census(self):
        """Count functional replicators (transfers to numpy for analysis)."""
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
