# Tutorial: Mining Coins with Self-Replicating 6502 Programs

Welcome to 6502coin -- where artificial life meets cryptocurrency.

In this tutorial, you will launch a grid of virtual 6502 CPUs, inject a
self-replicating program, watch it spread across the board, and understand
how that computation turns into mineable blocks.

## What is 6502life?

Picture a 256x256 grid. Each cell is its own 6502 CPU with 1KB of memory.
Cells can read and write their neighbors' memory and swap positions with
them. The scheduler randomly picks cells and runs them for a few dozen
cycles before preempting with a timer interrupt.

Programs on this board can copy themselves to neighbors. But the copies are
noisy -- about 1 in 2048 bits gets flipped during a copy. This means the
programs *mutate*. Over time, you get evolution by natural selection: programs
that copy faster and survive more mutations dominate the board.

That ongoing computation is the basis of 6502coin mining. Ticks accumulate
into blocks, blocks produce coins. The more interesting the artificial life
dynamics on your board, the more coins you earn.

## Step 1: Install and Launch the Miner

```bash
# Clone and install
git clone https://github.com/ihh/6502life.git
cd 6502life
npm install
cd app && npm install

# Launch the coin miner (development mode, hot-reloading)
npm run coin:dev
```

This opens a browser tab with the mining dashboard. You should see a dark
grid -- this is your board. It starts empty (all zeros).

## Step 2: Understanding What You See

The colored grid is a bird's-eye view of your board. Each pixel is one cell.

**What the colors mean:**

- **Black** = dead cell, no recent activity. Memory is mostly zeros.
- **Bright warm colors (red, orange, yellow)** = recent write activity.
  Something just modified this cell's memory.
- **Cool colors (blue, green)** = write activity, but further in the past.
  The cell was active a while ago and has been cooling off.
- **Shifting color waves** = a replicator spreading across the board.
  You will see a frontier of bright activity followed by cooling cells behind it.

When a replicator first colonizes a region, you see a bright wave front
expanding outward. Behind the wave, cells settle into a steady hum of
re-copying and mutation.

## Step 3: Inject a Nano-2x Replicator

The nano-2x is the simplest interesting replicator: just 8 bytes of code.
It copies itself to two neighbors (forward and right) on each scheduling.

In the mining dashboard, select **Nano 2x** from the preset dropdown and
click "Inject." Place it anywhere on the board.

**What to watch for:**

1. **The initial burst** -- within seconds, the nano-2x starts copying to
   neighbors. You see a small bright spot appear and grow.

2. **Exponential spread** -- each copy makes more copies. The bright region
   doubles in size every few seconds. This is exponential growth, the same
   dynamic that drives biological populations.

3. **Board saturation** -- eventually the entire board is filled with
   nano-2x descendants. The colors shift from hot (active frontier) to
   cooler (steady-state background replication).

4. **Mutation effects** -- because copies are noisy, some descendants will
   have flipped bits. Most mutations break the program (it stops replicating).
   A few might change its behavior in interesting ways. Over long runs, you
   may see patches of different-colored activity where mutant lineages
   have taken hold.

The nano-2x source code is delightfully tiny:

```asm
@start:
BRK
.byte $F5       ; noisy copy to forward neighbor
BRK
.byte $F6       ; noisy copy to right neighbor
BNE @start      ; loop (branch if not zero)
BEQ @start      ; loop (branch if zero -- catches both cases)
```

That `BNE`/`BEQ` pair at the end is a clever trick: no matter what the CPU
flags are, one of those branches will fire. The program always loops back
to `@start`.

## Step 4: Understanding Coin Mining

The mining loop works like this:

1. **Ticks**: Every time the scheduler runs an interrupt on a cell, that is
   one tick. Your board accumulates ticks continuously.

2. **Blocks**: A fixed number of ticks constitutes a block. When the block
   threshold is reached, the current board state is hashed and a new block
   is emitted.

3. **Coins**: Blocks produce coins. The more blocks your miner produces,
   the more coins you earn.

The key insight is that mining is not proof-of-work in the traditional sense.
It is proof-of-life: the computation that produces coins is an actual
artificial life simulation with evolutionary dynamics. The "work" is running
the 6502 CPUs and watching programs replicate, mutate, and compete.

## Step 5: Try Different Presets

Each preset has a different replication strategy. Try them and compare:

### Nano (6 bytes)
The absolute minimum viable replicator. Copies to one neighbor only.
Spreads slowly but is so small that it is very hard to kill by mutation.
Only 48 bits -- each copy has about a 97.7% chance of being perfect.

### Hardy (10 bytes)
Copies to all four cardinal neighbors (N, E, S, W) on successive schedulings.
Spreads faster than nano but is slightly larger, so more vulnerable to mutation.
Watch for the characteristic diamond-shaped spreading pattern.

### Triplicator (variable)
Maintains three copies of itself and uses majority-vote error correction
to repair mutation damage. This is the "DNA repair enzyme" of the 6502life
world. It spreads more slowly (because it spends cycles on repair) but
survives far longer in mutation-heavy environments.

**What to look for:** inject a triplicator into a board already dominated
by nano-2x. Can the triplicator carve out territory? Or does the faster
but more fragile nano outcompete it?

### Directional Spreader
Copies itself forward, then physically moves forward into the copy.
This creates a spreading wavefront that leaves copies behind.
Watch for long streaks of activity rather than the circular spread
pattern of the BRK-based replicators.

### Resetter
An anti-life weapon. It does not just copy itself -- it actively kills
neighboring cells by zeroing their entry point and resetting their program
counter. Watch it create dead zones (black patches) that slowly expand.

### BRK-Activator
Identical to the nano replicator. Drives the board toward "B state" --
cells whose first byte is 0x00 (BRK opcode). A simple chain reaction
copier.

### Alive-Forcer
The opposite of the resetter. It writes NOP ($EA) to neighbors' first byte,
forcing them into "alive state" (byte[0] != 0). Watch for how it interacts
with BRK-based replicators: it converts their BRK opcodes to NOPs,
effectively sterilizing them.

## Step 6: Competition and Extinction Events

The most interesting dynamics happen when you put two different replicators
on the same board. Try these experiments:

**Experiment 1: Nano-2x vs. Triplicator**
```bash
node cli/bin/inject.js --size 16 --cell 0,0 --asm presets/nano-2x.asm \
  --cell 15,15 --asm presets/triplicator.asm --save /tmp/competition.json
node cli/bin/run.js --state /tmp/competition.json --interrupts 100000 \
  --save /tmp/competition-done.json --quiet
node cli/bin/heatmap.js --state /tmp/competition-done.json --metric entropy
```

Who wins? The fast but fragile nano, or the slow but self-repairing
triplicator?

**Experiment 2: Resetter vs. Nano-2x**
```bash
node cli/bin/inject.js --size 16 --cell 0,0 --asm presets/resetter.asm \
  --cell 15,15 --asm presets/nano-2x.asm --save /tmp/war.json
node cli/bin/run.js --state /tmp/war.json --interrupts 100000 \
  --save /tmp/war-done.json --quiet
node cli/bin/heatmap.js --state /tmp/war-done.json --metric writes
```

The resetter actively destroys programs. Can the nano-2x outrun the
destruction? Look for the boundary between dead zones (black) and
active zones (colored).

## The ALife Angle

What you are watching is not just a screensaver. It is a genuine artificial
life system with all the hallmarks of Darwinian evolution:

- **Replication with variation** -- programs copy themselves, but copies
  have random bit flips (mutations).
- **Selection** -- programs that copy faster, or survive more mutations,
  leave more descendants.
- **Competition** -- board space is finite. One replicator's copies
  overwrite another's.
- **Ecological dynamics** -- predator-prey relationships (resetter vs.
  replicator), competitive exclusion, niche partitioning.

Over long runs, you may observe:

- **Extinction events** -- a dominant replicator suddenly collapses as
  accumulated mutations degrade its population.
- **Speciation** -- mutant lineages that behave differently from the ancestor.
- **Arms races** -- if two programs evolve to compete, they may co-evolve
  counter-strategies.

This is the philosophical core of 6502coin: mining rewards are generated by
genuine artificial life dynamics, not by burning electricity on meaningless
hash puzzles.

## CLI Power User Guide

For headless operation, scripting, and deeper analysis, use the CLI tools:

### Run a simulation
```bash
# Run nano-2x on an 8x8 board for 100,000 interrupts
node cli/bin/run.js --size 8 --asm presets/nano-2x.asm --cell 0,0 \
  --interrupts 100000 --save state.json
```

### Visualize activity
```bash
# Write heatmap -- which cells were written to most recently?
node cli/bin/heatmap.js --state state.json --metric writes

# Entropy heatmap -- which cells have the most random-looking memory?
node cli/bin/heatmap.js --state state.json --metric entropy
```

### Inspect a cell
```bash
# Full hex dump and register state
node cli/bin/inspect.js --state state.json --cell 0,0 --all

# Just registers
node cli/bin/inspect.js --state state.json --cell 3,5 --registers
```

### Disassemble
```bash
# What code is running in cell (2,3)?
node cli/bin/disasm.js --state state.json --cell 2,3 --lines 32

# Diff two cells -- are they still identical copies?
node cli/bin/disasm.js --state state.json --cell 0,0 --cell 1,0 --diff
```

### Replay with event logging
```bash
# Record all writes and moves
node cli/bin/replay.js --state state.json --interrupts 5000 \
  --log events.jsonl --save state2.json

# Track lineage of a specific cell
node cli/bin/replay.js --size 16 --asm presets/nano-2x.asm --cell 0,0 \
  --interrupts 1000 --track 0,0 --log lineage.jsonl
```

### Mean-field model
```bash
# Theoretical prediction of board dynamics (Dead/BRK/Alive states)
node cli/bin/mean-field.js
```

This prints a trajectory showing how the board is expected to evolve over
time according to the mathematical model -- useful for comparing theory
against your simulation results.

### Build a phylogenetic tree
```bash
# From lineage events, build a tree of replicator descent
node cli/bin/phylo.js --log lineage.jsonl --format ascii
node cli/bin/phylo.js --log lineage.jsonl --format newick > tree.nwk
```

### Interactive TUI debugger
```bash
# Full four-pane debugger with disassembler, memory map, and minimap
node cli/bin/terminal.js --size 16 --asm presets/nano-2x.asm --cell 0,0
```

Tab between panes. Type `help` in the command pane for the full command
list. Watch replication happen in real time.

## Advanced Board Parameters

The simulation supports several board-level parameters that change the
physics of the world. You can set them individually or all at once.

### Mutation Rate (Epsilon)

The `--epsilon` flag sets the per-bit noise probability for BRK noisy copy
operations. The default is 1/2048 (~0.000488). Lower values mean more
faithful copies; higher values mean faster mutation.

```bash
# Perfect copies (no mutation) -- replicators spread without degradation
node cli/bin/run.js --size 16 --preset nano-2x --cell 0,0 \
  --epsilon 0 --interrupts 50000 --save /tmp/perfect.json

# High mutation -- rapid Muller's Ratchet degradation
node cli/bin/run.js --size 16 --preset triplicator --cell 0,0 \
  --epsilon 0.01 --interrupts 50000 --save /tmp/noisy.json

# Compare entropy
node cli/bin/heatmap.js --state /tmp/perfect.json --metric entropy
node cli/bin/heatmap.js --state /tmp/noisy.json --metric entropy
```

The `--epsilon` flag works on `run.js`, `replay.js`, and `terminal.js`.

### Board Params (JSON)

The `--board-params` flag accepts a JSON string with any combination of
board hyperparameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pBitNoise` | float | 1/2048 | Per-bit noise on BRK noisy copy |
| `pBrkFailure` | float | 0 | Probability BRK copy/swap silently fails |
| `magnetosensing` | bool | false | Write cell orientation to $FA each interrupt |
| `implementsMove` | bool | true | Enable BRK 1-244 swap operations |
| `implementsCopy` | bool | true | Enable BRK 245-252 noisy copy |
| `implementsSync` | bool | false | Enable BRK 253 sync interrupt request |
| `implementsAsync` | bool | false | Enable BRK 254 async interrupt request |

```bash
# Enable magnetosensing and sync interrupts with zero noise
node cli/bin/run.js --size 16 --preset nano-2x --cell 0,0 \
  --board-params '{"magnetosensing":true,"implementsSync":true,"pBitNoise":0}' \
  --interrupts 50000 --save /tmp/magneto.json

# Disable movement but keep copy -- organisms can spread but not move
node cli/bin/run.js --size 16 --preset spreader --cell 0,0 \
  --board-params '{"implementsMove":false}' \
  --interrupts 50000 --save /tmp/nomove.json
```

Note: if both `--epsilon` and `--board-params` are provided, both are
applied. The `--board-params` value takes precedence if it also sets
`pBitNoise`.

### Magnetosensing

When `magnetosensing` is enabled, the board writes each cell's current
orientation to byte $FA of its zero page before every interrupt. Programs
can read this byte to learn which direction they are facing.

This opens up new replicator strategies: a program can navigate
directionally instead of blindly copying in a random orientation.
Try writing a replicator that reads $FA and decides which neighbor to
copy to based on its orientation.

### Sync and Async Interrupts

When `implementsSync` is enabled, BRK 253 requests a synchronous
interrupt: the current cell will be scheduled again immediately on the
next tick. This lets programs chain multiple operations without being
preempted.

When `implementsAsync` is enabled, BRK 254 requests an asynchronous
interrupt after a short random delay. This lets programs schedule
future work.

These mechanisms enable more sophisticated programs that can coordinate
multi-step operations -- useful for complex self-repair routines or
cooperative multi-cell organisms.

## What Next?

- Try writing your own replicator. Start from the nano template and add
  features: error correction, multi-directional spread, active defense.
- Use the `inject.js` tool to set up tournament brackets between presets.
- Watch the mean-field model predictions and compare them to actual
  simulation outcomes.
- Experiment with board parameters: try magnetosensing, sync interrupts,
  or different mutation rates to see how they change evolutionary dynamics.
- Read `doc/tutorial-tracking-replicators.md` for a deep dive into lineage
  tracking and phylogenetic analysis.

Happy mining.
