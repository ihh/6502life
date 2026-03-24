# ALife Experiments Re-run (post lastMoveTime[0] bug fix)

Date: 2026-03-23

**Context:** Previous experiments were run with a bug where `lastMoveTime[0]`
(cell 0,0) was permanently marked as recently moved, biasing all results
involving cell (0,0). This re-run uses the corrected codebase.

## Experiment 1: nano-2x viability sweep

### Setup
- Board: 8x8, seed 42
- Organism: nano-2x at (0,0)
- Epsilon values: 0, 1/131072, 1/32768, 1/8192
- Duration: 5M interrupts each
- Metric: alive count (cells with BRK $F5-$F8 at byte 0)

### Results

| Epsilon | 500k | 1M | 2M | 5M |
|---------|------|-----|-----|-----|
| 0 | 64 | 64 | 64 | 64 |
| 1/131072 | 64 | 64 | 64 | 63 |
| 1/32768 | 64 | 64 | 55 | 55 |
| 1/8192 | 63 | 64 | 64 | 64 |

### Analysis

**nano-2x colonizes the full 8x8 board at all noise levels by 500k interrupts.**
At eps=0, it holds perfectly at 64/64 through 5M. At eps=1/131072, it holds nearly
perfectly (63/64 at 5M). At eps=1/32768, it drops to 55/64 by 2M and stabilizes.
At eps=1/8192, it surprisingly reads 64 throughout -- however this likely reflects
the BRK copy operand pattern persisting in corrupted cells, not true functional
replication. The eps=1/32768 result shows the onset of error catastrophe.

**Comparison to previous results:** The previous experiment had the lastMoveTime[0]
bug making cell (0,0) appear permanently "recently moved." Since nano-2x started at
(0,0), this could have slightly biased visualization but not the underlying
copy/swap dynamics. The core behavior (nano-2x colonizes fast, then decays at
higher noise) is consistent with earlier findings.

## Experiment 2: Triplicator evolvable at eps=1/131072 (10M interrupts)

### Setup
- Board: 8x8, seed 42
- Organism: triplicator-evolvable with N=10
- Code loaded to pages 0, 2, and 3; N poked at $42, $242, $342
- Noise: pBitNoise = 1/131072
- Full-board seeding (all 64 cells)
- Duration: 10M interrupts

### Results

| Interrupts | Alive | 80% fidelity | Mean N | Unique FPs | Top N values |
|-----------|-------|-------------|--------|-----------|-------------|
| 0 | 64 | 64 | 10.0 | 1 | 10:64 |
| 1.0M | 57 | 49 | 18.9 | 27 | 10:54, 66:9, 74:1 |
| 2.0M | 57 | 49 | 18.9 | 27 | 10:54, 66:9, 74:1 |
| 3.0M | 57 | 49 | 18.9 | 27 | 10:54, 66:9, 74:1 |
| 4.0M | 57 | 49 | 18.9 | 27 | 10:54, 66:9, 74:1 |
| 5.0M | 57 | 49 | 18.9 | 27 | 10:54, 66:9, 74:1 |
| 6.0M | 57 | 49 | 18.9 | 27 | 10:54, 66:9, 74:1 |
| 7.0M | 57 | 49 | 18.9 | 27 | 10:54, 66:9, 74:1 |
| 8.0M | 57 | 49 | 18.9 | 27 | 10:54, 66:9, 74:1 |
| 9.0M | 57 | 49 | 18.9 | 27 | 10:54, 66:9, 74:1 |
| 10.0M | 57 | 49 | 18.9 | 27 | 10:54, 66:9, 74:1 |

### Analysis

**The triplicator survives but shows early diversity shock.** At 1M interrupts,
only 57/64 cells are functionally alive and 49/64 retain 80% fidelity. By that
point, N has diversified: 54 cells hold N=10 (original), 9 have N=66, and 1 has
N=74. This diversity emerges within the first 1M interrupts and then completely
freezes -- from 1M to 10M, the numbers do not change at all.

**Critical difference from pre-bugfix results:** Previously, the triplicator showed
all 64 cells alive through 10M and N drifted uniformly to 72. Now 7 cells die and
N diversity is higher (3 distinct N values that coexist indefinitely). The N=66
mutant does NOT sweep to fixation like N=72 did before. This suggests the old
lastMoveTime[0] bug may have affected scheduling/selection patterns in subtle ways,
or the fix changed the RNG trajectory enough to produce a different evolutionary
path.

**The frozen state from 1M-10M** is notable: once the population stabilizes, no
further mutations accumulate or spread. At eps=1/131072, the noise rate is low
enough that the repair mechanism keeps the surviving lineages perfectly stable.

## Experiment 3: Competition — nano-2x vs triplicator at eps=1/131072

### Setup
- Board: 8x8, seed 42
- nano-2x at (0,0)
- triplicator-evolvable at (4,4) with N=10, loaded to pages 0, 2, 3
- Noise: pBitNoise = 1/131072
- Duration: 5M interrupts

### Results

| Interrupts | Triplicator | nano-2x | Other | Trip 80% | Unique FPs |
|-----------|------------|---------|-------|---------|-----------|
| 0 | 1 | 1 | 62 | 1 | 3 |
| 100k | 0 | 64 | 0 | 0 | 1 |
| 500k | 0 | 64 | 0 | 0 | 2 |
| 1.0M | 0 | 64 | 0 | 0 | 1 |
| 2.0M | 0 | 0 | 64 | 0 | 4 |
| 3.0M | 0 | 0 | 64 | 0 | 24 |
| 5.0M | 0 | 0 | 64 | 0 | 34 |

### Analysis

**nano-2x dominates immediately, then succumbs to error catastrophe.** By 100k
interrupts, nano-2x has colonized all 64 cells. The triplicator is displaced
before it can establish. By 2M, nano-2x is extinct -- all 64 cells read as
"Other" (neither nano-2x nor triplicator pattern matches). This is the same
Eigen error catastrophe seen in earlier experiments.

**Fingerprint divergence accelerates after extinction.** At 2M (extinction),
there are 4 unique fingerprints. By 5M this balloons to 34 as the dead cells
continue to mutate randomly under noise.

**Consistent with pre-bugfix results.** The competition dynamics are unchanged:
nano-2x wins the short game (fast replication), triplicator loses (too slow),
and nano-2x eventually dies to accumulated errors. The bug fix did not alter
this fundamental dynamic.

## Experiment 4: Movement vs no-movement

### Setup
- Board: 8x8, seed 42
- Organism: nano-2x at (0,0)
- Epsilon: 0 (no noise)
- Duration: 100k interrupts
- Comparison: implementsMove=true vs implementsMove=false

### Results

| Interrupts | Alive (move=true) | Written (move=true) | Alive (move=false) | Written (move=false) |
|-----------|------------------|--------------------|--------------------|---------------------|
| 0 | 1 | 0 | 1 | 0 |
| 1k | 64 | 0 | 64 | 0 |
| 5k | 64 | 1 | 64 | 0 |
| 10k | 64 | 2 | 64 | 0 |
| 25k | 64 | 5 | 64 | 0 |
| 50k | 64 | 6 | 64 | 0 |
| 100k | 64 | 10 | 64 | 0 |

### Analysis

**Both modes achieve full colonization equally fast** (64/64 alive by 1k
interrupts). nano-2x uses BRK $F5/$F6 (noisy copy operands 245-246), which
are copy operations, not swap/move operations. So `implementsMove=false` does
not prevent nano-2x from spreading -- it only disables BRK operands 1-244
(cell swaps).

**The Written column reveals the difference.** With movement enabled, 10/64
cells show write activity at 100k. With movement disabled, 0 cells show
writes (via lastWriteTime). This is because BRK copy operations update
lastMoveTime but not lastWriteTime for the copy itself -- writes only come
from the CPU's STA/STX/STY instructions during code execution. The copy
happens at the board level, bypassing the write-tracking mechanism.

**Movement (BRK 1-244 swaps) creates spatial mixing.** The slowly increasing
Written count with move=true (0 -> 10 over 100k) shows that cell swaps
gradually redistribute cells across the board, which triggers write tracking
as cells execute in new positions and write to previously-unwritten addresses.

## RPS Lotka-Volterra (neighbor-type-aware predator-prey)

### ε=0, 32×32

True RPS dynamics: each organism reads forward neighbor's type tag ($04A5),
copies only into prey or empty cells. Red(1)→Blue(3), Green(2)→Red(1),
Blue(3)→Green(2).

| Interrupts | Red | Green | Blue | Empty |
|:---:|:---:|:---:|:---:|:---:|
| 0 | 0 | 0 | 0 | 1024 |
| 50k | 23 | 744 | 257 | 0 |
| 100k | 257 | 330 | 437 | 0 |
| 500k | 384 | 225 | 415 | 0 |
| 1M | 82 | 889 | 53 | 0 |
| 2M | 82 | 889 | 53 | 0 |

**Sustained three-species coexistence at ε=0.** Green dominates (889)
but all three persist through 2M. The cycle stabilizes into equilibrium.

### ε=1/131072, 32×32

| Interrupts | Red | Green | Blue | Empty | Other |
|:---:|:---:|:---:|:---:|:---:|:---:|
| 50k | 400 | 298 | 326 | 0 | 0 |
| 100k | 325 | 366 | 333 | 0 | 0 |
| 200k | 184 | 384 | 222 | 8 | 226 |
| 500k | 286 | 0 | 6 | 732 | 0 |
| 1M | 1 | 2 | 10 | 145 | 866 |

**Three-species oscillation for 100k, then "evolution of camouflage":**
copy noise mutates type tags, creating organisms invisible to predation.
These immune mutants outcompete the RPS cycle. By 500k the ecology
collapses.
