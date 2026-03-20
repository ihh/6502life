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

### Next steps
- Try the I flag for atomic replication
- Investigate the background destruction rate quantitatively
- Larger board experiments
- Try restricting the JC distance to only the copied bytes and re-evaluate
  tree accuracy
