# Sync Interrupt Experiments (BRK 253)

## Overview

BRK 253 requests periodic scheduling: X,Y registers specify the period in cycles.
The next interrupt is scheduled at the nearest future absolute multiple of that period.
Feature-gated by `boardParams.implementsSync`.

These experiments test whether periodic scheduling via BRK 253 gives organisms a
fitness advantage over randomly-scheduled organisms.

## Organisms Tested

**sync-nano** (10 bytes): Requests sync every 500 cycles, then copies forward.
```
LDX #$F4 / LDY #$01 / BRK $FD / BRK $F5 / BNE/BEQ loop
```

**sync-nano-2x** (14 bytes): Requests sync, then copies forward and right.
```
LDX #$F4 / LDY #$01 / BRK $FD / BRK $F5 / BRK $F6 / BNE/BEQ loop
```

**nano-2x** (8 bytes, control): No sync, copies forward and right.
```
BRK $F5 / BRK $F6 / BNE/BEQ loop
```

## Experiment 1: Scheduling Regularity

**Setup**: 8x8 board, single organism at (0,0), 50k interrupts, `implementsSync: true`.

| Organism   | Schedulings | Expected (uniform) | Ratio |
|------------|-------------|---------------------|-------|
| sync-nano  | ~800-900    | 781                 | 1.03-1.16x |
| nano-2x    | ~720-740    | 781                 | 0.92-0.95x |

**Finding**: Sync interrupt provides a modest 8-25% scheduling advantage over random
scheduling. The advantage varies by run but is consistently positive.

## Experiment 2: Head-to-Head Competition

**Setup**: 8x8 board, sync-nano at (0,0) vs nano-2x at (4,4), 200k interrupts.

| Metric | Sync-nano | Nano-2x |
|--------|-----------|---------|
| Copies from origin | 138 | 517 |
| Cells matching pattern | 0/64 | 62/64 |

**Winner: nano-2x**, decisively.

**Why**: Sync-nano's BRK $FD (sync request) wastes one scheduling per copy cycle.
Every other scheduling is spent *requesting* the next interrupt rather than copying.
Meanwhile nano-2x copies on *every* scheduling in two directions.

## Experiment 3: Sync-nano-2x vs Nano-2x

**Setup**: Same as above but using sync-nano-2x (14 bytes, copies in 2 directions).

| Metric | Sync-nano-2x | Nano-2x |
|--------|-------------|---------|
| Copies from origin | 1,371 | 822 |
| Cells matching pattern | 0/64 | 14/64 |
| Cells with intact BRK $FD | 0/64 | N/A |

**Winner: nano-2x** by territory, despite fewer copies from origin.

**Key insight**: Zero cells retain an intact `BRK $FD` sequence after noisy copy.
The sync mechanism is completely destroyed by copy noise. Sync-nano-2x's origin cell
copies more frequently (thanks to sync), but its descendants are ordinary random-scheduled
organisms that lack the sync advantage. Meanwhile nano-2x's smaller genome (8 vs 14 bytes)
is more robust to bit-flip noise.

## Experiment 4: Period Optimization

**Setup**: 8x8 board, sync-nano alone at (0,0), 50k interrupts, varying period.

| Period | Schedulings | Ratio | Copies | Populated |
|--------|-------------|-------|--------|-----------|
| 100    | 817         | 1.05x | 29,556 | 64/64     |
| 500    | 903         | 1.16x | 20,139 | 64/64     |
| 2,000  | 817         | 1.05x | 28,092 | 64/64     |
| 10,000 | 790         | 1.01x | 26,423 | 64/64     |

**Finding**: Period 500 gives the highest scheduling advantage (1.16x) but *fewer* total
copies. Period 100 and 2000 produce more copies overall. The scheduling advantage does not
translate linearly to copy advantage because total cycles vary with period.

All periods eventually populate the entire 8x8 board because descendants spread via
random scheduling even without functional sync.

## Conclusions

1. **BRK 253 sync scheduling works** and provides a modest (~10-20%) scheduling
   frequency advantage.

2. **Sync is not heritable** under noisy copy. The `$FD` operand byte is just as
   vulnerable to bit-flips as any other byte. After one generation of noisy copy,
   descendants lose the sync capability.

3. **Genome size matters more than scheduling frequency.** Nano-2x's 8-byte genome
   survives noisy copy far better than sync-nano's 10-14 bytes. In competition,
   the simpler organism dominates.

4. **Sync is a "personal" advantage.** The origin cell benefits, but cannot pass
   the benefit to offspring. This makes sync a weak evolutionary strategy under
   the current noise model.

5. **Potential improvements**: Sync could become viable if (a) copy noise were
   reduced, (b) the sync operand ($FD) were protected or redundantly encoded,
   or (c) organisms evolved error-correction for the sync BRK sequence.

## Test File

`engine/test/sync-interrupt.test.js` -- run with `npm test`.

## Preset

`presets/sync-nano.asm` -- available in the terminal debugger as preset `sync-nano`.
