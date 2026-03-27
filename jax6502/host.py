"""
Host-side board simulation for the bare sim.

Manages the board storage, scheduling, and memory assembly/disassembly.
The actual 6502 execution happens in batch.py via JAX.
"""

import numpy as np
import jax.numpy as jnp
from .batch import run_batch


class BareBoard:
    """Minimal board: B×B cells, 1024 bytes each, neighborhoodSize=2."""

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
        self.storage[base + offset: base + offset + len(data)] = data

    def read_cell(self, i, j):
        base = self.cell_base(i, j)
        return self.storage[base: base + self.M].copy()

    def randomize(self):
        self.storage[:] = self.rng.randint(0, 256, size=len(self.storage), dtype=np.uint8)

    def run_quanta(self, n_quanta):
        """Run n_quanta scheduling events using JAX batched execution.

        Uses checkerboard-like pair scheduling: each quantum, pick a random
        cell and a random cardinal neighbor. Assemble their 2KB into the
        JAX batch, run, disassemble back.

        For simplicity, processes one quantum at a time (batching across
        cells would require the checkerboard scheduler).
        """
        B = self.B
        for _ in range(n_quanta):
            # Pick random cell
            i = self.rng.randint(0, B)
            j = self.rng.randint(0, B)
            # Pick random cardinal neighbor
            di, dj = [(0, 1), (1, 0), (0, -1), (-1, 0)][self.rng.randint(0, 4)]
            ni, nj = (i + di) % B, (j + dj) % B

            # Sample cycle budget (geometric-exponential, matching JS)
            r = self.rng.randint(0, 2**32)
            half_lives = 0
            while half_lives < 32 and (r & 1):
                r >>= 1
                half_lives += 1
            frac = self.rng.random()
            cycle_budget = max(1, int(np.ceil(16 * 177 * (half_lives + frac))))

            # Assemble 2KB memory: cell at 0-1023, neighbor at 1024-2047
            cell_base = self.cell_base(i, j)
            nbr_base = self.cell_base(ni, nj)
            mem = np.zeros(2048, dtype=np.uint8)
            mem[:1024] = self.storage[cell_base: cell_base + 1024]
            mem[1024:2048] = self.storage[nbr_base: nbr_base + 1024]

            # Run via JAX (single quantum, batch size 1)
            mem_jax = jnp.array(mem[np.newaxis, :], dtype=jnp.uint8)
            budget_jax = jnp.array([cycle_budget], dtype=jnp.int32)
            result_mem, brk_ops, cycles = run_batch(mem_jax, budget_jax)

            # Disassemble: write back both cells
            result = np.array(result_mem[0], dtype=np.uint8)
            self.storage[cell_base: cell_base + 1024] = result[:1024]
            self.storage[nbr_base: nbr_base + 1024] = result[1024:2048]

            self.total_quanta += 1

    def run_quanta_numpy(self, n_quanta):
        """Run without JAX — pure numpy, for comparison/fallback."""
        B = self.B
        for _ in range(n_quanta):
            i = self.rng.randint(0, B)
            j = self.rng.randint(0, B)
            di, dj = [(0, 1), (1, 0), (0, -1), (-1, 0)][self.rng.randint(0, 4)]
            ni, nj = (i + di) % B, (j + dj) % B

            r = self.rng.randint(0, 2**32)
            half_lives = 0
            while half_lives < 32 and (r & 1):
                r >>= 1
                half_lives += 1
            frac = self.rng.random()
            cycle_budget = max(1, int(np.ceil(16 * 177 * (half_lives + frac))))

            # TODO: numpy-based 6502 step loop (for when JAX isn't available)
            # For now, this is a placeholder
            self.total_quanta += 1

    def census(self):
        """Count functional replicators and measure diversity."""
        B = self.B
        functional = 0
        halted = 0
        loop_sigs = {}
        junk_sigs = {}

        for ci in range(B * B):
            base = ci * self.M
            cell = self.storage[base: base + self.M]

            # Functional replicator check
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
