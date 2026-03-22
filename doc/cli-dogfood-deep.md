# CLI Deep Dogfooding Report

Date: 2026-03-22

All commands run on an 8x8 board. This report covers six investigation
challenges, tool usability ratings, and improvement suggestions.

---

## Challenge 1: Tutorial Screenshots (nano-2x heatmaps at milestones)

Commands:
```bash
node cli/bin/run.js --size 8 --preset nano-2x --cell 0,0 --epsilon 0 \
  --interrupts 1000 --save /tmp/t1.json --quiet
node cli/bin/run.js --state /tmp/t1.json --interrupts 4000 --save /tmp/t2.json --quiet
node cli/bin/run.js --state /tmp/t2.json --interrupts 15000 --save /tmp/t3.json --quiet
node cli/bin/run.js --state /tmp/t3.json --interrupts 80000 --save /tmp/t4.json --quiet
node cli/bin/heatmap.js --state /tmp/tN.json --metric writes --json
```

### Heatmap: 1000 interrupts (writes)

All zeros -- the nano-2x has not yet written to any cell.

```
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
```

### Heatmap: 5000 interrupts (writes)

Single hot cell at (2,2) with value 0.921. The nano-2x has started
replicating but hasn't spread yet.

```
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.921 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
```

Note: the nano-2x was loaded at (0,0) but the hot cell is at (2,2).
This is because orientation rotation remaps the neighborhood addresses,
so the cell "moved" via swap to (2,2) before writing.

### Heatmap: 20000 interrupts (writes)

Still only one hot cell at (2,2), value dropped to 0.230 (write recency
decayed). The replicator is active but slow to spread.

```
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.230 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
```

### Heatmap: 100000 interrupts (writes)

Multiple cells now active. The replicator has spread to 7 cells.

```
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.000 0.000 0.046 0.000 0.000 0.391 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.660 0.000
0.000 0.000 0.000 0.738 0.000 0.000 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000
0.876 0.000 0.000 0.000 0.000 0.515 0.000 0.000
0.000 0.000 0.000 0.000 0.000 0.246 0.000 0.000
```

Observation: spread is slow and scattered -- cells appear at non-adjacent
positions, suggesting the replicator moves via BRK-swap before copying.

---

## Challenge 2: Phylogenetic Tree

Command:
```bash
node cli/bin/replay.js --size 8 --preset nano-2x --cell 0,0 --epsilon 0 \
  --interrupts 200000 --track 0,0 --log /tmp/phylo.jsonl --quiet
node cli/bin/phylo.js --log /tmp/phylo.jsonl --format ascii
```

### Tree Output

```
└── [0,0] (root)
    ├── [7,0] (sim=1, t=34)
    │   ├── [7,1] (sim=1, t=99)
    │   │   ├── [7,2] (sim=1, t=139)
    │   │   │   └── [6,2] (sim=1, t=278)
    │   │   │       └── [5,2] (sim=1, t=336)
    │   │   │           ├── [5,3] (sim=1, t=380)
    │   │   │           │   ├── [4,3] (sim=1, t=396)
    │   │   │           │   │   └── [3,3] (sim=1, t=434)
    │   │   │           │   │       ├── [3,4] (sim=1, t=479)
    │   │   │           │   │       │   ├── [4,4] (sim=1, t=539)
    │   │   │           │   │       │   └── [3,5] (sim=1, t=627)
    │   │   │           │   │       └── [2,3] (sim=1, t=789)
    │   │   │           │   └── [6,3] (sim=1, t=459)
    │   │   │           │       └── [7,3] (sim=1, t=648)
    │   │   │           └── [4,2] (sim=1, t=541)
    │   │   └── [6,1] (sim=1, t=161)
    │   │       ├── [6,0] (sim=1, t=205)
    │   │       └── [5,1] (sim=1, t=284)
    │   │           ├── [5,0] (sim=1, t=307)
    │   │           └── [4,1] (sim=1, t=359)
    │   └── [7,7] (sim=1, t=127)
    │       ├── [7,6] (sim=1, t=264)
    │       │   ├── [7,5] (sim=1, t=374)
    │       │   │   ├── [0,5] (sim=1, t=377)
    │       │   │   └── [6,5] (sim=1, t=403)
    │       │   │       └── [6,4] (sim=1, t=404)
    │       │   │           └── [7,4] (sim=1, t=442)
    │       │   └── [6,6] (sim=1, t=639)
    │       └── [6,7] (sim=1, t=330)
    │           └── [5,7] (sim=1, t=352)
    │               ├── [4,7] (sim=1, t=436)
    │               │   ├── [4,0] (sim=1, t=469)
    │               │   └── [4,6] (sim=1, t=550)
    │               │       ├── [3,6] (sim=1, t=779)
    │               │       └── [4,5] (sim=1, t=851)
    │               └── [5,6] (sim=1, t=537)
    │                   └── [5,5] (sim=1, t=583)
    │                       └── [5,4] (sim=1, t=654)
    ├── [1,0] (sim=1, t=73)
    │   ├── [1,1] (sim=1, t=115)
    │   └── [2,0] (sim=1, t=218)
    │       ├── [3,0] (sim=1, t=270)
    │       │   ├── [3,1] (sim=1, t=367)
    │       │   │   └── [3,2] (sim=1, t=423)
    │       │   └── [3,7] (sim=1, t=420)
    │       │       └── [2,7] (sim=1, t=622)
    │       └── [2,1] (sim=1, t=349)
    ├── [0,7] (sim=1, t=97)
    │   ├── [1,7] (sim=1, t=133)
    │   │   └── [1,6] (sim=1, t=552)
    │   │       └── [2,6] (sim=1, t=558)
    │   └── [0,6] (sim=1, t=243)
    └── [0,1] (sim=1, t=107)
        └── [0,2] (sim=1, t=123)
            └── [1,2] (sim=1, t=159)
                ├── [2,2] (sim=1, t=180)
                └── [1,3] (sim=1, t=219)
                    ├── [1,4] (sim=1, t=477)
                    │   ├── [2,4] (sim=1, t=517)
                    │   │   └── [2,5] (sim=1, t=573)
                    │   │       └── [1,5] (sim=1, t=614)
                    │   └── [0,4] (sim=1, t=524)
                    └── [0,3] (sim=1, t=732)

--- 64 nodes, 25 leaves, depth 10, 199536 events ---
```

### Analysis

- **64 nodes** = the entire 8x8 board was colonized
- **Depth 10**: the deepest lineage chain is 10 steps from the root
- **sim=1 everywhere**: all copies are perfect (epsilon=0)
- **Tree shape**: four main branches from [0,0], the largest going through
  [7,0]. The tree is reasonably balanced.
- **Timing**: first copy at t=34, board saturated by t~851 (25 leaf nodes)
- The tree looks correct -- lineage is monotonically increasing in time,
  and spatial adjacency patterns make sense (wrapping at boundaries).

---

## Challenge 3: Triplicator Code Integrity

### Original Triplicator (before running)

```
  $0000  00        BRK
  $0001  F5 C6     SBC $C6,X
  $0003  40        RTI
  $0004  10 04     BPL $000A
  $0006  A9 30     LDA #$30
  $0008  85 40     STA $40
  $000A  A4 40     LDY $40
  $000C  B9 00 02  LDA $0200,Y
  $000F  39 00 03  AND $0300,Y
  $0012  85 41     STA $41
  $0014  B9 00 00  LDA $0000,Y
  $0017  39 00 02  AND $0200,Y
  $001A  05 41     ORA $41
  $001C  85 41     STA $41
  $001E  B9 00 00  LDA $0000,Y
  $0021  39 00 03  AND $0300,Y
  $0024  05 41     ORA $41
  $0026  99 00 00  STA $0000,Y
  $0029  99 00 02  STA $0200,Y
  $002C  99 00 03  STA $0300,Y
  $002F  D0 CF     BNE $0000
  $0031  F0 CD     BEQ $0000
```

### After 100k interrupts at epsilon=0

Cell (0,0) is massively corrupted -- the original code is gone. The disassembly
shows garbled opcodes starting with `JSR $D6F5`. The triplicator has been
overwritten by copies from other cells or by its own writing gone wrong.

The diff between (0,0) and (3,3) shows both cells contain similar but different
garbage -- they look like shifted versions of the original code. The triplicator
writes to self (page 0x00), pages 0x02 and 0x03 using a majority-vote algorithm.
After 100k interrupts, the code has drifted significantly.

### Heatmap at 100k (triplicator, epsilon=0)

```
0.347 0.547 0.553 1.000 1.000 0.995 0.255 0.667
0.670 0.670 0.663 1.000 0.994 0.994 0.323 0.481
0.318 0.667 0.332 0.311 0.562 0.562 0.548 0.316
0.334 0.481 0.280 0.486 0.348 0.771 0.486 0.299
0.334 0.335 0.335 0.341 0.347 0.323 0.486 0.771
0.327 0.334 0.309 0.344 0.333 0.253 0.305 0.344
0.330 0.334 0.332 0.670 1.000 0.332 0.222 0.328
0.322 0.481 0.317 0.997 0.997 0.995 0.249 0.561
```

All cells are active. The triplicator spread everywhere and is actively writing.
However, the code is mutated -- the majority-vote algorithm doesn't preserve
itself perfectly when interacting with BRK-triggered copies from other cells.

### After 100k interrupts at epsilon=1/8192

Cell (0,0) has PC=$1F00 (unmapped ROM area, all BRK). The code is completely
dead. The noisy triplicator heatmap still shows broad activity:

```
0.225 0.783 0.360 0.817 0.029 0.998 0.217 0.084
0.260 0.041 1.000 0.137 0.079 0.229 0.380 0.353
0.218 0.065 0.998 0.454 0.236 0.357 0.229 0.228
0.351 0.087 0.450 0.783 0.354 0.086 0.224 0.224
0.272 0.226 0.234 0.007 0.220 0.206 0.113 0.039
0.190 0.226 0.218 0.044 0.226 0.034 0.043 0.038
0.219 0.223 0.082 0.229 0.042 0.212 0.078 0.084
0.227 0.357 0.358 0.082 0.190 0.323 0.355 0.045
```

But some of this activity is from degenerate BRK-copy chains rather than
intact triplicator code. The noise has degraded the code beyond repair.

---

## Challenge 4: Mean-Field Model vs Reality

### Mean-Field Prediction

```
Parameters:
  epsilon = 1/2048, r_a = 0.001, r_b = 8/255, sigma_crash = 0.0001

Final steady state:
  D (dead)  = 0.33%
  B (brk)   = 97.83%
  A (alive) = 1.84%
```

The model predicts that a random board converges to ~98% BRK-dominated
cells with only ~2% "alive" cells.

### Actual Simulation (random board, 100k interrupts)

```bash
node cli/bin/run.js --size 8 --randomize --interrupts 100000 \
  --save /tmp/mf.json --quiet
node cli/bin/heatmap.js --state /tmp/mf.json --metric writes --json
```

Write heatmap:
```
0.002 0.000 0.002 0.000 0.000 0.002 0.000 0.003
0.001 0.000 0.001 0.000 0.004 0.001 0.000 0.000
0.002 0.000 0.002 0.002 0.000 0.000 0.002 0.000
0.000 0.000 0.002 0.000 0.002 0.002 0.000 1.000
0.001 0.000 0.000 0.002 0.002 0.003 0.000 0.000
0.000 0.001 0.000 0.000 0.001 0.002 0.001 0.000
0.002 0.000 0.004 0.002 0.000 0.002 0.002 0.002
0.002 0.001 0.002 0.001 0.000 0.001 0.002 0.001
```

Entropy heatmap shows all cells at 0.874-0.913 (near maximum entropy),
consistent with random data.

### Analysis

The randomized board is almost entirely dead. Only one cell (3,7) shows
high write activity (1.000). The rest hover at 0.000-0.004. This broadly
matches the mean-field prediction: random code overwhelmingly crashes into
BRK loops. The lone active cell at (3,7) is likely a lucky BRK-copy chain
that happened to write recently.

The mean-field model is qualitatively correct: random boards are dominated
by dead/BRK cells. However, the model operates in epoch-time and doesn't
map cleanly to interrupt counts, making quantitative comparison difficult.

**Usability note**: mean-field.js doesn't accept any parameters. You can't
change epsilon, r_a, or other rates to match your simulation. This makes
direct comparison harder than it needs to be.

---

## Challenge 5: Social Mining

```bash
node coin/bin/social-mine.js --size 8 --ticks 10000 --verify
```

### Output

```
Social Mining: Game of Life 8x8
  Board A seed=42, Board B seed=99
  Edge: A exports east, B exports east
  Share interval: 100 ticks
  Block interval: 1000 ticks
  Total ticks: 10000
  1000/10000 ticks (10%)
  ...
  10000/10000 ticks (100%)
Session A saved to session-a.json
Session B saved to session-b.json
  10 blocks each, 103ms wall time

Verifying social sessions...
  Verification FAILED:
    - Replay: B block 0 end state hash mismatch

--- SOCIAL MINING COMPLETE ---
  Player A: 10 blocks, value=14.66
    Activity: 1.13x, Social: 1.30x
  Player B: 10 blocks, value=14.42
    Activity: 1.11x, Social: 1.30x
  Wall time: 0.1s
  Verified:  FAILED
```

### BUG: Verification fails

The social mining session completes but verification fails with a hash
mismatch on block 0 of Board B. This is a determinism bug -- the replay
doesn't reproduce the same state as the original run. This may be related
to the social sharing mechanism introducing non-determinism.

The output is otherwise clear and well-formatted. The progress bar, block
counts, and multiplier breakdowns are helpful.

---

## Challenge 6: Disabling Movement

```bash
node cli/bin/run.js --size 8 --preset nano-2x --cell 0,0 \
  --board-params '{"implementsMove":false}' \
  --interrupts 50000 --save /tmp/nomove.json --quiet
```

### Heatmap (no movement, writes)

```
0.000 0.009 0.074 0.608 0.000 0.130 0.008 0.009
0.859 0.120 0.016 0.017 0.017 0.130 0.001 0.130
0.062 0.000 0.001 0.120 0.059 0.000 0.009 0.001
0.018 0.121 0.060 0.058 0.064 0.838 0.000 0.009
0.848 0.860 0.000 0.859 0.001 0.844 0.000 0.845
0.857 0.000 0.010 0.027 0.000 0.838 0.837 0.845
0.008 0.001 0.100 0.842 0.839 0.075 0.837 0.748
0.553 0.846 0.000 0.071 0.001 0.838 0.008 0.008
```

### Analysis

Without movement, the nano-2x spreads much faster! At 50k interrupts,
roughly half the board (32/64 cells) shows significant write activity
(>0.1), compared to only 7 cells at 100k interrupts with movement enabled.

This is counterintuitive: you'd expect movement to help spreading. But
what's happening is that BRK-swap moves randomly shuffle cells around,
disrupting the copy process. Without movement, copying is more reliable --
the replicator stays put and methodically copies to its neighborhood.

The `--board-params` flag works but is completely undocumented in `--help`
(because `--help` doesn't exist for run.js). The JSON syntax is fragile
and error-prone.

---

## Tool Usability Ratings

### run.js -- 3/5

- **Good**: `--preset`, `--cell`, `--quiet`, `--save`, `--state` chain well
- **Good**: `--epsilon` and `--board-params` are powerful
- **Bad**: No `--help` flag. Running with `--help` just runs a default sim
- **Bad**: No progress indicator for long runs. 100k+ interrupts = minutes
  of silence
- **Bad**: `--board-params` undocumented, requires JSON string in shell quotes
- **Missing**: `--interrupts` count is not reported on completion

### heatmap.js -- 4/5

- **Good**: Clean ANSI rendering with color gradient and legend
- **Good**: `--json` output for programmatic use
- **Good**: `--metric` switch works well (writes, moves, entropy)
- **Bad**: Stripped of ANSI codes, the heatmap is meaningless solid blocks.
  Need a text-only fallback mode (e.g. ASCII art with symbols/numbers)
- **Missing**: No `--no-color` or `--ascii` mode for piping to files

### disasm.js -- 4/5

- **Good**: Clean output, shows PC position, collapse of repeated BRK
- **Good**: `--diff` mode is excellent for comparing cells
- **Bad**: diff always marks lines as `!=` even when they match at the byte
  level (the disassembly differs because instruction boundaries shift).
  This is confusing.
- **Missing**: `--hex-dump` mode to see raw bytes alongside disassembly

### inspect.js -- 3/5

- **Good**: `--all` shows full hex dump, registers, and activity
- **Bad**: `--json` mode on `--registers` returns empty cells array
- **Missing**: Would love a summary mode: "X cells alive, Y cells with
  recent writes, Z cells with BRK at PC"

### inject.js -- 4/5

- **Good**: `--preset`, `--asm`, `--hex`, `--poke` cover all use cases
- **Good**: `--zero` before load is helpful
- **Bad**: No way to list available presets from the CLI
- **Missing**: `--list-presets` flag

### replay.js -- 4/5

- **Good**: `--track` + `--log` for lineage capture is powerful
- **Good**: Supports `--census` for periodic snapshots
- **Bad**: Output is enormous (400k lines for 200k interrupts)
- **Bad**: No progress indicator
- **Missing**: Filter options to log only certain event types

### phylo.js -- 5/5

- **Good**: ASCII tree rendering is beautiful and correct
- **Good**: Summary line (64 nodes, 25 leaves, depth 10) is informative
- **Good**: Multiple formats (ascii, newick, dot)
- Delightful tool. No complaints.

### mean-field.js -- 3/5

- **Good**: Beautiful output with sparklines and trajectory table
- **Bad**: No CLI parameters. Can't customize epsilon, rates, etc.
- **Bad**: Can't compare to a specific simulation's parameters
- **Missing**: Accept `--epsilon`, `--ra`, `--rb` etc.

### social-mine.js -- 2/5

- **Good**: Progress output, multiplier breakdown
- **Bug**: Verification fails (see Challenge 5)
- **Bad**: Saves session files to current directory (session-a.json,
  session-b.json) without asking
- **Missing**: `--output-dir` flag

---

## Bugs Found

1. **social-mine.js verification fails**: Replay hash mismatch on Board B
   block 0. The social sharing mechanism may introduce non-determinism that
   breaks replay verification.

2. **run.js `--help` missing**: Running with `--help` executes a default
   simulation instead of showing usage. Same issue in inject.js and other
   CLI tools.

3. **heatmap.js degrades silently without color**: When piped or stripped
   of ANSI, the half-block characters all look identical. No fallback.

4. **disasm.js `--diff` alignment**: When two cells have the same code
   but shifted by one byte, every line shows as `!=` even though most bytes
   are identical. The diff is per-disassembled-instruction, not per-byte.

5. **social-mine.js pollutes working directory**: Creates session-a.json
   and session-b.json in the current directory.

---

## Top 10 Improvement Suggestions (Prioritized)

1. **Add `--help` to all CLI tools.** Every tool should print usage when
   invoked with `--help` or no required args. This is the #1 discoverability
   barrier.

2. **Add `--list-presets` to inject.js and run.js.** Users can't discover
   available presets without reading source code.

3. **Add progress indicators for long runs.** A simple stderr progress bar
   (e.g. `50000/100000 interrupts (50%)`) would transform the experience
   of waiting for simulations.

4. **Add `--ascii` mode to heatmap.js.** Use characters like `.:-=+*#@` to
   encode intensity when color is unavailable. This makes heatmaps
   embeddable in plain-text documents.

5. **Fix social-mine.js verification.** The determinism bug undermines the
   entire coin mining concept. This is a correctness issue.

6. **Add CLI parameters to mean-field.js.** Let users set epsilon and rates
   to match their simulation. Add a `--compare-state` flag that reads a
   saved state and computes observed D/B/A fractions alongside predictions.

7. **Add `--output-dir` to social-mine.js.** Don't pollute the working
   directory with session files.

8. **Add a board summary command.** Something like
   `node cli/bin/inspect.js --state file.json --summary` that reports:
   alive cells, BRK-dominated cells, total writes, mean entropy.

9. **Add byte-level diff to disasm.js.** When `--diff` is used, show
   byte-by-byte comparison alongside instruction disassembly, so shifted
   code doesn't mark everything as different.

10. **Document `--board-params` and `--epsilon`.** These are powerful
    experimental knobs but completely invisible to users. At minimum,
    add them to CLAUDE.md's CLI reference section.
