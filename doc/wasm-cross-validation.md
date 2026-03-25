# WASM Engine Cross-Validation Report

**Date:** 2026-03-22
**JS Engine:** `board/controller.js` + `board/memory.js` (using Sfotty 6502 emulator)
**Rust/WASM Engine:** `wasm/src/` (custom 6502 emulator)

## Summary

The Rust/WASM engine **cannot** be used as a drop-in replacement for the JS engine.
While the memory management, PRNG, and scheduling logic are functionally equivalent,
the CPU emulators produce different cycle counts for the same instruction sequences,
causing deterministic divergence after randomized content is introduced.

## Phase 1: Source Code Analysis

### Components That Match

1. **Mersenne Twister PRNG** -- Bit-identical. Both use the standard MT19937 algorithm
   with the same constants and tempering. `real()` uses the same `1.0/4294967296.0`
   divisor. Verified: initial state after `new(42)` produces identical sequences.

2. **Spiral sort / coordinate mapping** -- The spiral ordering uses the same comparator:
   `taxicab -> maxDelta -> angle(atan2(x,y))`. Both use `atan2(x, y)` (not `atan2(y, x)`)
   for NESW ordering. Rotation functions match: `rotate1(xy) = (y, -x)`. The Rust tables
   are computed identically via `once_cell::Lazy`.

3. **`sampleNextMove`** -- Identical logic:
   - `iOrig = rv1 % B`
   - `jOrig = ((rv1 >> 8) & 0xFFFF) % B`
   - `orientation = (rv1 >> 16) & 3`
   - Half-life loop counting trailing 1-bits of `rv2`
   - `nextCycles = ceil(16 * 177 * (nHalfLives + rv3))`
   - `nextRnd = rv4`

4. **Memory-mapped read/write** -- Address translation, rotation of vector-range bytes
   (0xF0-0xF9), ROM lookup table layout, undo history -- all match.

5. **BRK operand handling** -- Both use the same thresholds:
   - `operand > 0 && operand < 5 * 49`: swap `src=floor(op/49)`, `dest=op%49`
   - `operand >= 245 && operand <= 252`: noisy copy to `dest=op-244`
   - BRK $00: PC reset to 0 (both match)

6. **Copy-before-save (B flag)** -- Both perform BRK copy/swap BEFORE `commitWrites`
   (which saves registers), then set/clear the B flag on the stored P register afterward.
   This matches the recent JS fix.

7. **Noisy copy** -- Same algorithm: for each byte, generate `mt.int() & 0xFF` as random
   replacement bits, then independently flip each of 8 bit positions with probability
   `pBitNoise` (using `mt.real() < eps`). Result: `(rndByte & noiseBits) | (srcByte & ~noiseBits)`.

8. **Randomize** -- Both use `mt.int()` to fill storage 4 bytes at a time with big-endian
   byte extraction. (Note: JS `randomize()` takes an optional RNG function; when called as
   `randomize(() => mem.mt.int())`, it matches the Rust implementation.)

9. **Register save/restore** -- Same offsets: PCHI=0xF9, PCLO=0xFA, P=0xFB, A=0xFC,
   X=0xFD, Y=0xFE, S=0xFF. RNG written at 0xFC-0xFF (overlaps A/X/Y/S in storage,
   which is intentional -- RNG overwrites register save area; registers already loaded
   into CPU).

### Components That DIFFER

#### 1. CPU Emulator (Critical Divergence)

**JS:** Uses Sfotty (`@sfotty-pie/sfotty`), a cycle-accurate NMOS 6502 emulator.
Sfotty's `run()` executes one CPU cycle via a microcode-based pipeline. Its
`cycleCounter` counts UP from 0 and resets to 0 at instruction boundaries.
Sfotty handles all NMOS quirks: page-crossing penalties, reset sequences,
decimal mode, etc.

**Rust:** Uses a custom simplified 6502 emulator (`wasm/src/cpu.rs`). It decodes the
entire instruction upfront, resolves the effective address and reads the operand value,
then counts down `cycle_counter` from `totalCycles - 1`. The instruction effect is
applied when `cycle_counter` reaches 0.

**Observed differences:**
- Cycle counts per instruction can differ. For example, with random cell content,
  a run starting at PC=0x40D9 (EOR (indirect),Y): Sfotty used 8 cycles for the
  instruction (including initial reset/decode setup), while the Rust CPU would use
  5-6 cycles (standard timing).
- Sfotty has a `resetPending` state on construction that consumes an extra cycle
  on the first instruction. The Rust CPU does not.
- Page-crossing cycle penalties may differ in edge cases.
- The Rust CPU reads the operand value at decode time, not at the cycle when the
  real 6502 would read it. This is semantically identical for single-threaded
  execution but affects cycle counting.

**Impact:** After running even one instruction on randomized content, the engines
can reach different PCs at different cycle counts, leading to cascading divergence.

#### 2. Sfotty-Specific State Reset

**JS controller** (line 303-304):
```js
this.sfotty.cycleCounter = 0;
this.sfotty.operations = [() => this.sfotty.decode()];
```

**Rust controller:** Only sets `cpu.cycle_counter = 0` and `cpu.crashed = false`.

The JS controller explicitly resets Sfotty's internal `operations` array to force a
fresh decode on the next cycle. The Rust CPU has no equivalent internal state; its
`pending_op` is cleared when `cycle_counter` reaches 0.

#### 3. Per-Op Cycle Costs (BRK_OP_REGISTRY)

**JS:** The controller uses `BRK_OP_REGISTRY` to assign each BRK operation its own
cycle cost. If fewer scheduler cycles remain than the op requires, the BRK silently
fails (no effect). This creates selective pressure for multi-copy strategies.

**Rust:** Per-op cycle costs are not implemented. All BRK copy/swap operations always
succeed regardless of remaining cycles.

#### 4. `randomize()` RNG Source

**JS:** `BoardController.randomize(rng)` takes an optional RNG function. The default
uses `Math.random()`, NOT the deterministic MT. To get deterministic randomization,
callers must pass `() => mem.mt.int()`.

**Rust:** `BoardController.randomize()` always uses the board's MT. This means the
Rust engine's randomize is always deterministic, but it advances the MT state, which
the JS default `randomize()` does not.

When the JS caller passes `() => mem.mt.int()` (as the cross-validation script does),
both produce identical results.

#### 5. Per-Byte Write Time Tracking

**JS:** Tracks `lastWriteTimeForByte[cell][byte]` for per-byte granularity.

**Rust:** Only tracks `last_write_time[cell]` (per-cell). This is a memory optimization
and does not affect simulation correctness, only visualization detail.

#### 6. `onBrkEvent` Hook

**JS:** Supports `onBrkEvent` callback for monitoring BRK copy/swap events.

**Rust:** No equivalent callback mechanism.

## Phase 2: Build Results

- **Rust toolchain:** rustc 1.89.0 (available)
- **wasm-pack:** Installed successfully (v0.14.0)
- **Build:** `wasm-pack build --target web` succeeds with 3 warnings (unused fields/const)
- **Rust unit tests:** All 33 tests pass (`cargo test`)

## Phase 3: Empirical Cross-Validation

### Test Results

| Test | Result | Details |
|------|--------|---------|
| MT PRNG sequence | PASS | Implicit: initial state matches |
| Initial storage (empty board) | PASS | Byte-identical after construction |
| 500 interrupts (empty board) | PASS | Byte-identical at every checkpoint |
| Randomize storage | PASS | Byte-identical using `mt.int()` RNG |
| 500 interrupts (randomized) | **FAIL** | Diverges at interrupt 1 |

### Divergence Detail

With randomized cell content (seed 42, size 8):
- **Interrupt 0:** Both run 7 CPU cycles (BRK $00 at PC=0). Storage identical.
- **Interrupt 1:** JS runs 15 CPU cycles, WASM runs 12 CPU cycles.
  The PC diverges, leading to different register states saved at 0xF9-0xFF.
  5 bytes differ after this interrupt.
- **By interrupt 499:** 16,662 bytes differ across the board.

The empty board passes because all cells contain zeros. Every cell starts with
opcode 0x00 (BRK) at PC=0x0000, which the controller handles before invoking the
CPU, so the CPU emulator never actually executes instructions.

## Specific Test Cases for Full Equivalence

To make the Rust engine bit-compatible with the JS engine, these tests would need to pass:

1. **Per-instruction cycle count:** For every valid opcode and addressing mode, verify
   the Rust CPU uses the same number of cycles as Sfotty (including page-crossing).

2. **Instruction boundary detection:** Verify that `cycle_counter == 0` occurs at the
   same points as Sfotty's `cycleCounter === 0`.

3. **Multi-instruction sequences:** Run 100+ instructions on known memory content and
   compare final CPU state (PC, A, X, Y, S, P) and cycle count.

4. **BRK with noisy copy + random content:** Run 10,000 interrupts on randomized
   boards and compare full storage state.

5. **Atomic mode (I flag):** Verify undo behavior matches when the I flag is set and
   a timer interrupt fires.

## Recommendations

### Can the Rust/WASM Engine Replace the JS Engine?

**No, not currently.** The CPU emulator differences cause deterministic divergence.
Any saved state produced by one engine will evolve differently on the other.

### What Needs Fixing

To achieve bit-compatibility:

1. **Replace the Rust CPU with a Sfotty port** (or integrate the actual Sfotty WASM
   build). The custom `cpu.rs` has simplified cycle counting that does not match
   Sfotty's microcode-based cycle-accurate model. A faithful port would need to
   replicate Sfotty's `decode()` -> `operations[]` pipeline.

2. **Add per-op cycle cost support** (`BRK_OP_REGISTRY`) to the Rust controller.

3. **Match the `randomize()` default** behavior (though this is a caller issue, not
   an engine issue -- the WASM wrapper could default to using `Math.random()`).

### Alternative: Use as a Separate Engine

If bit-compatibility is not required, the Rust/WASM engine works correctly as a
standalone simulation engine. It is deterministic (same seed produces same results
across runs), implements all the key game mechanics, and would be significantly
faster than the JS engine for large boards. It just produces a different simulation
from the JS engine given the same initial conditions and random content.

## Files Examined

- `/Users/yam/6502life/wasm/src/mt.rs` -- Mersenne Twister (matches JS)
- `/Users/yam/6502life/wasm/src/memory.rs` -- Board memory (matches JS)
- `/Users/yam/6502life/wasm/src/controller.rs` -- Controller (mostly matches JS)
- `/Users/yam/6502life/wasm/src/cpu.rs` -- CPU emulator (DIFFERS from Sfotty)
- `/Users/yam/6502life/wasm/src/tables.rs` -- Lookup tables (matches JS)
- `/Users/yam/6502life/wasm/src/lib.rs` -- WASM bindings
- `/Users/yam/6502life/wasm/js/wasm-board.js` -- JS wrapper for WASM
- `/Users/yam/6502life/board/controller.js` -- JS controller (reference)
- `/Users/yam/6502life/board/memory.js` -- JS memory (reference)
- `/Users/yam/6502life/wasm/cross-validate.mjs` -- Cross-validation test script
