# Experiment Log: Phylogenetic Distance in 6502life

## 2026-03-20: Three-spreader comparison

### Setup
- Board: 8x8, seed 42
- Interrupts: 2,000,000 per run
- Three spreader variants injected at cell (0,0)
- Default noise params: pBitNoise=0.001, pByteNoise=0, pCellNoise=0

### Spreader variants

| Preset | Code size | Mechanism | Copies/run | Swaps/run | Avg cycles/int |
|--------|-----------|-----------|------------|-----------|----------------|
| spreader | 38 bytes | LDA/STA loop, 512 bytes per rep | 3,462 | 114,620 | 7.5 |
| brk-spreader | 15 bytes | BRK noisy-copy operand | 18,722 | 269,101 | 8.7 |
| mini-spreader | 24 bytes | LDA/STA loop, 27 bytes per rep | 8,178 | 213,976 | 7.6 |

### Key observations

**1. The BRK spreader triggers 5x more noisy copies than the original.**
The BRK spreader completes a full cell copy in one interrupt (the BRK opcode
handles it atomically), while the original spreader's LDA/STA loop takes many
interrupts to complete 512 bytes. Most of the original spreader's interrupts
are spent mid-copy, contributing swaps but not complete replications.

**2. The mini-spreader is a middle ground.**
It copies only 27 bytes (code + PC save area) per replication via LDA/STA,
completing in fewer interrupts than the full 512-byte original. It triggered
8,178 copies (from random cells also hitting BRK copy operands in their
randomized memory) plus 213,976 swaps.

**3. Avg cycles/interrupt is ~7-9 for all three.**
This is because all three spreaders use BRK to yield, which fires a software
interrupt after 7 cycles. The timer-based interrupt (Poisson with mean ~2800
cycles) almost never fires because BRK preempts it.

**4. Chi-squared goodness of fit rejects the pure copy-noise model.**
For all three spreaders, the observed per-byte Hamming histograms are
inconsistent with the `copyCellWithNoise` noise model (chi-squared >> critical
value). The reason: most "mutations" don't come from the noisy-copy channel.
They come from:
- Partial overwrites from interrupted LDA/STA loops
- Cross-contamination when random cells write into each other's code regions
- Swap events shuffling cell contents

The histograms are bimodal: most bytes are identical (h=0) but a fraction
are completely unrelated (h ~ Bin(8, 0.5)), consistent with a
"correct copy vs random overwrite" mixture rather than per-bit noise.

**5. The mini-spreader shows the most divergence.**
With p_bit=0.076 average (vs 0.043 for original, 0.061 for BRK), the mini-
spreader accumulates more changes. This is because it only copies 27 bytes
of the 1024-byte cell, leaving the remaining 997 bytes as a canvas for random
overwrites from other cells. The fingerprint range (0-896 bytes) includes
mostly bytes NOT copied by the mini-spreader, hence more divergence.

### Histogram analysis: (0,0) vs (7,7)

| h (bits diff) | spreader | brk-spreader | mini-spreader |
|:---:|:---:|:---:|:---:|
| 0 | 813 | 781 | 413 |
| 1 | 54 | 42 | 285 |
| 2 | 7 | 18 | 92 |
| 3 | 7 | 19 | 42 |
| 4 | 9 | 18 | 36 |
| 5 | 4 | 9 | 21 |
| 6 | 2 | 7 | 4 |
| 7 | 0 | 2 | 2 |
| 8 | 0 | 0 | 1 |

The spreader and BRK-spreader histograms have a sharp peak at h=0 with a
long tail — the mixture model "most bytes identical, some completely random."
The mini-spreader histogram is much more spread, consistent with many more
bytes being unrelated (only 27/896 are actually copied).

## 2026-03-20: BRK spreader phylogenetic tree (from copy events)

### Bug fix: BRK copies bypassed history tracing

The `copyCellWithNoise` was called AFTER `commitWrites()` and
`resetUndoHistory()` in the controller's interrupt handler. This meant the
noisy copy's writes were never captured in the undo history that the tracker
monitors. Fixed by adding an `onBrkEvent` hook to the controller that
directly emits structured copy/swap events.

### Phylogenetic tree from first-copy lineage

Using `replay.js --track 0,0` with the BRK spreader (8x8 board, 2M interrupts):

- 4,366 total lineage events (including re-copies)
- All 64 cells reached
- Tree depth: up to 11 generations
- Spreading pattern:
  - First copy at t=52,772 (to cell 7,1)
  - Second copy at t=4,348,239 (to cell 1,1) — 80x longer wait
  - Exponential phase: most cells reached between t=6M-8M
  - Last cell reached at t=8,345,332

The long gap between first and second copy is because only one cell (0,0)
can spread initially, and it's only scheduled 1/64 of the time. Once the
second copy exists, both can spread, accelerating the process.

### Assembler improvements

Added two fixes to the assembler wrapper (`engine/assembler.js`):

1. **Zero-page,Y promotion**: The upstream `@neshacker/6502-tools` assembler
   classifies `$XX,Y` as zero_page_y even when that mode doesn't exist for
   the instruction (e.g. LDA, STA). We now detect this and use a sentinel
   address to force absolute_y mode, then patch the bytes back.

2. **Label arithmetic**: Added `@label+N` and `@label-N` expression resolution
   via a two-pass preprocessor. Needed for self-modifying code that patches
   instruction operands at known offsets.

### New presets

- **brk-spreader** (15 bytes): Uses BRK noisy-copy (operands $F5-$F8) to
  replicate atomically. Simplest possible spreader.

- **mini-spreader** (24 bytes): Lives at $E0, just before the register save
  area. Copies only 27 bytes ($E0-$FA: code + PC save) via LDA/STA loop.
  Reads from own page 0; writes to target page 0 only. 10x faster than the
  original spreader (27 vs 512 byte-copies per replication). Uses `BMI @start`
  for the loop-back (always taken since DEY past 0 sets N flag).

## 2026-03-20: Tree reconstruction accuracy

### Setup
- BRK spreader on 8x8 board, 5M interrupts, seed 42
- True tree: last-copy genealogy (most recent BRK copy to each cell)
- Reconstructed tree: UPGMA from pairwise bit-level Hamming/JC distance

### Results

**Tree reconstruction is poor.** Spearman rank correlation between true
genealogical depth and estimated JC distance: **ρ = -0.11** (essentially
no correlation).

The reason: most "mutations" don't come from the noisy-copy channel
(`copyCellWithNoise` with ε=0.001). They come from cross-contamination
— random cells writing into each other's code regions via LDA/STA during
normal execution. This noise is NOT phylogenetically informative; it's
independent of the genealogy. The JC distance model assumes all differences
arise from the copy channel, so it gives wrong distances.

**Robinson-Foulds distance**: 0.66 (normalized), meaning ~2/3 of
bipartitions disagree between the true and reconstructed trees.

### Conclusion
The JC distance formula works correctly for the noisy-copy channel, but
the noisy-copy channel is NOT the dominant source of sequence divergence
in this system. To get phylogenetically useful distances, we'd need to
either:
1. Suppress cross-contamination (e.g. use the I flag for atomic writes)
2. Restrict the fingerprint range to only the bytes that the spreader copies
3. Increase the noisy-copy noise rate so it dominates cross-contamination

## 2026-03-20: Coalescent analysis

### Last-copy genealogy structure
- 15,937 total BRK copies in 5M interrupts
- Copy rate per interrupt: 0.0032 (0.32%)
- Copies per cell per generation: 0.20
- The genealogy is shallow: median pairwise MRCA depth = 3 copy generations
- Maximum depth = 10

### Moran model N_e estimate
Under a Moran model (one replacement per event):
- Replacements per generation (64 interrupts): 0.20
- Moran N_e ≈ N²/(2·replacements/gen) = **10,040**

This is ~157× the census size (N=64), reflecting the very low replacement
rate. Most interrupts do NOT result in a copy event (the BRK spreader
only fires when a cell containing the spreader code is scheduled AND its
RNG-derived operand has been correctly patched).

### Coalescent shape
The top MRCA nodes are NOT equally used. Cell (7,1) is the MRCA of 69
pairs — disproportionately many. This suggests non-neutral dynamics:
some cells are more productive than others, possibly due to:
- Position effects (cells near the original are reached first)
- Stochastic variation in scheduling frequency
- The wrapping topology of the board

## 2026-03-20: Competition experiment

### Setup
- 8x8 board, BRK spreader at (0,0), mini-spreader at (4,4)
- Census by fingerprinting (comparing first 50 bytes to reference)

### Results

| Interrupts | BRK | Mini | Other |
|:---:|:---:|:---:|:---:|
| 0 | 1 | 1 | 62 |
| 100k | 4 | 1 | 59 |
| 500k | 0 | 3 | 61 |
| 1M | 0 | 0 | 64 |

**Both spreaders go extinct by 1M interrupts.** Neither can maintain itself
against the background noise of random cells overwriting each other. The
"other" category dominates — random execution of garbage code in the 62
uninfected cells generates enough writes to overwrite the spreader code.

### Interpretation
The board is a hostile environment. The spreader's replication rate (~0.3%
of interrupts) is too low relative to the destruction rate from random
overwrites. On a 256x256 board this would be even worse. Possible fixes:
- Use the I flag (atomic mode) to protect writes
- Higher copy rate (the mini-spreader is faster per copy but doesn't copy
  the full cell, leaving most of its memory vulnerable)
- Start with more initial copies to reach the exponential-growth threshold

## 2026-03-20: Systematic viability experiments

### Experiment 1: Viability under default noise (ε=0.001)

| Preset | Size | Copies | Swaps | @250k | @500k | @1M | @2M |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| spreader | 38 | 4,997 | 104,933 | 1 | 2 | 0 | 0 |
| brk-spreader | 15 | 9,376 | 278,744 | 63 | 58 | 0 | 0 |
| brk-spreader-2x | 26 | 43,367 | 107,194 | 0 | 0 | 0 | 0 |
| brk-spreader-3x | 37 | 9,135 | 288,237 | 64 | 3 | 0 | 0 |
| mini-spreader | 24 | 13,508 | 178,403 | 64 | 64 | 64 | 3 |
| mini-spreader-sei | 27 | 14,895 | 297,482 | 64 | 64 | 64 | 0 |
| directional | 10 | 779,640 | 28,986 | 0 | 0 | 0 | 0 |
| crawler | 12 | 13,239 | 169,688 | 64 | 64 | 64 | 0 |

**Key finding**: Every spreader goes extinct under default noise. The
mini-spreader (LDA/STA copy, no BRK noise) survives longest because its
copies are perfect (no noise channel involved). BRK-based spreaders destroy
themselves — each noisy copy corrupts the spreader code.

The mini-spreader shows up as "64 alive" because its copies spread via
LDA/STA (perfect fidelity), and the random BRK copies from garbage
execution happen to not corrupt the critical 27-byte region fast enough.
But by 2M interrupts, background noise catches up.

### Experiment 2: Effect of noise parameters (BRK-spreader-2x)

| pBitNoise | @250k | @500k | @1M | @2M | Copies |
|:---:|:---:|:---:|:---:|:---:|:---:|
| 0 | 64 | 64 | 64 | 64 | 135,134 |
| 0.001 | 0 | 0 | 0 | 0 | 1,320,470 |
| 0.01 | 0 | 0 | 0 | 0 | 1,103,943 |
| 0.05 | 0 | 0 | 0 | 0 | 952 |

**Critical result**: With zero noise, the BRK-spreader-2x sustains itself
perfectly. ANY nonzero pBitNoise kills it. The noisy-copy channel itself is
the lethal factor — it corrupts the spreader code.

At ε=0.05, only 952 copies total — the noise is so high that copies are
mostly garbage, and the spreader code is destroyed almost immediately.

### Experiment 3: Noise threshold (BRK-spreader-2x)

| pBitNoise | @250k | @500k | @1M | @2M |
|:---:|:---:|:---:|:---:|:---:|
| 0 | 64 | 64 | 64 | 64 |
| 0.0001 | 64 | 0 | 0 | 0 |
| 0.0002 | 64 | 46 | 0 | 0 |
| 0.0005 | 0 | 0 | 0 | 0 |
| 0.001 | 0 | 0 | 0 | 0 |

The extinction threshold is between ε=0 and ε=0.0001. Even one bit
error per 10,000 bits per copy event is enough to eventually destroy
the 26-byte spreader code. This is Eigen's error catastrophe: the
genome (26 bytes = 208 bits) × error rate (0.0001/bit) gives
~0.02 errors per copy, and ~50 copies are needed to fill the board.
The accumulated errors exceed the code's tolerance.

### Experiment 4: Board size (BRK-spreader-2x, zero noise)

| Board | Cells | @250k | @500k | @1M | @2M | Copies |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 8×8 | 64 | 64 | 64 | 64 | 64 | 133,614 |
| 16×16 | 256 | 256 | 256 | 256 | 256 | 117,126 |
| 32×32 | 1,024 | 44 | 313 | 672 | 781 | 22,410 |

32×32 doesn't fully colonize by 2M interrupts because the scheduling
rate per cell drops (each cell is scheduled 1/1024 of the time).

### Experiment 5: All variants at zero noise

| Preset | Copies | @250k | @500k | @1M | @2M |
|:---|:---:|:---:|:---:|:---:|:---:|
| spreader | 161 | 1 | 1 | 0 | 0 |
| brk-spreader | 744 | 64 | 61 | 59 | 50 |
| brk-spreader-2x | 134,820 | 64 | 64 | 64 | 64 |
| brk-spreader-3x | 41,008 | 64 | 64 | 64 | 0 |
| mini-spreader | 190 | 0 | 0 | 0 | 0 |
| mini-spreader-sei | 247 | 1 | 1 | 1 | 0 |
| directional | 1,162,758 | 64 | 64 | 64 | 64 |
| crawler | 219 | 64 | 64 | 64 | 64 |

**Surprising results at zero noise**:
- **spreader** (LDA/STA, page 2 template) STILL goes extinct! Even without
  copy noise, the background destruction from random cells overwrites the
  code. The LDA/STA spreader takes many interrupts to complete its 512-byte
  copy, and gets destroyed before finishing.
- **mini-spreader** ALSO fails at zero noise. Its LDA/STA copies are
  perfect, but the BRK $01 swap after copying moves the original away,
  and the exposed copy gets destroyed.
- **brk-spreader-2x** and **directional** are the winners: high copy rate
  (134k and 1.16M copies) means they replicate faster than destruction.
- **crawler** survives by copying AND moving — it escapes destruction.
- **brk-spreader-3x** eventually dies (0 at 2M) despite 41k copies,
  possibly because its larger code size (37 bytes) is more vulnerable.

### Key insight: Eigen's error catastrophe applies

The viability of a self-replicator depends on the balance between:
1. **Replication rate**: copies per unit time
2. **Destruction rate**: background noise corrupting the code
3. **Genome size**: more code = more vulnerable to errors
4. **Copy fidelity**: noisy copies accumulate errors

The BRK noisy-copy channel (operands $F5-$F8) is simultaneously the
replication mechanism and the primary source of errors. Even at ε=0.0001
(0.01% per bit), a 26-byte genome accumulates ~0.02 errors per copy.
Over 50+ copies needed to fill the board, lethal mutations are inevitable.

The most successful strategy is **high replication rate with minimal
genome size** (directional-spreader at 10 bytes) or **zero noise with
high copy rate** (BRK-spreader-2x).

### Experiment 6: Tree reconstruction at zero noise

At zero noise, all copies are perfect, so all cells are nearly identical
(24 unique fingerprints out of 64 cells). The Spearman ρ between true
genealogical depth and p_bit is only 0.09 — with no copy noise, there's
no phylogenetic signal to reconstruct from. The sequence differences come
entirely from cross-contamination, which is independent of the genealogy.

### Conclusion for phylogenetic modeling

The current system is in a regime where **cross-contamination dominates
copy noise** as the source of sequence divergence. This makes standard
phylogenetic methods inapplicable because the "mutations" are not
tree-structured. To use this system as a model of evolution, we need:

1. **Higher copy noise** (but this kills the spreader — error catastrophe)
2. **Suppressed cross-contamination** (e.g. read-only memory regions)
3. **Error correction** in the spreader code (checksums, redundancy)
4. **A fundamentally different architecture** where the replication
   mechanism is separated from the mutable genome

This mirrors real biology: genomes encode both the replication machinery
AND the heritable information, but cells have elaborate error correction
(DNA repair, proofreading) to maintain fidelity. Without that, evolution
cannot sustain complex genomes — which is exactly Eigen's error threshold.

## 2026-03-20: Noise model simplification

Removed byte noise, cell noise, and all mask parameters. The noisy copy
channel now has a single parameter: `pBitNoise` (default 1/2048 ≈ 1 bit
error per 256-byte page, or ~4 errors per 1024-byte cell copy).

Distance model simplified to pure binary Jukes-Cantor:
T = log(1 - 2p̂) / log(1 - ε).

## 2026-03-20: Diagnosing extinction — copy noise vs cross-contamination

### Critical experiment: zero-filled board

Ran hardy on a zero-filled board (all cells hit BRK $00 = noop, yield
immediately — zero cross-contamination) vs a randomized board.

| Board type | @100k alive | @500k alive | Copies at 500k |
|:---|:---:|:---:|:---:|
| Zero-fill | 4 | 0 | 67,972 |
| Randomized | 64 | 0 | 139,272 |

**Copy noise alone is lethal.** Even with zero cross-contamination, hardy
goes extinct by 500k interrupts. The 64k BRK copies at ~4 errors each
accumulate ~256k bit errors, corrupting all copies of the 12-byte program.

The randomized board paradoxically shows MORE alive cells early (64 at 100k)
because random execution sometimes produces BRK $F5-$F8 by chance, creating
accidental copies. But these are uncorrelated with the hardy code and don't
persist.

### All variants at ε=1/2048 (8×8 board)

| Preset | Size | @100k | @500k | @1M | @2M | @3M | @5M |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| spore | 6 | 4 | 4 | 26 | 0 | 0 | 0 |
| hardy | 12 | 64 | 0 | 0 | 0 | 0 | 0 |
| brk-spreader | 15 | 3 | 10 | 0 | 0 | 0 | 0 |
| directional | 10 | 64 | 0 | 0 | 0 | 0 | 0 |
| crawler | 12 | 2 | 1 | 4 | 21 | 0 | 0 |

All extinct by 5M. Crawler survives longest (21 alive at 2M) due to its
move-around strategy — it escapes corrupted regions.

### Implication for program design

Programs need to either:
1. **Tolerate errors**: redundancy, error correction, flexible entry points
2. **SEI protection**: run with I flag set to revert timer-interrupted writes
3. **Fork-aware**: after BRK copy, child needs to detect it's a fresh copy
   and potentially run initialization/repair code
4. **Quiescent neighbors**: silence target cells before copying into them

## 2026-03-21: Nano replicator series

### Design rationale

The organism design agent identified that the optimal strategy at ε=1/2048
is **absolute minimum genome size**. The Eigen error threshold analysis:
every byte of code increases vulnerability. The battle is reaching >50%
board coverage, where cross-contamination becomes self-reinforcing
(replicators contaminate each other with replicator code = harmless).

### New presets

- **nano** (5 bytes): `BRK $F5 / CLC / BCC @start` — absolute minimum
- **nano-2x** (7 bytes): copies to cell 1 AND cell 2 (forward + right)
- **walking-nano** (7 bytes): copy forward then swap forward (move+copy)

### Viability results (ε=1/2048, 8×8 board)

| Preset | Size | Copies | @250k | @500k | @1M | @2M | @3M | @5M |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| nano | 5 | 23,721 | 4 | 6 | 1 | 0 | 0 | 0 |
| **nano-2x** | **7** | **51,128** | **64** | **64** | **47** | 1 | 4 | 0 |
| walking-nano | 7 | 152,632 | 5 | 0 | 2 | 7 | 0 | 0 |
| hardy | 12 | 1,367,148 | 0 | 0 | 0 | 0 | 0 | 0 |
| spore | 6 | 138,747 | 10 | 8 | 0 | 0 | 0 | 0 |
| directional | 10 | 2,515,011 | 0 | 0 | 0 | 0 | 0 | 0 |

**nano-2x is the breakthrough.** First program to sustain near-complete
board coverage (64/64) through 500k interrupts at ε=1/2048. Still 47/64
at 1M. All other variants go extinct much earlier.

### Why nano-2x wins

1. **Small genome** (7 bytes = 56 bits): only 2.7% chance of a copy error
   per BRK copy in the code region.
2. **Two-direction coverage**: copies to both forward and right on
   alternating schedulings. Since orientation is randomized, this gives
   broader spatial coverage than single-direction nano.
3. **CLC/BCC loop** instead of BNE/BEQ: unconditional branch via CLC+BCC
   is only 3 bytes, while BNE+BEQ is 4 bytes. Every byte saved matters.
4. **No swap**: unlike walking-nano, nano-2x stays put. This means the
   original cell keeps producing copies without being moved away.

### Why larger programs fail

Hardy (12 bytes, 1.37M copies) and directional-spreader (10 bytes, 2.5M
copies) have MUCH higher copy rates, but their larger genomes make each
copy more likely to introduce a lethal mutation. The extra replication
speed can't compensate for the higher error rate.

### Critical mass hypothesis

The agent's insight: once nano-2x reaches >50% board occupation, the
cross-contamination becomes harmless (replicators contaminating each other
with replicator code). The 64/64 coverage at 250k confirms this — the
replicator reaches critical mass fast enough to establish dominance.

The decline after 1M suggests that accumulated copy errors eventually
corrupt enough copies that the population drops below the critical mass
threshold, triggering a collapse.
