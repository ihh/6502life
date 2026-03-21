# CLI Bug Report

Systematic investigation of 6502life bugs, March 2026.
Builds on findings from `doc/cli-dogfood-notes.md`.

---

## Bug 1: Write/Move Heatmap Always Zero (confirmed, root cause identified)

### Reproduction
```bash
node cli/bin/run.js --size 8 --asm presets/nano-2x.asm --cell 0,0 --interrupts 10000 --save /tmp/state.json
node cli/bin/heatmap.js --state /tmp/state.json --metric writes
```

### Expected
Heatmap shows non-zero write activity for cells that were written to.

### Actual
Output line reads `Heatmap: writes, 8x8 board, 0 total cycles` and renders all-black.

### Root Cause
The state serialization (`controller.state` getter in `board/controller.js:38-47`)
saves only `memory`, CPU registers, and `noiseParams`. It does NOT save:
- `totalCycles`
- `lastWriteTime[]`
- `lastMoveTime[]`
- `lastWriteTimeForByte[][]`

When `heatmap.js` creates a fresh board via `createBoard()` and sets
`controller.state = state`, the activity arrays remain at their default
(all zeros). `controller.totalCycles` stays 0.

The heatmap code at `cli/bin/heatmap.js:39` uses `controller.totalCycles || 1`
as the normalizer, but all `lastWriteTime[idx]` values are 0, so every cell
reports zero activity.

Note: the `inspect.js` tool shows activity correctly because it calls
`getRecentlyActiveCells(controller)` on the SAME controller that ran the
simulation (before save/load). The activity data is live in memory but
lost on serialization.

### Fix Required
Add `totalCycles`, `lastWriteTime`, `lastMoveTime` (and optionally
`lastWriteTimeForByte`) to the `state` getter/setter in `board/controller.js`.

---

## Bug 2: Non-Deterministic Simulation (confirmed, root cause identified)

### Reproduction
```bash
node cli/bin/run.js --size 8 --seed 42 --asm presets/nano-2x.asm --cell 0,0 --interrupts 50000 --save /tmp/state1.json
node cli/bin/run.js --size 8 --seed 42 --asm presets/nano-2x.asm --cell 0,0 --interrupts 50000 --save /tmp/state2.json
diff /tmp/state1.json /tmp/state2.json
```

### Expected
Identical output files (same seed, same program, same parameters).

### Actual
Files differ completely. Memory diverges at byte 3 of cell 0. All registers,
MT state, and iOrig/jOrig differ. 57,906 of 65,536 memory bytes differ.

### Root Cause: Double Sfotty Construction
`board/controller.js` lines 20-23:
```js
this.newSfotty();                         // line 20: creates + patches sfotty
this.readRegisters();                     // line 21: loads registers into first sfotty
this.writeRng();                          // line 22: writes RNG to storage
this.sfotty = new Sfotty(this.memory);    // line 23: OVERWRITES with NEW sfotty
```

Line 23 creates a second Sfotty instance that replaces the first one. The new
Sfotty has uninitialized registers (JavaScript default values, not
seed-controlled). This means:

1. The CPU starts with random PC, A, X, Y, S values (not from storage)
2. The `decode()` patch from `newSfotty()` is lost (the "CPU crashed"
   suppression), so stderr noise returns
3. Every run produces different initial CPU state

The `readRegisters()` call at line 21 correctly loaded registers from
storage into the FIRST sfotty, but that sfotty is immediately discarded.

### Impact
- **All CLI simulations are non-deterministic.** The `--seed` flag controls
  only the Mersenne Twister (memory layout, scheduling order), not the
  initial CPU state.
- Programs that start with `BRK $00` (which resets PC to 0) eventually
  self-correct, but the first few interrupts produce different results
  each run. This cascades through the MT-based scheduling, causing
  complete divergence.
- The `terminal.js` script mode partially works around this by clearing
  `sfotty.resetPending` and calling `readRegisters()` after setup, but
  does not fix the double-construction bug.

### Fix Required
Remove line 23 (`this.sfotty = new Sfotty(this.memory);`). The `newSfotty()`
call at line 20 already creates and patches the Sfotty instance correctly.

---

## Bug 3: Sfotty CLC/BCC Behavior (not reproducible as a CPU bug)

### Reproduction
```bash
echo 'LDA #$00
CLC
BCC @skip
NOP
@skip:
BRK
.byte $00' | node cli/bin/assemble.js
```
Produces `a900189001ea0000`, which correctly encodes:
- `$00`: LDA #$00 (A9 00)
- `$02`: CLC (18)
- `$03`: BCC +1 (90 01) - branches to $06
- `$05`: NOP (EA)
- `$06`: BRK $00 (00 00)

### Finding
The CLC/BCC encoding is correct. The branch offset of +1 correctly skips
the NOP. However, **testing this in the simulation is unreliable due to
Bug 2** (double Sfotty construction). The CPU starts at a random PC rather
than $0000, so the test program may never execute from the beginning.

On a 1x1 board with seed 42, `sfotty.PC` starts at `$CE8B` (random
JavaScript default), not `$0000`. The test program at $0000-$0007 is
never reached unless a BRK $00 at a random address happens to reset PC.

### Conclusion
Cannot confirm or deny the CLC/BCC CPU bug until Bug 2 is fixed. The
assembler correctly encodes the branch. The reported issue from
`experiment-log.md` may have been a symptom of the non-determinism bug
rather than an actual CPU instruction bug.

---

## Bug 4: Triplicator Code Degradation (expected behavior)

### Reproduction
```bash
node cli/bin/run.js --size 8 --seed 42 --asm presets/triplicator.asm --cell 0,0 --interrupts 100000 --save /tmp/tri.json
node cli/bin/disasm.js --state /tmp/tri.json --cell 0,0 --lines 30
```

### Finding
After 100k interrupts at the default epsilon (1/2048), cell (0,0)'s
triplicator code is completely corrupted. The original 51-byte program is
unrecognizable. The disassembly shows garbage instructions (`STY $50`,
`ROR A`, `BMI`, undefined opcodes).

This is **expected behavior** (Muller's Ratchet). With copy noise at
1/2048, mutations accumulate faster than the majority-vote repair
mechanism can correct them. The previous dogfood notes document the
degradation timeline in detail.

The code at $0200 (page 2 backup) and $0300 (page 3 backup) are also
corrupted, confirming that all three copies used for majority-vote repair
have degraded.

---

## Bug 5: Phylo Tree Builder Produces Empty Output (confirmed, root cause identified)

### Reproduction
```bash
node cli/bin/replay.js --size 8 --asm presets/nano-2x.asm --cell 0,0 --interrupts 100000 --track 0,0 --log /tmp/lineage.jsonl
node cli/bin/phylo.js --log /tmp/lineage.jsonl --format ascii
```

### Expected
An ASCII tree showing parent-child copy relationships between cells.

### Actual
Output: `64 nodes, 0 leaves, depth 0, 70721 events`
No tree is printed.

### Root Cause: Cycles in the Lineage Graph
The lineage log contains 70,721 events across 64 cells (8x8 board).
Every cell is both a source and a destination of copies. When cell A
copies to cell B, and later cell B (or a descendant chain) copies back
to cell A, the tree builder creates a parent cycle: A's parent is set
to some descendant of A.

After processing all events:
- **0 roots** (every node has a parent, forming one or more cycles)
- **16 leaves** (nodes with no children) exist but are unreachable
  from roots
- The `printAsciiTree()` function iterates over `roots`, which is empty,
  so nothing is printed
- The `getStats()` function only counts leaves/depth reachable from
  roots, so reports 0 leaves and depth 0

### Fix Required
The tree builder needs to handle cycles. Options:
1. **Detect and break cycles** by treating re-copies as new lineage
   events (create versioned node keys like `"0,0@t=500"` instead of
   reusing `"0,0"`)
2. **Use a DAG** instead of a tree: allow multiple parents per node,
   one per copy event
3. **Report the cycle**: at minimum, detect the 0-roots condition and
   print a warning explaining that the lineage graph contains cycles

---

## Summary

| # | Bug | Severity | File |
|---|-----|----------|------|
| 1 | Write/move heatmap always zero | Medium | `board/controller.js` (state serialization) |
| 2 | Non-deterministic simulation | **Critical** | `board/controller.js:23` (double Sfotty construction) |
| 3 | CLC/BCC branch | Unconfirmed | Blocked by Bug 2 |
| 4 | Triplicator degradation | Expected | N/A |
| 5 | Phylo tree empty output | Medium | `cli/bin/phylo.js` (cycle handling) |

Bug 2 is the most critical: it affects ALL simulation results from all
CLI tools (run.js, replay.js, terminal.js without script mode). Every
simulation is non-deterministic regardless of the seed parameter. The
fix is a one-line deletion in `board/controller.js`.
