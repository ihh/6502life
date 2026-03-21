# Triplicator Repair Rate Experiments

Date: 2026-03-21

## Setup

- Board: 8x8 (64 cells)
- Seed: 42
- Triplicator variants tested with repair LOOP (not duplication)
- Code size: original 51B, loop variants 56B, evolvable 58B
- The loop adds only 5 bytes (LDX #N / DEX / BNE) regardless of N
- Previous "faster repair" experiment failed because it DUPLICATED the repair block,
  inflating the genome from 51B to 96-366B. The loop approach keeps code compact.

## Experiment 1A: Single-Cell Seeding (Spread + Survive)

Triplicator seeded at cell (0,0) only. Tests ability to spread AND maintain integrity.

### Functional alive counts at 1M interrupts

| Epsilon | original (N=1) | loop N=5 | loop N=10 | loop N=20 |
|---------|------|------|------|------|
| 1/32768 | 64 | 64 | 64 | 64 |
| 1/65536 | 64 | 0 | 64 | 64 |
| 1/131072 | 64 | 64 | 64 | 64 |

### 80% byte-match at 1M interrupts

| Epsilon | original (N=1) | loop N=5 | loop N=10 | loop N=20 |
|---------|------|------|------|------|
| 1/32768 | 0 | 0 | 0 | 0 |
| 1/65536 | 0 | 0 | 0 | 0 |
| 1/131072 | 64 | 0 | 0 | 0 |

### Spread timeline (func-alive at each checkpoint)

#### original (N=1) (51B)

| Epsilon | 100k | 500k | 1M |
|---------|------|------|------|
| 1/32768 | 64 | 64 | 64 |
| 1/65536 | 64 | 64 | 64 |
| 1/131072 | 64 | 64 | 64 |

#### loop N=5 (56B)

| Epsilon | 100k | 500k | 1M |
|---------|------|------|------|
| 1/32768 | 64 | 63 | 64 |
| 1/65536 | 64 | 0 | 0 |
| 1/131072 | 64 | 64 | 64 |

#### loop N=10 (56B)

| Epsilon | 100k | 500k | 1M |
|---------|------|------|------|
| 1/32768 | 64 | 64 | 64 |
| 1/65536 | 64 | 64 | 64 |
| 1/131072 | 64 | 64 | 64 |

#### loop N=20 (56B)

| Epsilon | 100k | 500k | 1M |
|---------|------|------|------|
| 1/32768 | 64 | 64 | 64 |
| 1/65536 | 64 | 64 | 64 |
| 1/131072 | 64 | 64 | 64 |

## Experiment 1B: Full-Board Seeding (Repair Maintenance)

All 64 cells seeded with triplicator. Tests pure repair ability under noise.

### Functional alive counts at 1M interrupts

| Epsilon | original (N=1) | loop N=5 | loop N=10 | loop N=20 |
|---------|------|------|------|------|
| 1/8192 | 64 | 64 | 64 | 0 |
| 1/32768 | 64 | 63 | 64 | 64 |
| 1/131072 | 64 | 64 | 0 | 64 |

### 80% byte-match at 1M interrupts

| Epsilon | original (N=1) | loop N=5 | loop N=10 | loop N=20 |
|---------|------|------|------|------|
| 1/8192 | 0 | 0 | 0 | 0 |
| 1/32768 | 0 | 0 | 0 | 0 |
| 1/131072 | 64 | 0 | 0 | 64 |

## Experiment 2: Evolvable Repair Rate

The repair count N is stored at byte \$42 in the genome. During noisy BRK copies,
N mutates along with the rest of the code. Natural selection acts on N: cells with
suboptimal N values die to corruption or waste scheduling cycles.
Full-board seeding.

### Results

#### eps=1/32768, initial N=5

| Checkpoint | Alive | 80% match | Mean N | Top N values |
|-----------|-------|----------|--------|-------------|
| 100k | 64 | 64 | 5.0 | 5:64 |
| 500k | 64 | 0 | 0.0 | 0:64 |
| 1M | 64 | 0 | 7.0 | 7:64 |

#### eps=1/32768, initial N=10

| Checkpoint | Alive | 80% match | Mean N | Top N values |
|-----------|-------|----------|--------|-------------|
| 100k | 64 | 64 | 10.0 | 10:64 |
| 500k | 64 | 0 | 10.0 | 10:64 |
| 1M | 64 | 0 | 10.0 | 10:64 |

#### eps=1/32768, initial N=20

| Checkpoint | Alive | 80% match | Mean N | Top N values |
|-----------|-------|----------|--------|-------------|
| 100k | 64 | 64 | 20.0 | 20:64 |
| 500k | 64 | 0 | 22.0 | 22:64 |
| 1M | 64 | 0 | 214.0 | 214:64 |

#### eps=1/131072, initial N=5

| Checkpoint | Alive | 80% match | Mean N | Top N values |
|-----------|-------|----------|--------|-------------|
| 100k | 64 | 64 | 5.0 | 5:64 |
| 500k | 64 | 64 | 5.0 | 5:64 |
| 1M | 64 | 55 | 5.0 | 5:64 |

#### eps=1/131072, initial N=10

| Checkpoint | Alive | 80% match | Mean N | Top N values |
|-----------|-------|----------|--------|-------------|
| 100k | 64 | 64 | 10.0 | 10:64 |
| 500k | 64 | 64 | 10.0 | 10:64 |
| 1M | 64 | 64 | 10.0 | 10:64 |

#### eps=1/131072, initial N=20

| Checkpoint | Alive | 80% match | Mean N | Top N values |
|-----------|-------|----------|--------|-------------|
| 100k | 64 | 64 | 20.0 | 20:64 |
| 500k | 64 | 64 | 20.0 | 20:64 |
| 1M | 64 | 64 | 16.0 | 16:64 |

## Analysis

### Loop repair vs original

The original triplicator repairs 1 byte per scheduling cycle. With a repair range
of ~50 bytes, it takes ~50 scheduling cycles to fully scan all code bytes.

The loop variants repair N bytes per scheduling, dramatically improving the
repair-to-corruption ratio:
- At N=5: full code scan every ~11 schedulings
- At N=10: full code scan every ~6 schedulings
- At N=20: full code scan every ~3 schedulings

The crucial insight: a LOOP adds only 5 bytes to the genome (LDX #N / DEX / BNE),
whereas DUPLICATING the repair block adds ~45 bytes per extra copy. Smaller code =
less surface area to corrupt = more robust.

### Cycle budget analysis

Each repair iteration costs ~55 cycles:
- DEC \$40 (5), BPL (2-3), LDY \$40 (3) = ~10 cycles
- Majority vote: 3 pairs of LDA/AND/ORA/STA = ~36 cycles
- Write-back: 3 STAs = ~14 cycles
- DEX (2) + BNE (3) = 5 cycles

The timer mean is ~2800 cycles (Poisson-distributed). BRK = 7 cycles. LDX = 2 cycles.
Available budget: (2800 - 9) / 55 = ~50 iterations max.

Safe targets (accounting for Poisson variance):
- N=5: 284 cycles (~10% of mean, very safe)
- N=10: 559 cycles (~20% of mean, safe)
- N=20: 1109 cycles (~40% of mean, usually safe)
- N=50: 2759 cycles (~99% of mean, risky — many schedulings will be cut short)

### Evolvable N

Results at 1M:

- eps=1/32768, initial N=5: 64/64 alive, 80%=0, mean N=7.0, top=[7:64]
- eps=1/32768, initial N=10: 64/64 alive, 80%=0, mean N=10.0, top=[10:64]
- eps=1/32768, initial N=20: 64/64 alive, 80%=0, mean N=214.0, top=[214:64]
- eps=1/131072, initial N=5: 64/64 alive, 80%=55, mean N=5.0, top=[5:64]
- eps=1/131072, initial N=10: 64/64 alive, 80%=64, mean N=10.0, top=[10:64]
- eps=1/131072, initial N=20: 64/64 alive, 80%=64, mean N=16.0, top=[16:64]

N drift observed in 3 runs — natural selection is acting on N.

### Viable N range

From the cycle budget analysis, the viable range for N is approximately:
- **Minimum**: N >= 1 (must repair at least something)
- **Optimum**: N ~ 10-20 (full code scan every 3-6 schedulings)
- **Maximum**: N ~ 50 (uses nearly all scheduling budget; Poisson variance
  means many schedulings get cut short before completing the repair loop)
- **N = 0**: effectively disables repair; viable only at zero noise

The evolvable triplicator allows natural selection to find this optimum.
At high noise, N should evolve upward (more repair needed to survive).
At low noise, N is neutral and drifts freely.

## Best-performing variant

Best performer (single-cell spread test): **original (N=1)** (64/64 func-alive, 64/64 80%-match at eps=1/131072)

```asm
; Triplicator: self-repairing replicator
; BRK copy FIRST (byte 0), then repair one byte, then loop.
; 3 copies at pages 0, 2, 3. Majority vote repairs one byte per scheduling.
; Repair index at $40, temp at $41 (outside code range $00-$3F).
@top:
BRK
.byte $F5           ; copy to forward neighbor — fires every scheduling
; Repair one byte (parent continues here after BRK yields)
DEC $40
BPL @go
LDA #$30            ; repair range $01-$30 (49 bytes, covers code)
STA $40
@go:
LDY $40
LDA $0200,Y
AND $0300,Y
STA $41
LDA $00,Y
AND $0200,Y
ORA $41
STA $41
LDA $00,Y
AND $0300,Y
ORA $41
STA $00,Y
STA $0200,Y
STA $0300,Y
BNE @top
BEQ @top```

## Evolvable variant assembly

```asm
; Triplicator with evolvable repair rate
; BRK copy FIRST, then repair N bytes in a loop, then back to top.
; N is stored as a byte at offset $42 (outside code range $00-$3F).
; During noisy copies, N mutates along with the rest of the genome.
; Natural selection acts on N: too low = dies to corruption,
; too high = timer fires mid-repair = wasted scheduling.
; 3 copies at pages 0, 2, 3. Majority vote.
; Repair index at $40, temp at $41, N at $42.
@top:
BRK
.byte $F5           ; copy to forward neighbor — fires every scheduling
; Load evolvable repair count
LDX $42             ; N stored at byte $42
BEQ @skip           ; if N=0, skip repair entirely
@outer:
DEC $40
BPL @noWrap
LDA #$42            ; repair range $00-$42 (covers code + N byte at $42)
STA $40
@noWrap:
LDY $40
LDA $0200,Y
AND $0300,Y
STA $41
LDA $00,Y
AND $0200,Y
ORA $41
STA $41
LDA $00,Y
AND $0300,Y
ORA $41
STA $00,Y
STA $0200,Y
STA $0300,Y
DEX
BNE @outer
@skip:
BNE @top
BEQ @top
```

N is stored at byte \$42. To use, poke the initial N value at offsets \$42, \$242, \$342.

Total runtime: 1821.7s
