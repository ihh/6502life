# 6502life

This repo contains the beginnings of a rudimentary framework for virtual 6502-based cellular automata.

It is inspired by various recreational coding and artificial-life experiments, including:

+ [Avida](https://en.wikipedia.org/wiki/Avida_(software)) - artificial life experiments where the machine architecture is designed to facilitate evolvability
+ [Core War](https://en.wikipedia.org/wiki/Core_War) - competitive coding where programs run in the same address space and try to overwrite each other
+ [JSBeeb](https://bbc.xania.org/) - web-based BBC micro emulator. The BBC micro is, of course, 6502-based. There are many other emulators for 6502-based machines out there too...
+ [The BBC Micro Bot](https://mastodon.me.uk/@bbcmicrobot) - one of the great wins of the 6502 corner of the retro-coding hobbyist world


## Repository layout

JavaScript code to simulate the operating system as described here (the "Board") is in `board/`.

The beginnings of a React-based web app (using Vite) are in `6502life-test-app/` but it's pretty bare-bones at the moment.

The next development priority should be to build out the web app; e.g. better visualization code, a debugger, and so on.

# System design

The system is designed using the following principles:

+ It should be plausibly implementable in hardware
+ It has some features designed to make it easy to code cellular automata that are well-studied in physics, chemistry, and biology. Specifically, it enforces translational and rotational invariance, and offers some low-level operations to facilitate diffusion. There is a random number generator, and the interrupt flag is used to allow the programmer to make some operations "atomic", which can mitigate some otherwise glitchy (and not very physical) behavior
+ As much as possible, the implementation of these extensions is "aligned" with the ways 6502-based machines do things. For example, symmetries are achieved by memory-mapping; atomicity, using the interrupt flag

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
| 0F0-0F9 | Cell index pointers, auto-rotated by memory mapper |
| 0F9-0FB | Used to save 6502 registers on interrupt, and restore after interrupt |
| 0FC-0FF | Random number generator, updated on interrupt |
| 100-1FF | Stack (or risky storage...) |
| 200-37F | Available for code or data |
| 380-38F | 16x16 pixel bitmap, red channel |
| 3A0-3AF | 16x16 pixel bitmap, green channel |
| 3C0-3CF | 16x16 pixel bitmap, blue channel |
| 3E0-3FF | ASCII display name |

Notes:

+ Bytes F0-F9 of zero page are special because they can be used to store pointers to cell indices in the memory map. When the memory map is randomly rotated, the top 6 bits of these cells are "rotated" too. Note this includes byte F9 which is used to store PCHI, the current program register (which allows the CPU to safely - or at least somewhat safely - execute code in a neighborhood page).
+ Bytes F9-FB are used to store (in order) PCHI, PCLO, P, A, X, Y, S. So a cell can (for example) "hijack" a neighboring cell's execution state by writing directly to its PC, if that is something a developer wants to do.
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

"Software" interrupts (via the 6502 BRK instructioN) can be used by the developer to implement fast memory swaps and copies (though copies incur a random error probability, to penalize viral spreaders and introduce mutations).

### Hardware interrupts

Hardware interrupts arrive as an (approximately) Poisson process with an average rate of 1 per 4,096 cycles.
  An interrupt is handled as follows:

+ The CPU registers are written to the last seven bytes of zero page.
+ If the interrupt disable flag (I) in the status register P is clear, then the memory-mapped neighborhood of the current origin is copied from RAM to storage (after un-rotating the oriented registers from 0xF0-F9). Otherwise, if I is set, all edits made since the last interrupt are lost (including the registers written to zero page in the previous step). Note that this step requires that either the operating system or the paging hardware must "remember" the current origin and orientation between interrupts, along with the pre-edited state of the memory-mapped neighborhood. This information should not be visible to user-space code.
+ A new origin cell (i,j) and orientation is randomly sampled. The memory-mapped neighborhood of that cell is copied from long-term storage to RAM, using the sampled orientation. Oriented registers at bytes 0xF0-0xF9 of every 1K block have rotations applied.
+ The last four bytes of zero page are overwritten with pseudorandom numbers.
+ CPU registers are restored from the last seven bytes of zero page.
+ The interrupt completes.

### Software interrupts

A BRK software interrupt is handled almost identically, with the following differences:

+ The B flag is set before P is pushed to the stack.
+ After saving registers Y,X,A,S to memory, the operand byte following the BRK opcode is examined.

| Operand byte | Operation |
|--------------|-----------|
| 0 | Does nothing |
| 1 | The cells indexed by X and Y are swapped (that is, 1024-byte blocks starting from 0x400\*X and 0x400\*Y) |
| 2 | The pages indexed by X and Y are swapped (that is, 256-byte blocks from 0x100\*X and 0x100\*Y) |
| 3 | Page X is copied to page Y, with a small error probability |
| 4-255 | Reserved; currently does nothing |

The guiding principle when considering adding more software interrupts,
or expanding the OS in any way, should be to not add any functionality that can't be justified via quasi-physical principles. For example, instant page swap is justifiable to implement diffusion; error-prone copy at higher rates is justifiable on thermodynamic grounds and/or by Shannon's noisy channel coding theorem.

After any memory operation is performed as part of a software interrupt, control returns to the scheduler, which will randomly pass control to another cell (as in the case of a hardware interrupt).

The interrupt disable flag is ignored by the BRK handler; memory is always copied back to storage (i.e. never reverted) following a software interrupt.
