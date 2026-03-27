"""
Batched 6502 execution for the bare sim.

Runs N independent CPUs in parallel via jax.vmap, each executing
instructions until their cycle budget is exhausted or BRK is hit.
Handles register save/restore to $F9-$FF between quanta.
"""

import jax
import jax.numpy as jnp
from functools import partial
from .cpu import step_one_instruction, ADDR_MASK


# Register save area offsets within cell memory (page 0)
REG_PCHI = 0xF9
REG_PCLO = 0xFA
REG_P    = 0xFB
REG_A    = 0xFC
REG_X    = 0xFD
REG_Y    = 0xFE
REG_S    = 0xFF


def read_registers(memory):
    """Read CPU registers from the cell's save area ($F9-$FF)."""
    pc = (memory[REG_PCHI].astype(jnp.int32) << 8) | memory[REG_PCLO].astype(jnp.int32)
    return (
        pc.astype(jnp.uint16),
        memory[REG_A],
        memory[REG_X],
        memory[REG_Y],
        memory[REG_S],
        memory[REG_P],
    )


def write_registers(memory, pc, a, x, y, s, p):
    """Write CPU registers to the cell's save area ($F9-$FF)."""
    memory = memory.at[REG_PCHI].set(((pc >> 8) & 0xFF).astype(jnp.uint8))
    memory = memory.at[REG_PCLO].set((pc & 0xFF).astype(jnp.uint8))
    memory = memory.at[REG_P].set(p)
    memory = memory.at[REG_A].set(a)
    memory = memory.at[REG_X].set(x)
    memory = memory.at[REG_Y].set(y)
    memory = memory.at[REG_S].set(s)
    return memory


def run_one_quantum(memory, cycle_budget):
    """Run one cell for one quantum: read registers, execute, save registers.

    Args:
        memory: uint8[2048] — cell (0-1023) + neighbor (1024-2047)
        cycle_budget: int32 — cycles before timer interrupt

    Returns:
        memory: uint8[2048] — updated
        brk_operand: int16 — -1 if no BRK, else operand byte
        cycles_used: int32
    """
    # Read registers from cell's save area
    pc, a, x, y, s, p = read_registers(memory)

    # Run instructions until budget exhausted or BRK
    max_steps = 500  # upper bound on instructions per quantum

    def scan_fn(carry, _step):
        pc, a, x, y, s, p, memory, cycles_used, brk_op, done = carry

        # Execute one instruction (branchless)
        new_pc, new_a, new_x, new_y, new_s, new_p, new_memory, cyc, brk, halted = \
            step_one_instruction(pc, a, x, y, s, p, memory)

        new_cycles = cycles_used + cyc
        hit_brk = brk >= 0
        hit_halt = halted
        over_budget = new_cycles >= cycle_budget

        # Should we accept this instruction's results?
        # Accept if: not already done, and not over budget
        # If over budget: rollback (keep old state, as if instruction never ran)
        accept = ~done & ~over_budget
        done_now = done | over_budget | hit_brk | hit_halt

        # Conditionally update state
        pc_out = jnp.where(accept, new_pc, pc)
        a_out = jnp.where(accept, new_a, a)
        x_out = jnp.where(accept, new_x, x)
        y_out = jnp.where(accept, new_y, y)
        s_out = jnp.where(accept, new_s, s)
        p_out = jnp.where(accept, new_p, p)
        mem_out = jnp.where(accept, new_memory, memory)
        cyc_out = jnp.where(accept, new_cycles, cycles_used)
        brk_out = jnp.where(accept & hit_brk, brk, brk_op)

        return (pc_out, a_out, x_out, y_out, s_out, p_out,
                mem_out, cyc_out, brk_out, done_now), None

    init = (pc.astype(jnp.int32), a.astype(jnp.int32), x.astype(jnp.int32),
            y.astype(jnp.int32), s.astype(jnp.int32), p.astype(jnp.int32),
            memory, jnp.int32(0), jnp.int16(-1), jnp.bool_(False))

    (pc_f, a_f, x_f, y_f, s_f, p_f, mem_f, cycles_f, brk_f, _), _ = \
        jax.lax.scan(scan_fn, init, jnp.arange(max_steps))

    # Save registers back to cell memory
    mem_f = write_registers(mem_f, pc_f.astype(jnp.uint16),
                            a_f.astype(jnp.uint8), x_f.astype(jnp.uint8),
                            y_f.astype(jnp.uint8), s_f.astype(jnp.uint8),
                            p_f.astype(jnp.uint8))

    return mem_f, brk_f, cycles_f


# Batched version: run N quanta in parallel
run_batch = jax.jit(jax.vmap(run_one_quantum, in_axes=(0, 0)))
