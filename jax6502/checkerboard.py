"""
Checkerboard-batched bare sim runner.

Each "pass" schedules B²/2 non-overlapping (cell, neighbor) pairs
simultaneously via jax.vmap. Two passes cover the full board.

The tiling randomly selects:
- Direction: X (horizontal) or Y (vertical) pairs
- Offset: 0 or 1 translation in each axis
- Per-pair role: which cell is active, which is neighbor
"""

import numpy as np
import jax
import jax.numpy as jnp
from .batch import run_one_quantum


# JIT + vmap: run N quanta in parallel
_run_batch_jit = None

def _get_batched_runner(n):
    """Get or compile the batched runner for batch size n."""
    global _run_batch_jit
    if _run_batch_jit is None:
        _run_batch_jit = jax.jit(jax.vmap(run_one_quantum, in_axes=(0, 0)))
    return _run_batch_jit


class BareBoardCheckerboard:
    """Board with checkerboard-batched JAX execution."""

    def __init__(self, size=16, seed=42):
        self.B = size
        self.M = 1024
        self.storage = np.zeros(size * size * 1024, dtype=np.uint8)
        self.rng = np.random.RandomState(seed)
        self.total_quanta = 0

    def cell_base(self, i, j):
        return (i * self.B + j) * self.M

    def write_cell(self, i, j, offset, data):
        base = self.cell_base(i, j)
        self.storage[base + offset: base + offset + len(data)] = list(data)

    def read_cell(self, i, j):
        base = self.cell_base(i, j)
        return self.storage[base: base + self.M].copy()

    def _build_pairs(self):
        """Build one checkerboard pass: B²/2 non-overlapping (cell, neighbor) pairs."""
        B = self.B
        rv = self.rng.randint(0, 8)
        tiling = rv & 1       # 0=X, 1=Y
        offset_i = (rv >> 1) & 1
        offset_j = (rv >> 2) & 1

        pairs = []  # [(cell_i, cell_j, nbr_i, nbr_j), ...]

        if tiling == 0:  # X: pair along i-axis
            for k in range(B // 2):
                for j in range(B):
                    role = self.rng.randint(0, 2)
                    i0 = (2 * k + offset_i) % B
                    i1 = (2 * k + 1 + offset_i) % B
                    jj = (j + offset_j) % B
                    if role == 0:
                        pairs.append((i0, jj, i1, jj))
                    else:
                        pairs.append((i1, jj, i0, jj))
        else:  # Y: pair along j-axis
            for i in range(B):
                for k in range(B // 2):
                    role = self.rng.randint(0, 2)
                    ii = (i + offset_i) % B
                    j0 = (2 * k + offset_j) % B
                    j1 = (2 * k + 1 + offset_j) % B
                    if role == 0:
                        pairs.append((ii, j0, ii, j1))
                    else:
                        pairs.append((ii, j1, ii, j0))

        return pairs

    def _sample_budgets(self, n):
        """Sample n cycle budgets from the geometric-exponential distribution."""
        budgets = np.zeros(n, dtype=np.int32)
        for idx in range(n):
            r = int(self.rng.randint(0, 2**31))
            hl = 0
            while hl < 32 and (r & 1):
                r >>= 1
                hl += 1
            frac = self.rng.random()
            budgets[idx] = max(1, int(np.ceil(16 * 177 * (hl + frac))))
        return budgets

    def run_pass(self):
        """Run one checkerboard pass: B²/2 quanta in parallel."""
        pairs = self._build_pairs()
        n = len(pairs)
        budgets = self._sample_budgets(n)

        # Assemble memory batch: [n, 2048]
        mem_batch = np.zeros((n, 2048), dtype=np.uint8)
        for idx, (ci, cj, ni, nj) in enumerate(pairs):
            cb = self.cell_base(ci, cj)
            nb = self.cell_base(ni, nj)
            mem_batch[idx, :1024] = self.storage[cb:cb+1024]
            mem_batch[idx, 1024:2048] = self.storage[nb:nb+1024]

        # Run via JAX
        runner = _get_batched_runner(n)
        result_mem, brk_ops, cycles = runner(
            jnp.array(mem_batch, dtype=jnp.uint8),
            jnp.array(budgets, dtype=jnp.int32))

        # Disassemble: write back
        result = np.asarray(result_mem, dtype=np.uint8)
        for idx, (ci, cj, ni, nj) in enumerate(pairs):
            cb = self.cell_base(ci, cj)
            nb = self.cell_base(ni, nj)
            self.storage[cb:cb+1024] = result[idx, :1024]
            self.storage[nb:nb+1024] = result[idx, 1024:2048]

        self.total_quanta += n

    def run_rounds(self, n_rounds):
        """Run n full rounds (each round = 2 passes = every cell visited once)."""
        for _ in range(n_rounds):
            self.run_pass()
            self.run_pass()

    def census(self):
        """Count functional replicators and variants."""
        B = self.B
        functional = 0
        loop_sigs = {}
        junk_sigs = {}

        for ci in range(B * B):
            base = ci * self.M
            cell = self.storage[base: base + self.M]

            is_fn = (cell[0] == 0xB5 and cell[2] == 0x9D and cell[3] == 0x00 and
                     cell[4] == 0x04 and cell[5] in (0xE8, 0xCA) and
                     cell[6] in (0xD0, 0x90, 0x50, 0x10, 0x30, 0xB0, 0x70))
            if is_fn:
                functional += 1
                lsig = bytes(cell[:8]).hex()
                loop_sigs[lsig] = loop_sigs.get(lsig, 0) + 1
                jsig = bytes(cell[16:20]).hex()
                junk_sigs[jsig] = junk_sigs.get(jsig, 0) + 1

        return {
            'functional': functional,
            'total': B * B,
            'loop_variants': len(loop_sigs),
            'junk_variants': len(junk_sigs),
            'top_loops': sorted(loop_sigs.items(), key=lambda x: -x[1])[:5],
        }
