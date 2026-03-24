# Cross-Board Evolution Experiments

Using EdgeSession social mining infrastructure for edge sharing.

Date: 2026-03-23

## Experiment 1: Organism Migration Across Boards

### Setup
- Two 8x8 boards, both at eps=0 (no noise)
- Board A: nano-2x at (0,0). Board B: empty (zeroed).
- Share south(A)->north(B) edge every 100 ticks for 200k ticks
- Tracking: when nano-2x first appears on Board B, colonization rate

### Results

| Ticks | A alive | A nano-2x | B alive | B nano-2x | Shares |
|-------|---------|-----------|---------|-----------|--------|
| 0 | 1 | 1 | 0 | 0 | 0 |
| 1k | 64 | 64 | 63 | 63 | 10 |
| 5k | 64 | 64 | 64 | 64 | 50 |
| 10k | 64 | 64 | 64 | 64 | 100 |
| 25k | 64 | 64 | 64 | 64 | 250 |
| 50k | 64 | 64 | 64 | 64 | 500 |
| 100k | 64 | 64 | 64 | 64 | 1000 |
| 150k | 64 | 64 | 64 | 64 | 1500 |
| 200k | 64 | 64 | 64 | 64 | 2000 |

**First nano-2x appearance on Board B:** 1k ticks

## Experiment 2: Divergent Evolution

### Setup
- Two 8x8 boards, both seeded with nano-2x at (0,0), eps=1/131072
- Share edge every 500 ticks for 1M ticks (connected phase)
- Then run each independently for another 1M ticks (isolated phase)
- Compare populations using MinHash fingerprinting

### Connected Phase (1M ticks, sharing every 500)

| Ticks | A alive | B alive | A unique | B unique | Cross-sim | A-self-sim | B-self-sim |
|-------|---------|---------|----------|----------|-----------|------------|------------|
| 0 | 1 | 1 | 2 | 2 | 0.951 | 0.951 | 0.950 |
| 100k | 64 | 64 | 4 | 2 | 0.537 | 0.544 | 0.549 |
| 250k | 64 | 64 | 4 | 7 | 0.615 | 0.904 | 0.602 |
| 500k | 64 | 64 | 1 | 9 | 0.495 | 0.872 | 0.453 |
| 750k | 59 | 57 | 5 | 14 | 0.403 | 0.834 | 0.392 |
| 1.0M | 64 | 61 | 1 | 15 | 0.327 | 0.913 | 0.362 |

### Isolated Phase (1M additional ticks, no sharing)

| Ticks | A alive | B alive | A unique | B unique | Cross-sim | A-self-sim | B-self-sim |
|-------|---------|---------|----------|----------|-----------|------------|------------|
| +0 | 64 | 61 | 1 | 15 | 0.327 | 0.913 | 0.362 |
| +250k | 64 | 61 | 2 | 15 | 0.191 | 0.944 | 0.361 |
| +500k | 64 | 61 | 3 | 15 | 0.129 | 0.881 | 0.362 |
| +750k | 64 | 61 | 5 | 15 | 0.111 | 0.801 | 0.365 |
| +1.0M | 64 | 61 | 3 | 15 | 0.090 | 0.664 | 0.364 |

## Experiment 3: Asymmetric Noise

### Setup
- Board A: eps=0 (clean), Board B: eps=1/8192 (noisy)
- Both seeded with nano-2x at (0,0)
- Share east(A)->west(B) edge every 100 ticks for 500k ticks
- Questions: Do clean organisms survive on the noisy board?
  Do mutants from the noisy board invade the clean board?

### Results

| Ticks | A alive | A nano-2x | A unique | B alive | B nano-2x | B unique | Cross-sim |
|-------|---------|-----------|----------|---------|-----------|----------|-----------|
| 0 | 1 | 1 | 2 | 1 | 1 | 2 | 0.951 |
| 10k | 64 | 64 | 9 | 64 | 64 | 13 | 0.148 |
| 50k | 64 | 64 | 5 | 64 | 64 | 10 | 0.400 |
| 100k | 64 | 64 | 6 | 64 | 64 | 10 | 0.566 |
| 200k | 64 | 64 | 6 | 64 | 64 | 8 | 0.690 |
| 300k | 64 | 64 | 2 | 64 | 64 | 7 | 0.691 |
| 500k | 64 | 64 | 3 | 60 | 39 | 17 | 0.612 |

### Post-isolation (100k more ticks, no sharing)

- Board A (clean): 64 alive, 64 nano-2x
- Board B (noisy): 61 alive, 28 nano-2x
- Cross-board similarity: 0.328

## Experiment 4: Red vs Blue Across Boards

### Setup
- Board A: red organism at (0,0). Board B: blue organism at (0,0).
- Both boards 8x8, eps=0
- Share east(A)->west(B) edge every 100 ticks for 500k ticks
- Red writes hue=0x01 to $3A0, Blue writes hue=0xAA to $3A0

### Results

| Ticks | A-red | A-blue | A-other | B-red | B-blue | B-other |
|-------|-------|--------|---------|-------|--------|---------|
| 0 | 1 | 0 | 63 | 0 | 1 | 63 |
| 5k | 7 | 57 | 0 | 7 | 57 | 0 |
| 10k | 0 | 64 | 0 | 0 | 64 | 0 |
| 25k | 0 | 64 | 0 | 0 | 64 | 0 |
| 50k | 0 | 64 | 0 | 0 | 64 | 0 |
| 100k | 0 | 64 | 0 | 0 | 64 | 0 |
| 200k | 0 | 64 | 0 | 0 | 64 | 0 |
| 300k | 0 | 64 | 0 | 0 | 64 | 0 |
| 500k | 0 | 64 | 0 | 0 | 64 | 0 |

**Winner: Blue** (128 cells vs 0 red)

