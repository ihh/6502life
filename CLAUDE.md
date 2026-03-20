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
| 0x0F0-0x0F9 | Oriented registers (auto-rotated by memory mapper) |
| 0x0F9-0x0FF | CPU register save area + RNG |
| 0x100-0x1FF | Stack |
| 0x200-0x37F | Code or data |
| 0x380-0x3BF | 16x16 RGB bitmap (R at 0x380, G at 0x3A0, B at 0x3C0) |
| 0x3E0-0x3FF | ASCII display name (32 bytes) |

## Conventions

- **Oriented registers** at 0xF0-0xF9: top 6 bits are rotated with the orientation
- **Register save area** at 0xF9-0xFF: PCHI, PCLO, P, A, X, Y, S
- **RNG** at 0xFC-0xFF: 4 bytes of pseudorandom numbers, refreshed each interrupt
- **BRK operands**: byte `b` after BRK opcode: 0=noop, 1–244=swap cells (src=floor(b/49), dest=b%49), 245–252=noisy copy origin→cell(b−244), 253–255=reserved. Bad opcodes handled as BRK 0.
- **Interrupt flag (I)**: when set, writes are reverted on timer interrupt (atomic mode)
- **Display name** at 0x3E0-0x3FF: 32 bytes of ASCII. Parsed by the web app as
  `[cssColor]:[iconifyIconName]` (e.g. `orange:bee`, `red:sword`). If no colon present,
  the name is treated as an Iconify icon in the `game-icons` set. The web app renders these
  as SVG icons via the @iconify library.
- **RGB bitmap** at 0x380-0x3BF: 16x16 pixel bitmap (32 bytes per channel: R, G, B).
  Each bit represents one pixel. Rendered in the Cell Inspector panel.

## Sfotty CPU Notes

Sfotty stores flags as booleans (`sfotty.I`, `sfotty.N`, etc.) not via `sfotty.P`.
Use `sfotty.setP(val)` / `sfotty.getP()` to convert between flags and the P register byte.
The controller uses raw `sfotty.P` property for save/restore (not getP/setP).
`sfotty.run()` is cycle-accurate (1 cycle per call), not instruction-level.
