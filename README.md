# 6502life

This repo contains the beginnings of a rudimentary framework for virtual 6502-based cellular automata.

It is inspired by various recreational coding and artificial-life experiments, including:

+ [Avida](https://en.wikipedia.org/wiki/Avida_(software)) - artificial life experiments where the machine architecture is designed to facilitate evolvability
+ [Core War](https://en.wikipedia.org/wiki/Core_War) - competitive coding where programs run in the same address space and try to overwrite each other
+ [JSBeeb](https://bbc.xania.org/) - web-based BBC micro emulator. The BBC micro is, of course, 6502-based. There are many other emulators for 6502-based machines out there too...
+ [The BBC Micro Bot](https://mastodon.me.uk/@bbcmicrobot) - one of the great wins of the 6502 corner of the retro-coding hobbyist world


## Two ways to explore

The project offers two complementary interfaces that share the same simulation engine:

**Web dashboard** (`app/`) — a React+Vite 2D interface for visual exploration.
Provides a scrollable overview map, a tiled icon view, per-cell inspection (registers, memory, disassembly, bitmap),
an inline assembly editor, bulk operations, and save/load. Best for getting a bird's-eye view of the board,
watching patterns emerge in real time, and editing cell programs interactively.

```bash
npm install && cd app && npm install && npm run dev
```

**Terminal debugger** (`cli/`) — a four-pane TUI for low-level debugging.
Includes a sextant-character memory map, a live disassembler, a command prompt with breakpoints and watches,
and a board minimap. Best for tracing execution, stepping through instructions, inspecting raw memory,
and scripting batch runs from the command line.

```bash
node cli/bin/terminal.js --size 16 --preset spreader --cell 0,0
```

Use them together: prototype a program in the web editor, then drop into the terminal debugger
to trace a subtle bug, or run a headless batch with `cli/bin/run.js` and load the saved state
into either UI for inspection.

## Repository layout

| Directory | Purpose |
|-----------|---------|
| `engine/` | Shared engine layer (board, assembler, formatting) used by both interfaces |
| `board/`  | Core simulation: memory management, CPU controller, visualizer |
| `app/`    | React+Vite web dashboard |
| `cli/`    | Command-line tools: assembler, runner, inspector, TUI, terminal debugger |
| `tex/`    | LaTeX documentation |

# System design

## Design principles

The system is designed using the following principles:

+ It should be plausibly implementable in hardware
+ It has some features designed to make it easy to code cellular automata that are well-studied in physics, chemistry, and biology:
    + It enforces translational and rotational invariance
    + There is a random number generator
    + It offers some low-level operations to facilitate diffusion
    + The interrupt flag allows the programmer to make routines "atomic", which can mitigate some glitchy (and not very physical) behavior
+ As much as possible, the implementation of these extensions is "aligned" with the ways 6502-based machines do things. For example, symmetries are achieved by memory-mapping; atomicity, using the interrupt flag
+ There is a strong-ish prior against implementing other utility subroutines, unless they reflect basic physics

At the risk of repeating this point: extensions to the typical 6502-based machine architecture are pretty minimalistic. We want this to look like a 6502 machine (or, more precisely, a huge array of 6502s networked in a square grid).
Beyond that, we do not want to impose too many software-level architectural biases (so e.g. we have avoided adding a big library of subroutines in ROM or via software interrupts, though this could conceivably change).

## Board

The "Board" is a virtual 256x256 grid of cells. In principle it could be much larger, but this keeps things manageable for now.

Each cell has 4 pages (0x400 bytes) of memory and runs a virtual 6502 CPU which has memory-mapped access to itself and 48 neighbors in a 7x7 square grid, centered on the cell itself.

The board has periodic boundary conditions: it wraps around, so e.g. the cell at (255,255) can "see" cells (252,252) and also (2,2).

Access to neighbors is provided by mapping the 4 pages for each neighbor into the addressable RAM space of the cell's CPU.
The memory map is arbitrarily translated and rotated:

+ The system uses relative offsetting for cell coordinates, to enforce translational invariance.
+ Additionally, the memory map is rotated by a random multiple of 90&deg;, and some memory locations (representing vectors into neighboring cells) are rotated in the same way, to enforce rotational invariance.
+ A number of lookup tables are provided in the read-only part of the system memory map, to facilitate vector arithmetic and help cope with some of the implications of randomly rotating the neighborhood memory map.

Execution is single-threaded with random preemptive interrupts. Only CPU is active at any given time.

When a cell is active, it can read or write to itself or its neighbors. A program can use the 6502 interrupt flag to indicate that writes should be reverted if an interrupt occurs before an atomic operation is complete.

We aim to clock the entire board at the rate of a 1981 BBC Micro (2Mhz), so each cell updates at ~30.5Hz.
 (This is a lower bound, and should be easily achievable on modern computers. There is no reason you can't run the board faster.)
 
## System memory map

| Address range | Usage |
|---------------|-------|
| 0000-BFFF | RAM-mapped neighborhood (see neighborhood map, below) |
| C000-DFFF | ROM, unused |
| E000-EE3F | ROM lookup tables for vector operations on neighborhood |
| EE40-FFFF | ROM, unused |

## Neighborhood memory map

The neighborhood memory map is structured so as to facilitate compact 6502 programs that operate on the Moore and von Neumann neighborhoods, and other "simple" neighborhoods.

<table>
<tr> <td></td><td> x=-3 </td><td> x=-2 </td><td> x=-1 </td><td> x=0 </td><td> x=1 </td><td> x=2 </td><td> x=3 </td> </tr>
<tr> <td> y=3 </td><td>Cell #48 <br> Coords (-3,3) <br> Addr C000..C3FF</td><td>Cell #44 <br> Coords (-2,3) <br> Addr B000..B3FF</td><td>Cell #36 <br> Coords (-1,3) <br> Addr 9000..93FF</td><td>Cell #21 <br> Coords (0,3) <br> Addr 5400..57FF</td><td>Cell #29 <br> Coords (1,3) <br> Addr 7400..77FF</td><td>Cell #37 <br> Coords (2,3) <br> Addr 9400..97FF</td><td>Cell #45 <br> Coords (3,3) <br> Addr B400..B7FF</td> </tr>
<tr> <td> y=2 </td><td>Cell #43 <br> Coords (-3,2) <br> Addr AC00..AFFF</td><td>Cell #28 <br> Coords (-2,2) <br> Addr 7000..73FF</td><td>Cell #20 <br> Coords (-1,2) <br> Addr 5000..53FF</td><td>Cell #9 <br> Coords (0,2) <br> Addr 2400..27FF</td><td>Cell #13 <br> Coords (1,2) <br> Addr 3400..37FF</td><td>Cell #25 <br> Coords (2,2) <br> Addr 6400..67FF</td><td>Cell #38 <br> Coords (3,2) <br> Addr 9800..9BFF</td> </tr>
<tr> <td> y=1 </td><td>Cell #35 <br> Coords (-3,1) <br> Addr 8C00..8FFF</td><td>Cell #19 <br> Coords (-2,1) <br> Addr 4C00..4FFF</td><td>Cell #8 <br> Coords (-1,1) <br> Addr 2000..23FF</td><td>Cell #1 <br> Coords (0,1) <br> Addr 0400..07FF</td><td>Cell #5 <br> Coords (1,1) <br> Addr 1400..17FF</td><td>Cell #14 <br> Coords (2,1) <br> Addr 3800..3BFF</td><td>Cell #30 <br> Coords (3,1) <br> Addr 7800..7BFF</td> </tr>
<tr> <td> y=0 </td><td>Cell #24 <br> Coords (-3,0) <br> Addr 6000..63FF</td><td>Cell #12 <br> Coords (-2,0) <br> Addr 3000..33FF</td><td>Cell #4 <br> Coords (-1,0) <br> Addr 1000..13FF</td><td><b>Cell #0 <br> Coords (0,0) <br> Addr 0000..03FF</b></td><td>Cell #2 <br> Coords (1,0) <br> Addr 0800..0BFF</td><td>Cell #10 <br> Coords (2,0) <br> Addr 2800..2BFF</td><td>Cell #22 <br> Coords (3,0) <br> Addr 5800..5BFF</td> </tr>
<tr> <td> y=-1 </td><td>Cell #34 <br> Coords (-3,-1) <br> Addr 8800..8BFF</td><td>Cell #18 <br> Coords (-2,-1) <br> Addr 4800..4BFF</td><td>Cell #7 <br> Coords (-1,-1) <br> Addr 1C00..1FFF</td><td>Cell #3 <br> Coords (0,-1) <br> Addr 0C00..0FFF</td><td>Cell #6 <br> Coords (1,-1) <br> Addr 1800..1BFF</td><td>Cell #15 <br> Coords (2,-1) <br> Addr 3C00..3FFF</td><td>Cell #31 <br> Coords (3,-1) <br> Addr 7C00..7FFF</td> </tr>
<tr> <td> y=-2 </td><td>Cell #42 <br> Coords (-3,-2) <br> Addr A800..ABFF</td><td>Cell #27 <br> Coords (-2,-2) <br> Addr 6C00..6FFF</td><td>Cell #17 <br> Coords (-1,-2) <br> Addr 4400..47FF</td><td>Cell #11 <br> Coords (0,-2) <br> Addr 2C00..2FFF</td><td>Cell #16 <br> Coords (1,-2) <br> Addr 4000..43FF</td><td>Cell #26 <br> Coords (2,-2) <br> Addr 6800..6BFF</td><td>Cell #39 <br> Coords (3,-2) <br> Addr 9C00..9FFF</td> </tr>
<tr> <td> y=-3 </td><td>Cell #47 <br> Coords (-3,-3) <br> Addr BC00..BFFF</td><td>Cell #41 <br> Coords (-2,-3) <br> Addr A400..A7FF</td><td>Cell #33 <br> Coords (-1,-3) <br> Addr 8400..87FF</td><td>Cell #23 <br> Coords (0,-3) <br> Addr 5C00..5FFF</td><td>Cell #32 <br> Coords (1,-3) <br> Addr 8000..83FF</td><td>Cell #40 <br> Coords (2,-3) <br> Addr A000..A3FF</td><td>Cell #46 <br> Coords (3,-3) <br> Addr B800..BBFF</td> </tr>
</table>


The cell indices are arranged in a spiral order:

| Cell indices | Taxicab distance | Directions (in order) |
|--------------|------------------|------------|
 0 | 0 | Origin=(0,0) |
| 1..4 | 1 | N=(0,+1), E=(+1,0), S, W |
| 5..8 | 2 | NE, SE, SW, NW |
| 9..12 | 2 | N<sup>2</sup>, E<sup>2</sup>, S<sup>2</sup>, W<sup>2</sup> |
| 13..20 | 3 | N<sup>2</sup>E, NE<sup>2</sup>, SE<sup>2</sup>, S<sup>2</sup>E, S<sup>2</sup>W, SW<sup>2</sup>, NW<sup>2</sup>, N<sup>2</sup>W |
| 21..24 | 3 | N<sup>3</sup>, E<sup>3</sup>, S<sup>3</sup>, W<sup>3</sup> |
| 25..27 | 4 | N<sup>2</sup>E<sup>2</sup>, S<sup>2</sup>E<sup>2</sup>, S<sup>2</sup>W<sup>2</sup>, N<sup>2</sup>W<sup>2</sup> |
| 28..35 | 4 | N<sup>3</sup>E, NE<sup>3</sup>, SE<sup>3</sup>, S<sup>3</sup>E, S<sup>3</sup>W, SW<sup>3</sup>, NW<sup>3</sup>, N<sup>3</sup>W |
| 36..43 | 5 | N<sup>3</sup>E<sup>2</sup>, N<sup>2</sup>E<sup>3</sup>, S<sup>2</sup>E<sup>3</sup>, S<sup>3</sup>E<sup>2</sup>, S<sup>3</sup>W<sup>2</sup>, S<sup>2</sup>W<sup>3</sup>, N<sup>2</sup>W<sup>3</sup>, N<sup>3</sup>W<sup>2</sup> |
| 44..48 | 6 | N<sup>3</sup>E<sup>3</sup>, S<sup>3</sup>E<sup>3</sup>, S<sup>3</sup>W<sup>3</sup>, N<sup>3</sup>W<sup>3</sup>

The neighborhood is rotated by a random multiple of 90&deg; after each interrupt. To allow programs to maintain consistent pointers to particular locations (or direction variables), the system also rotates certain bytes in zero page (F0-F8).

## Cell memory map

Within each cell, memory is laid out as follows:

| Address offset range | Usage |
|----------------------|-------|
| 000 | Default entry point |
| 000-0EF | Zero page, available for code or data |
| 0F0-0F8 | Cell index pointers, auto-rotated by memory mapper |
| 0F9-0FB | Used to save 6502 registers on interrupt, and restore after interrupt (0xF9/PCHI is also auto-rotated) |
| 0FC-0FF | Random number generator, updated on interrupt |
| 100-1FF | Stack (or risky storage...) |
| 200-37F | Available for code or data |
| 380-38F | 16x16 pixel bitmap, red channel |
| 3A0-3AF | 16x16 pixel bitmap, green channel |
| 3C0-3CF | 16x16 pixel bitmap, blue channel |
| 3E0-3FF | ASCII display name |

Notes:

+ Bytes F0-F8 of zero page are special because they can be used to store pointers to cell indices in the memory map. When the memory map is randomly rotated, the top 6 bits of these cells are "rotated" too. Byte F9 (PCHI) is also auto-rotated but is considered controller-reserved.
+ Bytes F9-FF are used to store (in order) PCHI, PCLO, P, A, X, Y, S. So a cell can (for example) "hijack" a neighboring cell's execution state by writing directly to its PC, if that is something a developer wants to do.
+ Addresses 380-3FF are reserved for visualization, by convention, but there is nothing stopping a program using them for code or data.

Currently the visualization code parses the display name as an [Iconify](https://iconify.design/) icon
(optionally preceded by a CSS color name and then a colon); the bitmap is not used.
This may change.

## Vector lookup tables

In the following table, i and j represent cell indices,
while v<sub>i</sub> represents the (x,y) offset of that cell in the
current reference frame.
So, for example, cell #i represents the cell in the memory-mapped neighborhood whose memory lies from 0x400\*i to (0x400\*i + 0x3FF) inclusive;
and v<sub>0</sub>=(0,0), v<sub>1</sub>=(0,1), v<sub>2</sub>=(1,0), etc.

| Table start S | Meaning of S[i] |
|---------------|-----------------|
| E000 + 64*j | Cell index for the vector sum v<sub>i</sub> + v<sub>j</sub> |
| EC40 | Rotation 90&deg; clockwise |
| EC80 | Rotation 180&deg; |
| ECC0 | Rotation 90&deg; anti-clockwise |
| ED00 | Reflection about x-axis |
| ED40 | Reflection about y-axis |
| ED80 | (X coordinate of v<sub>i</sub>) + 3 |
| EDC0 | (Y coordinate of v<sub>i</sub>) + 3 |
| EE00 | Cell index lookup; see below |

  The table from 0xEE00-0xEE3F contains the mapping from (x,y) coordinates to cell indices,
  with y ascending fastest, starting from cell (-3,-3);
  so the byte in 0xEE00+(y+3)+64*(x+3) is the index of cell with relative offset (x,y)
  for -3 &leq; x,y &leq; 3.

## Interrupts

The system uses "hardware" interrupts to schedule execution of different cells, and to do housekeeping around switching the currently running cell.

"Software" interrupts (via the 6502 BRK instruction) can be used by the developer to implement fast memory swaps and copies (though copies incur a random bit error probability, introducing mutations).

### Interrupt model

Pre-emptive scheduling is conceptually an IRQ (maskable by SEI) followed by an NMI (unmaskable context switch). Memory writeback happens between the two if the I flag allows it. Setting I (via SEI) makes writes atomic: they commit only on BRK, and are reverted on timer interrupt.

### Hardware (timer) interrupts

Timer interrupts arrive as an (approximately) Poisson process with an average rate of 1 per 4,096 cycles. On a timer interrupt:

+ If the interrupt disable flag (I) is set, all writes since the last interrupt are reverted (atomic abort). Otherwise:
+ The B flag (bit 4) is cleared in P.
+ CPU registers are written to the last seven bytes of zero page (0xF9–0xFF).
+ The memory-mapped neighborhood is committed to storage.
+ A new origin cell (i,j) and orientation is randomly sampled. The new cell's neighborhood is loaded.
+ The last four bytes of zero page (0xFC–0xFF) are overwritten with pseudorandom numbers.
+ CPU registers are restored from the last seven bytes of zero page.

### Software (BRK) interrupts

BRK costs 7 CPU cycles (matching the real NMOS 6502: 2 to fetch opcode + operand, 3 to push PC and P to stack, 2 to read the IRQ vector). Undocumented opcodes are treated as BRK 0 at the same 7-cycle cost.

BRK always commits writes (the I flag is ignored). The operand byte `b` (immediately after the BRK opcode) selects an operation. Copy and swap operations happen **before** registers are saved, so a BRK copy produces a child that inherits the pre-BRK register state from the previous scheduling.

The B flag (bit 4 of P at 0xFB) is set after BRK, cleared after timer interrupt. This enables **fork detection**: after a BRK copy, the child inherits B=0 (pre-BRK state) while the parent gets B=1. Programs can `LDA $FB / AND #$10 / BNE @parent` to branch.

| Operand `b` | Operation |
|--------------|-----------|
| 0 | Resets PC to 0x0000. Yields to scheduler. |
| 1–244 | Swap cells: src = floor(b/49), dest = b%49. Sources are cells 0–4 (origin + 4 cardinal), destinations are cells 0–48 (full neighborhood). Self-swaps (src=dest) update move times but do not copy data. Feature-gated by `implementsMove`. Yields to scheduler. |
| 245–252 | Noisy copy: origin cell is copied to cell (b − 244), i.e. cells 1–8, subject to bit noise (see below). Feature-gated by `implementsCopy`. Yields to scheduler. |
| 253 | Sync interrupt request: X,Y registers specify period in cycles. The next interrupt for this cell is scheduled at the nearest future absolute multiple of that period (using global board time). Feature-gated by `implementsSync`. Yields to scheduler. |
| 254 | Async interrupt request: X,Y registers specify delay in cycles. Schedules the next interrupt for this cell after that many cycles. Feature-gated by `implementsAsync`. Yields to scheduler. |
| 255 | Reserved (no operation). Yields to scheduler. |

If a BRK operand's feature flag is not enabled (e.g. `implementsMove=false`), the BRK just yields to the scheduler with no effect.

A bad (unrecognized) opcode is handled like BRK 0: PC resets to 0, control returns to the scheduler.

#### Board hyperparameters

The `BoardController` accepts a `boardParams` dictionary with the following defaults:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `pBitNoise` | 1/2048 | Per-bit noise probability on BRK noisy copy |
| `pBrkFailure` | 0 | Probability a BRK copy/swap silently fails |
| `magnetosensing` | false | If true, scheduler writes orientation to $FA (shifted left 2 bits) |
| `implementsMove` | true | Enable BRK 1–244 swap operations |
| `implementsCopy` | true | Enable BRK 245–252 noisy copy |
| `implementsSync` | false | Enable BRK 253 sync interrupt request |
| `implementsAsync` | false | Enable BRK 254 async interrupt request |

#### Magnetosensing

When `magnetosensing` is enabled, the scheduler writes the current orientation (0–3, shifted left by 2 bits) to address $FA after each context switch. Programs can read $FA to detect their absolute orientation, breaking rotational symmetry. When disabled (default), $FA is written as 0.

#### Noisy copy model

The noisy copy (operands 245–252) copies all 1024 bytes of the origin cell to the destination. Each bit is independently randomized (replaced by a fair coin flip) with probability ε (`pBitNoise`), and faithfully copied with probability 1−ε. The default is ε = 1/2048, giving approximately 1 bit error per 256-byte page copied (~4 errors per cell).

LDA/STA writes (normal 6502 store instructions) are always exact — noise applies only to BRK noisy copies.

See [tex/6502life.pdf](tex/6502life.pdf) for the full specification.
