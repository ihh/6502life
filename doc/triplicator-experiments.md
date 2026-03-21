# Triplicator Noise Threshold Experiments

Date: 2026-03-21

## Setup

- Board: 8x8 (64 cells)
- Seed: 42
- Triplicator: 3 copies at pages 0, 2, 3; majority-vote repair of 1 byte/scheduling
- "Alive" = 80%+ of code bytes match reference

## Experiment 1: Binary Search on Epsilon

Triplicator at varying noise rates, 5M interrupts.

| Epsilon | 500k | 1M | 2M | 5M |
|---------|------|-----|-----|-----|
| 1/16384 | 0 | 0 | 0 | 0 |
| 1/32768 | 0 | 0 | 0 | 0 |
| 1/65536 | 0 | 0 | 0 | 0 |
| 1/131072 | 64 | 64 | 0 | 0 |

## Experiment 2: Faster Repair at Epsilon=1/8192

Multiple bytes repaired per scheduling cycle.

| Repair/sched | Code size | 500k | 1M | 2M | 5M |
|-------------|-----------|------|-----|-----|-----|
| 1 | 51B | 0 | 0 | 0 | 0 |
| 2 | 96B | 0 | 0 | 0 | 0 |
| 4 | 186B | 0 | 0 | 0 | 0 |
| 8 | 366B | 0 | 0 | 0 | 0 |

## Experiment 3: Competition (Triplicator vs Nano-2x at Epsilon=1/32768)

Triplicator at (0,0), nano-2x at (4,4).

| Checkpoint | Triplicator | Nano-2x |
|-----------|-------------|---------|
| 500k | 0/64 | 0/64 |
| 1000k | 0/64 | 0/64 |
| 2000k | 0/64 | 0/64 |
| 5000k | 0/64 | 0/64 |

## Analysis

Total runtime: 3187.2s
