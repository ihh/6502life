# 6502life

A virtual 256x256 grid of interconnected 6502 CPUs simulating cellular automata.

## Repo Structure

- `board/` — Core engine: memory management, CPU controller, visualizer
- `engine/` — Shared engine layer (board.js, assembler.js, format.js) used by both CLI and web app
- `app/` — React+Vite web dashboard for running and inspecting the board
- `cli/` — Command-line tools for assembling, running, inspecting, and visualizing the board
- `6502life-test-app/` — Legacy prototype UI (broken, superseded by `app/`)
- `tex/` — LaTeX documentation (run `make` in tex/ to build PDF)
- `doc/` — Built PDFs and tutorials

## How to Run

```bash
npm install
cd app && npm install && npm run dev
```

## How to Test

```bash
npm test
```

## CLI Tools

All CLI tools are zero-dependency Node.js ESM scripts sharing the `engine/` layer with the web app.

### Assembler
```bash
# Assemble source file to hex
node cli/bin/assemble.js source.asm

# From stdin
echo 'NOP' | node cli/bin/assemble.js

# Output formats: hex (default), bin, json
node cli/bin/assemble.js -f bin -o output.bin source.asm
```

### Run Simulation
```bash
# Run with defaults (8x8 board, seed 42, 1000 scheduler cycles)
node cli/bin/run.js

# Load assembly into cell and run
node cli/bin/run.js --asm counter.asm --cell 0,0 --cycles 5000

# Run by interrupt count, JSON output
node cli/bin/run.js --seed 42 --size 16 --interrupts 100 --json

# Load a preset by name
node cli/bin/run.js --preset nano-2x --cell 0,0 --interrupts 10000

# Set mutation rate (epsilon = per-bit noise probability)
node cli/bin/run.js --preset nano-2x --cell 0,0 --epsilon 0 --interrupts 10000

# Set any board params via JSON
node cli/bin/run.js --preset nano-2x --cell 0,0 \
  --board-params '{"hasCompass":true,"pBitNoise":0}' --interrupts 10000

# Save/load state
node cli/bin/run.js --randomize --save state.json
node cli/bin/run.js --state state.json --cycles 1000
```

### Inspect State
```bash
node cli/bin/inspect.js --state state.json --cell 3,5 --all
node cli/bin/inspect.js --state state.json --registers --json
```

### Interactive TUI (simple)
```bash
node cli/bin/tui.js --size 16 --randomize
node cli/bin/tui.js --asm program.asm --cell 0,0

# Controls: arrows=move, space=step, r=run, p=pause, 1-9=speed, +/-=zoom, q=quit
```

### Terminal Debugger (full)
```bash
node cli/bin/terminal.js --size 16 --randomize
node cli/bin/terminal.js --asm program.asm --cell 0,0
node cli/bin/terminal.js --preset counter --cell 0,0

# With probe socket for external CLI tools:
node cli/bin/terminal.js --size 16 --preset copier --cell 0,0 --listen

# Four-pane layout: memory map, disassembler, command prompt, board minimap
# Tab to switch focus between panes
# Type "help" in the command pane for debugger commands
# Presets: counter, nop, copier, overwriter, tumbler, spreader, painter, knight, crawler
```

### CLI Probe (connects to running debugger)
```bash
# Requires terminal.js running with --listen
node cli/bin/probe.js status                    # board status
node cli/bin/probe.js fingerprint 0,0           # MinHash cell fingerprint
node cli/bin/probe.js scan                      # board-wide fingerprint table
node cli/bin/probe.js diff 0,0 1,0              # byte-level diff
node cli/bin/probe.js tag 0,0 origin            # tag a cell
node cli/bin/probe.js track 0,0                 # stream lineage events
node cli/bin/probe.js census --interval 500     # periodic census stream
node cli/bin/probe.js subscribe writes          # raw write event stream
```

### Disassembler
```bash
# From state file
node cli/bin/disasm.js --state state.json --cell 0,0 --lines 32

# From hex
node cli/bin/disasm.js --hex "A9 01 8D 10 00"

# Diff two cells
node cli/bin/disasm.js --state state.json --cell 0,0 --cell 1,0 --diff
```

### Replay (deterministic, with event logging)
```bash
# Run 5000 interrupts, log all events
node cli/bin/replay.js --state snap.json --interrupts 5000 --log events.jsonl --save snap2.json

# Track a cell during replay
node cli/bin/replay.js --size 16 --asm copier.asm --cell 0,0 --interrupts 1000 --track 0,0 --log lineage.jsonl

# Use a preset (same as run.js)
node cli/bin/replay.js --size 16 --preset nano-2x --cell 0,0 --interrupts 1000 --log events.jsonl

# With epsilon and board params
node cli/bin/replay.js --size 16 --preset nano-2x --cell 0,0 --epsilon 0 --interrupts 1000 --log events.jsonl
node cli/bin/replay.js --state snap.json --board-params '{"hasCompass":true}' --interrupts 500 --log events.jsonl

# Periodic census during replay
node cli/bin/replay.js --state snap.json --interrupts 500 --census 100 --log census.jsonl
```

### Inject (patch cells in saved state)
```bash
# Load preset into cell
node cli/bin/inject.js --state board.json --preset spreader --cell 4,4 --save board.json

# Multiple injections
node cli/bin/inject.js --size 16 --randomize --cell 0,0 --asm a.asm --cell 15,15 --preset copier --save board.json

# Poke individual bytes
node cli/bin/inject.js --state board.json --cell 3,3 --poke F0=40 --save board.json
```

### Heatmap (terminal-rendered)
```bash
node cli/bin/heatmap.js --state state.json --metric writes
node cli/bin/heatmap.js --state state.json --metric entropy
node cli/bin/heatmap.js --state state.json --metric moves --json
```

### Phylo (tree from lineage log)
```bash
# ASCII tree
node cli/bin/phylo.js --log lineage.jsonl --format ascii

# Newick format (for phylogenetic tools)
node cli/bin/phylo.js --log lineage.jsonl --format newick > tree.nwk

# DOT format (for Graphviz)
node cli/bin/phylo.js --log lineage.jsonl --format dot | dot -Tsvg > tree.svg
```

### Tutorial
See `doc/tutorial-tracking-replicators.md` for a walkthrough of writing,
loading, and tracking self-replicating programs.

## Key Architecture

### `board/memory.js` — BoardMemory
Manages the 256x256 grid storage (64MB total). Each cell has 1024 bytes (4 pages).
Provides randomly translated and rotated memory-mapped access to a 7x7 neighborhood (49 cells).

### `board/controller.js` — BoardController
Orchestrates CPU execution using the Sfotty 6502 emulator. Runs single-threaded with
preemptive Poisson-distributed interrupts. Tracks write/move times for visualization.

The Sfotty CPU interface: `sfotty.run()` executes one instruction, `sfotty.cycleCounter`
gives the cycle count. CPU registers: A, X, Y, S, P, PC.

### `board/visualizer.js` — BoardVisualizer
Generates pixel buffers for overview (1 pixel/cell) and detail (32x32 pixels/cell) views.
Colors encode cell activity using HSV with exponential decay of write/move recency.

## Memory Map Summary

| Address Range | Usage |
|---------------|-------|
| 0x0000-0xBFFF | RAM: 49-cell neighborhood (7x7), 1024 bytes each |
| 0xE000-0xEE3F | ROM: Lookup tables for vector/rotation operations |

## Cell Memory Layout (within each 1024-byte cell)

| Offset | Usage |
|--------|-------|
| 0x000 | Default entry point |
| 0x000-0x0EF | Zero page: code or data |
| 0x0F0-0x0F8 | Oriented registers (auto-rotated by memory mapper) |
| 0x0F9-0x0FF | CPU register save area + RNG (0xF9 is also auto-rotated) |
| 0x100-0x1FF | Stack |
| 0x200-0x37F | Code or data |
| 0x3C0-0x3DF | 16x16 monochrome bitmap (1 bit/pixel, 32 bytes) |
| 0x3E0-0x3FB | ASCII display name (28 bytes) |
| 0x3FC-0x3FE | Reserved |
| 0x3FF | Hue byte (0-255 → 0-360° HSV) |

## Conventions

- **Oriented registers** at 0xF0-0xF8: top 6 bits are rotated with the orientation. 0xF9 (PCHI) is also auto-rotated but is controller-reserved.
- **Register save area** at 0xF9-0xFF: PCHI, PCLO, P, A, X, Y, S
- **RNG** at 0xFC-0xFF: 4 bytes of pseudorandom numbers, refreshed each interrupt
- **Compass**: if enabled (`boardParams.hasCompass`), the scheduler writes the current orientation to $FA (shifted left 2 bits). Programs can read $FA to detect their absolute orientation. Disabled by default (writes 0).
- **Board hyperparameters** (`boardParams`): scalar params `pBitNoise` (default 1/2048), `pBitNoiseZero` (default 0.5, P(resampled bit=0)), `nSwapCycles` (default 0, minimum remaining scheduler cycles for BRK copy/swap to succeed), `hasCompass` (default false). The `brkOps` registry (see below) controls which BRK operands are enabled.
- **BRK operand registry** (`boardParams.brkOps`): maps operation names to `{ range: [lo, hi], enabled: bool }`. The code-side `BRK_OP_REGISTRY` adds cycle costs, address encoding, and handler functions. A 256-entry dispatch table is built at construction time for O(1) lookup. Default entries:
  - `reset`: range [0, 0], enabled=true, 12 cycles. Reset PC to 0, yield.
  - `swap`: range [1, 48], enabled=true, 49 cycles. Swap cell 0 with cell b. O(1) via page-table remap.
  - `copy`: range [49, 96], enabled=true, 14400 cycles. Noisy copy cell 0 to cell (b-48). O(M) through noise gate.
  - `sync`: range [97, 97], enabled=false, 24 cycles. Sync interrupt request; X,Y = period in cycles.
  - `async`: range [98, 98], enabled=false, 24 cycles. Async interrupt request; X,Y = delay in cycles.
  - Operands 99-255 are unassigned (yield). Board owners can extend the registry with custom operations in this range.
  Bad opcodes handled as BRK 0. Copy/swap happens BEFORE registers are saved, so the child inherits the pre-BRK register state. Legacy `implementsMove`/`implementsCopy`/`implementsSync`/`implementsAsync` flags are accepted on construction and in serialized state for backward compatibility.
- **Interrupt model**: Pre-emptive scheduling is conceptually an IRQ (maskable by SEI) followed by an NMI (unmaskable context switch). Memory writeback happens between the IRQ and NMI if the I flag allows it. Setting I (SEI) makes writes atomic: they commit only on BRK (software interrupt), and are reverted on timer interrupt.
- **B flag** (bit 4 of P at $FB): set after BRK (software interrupt), cleared after timer interrupt. Follows 6502 convention (BRK/PHP set B; IRQ/NMI clear B). Enables fork detection: after BRK copy, the child inherits B=clear (pre-BRK state), while the parent gets B=set. Programs can read $FB and test bit 4 to detect whether they are a fresh copy or the original.
## Visualization Conventions (not part of VM spec)

The VM does not read or interpret these bytes — programs can use them for anything.
But viewers, debuggers, and phone UIs may render cells based on this layout:

- **Hue byte** at 0x3FF: 1 byte, 0-255 mapped to 0-360° HSV hue. Nonzero hue is
  rendered at full saturation with brightness scaled by recent activity. Zero falls
  back to default activity-based heat coloring.
- **Monochrome bitmap** at 0x3C0-0x3DF: 16x16 pixel bitmap (1 bit/pixel, 32 bytes).
  Provides shape; the hue byte provides color. Available for cell inspector panels.
- **Display name** at 0x3E0-0x3FB: 28 bytes of ASCII. Parsed by the web app as
  `[cssColor]:[iconifyIconName]` (e.g. `orange:bee`, `red:sword`). If no colon present,
  the name is treated as an Iconify icon in the `game-icons` set.
- **Phone PWA**: uses hue byte for cell color when present, falling back to overview
  color (HSV from write/move recency).
- **SokoScript**: compiled programs should write their cell type name to 0x3E0, set
  a hue byte, and optionally render state as a bitmap.
- **CLI heatmap**: uses activity data (lastWriteTime/lastMoveTime), not the bitmap.
- **TUI debugger**: shows hex dump, disassembly, and activity colors.

## Sfotty CPU Notes

Sfotty stores flags as booleans (`sfotty.I`, `sfotty.N`, etc.) not via `sfotty.P`.
Use `sfotty.setP(val)` / `sfotty.getP()` to convert between flags and the P register byte.
The controller uses raw `sfotty.P` property for save/restore (not getP/setP).
`sfotty.run()` is cycle-accurate (1 cycle per call), not instruction-level.
