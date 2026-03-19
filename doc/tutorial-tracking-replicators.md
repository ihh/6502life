# Tutorial: Tracking Self-Replicating Programs on the 6502life Board

This tutorial walks through writing a self-replicating 6502 program,
loading it onto the board, simulating at low speed, and tracking its
spread using both the terminal debugger and the CLI probe tool.

## Prerequisites

```bash
npm install
```

## Part 1: Understanding the Memory Map

Each cell on the board has 1024 bytes of storage. When a cell executes,
it sees a 7×7 neighborhood of 49 cells mapped into its address space:

| Cell index | Direction | Address range   |
|------------|-----------|-----------------|
| 0          | Self      | $0000–$03FF     |
| 1          | North     | $0400–$07FF     |
| 2          | East      | $0800–$0BFF     |
| 3          | South     | $0C00–$0FFF     |
| 4          | West      | $1000–$13FF     |
| 5          | NE        | $1400–$17FF     |
| …          | …         | …               |

Every time the scheduler gives control to a cell, the neighborhood is
randomly translated (different origin cell) and rotated (0°/90°/180°/270°).
So "North" doesn't mean a fixed direction — it's a random adjacent cell.

The cell's own 1024 bytes are at $0000–$03FF. Code starts at byte 0.
Registers are saved at $F9–$FF. The stack is at $100–$1FF.

## Part 2: Anatomy of a Self-Copier

A program replicates by copying its own bytes to a neighbor cell's
address range. Here's the built-in `copier` preset, which copies
itself to cell 2 (East):

```asm
; Copy pages 0+1 of self to cell 2 (East)
; Cell 2 starts at $0800, page 0 at $0800, page 1 at $0900
LDY #$01             ; start at byte 1 (avoid BRK at byte 0)
@loop_p0:
LDA $0201,Y          ; read self page 0 via page-aligned access
STA $0801,Y          ; write to cell 2 page 0
INY
BNE @loop_p0         ; loop 255 times (bytes 1–255)
@loop_p1:
LDA $0101,Y          ; self page 1
STA $0901,Y          ; cell 2 page 1
INY
BNE @loop_p1
BRK                  ; yield to scheduler
.byte $01            ; BRK operand (noop swap)
```

This copies 510 bytes (two pages minus byte 0) to the East neighbor.
Because the neighborhood is randomly oriented each interrupt, "East"
is a different physical neighbor each time. Over many interrupts, the
copier gradually spreads in all directions.

**Key insight:** The copier reads from `$0201,Y` and `$0101,Y` instead
of `$0001,Y` and `$0100,Y`. This is because LDA absolute,Y uses
16-bit addresses and can cross page boundaries, and the self-referencing
offsets let the copy loop avoid storing a BRK (0x00) byte in the
instruction stream.

## Part 3: A Better Replicator — The Random Spreader

The `copier` always targets cell 2. We can do better by using the RNG
at $FC–$FF to pick a random cardinal neighbor. The trick: **self-modifying
code** patches the target high byte in the STA instructions at runtime.

```asm
; Random spreader: copies self to a random cardinal neighbor
; Uses RNG byte at $FC to select N/E/S/W (cells 1-4)
; Target cell page 0 high byte: cell 1=$04, 2=$08, 3=$0C, 4=$10
; Self-modifying code patches the STA high bytes in the copy loops.

LDA $FC         ; RNG byte (refreshed each interrupt)
AND #$03        ; 0–3
CLC
ADC #$01        ; 1–4
ASL
ASL             ; 4,8,12,16 = high byte of target page 0
STA $17         ; patch high byte of STA in page 0 loop (offset $17)
CLC
ADC #$01        ; high byte of target page 1
STA $20         ; patch high byte of STA in page 1 loop (offset $20)
; Copy page 0 (bytes 1–255)
LDY #$01
@lp0:
LDA $0201,Y     ; read self page 0
STA $0401,Y     ; write to target page 0 (high byte $04 patched above)
INY
BNE @lp0
; Copy page 1 (bytes 1–255)
@lp1:
LDA $0101,Y     ; read self page 1
STA $0501,Y     ; write to target page 1 (high byte $05 patched above)
INY
BNE @lp1
; Yield
BRK
.byte $01
```

The key trick: `STA $17` writes the computed target high byte directly
into the STA instruction's third byte at program offset $17. When the
copy loop runs, `STA $0401,Y` has been patched to `STA $0801,Y` (or
whatever the random target is). This avoids needing indirect addressing
with a correctly-initialized zero-page pointer.

Use the `spreader` preset to try it:

```bash
node cli/bin/terminal.js --size 16 --preset spreader --cell 0,0 --listen
```

## Part 4: Using the Terminal Debugger

### Start the debugger with a small board

```bash
node cli/bin/terminal.js --size 16 --preset copier --cell 0,0 --listen
```

Flags:
- `--size 16` — 16×16 board (256 cells) for fast experiments
- `--preset copier` — load the copier program into cell (0,0)
- `--cell 0,0` — place it at the origin
- `--listen` — start the probe socket server

The debugger opens with four panes:
- **Top-left (Memory):** Hex view of the 7×7 neighborhood
- **Top-right (Disasm):** Disassembly and register state
- **Bottom-left (Command):** Type commands here
- **Bottom-right (Minimap):** Board overview

### Navigate and inspect

| Key       | Action                              |
|-----------|-------------------------------------|
| Tab       | Cycle focus between panes           |
| Arrows    | Move cursor (memory) / scroll       |
| Ctrl+Arrow| Move board focus to adjacent cell    |
| Space     | Toggle run/pause                    |
| n         | Single-step (one interrupt)         |
| d         | Toggle disassembly sync/free mode   |

### Step through the copier

1. Press `n` a few times. Watch the disassembly pane — the PC advances
   through the LDY, LDA, STA, INY, BNE loop.

2. The status bar shows `int: N` — the interrupt count.

3. After the copier completes (~500 cycles), it hits BRK and yields.
   The next interrupt moves to a random cell somewhere else on the board.

4. Type `cell 0,0` in the command pane to jump back to the copier's cell.

5. Press `m` in the minimap pane to toggle between local and global view.

### Use probe commands in the TUI

With `--listen`, the probe/tracking system is active. Try these commands
in the command pane:

```
fp              # fingerprint the current cell
fp 0,0          # fingerprint cell (0,0)
tag 0,0 origin  # tag the origin cell
track 0,0       # start tracking lineage from (0,0)
```

Now run for a while:

```
speed 16        # 16 interrupts per frame
r               # run
```

Wait a bit, then:

```
p               # pause
census          # see fingerprint distribution
tags origin     # find all cells tagged "origin" (including copies)
```

### Diff two cells

After the copier has spread, inspect a copy:

```
diff 0,0 1,0    # byte-level diff between origin and a neighbor
```

If the copy was perfect, you'll see `identical (sim=1)`. If it was
partial (interrupted mid-copy), you'll see the byte count and similarity.

## Part 5: Using the CLI Probe

In a **second terminal**, while the debugger is still running:

### One-shot commands

```bash
# Board status
node cli/bin/probe.js status

# Fingerprint the origin
node cli/bin/probe.js fingerprint 0,0

# Full board scan — shows how many cells share each fingerprint
node cli/bin/probe.js scan

# Find cells matching the copier's fingerprint
HASH=$(node cli/bin/probe.js fingerprint 0,0 | jq -r .hash)
node cli/bin/probe.js scan --match $HASH

# Diff origin against a neighbor
node cli/bin/probe.js diff 0,0 1,0

# Tag cells
node cli/bin/probe.js tag 0,0 origin

# Get a one-shot census
node cli/bin/probe.js census
```

### Streaming: watch copies spread in real time

```bash
# Track lineage from the origin — streams copy events as JSON
node cli/bin/probe.js track 0,0 --tag ancestor

# Each time the copier writes its code to a new cell, you'll see:
# {"channel":"lineage","event":"copied_to","src":[0,0],"dst":[1,0],"similarity":0.98,...}

# The tracker auto-propagates: once cell (1,0) starts copying too,
# *its* copies will also be tracked.
```

### Periodic census — watch population dynamics

```bash
# Get a census every 500 interrupts
node cli/bin/probe.js census --interval 500

# Output (one JSON per line):
# {"channel":"census","interrupt":500,"active":12,"uniqueFingerprints":3,"top":{"a3f2c891":8,...},...}
# {"channel":"census","interrupt":1000,"active":45,"uniqueFingerprints":4,...}

# Pipe to jq for readable output:
node cli/bin/probe.js census --interval 500 | jq '{int: .interrupt, copies: .top}'
```

### Watch a specific cell being overwritten

```bash
# Alert when cell (3,3) is written to
node cli/bin/probe.js watch 3,3

# Output shows who wrote what:
# {"channel":"watch","cell":[3,3],"src":[0,0],"bytes":[{"offset":0,"old":0,"new":169},...]}
```

### Subscribe to raw write events

```bash
# See every non-atomic write on the board
node cli/bin/probe.js subscribe writes | jq '{src: .src, dst: .dst, n: (.bytes | length)}'
```

## Part 6: Putting It All Together — A Full Experiment

Here's a complete workflow for studying how a replicator colonizes a board:

```bash
# Terminal 1: start debugger on a 32×32 board with the copier at (0,0)
node cli/bin/terminal.js --size 32 --preset copier --cell 0,0 --listen

# In the TUI, type:
#   tag 0,0 patient-zero
#   track 0,0
#   speed 32
#   r
```

```bash
# Terminal 2: stream census every 1000 interrupts, save to file
node cli/bin/probe.js census --interval 1000 > census.jsonl &

# Terminal 2: track lineage events, save to file
node cli/bin/probe.js track 0,0 --tag patient-zero > lineage.jsonl &
```

After the simulation runs for a while, kill the streams with Ctrl+C and
analyze:

```bash
# How many unique programs exist at each census?
cat census.jsonl | jq '.uniqueFingerprints'

# When did the copier first reach 50% coverage?
cat census.jsonl | jq 'select(.top | to_entries | map(select(.value > 512)) | length > 0) | .interrupt' | head -1

# Lineage tree: which cells were copied when?
cat lineage.jsonl | jq '{t: .interrupt, src: .src, dst: .dst, sim: .similarity}'
```

## Part 7: Writing Your Own Replicator

Key considerations:

1. **Avoid BRK (0x00) in the code stream.** BRK triggers a software
   interrupt, so any 0x00 byte will be treated as a BRK opcode when
   the program counter reaches it. Use `LDY #$01` and start loops at
   byte 1, or use addressing modes that avoid zero bytes.

2. **Copy enough.** You need to copy at least all the code bytes.
   The copier copies 510 bytes (2 pages). If your program is longer,
   copy more pages.

3. **Use atomic mode for reliable copies.** Set the I flag (`SEI`)
   before starting a copy. If a timer interrupt fires mid-copy, all
   writes are reverted — so you get all-or-nothing. Clear I (`CLI`)
   when done, or just let the BRK commit the writes.

4. **The RNG at $FC–$FF is refreshed each interrupt.** Use it for
   random target selection.

5. **Orientation changes every interrupt.** Your code always sees
   "North" as cell 1, but the physical direction rotates. This is
   actually helpful — a program that always copies North will spread
   in all directions over time.

Here is a template:

```asm
; Self-replicating template
; Copies pages 0-1 of self to cell 1 (North, randomly oriented)
SEI                 ; atomic mode: all-or-nothing copy
LDY #$01
@page0:
LDA $0201,Y        ; read own page 0
STA $0401,Y        ; write to cell 1 page 0
INY
BNE @page0
@page1:
LDA $0101,Y        ; read own page 1
STA $0501,Y        ; write to cell 1 page 1
INY
BNE @page1
CLI                 ; end atomic mode
BRK
.byte $01           ; yield
```

To test from a file:

```bash
node cli/bin/terminal.js --size 16 --asm my-replicator.asm --cell 0,0 --listen
```

## Part 8: Advanced — Competing Replicators

Load two different programs and watch them fight for territory:

```bash
# Start with empty board
node cli/bin/terminal.js --size 32 --listen
```

In the TUI command pane:

```
preset copier
cell 0,0
tag 0,0 copier-strain
track 0,0

cell 15,15
preset copier
tag 15,15 rival-strain
track 15,15
```

Then run and use the probe to watch:

```bash
# In terminal 2:
node cli/bin/probe.js census --interval 500 | jq '{
  int: .interrupt,
  unique: .uniqueFingerprints,
  top3: (.top | to_entries | sort_by(-.value) | .[0:3])
}'
```

Since both strains are identical copiers, they'll merge into one
fingerprint. To make them distinguishable, modify one slightly — change
a data byte, or have one copy 3 pages instead of 2. Even a single-byte
difference produces a different content hash, while the MinHash similarity
remains high (~0.98), showing they're closely related.

## Quick Reference

### Terminal Debugger Commands (with --listen)

| Command         | Description                             |
|-----------------|-----------------------------------------|
| `fp [I,J]`      | MinHash fingerprint of cell             |
| `tag I,J NAME`  | Tag cell                                |
| `untag I,J NAME`| Remove tag                              |
| `tags [NAME]`   | List tags on cell or find by tag        |
| `track [I,J]`   | Track cell lineage (copy detection)     |
| `untrack [I,J]` | Stop tracking                           |
| `diff I,J I,J`  | Diff two cells                          |
| `census`        | Board-wide fingerprint census           |

### Probe CLI Commands

| Command                        | Mode     | Description                    |
|--------------------------------|----------|--------------------------------|
| `probe.js status`              | One-shot | Board status                   |
| `probe.js fingerprint I,J`     | One-shot | Cell fingerprint               |
| `probe.js scan`                | One-shot | Board-wide fingerprint table   |
| `probe.js scan --match HASH`   | One-shot | Find cells matching hash       |
| `probe.js diff I,J I,J`       | One-shot | Byte-level diff                |
| `probe.js tag I,J NAME`       | One-shot | Tag cell                       |
| `probe.js tags --tag NAME`    | One-shot | Find cells with tag            |
| `probe.js census`             | One-shot | One-shot census                |
| `probe.js track I,J`          | Stream   | Lineage events (auto-follows)  |
| `probe.js watch I,J`          | Stream   | Watchpoint on cell writes      |
| `probe.js census --interval N`| Stream   | Periodic census every N ints   |
| `probe.js subscribe writes`   | Stream   | Raw write events               |
| `probe.js subscribe moves`    | Stream   | Raw cell swap events           |
| `probe.js config --similarity N` | One-shot | Set copy detection threshold |
