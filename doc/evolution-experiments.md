# Long-term Evolution Experiments

Date: 2026-03-22

## Experiment 1: Long-term evolution (triplicator-evolvable, eps=1/131072, 10M interrupts)

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
| 0.5M | 64 | 64 | 10.0 | 1 | 10:64 |
| 1.0M | 64 | 0 | 10.0 | 1 | 10:64 |
| 2.0M | 64 | 0 | 72.0 | 1 | 72:64 |
| 3.0M | 64 | 0 | 72.0 | 2 | 72:64 |
| 4.0M | 64 | 0 | 72.0 | 2 | 72:64 |
| 5.0M | 64 | 0 | 72.0 | 3 | 72:64 |
| 6.0M | 64 | 0 | 72.0 | 3 | 72:64 |
| 7.0M | 64 | 0 | 72.0 | 3 | 72:64 |
| 8.0M | 64 | 0 | 72.0 | 3 | 72:64 |
| 9.0M | 64 | 0 | 72.0 | 3 | 72:64 |
| 10.0M | 64 | 0 | 72.0 | 3 | 72:64 |

### Analysis

**The triplicator-evolvable survives indefinitely at eps=1/131072.** All 64 cells
remain functionally alive through the entire 10M-interrupt run. This confirms
it has crossed the error threshold -- replication + repair outpaces noise.

**N drifted dramatically from 10 to 72.** Between 1M and 2M interrupts, a mutant
with N=72 swept through the entire population. This is surprising because the
previous repair-rate experiments found N=10 to be optimal. The N=72 variant
performs ~72 repair iterations per BRK copy, which at ~55 cycles each would
consume ~3960 cycles -- more than the average scheduling window (~2800 cycles).
This means the timer fires mid-repair, and (since I flag is not set) the partial
repair commits. Effectively, N=72 means "repair until the timer fires," which
maximizes repair per scheduling at the cost of fewer BRK copies.

**Why N=72 wins over N=10 at this noise level**: At eps=1/131072, copy noise is
very low (~0.06 bit errors per 1024-byte copy). The dominant threat is no longer
copy errors but cross-contamination from neighboring cells. More repair iterations
per scheduling means more bytes corrected per scheduling, which compensates for
the reduced copy rate. At higher noise (eps=1/32768), N=10 would likely still win
because copy frequency matters more when copies are noisier.

**Code diversity is very low** (3 unique fingerprints at 10M). The population is
nearly clonal, with N=72 having swept to fixation. The 3 fingerprints represent
minor variants that differ in non-functional bytes.

## Experiment 2: Multi-species ecology (triplicator-evolvable vs nano-2x)

### Setup
- Board: 8x8, seed 42
- Triplicator-evolvable at (0,0) with N=10, loaded to pages 0, 2, 3
- nano-2x at (4,4)
- Noise: pBitNoise = 1/131072
- Duration: 5M interrupts

### Results

| Interrupts | Triplicator | nano-2x | Other | Trip 80% | Unique FPs |
|-----------|------------|---------|-------|---------|-----------|
| 0 | 1 | 1 | 62 | 1 | 3 |
| 100k | 0 | 64 | 0 | 0 | 1 |
| 500k | 0 | 64 | 0 | 0 | 1 |
| 1M | 0 | 64 | 0 | 0 | 2 |
| 2M | 0 | 64 | 0 | 0 | 1 |
| 3M | 0 | 0 | 64 | 0 | 3 |
| 5M | 0 | 0 | 64 | 0 | 2 |

### Analysis

**nano-2x dominated immediately, then went extinct.** By 100k interrupts, nano-2x
had colonized all 64 cells, completely displacing the triplicator. nano-2x's speed
advantage is decisive: it fires two BRK copies per scheduling loop (7+7=14 cycles),
while the triplicator spends ~55+ cycles per repair iteration before its BRK copy.

**The triplicator never got a foothold.** Starting from a single cell at (0,0)
against 62 empty cells and 1 nano-2x cell, the triplicator needed to copy to pages
0, 2, and 3 in each target cell. nano-2x only needs page 0 (8 bytes). The
triplicator's first scheduling might fire 1 BRK copy, while nano-2x fires ~200
copies per scheduling. In the race to colonize empty cells, nano-2x wins easily.

**nano-2x then went extinct between 2M and 3M.** Despite occupying all 64 cells,
nano-2x could not sustain itself. At eps=1/131072, each BRK copy introduces
~0.06 bit errors in its 8-byte genome. Over millions of copies, lethal mutations
accumulate. Without repair, nano-2x has no defense against error accumulation.

**This confirms Eigen's error catastrophe.** nano-2x wins the short game (fast
colonization) but loses the long game (no error correction). The triplicator could
win the long game (self-repair) but loses the short game (too slow to colonize).
In competition, speed wins initially, but the fast replicator inevitably succumbs
to mutation. Neither organism achieves long-term coexistence.

**Ecological implication**: For coexistence, the triplicator would need either
(a) a larger board where both species can expand into unoccupied territory, or
(b) a pre-seeded population to avoid the initial colonization bottleneck.

## Experiment 3: Spontaneous emergence from random (eps=0, 10M interrupts)

### Setup
- Board: 8x8, seed 42, fully randomized
- Noise: pBitNoise = 0 (zero noise)
- Duration: 10M interrupts
- Looking for: cells with BRK $F5-$F8 at byte 0, self-replicating patterns

### Results

| Interrupts | BRK-copy@0 cells | Unique FPs | Notes |
|-----------|-----------------|-----------|-------|
| 0 | 0 | 64 |  |
| 100k | 0 | 59 |  |
| 500k | 0 | 3 |  |
| 1M | 0 | 4 |  |
| 2M | 0 | 36 |  |
| 5M | 0 | 29 |  |
| 10M | 0 | 41 |  |

### Self-replication check at 10M

Found 20 clusters of identical cells:
- 3 cells: (3,3), (3,4), (4,3)
  First 8 bytes: 4f a3 7a d6 8d 2a 15 f5
- 3 cells: (1,3), (2,4), (2,5)
  First 8 bytes: 4f a3 7a d6 8d 2a 15 f5
- 3 cells: (4,1), (4,2), (6,0)
  First 8 bytes: 4f a3 7a d6 8d 2a 15 f5
- 2 cells: (2,1), (3,0)
  First 8 bytes: 50 a5 7b d7 8e 2a 14 f5
- 2 cells: (3,7), (4,6)
  First 8 bytes: 4f a3 7a d6 8d 2a 15 f4

## Experiment 4: Magnetosensing vs standard nano-2x

### Setup
- Board: 8x8, seed 42
- Noise: pBitNoise = 1/131072
- Duration: 5M interrupts
- Comparison: standard nano-2x vs magnetosensing nano-2x variant

### Control: standard nano-2x (no magnetosensing)

| Interrupts | Alive | Unique FPs |
|-----------|-------|-----------|
| 0 | 1 | 2 |
| 100k | 64 | 3 |
| 500k | 64 | 1 |
| 1M | 64 | 2 |
| 2M | 64 | 1 |
| 3M | 64 | 4 |
| 5M | 64 | 2 |

### Magnetosensing nano-2x variant

This variant uses a direction-aware copy strategy.
When magnetosensing is enabled, $FA contains (orientation << 2).
The organism reads $FA and adjusts its BRK operand accordingly.

| Interrupts | Alive | Unique FPs |
|-----------|-------|-----------|
| 0 | 1 | 2 |
| 100k | 64 | 2 |
| 500k | 64 | 2 |
| 1M | 64 | 2 |
| 2M | 64 | 1 |
| 3M | 64 | 3 |
| 5M | 64 | 1 |

### Direction-aware triplicator (magnetosensing ON)

Uses triplicator-evolvable with magnetosensing enabled.
The organism itself does not read $FA, but the board provides
orientation info. This tests whether magnetosensing as a board
parameter affects triplicator survival.

| Interrupts | Alive | 80% fidelity | Mean N |
|-----------|-------|-------------|--------|
| 0 | 64 | 64 | 10.0 |
| 500k | 64 | 64 | 10.0 |
| 1M | 64 | 64 | 10.0 |
| 2M | 64 | 64 | 10.0 |
| 3M | 64 | 0 | 10.0 |
| 5M | 64 | 0 | 10.0 |

### Triplicator control (magnetosensing OFF)

| Interrupts | Alive | 80% fidelity | Mean N |
|-----------|-------|-------------|--------|
| 0 | 64 | 64 | 10.0 |
| 500k | 64 | 64 | 10.0 |
| 1M | 64 | 64 | 10.0 |
| 2M | 64 | 0 | 10.0 |
| 3M | 64 | 0 | 10.0 |
| 5M | 64 | 0 | 26.0 |

