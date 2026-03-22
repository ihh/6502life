# CLI Bug Report 2

Date: 2026-03-22

## 1. Determinism Re-check

**Test procedure:**
```bash
node cli/bin/run.js --size 8 --seed 42 --asm presets/nano-2x.asm --cell 0,0 \
  --interrupts 10000 --save /tmp/d1.json --quiet
node cli/bin/run.js --size 8 --seed 42 --asm presets/nano-2x.asm --cell 0,0 \
  --interrupts 10000 --save /tmp/d2.json --quiet
diff /tmp/d1.json /tmp/d2.json
```

**Result: NOT DETERMINISTIC.** `diff` shows extensive differences between
the two runs. Same seed, same preset, same parameters, different output.

The memory contents diverge significantly across many cells. This means the
determinism bug is still present: something in the simulation path depends
on non-deterministic state (likely Map iteration order, random scheduling,
or timestamp-based seeding overriding the `--seed` flag).

**Note on `--preset` flag:** `run.js` does NOT support `--preset`. The flag
is silently ignored, and the simulation runs on a blank board. This was the
cause of misleading results in initial testing -- see finding #6 below.

## 2. Heatmap After Fix

**Test procedure:**
```bash
node cli/bin/run.js --size 8 --asm presets/nano-2x.asm --cell 0,0 \
  --interrupts 50000 --save /tmp/heat.json --quiet
node cli/bin/heatmap.js --state /tmp/heat.json --metric writes
```

**Result: WORKS.** The writes heatmap shows nonzero activity across the
board when a replicating preset is loaded via `--asm`. Values range from
0.394 to 1.000, with a colorful pattern showing cell write recency.

The entropy heatmap also works, showing values from 0.270 to 0.307 for
a nano-2x saturated board.

The `lastWriteTime` and `lastMoveTime` arrays are properly serialized and
restored from JSON state files.

## 3. Mean-Field Model

**`mean-field.js`** is a standalone analytical tool that computes the
predicted trajectory of board state over time using a mathematical
mean-field model. It classifies cells into three states:

- **D (Dead)**: byte[0] = 0x00, byte[1] = 0x00 (BRK 0 loop)
- **B (BRK)**: byte[0] = 0x00, byte[1] != 0x00 (BRK with operand, i.e. active copier)
- **A (Alive)**: byte[0] != 0x00 (not a BRK instruction)

Output includes transition rate matrices, steady-state estimates, a
trajectory table, sparkline visualizations, and characteristic timescales.

Default run shows the board converging to ~97.8% B state, ~1.8% A state,
~0.3% D state by epoch 500. This makes physical sense: BRK-based copiers
(like nano) dominate because BRK-first programs are robust to PC corruption.

**`mean-field-fit.js`** is a companion tool that runs an actual simulation,
collects census data, and fits the mean-field model parameters to the
empirical trajectory. It runs 100,000 interrupts on a 16x16 board and
reports best-fit rates for copy, crash, and self-write transitions, along
with RMSE. Works correctly.

## 4. New Presets

### Resetter (`presets/resetter.asm`)
22 bytes. Copies itself forward via BRK $F5, then actively kills cell 2
by zeroing bytes 0-1 (making it BRK 0, a dead loop) and resetting its PC
to 0x0000. This forces the target into a permanent dead state.

**Observed behavior:** After 5000 interrupts on 8x8, cell 0,0 shows
byte[0]=0x00, byte[1]=0x5E (94) -- it has been overwritten by mutations
from its own copies. The board shows varied entropy values, indicating
a mix of live and dead cells.

### BRK-Activator (`presets/brk-activator.asm`)
6 bytes. Identical to the nano preset. Drives the board toward B state
(BRK with operand). After 5000 interrupts, cell 0,0 shows byte[1]=0xF5
(the copy operand), confirming active replication.

### Alive-Forcer (`presets/alive-forcer.asm`)
22 bytes. Copies itself forward, then writes NOP ($EA) to cell 2 and
cell 3's byte[0], forcing them into A state (byte[0] != 0). Also resets
their PC. After 5000 interrupts, cell 0,0 has been fully zeroed --
it was overwritten by mutant descendants. The alive-forcer is B-state
itself (byte[0] = BRK), so its own copies maintain B-state while forcing
neighbors into A-state.

All three presets run without errors and produce expected behavior.

## 5. Rust/WASM Engine

**Build status:** The Rust/WASM engine at `wasm/` compiles successfully.

```bash
cd wasm && cargo build --target wasm32-unknown-unknown --release
```

Compiles with 3 warnings (unused constants/imports). A pre-built `wasm/pkg/`
directory exists with `board6502_wasm_bg.wasm` and JS bindings.

**`wasm-pack` is not installed** on this machine, so `wasm-pack build` was
not tested. However, since the pkg directory already exists with built
artifacts, the `example.html` file should work if served via a local HTTP
server:

```bash
cd wasm && python3 -m http.server 8080
# Then open http://localhost:8080/example.html
```

The example.html creates a 32x32 board, randomizes it, benchmarks 10K
interrupts, and provides Start/Stop and Step buttons for visualization.
It imports from `./pkg/board6502_wasm.js`.

## 6. Additional Finding: `run.js` Silently Ignores Unknown Flags

**Bug:** `run.js` does not support `--preset` but silently ignores it.
Running:
```bash
node cli/bin/run.js --preset nano-2x --cell 0,0 --interrupts 10000 --save out.json
```
produces a simulation with an all-zeros board (no preset loaded). The
`--preset` flag is consumed by the argument parser but never acted upon.

This is confusing because `terminal.js`, `inject.js`, and `profile.js` all
support `--preset`, but `run.js` does not. Users following documentation or
tutorials that reference `--preset` with `run.js` will get misleading results.

**Recommendation:** Either add `--preset` support to `run.js`, or emit a
warning/error when an unsupported flag is provided.

## Summary

| Test | Status | Notes |
|------|--------|-------|
| Determinism | FAIL | Two identical runs produce different output |
| Heatmap writes | PASS | Shows nonzero activity when preset loaded via `--asm` |
| Heatmap entropy | PASS | Works correctly |
| Mean-field model | PASS | Analytical and fitting tools both work |
| New presets (resetter) | PASS | Runs, replicates, kills neighbors as designed |
| New presets (brk-activator) | PASS | Runs, identical to nano |
| New presets (alive-forcer) | PASS | Runs, forces A-state on neighbors |
| Rust/WASM build | PASS | Compiles, pkg/ exists, example.html looks correct |
| wasm-pack build | SKIP | wasm-pack not installed |
| run.js --preset | BUG | Silently ignored, should warn or be supported |
