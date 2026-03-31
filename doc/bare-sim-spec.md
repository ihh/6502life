# Bare Sim Controller Specification

Minimum vectorizable reaction-diffusion controller for the 6502life board.
All GPU and CPU emulators MUST implement this spec to be cross-validated.

## Memory layout

Each quantum operates on a **2048-byte memory window**:

| Range | Contents |
|-------|----------|
| `0x0000–0x03FF` | Active cell (1024 bytes) |
| `0x0400–0x07FF` | Secondary cell (1024 bytes) |

Addresses wrap at `0x7FF` (2KB boundary): `addr & 0x7FF`.

## Scheduling: checkerboard pass

A **pass** processes `B²/2` non-overlapping (active, secondary) cell pairs simultaneously.

### Pair construction

1. Sample a random integer `rv ∈ [0, 8)` from the board PRNG.
2. Extract: `tiling = rv & 1`, `offset_i = (rv >> 1) & 1`, `offset_j = (rv >> 2) & 1`.
3. Build pairs (order matters for PRNG consumption):
   - If `tiling == 0` (X-axis pairs): for `k` in `0..B/2`, for `j` in `0..B`:
     - `i0 = (2k + offset_i) % B`, `i1 = (2k + 1 + offset_i) % B`, `jj = (j + offset_j) % B`
     - Sample `role = prng.int() & 1`
     - If `role == 0`: active = `(i0, jj)`, secondary = `(i1, jj)`
     - If `role == 1`: active = `(i1, jj)`, secondary = `(i0, jj)`
   - If `tiling == 1` (Y-axis pairs): for `i` in `0..B`, for `k` in `0..B/2`:
     - `ii = (i + offset_i) % B`, `j0 = (2k + offset_j) % B`, `j1 = (2k + 1 + offset_j) % B`
     - Sample `role = prng.int() & 1`
     - If `role == 0`: active = `(ii, j0)`, secondary = `(ii, j1)`
     - If `role == 1`: active = `(ii, j1)`, secondary = `(ii, j0)`

### Cycle budget sampling

For each pair, immediately after sampling `role`, sample a cycle budget:

```
r = prng.int()          // unsigned 32-bit
half_lives = 0
while half_lives < 32 and (r & 1):
    r >>= 1
    half_lives += 1
frac = prng.real()      // uniform [0, 1)
budget = max(1, ceil(16 * 177 * (half_lives + frac)))
```

This gives a geometric-exponential distribution with mean ~2832 cycles.

### Memory assembly

For each pair, assemble a 2048-byte memory window:
```
mem[0x000..0x3FF] = storage[active_cell]
mem[0x400..0x7FF] = storage[secondary_cell]
```

## Quantum execution

Run the 6502 CPU on the 2048-byte memory window for up to `budget` cycles or `MAX_STEPS` instructions (default 350), whichever comes first. Stop also on BRK or JAM.

### Controller mode A: cold reset (basic)

Before each quantum:
```
PC = 0x0000
A = X = Y = 0
S = 0xFF
P = 0x30
```

After each quantum: no register save. State is discarded.

### Controller mode B: register save/restore (standard)

Before each quantum, read registers from the active cell's save area:
```
PC = (mem[0xF9] << 8) | mem[0xFA]
P  = mem[0xFB]
A  = mem[0xFC]
X  = mem[0xFD]
Y  = mem[0xFE]
S  = mem[0xFF]
```

After each quantum, write registers back:
```
mem[0xF9] = (PC >> 8) & 0xFF
mem[0xFA] = PC & 0xFF
mem[0xFB] = P
mem[0xFC] = A
mem[0xFD] = X
mem[0xFE] = Y
mem[0xFF] = S
```

On BRK: stop execution, save registers as above (PC points to instruction after BRK operand). The BRK operand byte is available to the host controller for dispatch (copy, swap, etc.) but the bare sim does not act on it — it just reports it.

### Memory disassembly

After each quantum, write back both cells:
```
storage[active_cell]    = mem[0x000..0x3FF]
storage[secondary_cell] = mem[0x400..0x7FF]
```

## CPU specification

The 6502 CPU must match Sfotty behavior exactly on all 256 opcodes, including:

- All documented NMOS 6502 opcodes
- Undocumented opcodes: LAX, SAX, DCP, ISC, SLO, RLA, SRE, RRA, ANC, ALR, ARR, AXS
- Undocumented NOPs (various byte/cycle counts)
- JAM opcodes (halt CPU)
- Unstable opcodes (XAA, AHX, TAS, SHY, SHX, LAS) treated as NOPs with correct timing
- BCD mode for ADC/SBC (NMOS behavior with N/Z from unmasked result)
- JMP indirect page-wrap bug
- Page-cross penalty: `(base_lo + index) >= 255` (Sfotty quirk, not `>= 256`)
- TSX does NOT update N/Z flags (Sfotty quirk)
- BRK pushes PC+1 (not PC+2), does NOT set I flag

## PRNG specification

The board PRNG must be a **xorshift32** generator matching `webgpu/prng.js`:

```
state = state ^ (state << 13)
state = state ^ (state >>> 17)
state = state ^ (state << 5)
return state >>> 0
```

Methods:
- `int()`: return raw 32-bit unsigned integer, advance state
- `below(n)`: return `int() % n` (biased but acceptable for small n)
- `real()`: return `int() / 4294967296.0` (uniform [0, 1))

Initial state is set from the board seed.

## Determinism guarantee

Given the same seed:
1. The PRNG sequence is identical
2. Pair construction consumes PRNG values in the same order
3. CPU execution is cycle-exact and bit-exact
4. The board state after N passes is identical across all implementations

This must hold for **random opcode soup** — arbitrary memory contents, not just curated test programs. Fill memory with random bytes, run N passes, compare storage byte-for-byte.

## Implementations

| Implementation | Location | Status |
|----------------|----------|--------|
| JS (CPU fallback) | `webgpu/bare-sim-cpu.js` | Reference |
| WebGPU (WGSL shader) | `webgpu/cpu6502.wgsl` + `webgpu/bare-sim.js` | Cross-validated against JS |
| JAX (Python/GPU) | `jax6502/fast_board.py` + `jax6502/cpu.py` | 2250/2265 CPU parity |
| Rust/WASM | `wasm/src/cpu.rs` | Cross-validated against JS |

## Extension points (NOT part of bare sim spec)

The following are board controller features, not bare sim features.
They are implemented in `board/controller.js` and are orthogonal to this spec:

- BRK operand dispatch (copy, swap, reset)
- Oriented registers (rotation at 0xF0-0xF8)
- Bit noise (pBitNoise mutation on writeback)
- Full 49-cell neighborhood (7x7 memory mapping)
- Compass (orientation written to 0xFA)
- Decay rate (cosmic ray bit flips)
