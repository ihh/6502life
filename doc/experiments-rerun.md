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

