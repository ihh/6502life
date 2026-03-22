# Social Mining Dogfood Report

Date: 2026-03-22

## Challenge 1: Social Mining End-to-End

### Command
```bash
node coin/bin/social-mine.js --size 8 --seed-a 42 --seed-b 99 --ticks 50000 --share-interval 100 --verify
```

### Observations

**The tool works but crashes at the summary output stage.** The simulation runs,
produces 50 blocks for each player, and verification passes. However, the CLI
crashes before printing the summary because of a property name mismatch between
`computeCoinValue()` and the output code.

The `computeCoinValue()` function (in `coin/economics.js`) returns:
- `totalCoins` (not `totalValue`)
- `socialMultiplier`
- `soloRate`

But `social-mine.js` lines 168-184 reference:
- `valueA.totalValue` (undefined -- should be `totalCoins`)
- `valueA.activityMultiplier` (does not exist)
- `valueA.networkMultiplier` (does not exist)

The same bug exists in `social-verify.js` line 139.

**Workaround:** Use `--json --quiet` flags, which bypass the broken text output
path and produce clean JSON to stdout. Alternatively, use `--json` alone (stdout
gets JSON, stderr gets progress, but the non-JSON summary path is never reached).

**Verification (--verify flag) works correctly.** When tested with `--json`,
the `verified` field is `true`. The dual-witness signature scheme, hash chains,
boundary frame cross-consistency, and full replay verification all pass.

**With --json output:**
```json
{
  "playerA": { "blocks": 50, "finalTick": 50000, "multipliers": { "social": 1 } },
  "playerB": { "blocks": 50, "finalTick": 50000, "multipliers": { "social": 1 } },
  "wallTimeMs": 1357,
  "verified": true
}
```

**Performance:** 50k ticks of Game of Life on 8x8 boards completes in ~1 second.

### Usability Issues

1. **Bug: `totalValue` vs `totalCoins` property mismatch** -- crashes the CLI in
   non-JSON mode. Both `social-mine.js` and `social-verify.js` affected.
2. **Bug: references to nonexistent multiplier properties** -- `activityMultiplier`
   and `networkMultiplier` are not returned by `computeCoinValue()`. The economics
   module returns `soloRate`, `socialMultiplier`, `nicheBonus`.
3. **Social multiplier always 1.0** -- the `computeCoinValue()` function checks
   `context.isSocial` but `social-mine.js` doesn't pass a `context` argument,
   so the social multiplier is never applied. The social bonus is effectively
   lost.
4. **Stale session files in project root** -- if old `session-a.json` /
   `session-b.json` files exist from a previous code version, the verifier
   correctly rejects them. Good behavior, but users might be confused.

### Suggestions

- Fix the property name mismatches (`totalValue` -> `totalCoins`, remove
  `activityMultiplier`/`networkMultiplier` references, or add them to the
  economics module).
- Pass `{ isSocial: true }` as the context when calling `computeCoinValue()`
  from social mining tools, so the 1.5x social multiplier actually applies.
- Add `--out-a` / `--out-b` to the `--help` text (they exist but are
  underdocumented).

---

## Challenge 2: Organism Migration (nano-2x)

### Command
```javascript
// Two 8x8 Board6502Engines, nano-2x seeded at (3,3) on each
// EdgeSession sharing east edge every 100 ticks, run 100k ticks
```

### Observations

**Boundary cells are perfectly synchronized.** After 100k ticks, every cell on
Board A's east edge is byte-identical to the corresponding cell on Board B's
west edge (1024/1024 bytes match for all 8 boundary cell pairs).

**Organisms spread and evolved.** Both boards show extensive copy activity:
- Board A: 63,757 copies, 443 swaps
- Board B: 69,133 copies, 525 swaps
- All 64 cells on each board have unique hashes

**The original nano-2x signature (8 bytes) is not preserved.** Zero cells on
either board match the original nano-2x first-8-byte signature after 100k
ticks. The organisms have mutated significantly. However, the first bytes of
boundary cells show a consistent pattern starting with `80 FD 00 F6 D0 FA`,
suggesting a dominant evolved variant.

**Edge-sharing semantics work correctly.** Board A's east column is copied to
Board B's west column every 100 ticks, and vice versa. This means the boundary
region acts as a "portal" where organisms from one board appear on the other.

### Usability Issues

- No built-in CLI tool for running 6502 boards in social mode (the
  `social-mine.js` tool only supports the Game of Life engine). Running 6502
  social scenarios requires custom scripting with the `Board6502Engine` and
  `EdgeSession` classes.
- `Board6502Engine` has an async `ready()` method (for preset loading) that
  must be awaited before calling `step()`. This is easy to forget.

### Suggestions

- Add a `--engine board6502` flag to `social-mine.js` (or a separate
  `social-mine-6502.js` tool) that uses `Board6502Engine` with preset support.
- Consider adding a `--preset` flag for organism seeding.

---

## Challenge 3: Triplicator Across Boards

### Command
```javascript
// Same setup as Challenge 2 but with triplicator preset (51 bytes)
```

### Observations

**Boundary cells are again perfectly synchronized** (1024/1024 match on all 8
cell pairs).

**Triplicator does NOT survive intact.** Zero cells on either board retain >80%
match to the original triplicator code after 100k ticks. The error-correcting
code does not survive the mutation pressure over this timescale.

**Copy/swap rates are lower than nano-2x:**
- Board A: 29,079 copies, 354 swaps
- Board B: 32,661 copies, 361 swaps

This is about half the copy rate of nano-2x, suggesting the triplicator's
larger code size makes it less aggressively replicating.

### Usability Issues

Same as Challenge 2 -- no built-in CLI tool for 6502 social scenarios.

### Suggestions

- The triplicator's error-correction may need to operate at a faster rate to
  outpace the mutation rate. Alternatively, a "super-triplicator" that votes
  across more copies might be more robust.
- Would be useful to have a metric for "code fidelity" -- how closely
  organisms match their original preset over time.

---

## Challenge 4: Competition (nano-2x vs triplicator)

### Command
```javascript
// Board A: nano-2x at (3,3), Board B: triplicator at (3,3)
// Share east edge every 100 ticks, run 100k ticks
```

### Observations

**nano-2x slightly dominates in copy rate** but both boards converge to
similar dynamics:

| Tick   | A (nano-2x) copies | B (triplicator) copies | A unique | B unique |
|--------|-------------------|----------------------|----------|----------|
| 10,000 | 8,556             | 8,667                | 64       | 64       |
| 25,000 | 19,284            | 20,163               | 64       | 64       |
| 50,000 | 34,822            | 36,001               | 64       | 63       |
| 100,000| 50,249            | 49,398               | 64       | 64       |

**By 100k ticks, both boards have similar copy counts.** The triplicator board
actually has slightly more copies early on, then nano-2x pulls ahead. This
suggests the competition is fairly even once organisms evolve away from their
original code.

**Board B (triplicator) has zero active cells by 25k ticks**, while Board A
retains 2 active cells throughout. This suggests nano-2x-descended organisms
are more persistently active.

### Usability Issues

- No way to measure which organism "won" -- the unique hash count stays at 64
  for both boards, and there's no organism lineage tracking in social mode.

### Suggestions

- Add MinHash fingerprinting to the social mining pipeline to track whether
  organisms from Board A appear on Board B and vice versa.
- A "domination score" metric comparing boundary cell similarity to each
  board's interior would be useful.

---

## Challenge 5: Different Board Parameters

### Command
```javascript
// Board A: pBitNoise=0 (no noise), Board B: pBitNoise=0.001 (noisy)
// Both seeded with nano-2x at (3,3), same seed (42)
```

### Observations

**Noise dramatically affects copy rates.** The noisy board has far fewer
copies:

| Tick    | A (no noise) copies | B (noisy) copies | Ratio |
|---------|-------------------|-----------------|-------|
| 10,000  | 9,344             | 8,364           | 1.12x |
| 25,000  | 23,740            | 19,685          | 1.21x |
| 50,000  | 47,530            | 31,286          | 1.52x |
| 100,000 | 91,313            | 38,510          | 2.37x |

**The gap widens over time.** By 100k ticks, the noise-free board has 2.4x
more copies. Noise disrupts replication fidelity, reducing the effective
replication rate.

**Swap rates diverge dramatically:**
- Board A (no noise): 27 swaps total
- Board B (noisy): 260 swaps total

Noise increases swap events 10x, likely because corrupted BRK operands
trigger swaps instead of copies.

**Both boards maintain the same number of unique hashes (64)** and the same
number of active cells (2), suggesting the population structure is similar
even though dynamics differ.

### Usability Issues

- `pBitNoise` is passed via the `Board6502Engine` config but the parameter
  name is not obvious. Passing it as a top-level config property works but
  feels fragile.
- No way to compare boards visually in social mode.

### Suggestions

- Asymmetric noise creates a natural "ecosystem gradient" at the boundary.
  This could be an interesting game mechanic -- players with different board
  parameters create different evolutionary pressures.
- Document that `pBitNoise` controls per-byte noise rate during interrupts.

---

## Challenge 6: New Presets in Social Contexts

### Test 6a: resetter on Board A vs nano-2x on Board B

**The resetter does NOT kill organisms on Board B through the shared edge.**
After 100k ticks, Board B's west edge cells have nonzero code areas (0/8 cells
zeroed). The resetter's effect is local -- it resets cells on its own board but
the copied boundary data contains whatever evolved state exists in those cells,
not zeros.

Copy rates are comparable: A=58,535, B=54,289. The resetter appears to
coexist with the general evolved population rather than dominating.

### Test 6b: brk-activator on Board A vs nano-2x on Board B

Both boards converge to similar dynamics:
- Board A: 54,422 copies, 442 swaps
- Board B: 50,285 copies, 338 swaps

The brk-activator does not create noticeably different dynamics from other
presets at the boundary.

### Test 6c: alive-forcer on Board A vs nano-2x on Board B

Similar convergence:
- Board A: 57,051 copies, 313 swaps
- Board B: 56,610 copies, 369 swaps

Board B retains 2 active cells while Board A has 0, which is interesting --
the alive-forcer may paradoxically reduce long-term activity on its own board.

### Usability Issues

- Hard to tell what the new presets are actually doing without disassembly
  or step-by-step debugging.
- No preset-specific metrics (e.g., "cells reset" for resetter, "cells
  activated" for brk-activator).

### Suggestions

- Add preset-specific event counters to `Board6502Engine.summarize()`.
- The resetter's boundary-crossing failure is actually desirable -- it means
  organisms can't weaponize board edges to kill neighbors. But it should be
  documented.

---

## TUI Debugger with Social Scenarios

### Attempted
```bash
node cli/bin/terminal.js --size 8 --preset nano-2x --cell 0,0 --listen
```

### Observations

**The terminal debugger does not support social/multi-board scenarios.** There
is no `--social`, `--connect`, or `--share-edge` flag. The `--listen` flag
creates a read-only probe socket for inspection but does not enable
inter-board communication.

**Two terminal.js instances cannot share state.** The probe socket is
unidirectional (read-only inspection). There is no mechanism for one debugger
to push boundary data to another.

### Suggestions

- Add a `--pair <socket-path>` flag that connects two terminal.js instances
  via a Unix socket, sharing boundary data at a configurable interval.
- Alternatively, add a `social-terminal.js` that runs two boards side-by-side
  in a split-screen TUI, with boundary sharing visualized as a colored
  border between the two board views.
- The probe socket could be extended with write commands (e.g.,
  `setBoundary`) to enable external orchestration of social scenarios.

---

## Summary of Bugs Found

| # | Severity | Location | Description |
|---|----------|----------|-------------|
| 1 | **High** | `coin/bin/social-mine.js:168` | `valueA.totalValue` should be `valueA.totalCoins` |
| 2 | **High** | `coin/bin/social-mine.js:170-171` | References nonexistent `activityMultiplier`, `networkMultiplier` |
| 3 | **High** | `coin/bin/social-verify.js:124,139` | Same `totalValue` vs `totalCoins` mismatch |
| 4 | **Medium** | `coin/bin/social-mine.js:159` | `computeCoinValue()` called without `{ isSocial: true }` context, so social multiplier is never applied |
| 5 | **Low** | `coin/bin/social-mine.js` | No 6502 engine support (only Game of Life) |

Bugs 1-3 cause a crash (TypeError) whenever the tools try to print human-readable
output. The `--json` flag works around it for `social-mine.js`. The
`social-verify.js` tool crashes in both JSON and text mode after printing
verification results.

## Overall Assessment

The social mining infrastructure is functionally correct for the Game of Life
engine. The dual-witness signature scheme, hash chains, boundary frame
cross-consistency, and deterministic replay verification all work as designed.

For 6502 boards, the `EdgeSession` and `Board6502Engine` classes work correctly
when used programmatically. Organisms do cross board boundaries via edge-sharing,
and the boundary cells become perfectly synchronized. However, there is no
CLI tool that exposes this functionality -- users must write custom scripts.

The economics module (`computeCoinValue`) has a disconnect with the CLI tools
that consume it, suggesting the API was recently refactored without updating
all callers.
