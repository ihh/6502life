# IDE Dogfood Report: Terminal Debugger (`cli/bin/terminal.js`)

Date: 2026-03-22

## Method

All investigations used `--script` mode exclusively. No interactive TUI sessions.
The debugger was driven via script files containing commands like `step`, `cell`,
`dump`, `regs`, and `disasm`.

---

## Challenge 1: Watch nano-2x Spread

**Setup:** `node cli/bin/terminal.js --size 8 --preset nano-2x --cell 0,0 --script /tmp/challenge1.txt`

**Commands used:**
```
info
step 100
dump
step 100
dump
# repeated to 500 total, then inspected frontier cells
cell 1,0
regs
disasm $0000
dump
cell 0,1
regs
disasm $0000
dump
```

**Observations:**
- At 100 interrupts: 51/64 cells active (had non-zero content).
- At 200 interrupts: 61/64 active.
- At 300 interrupts: 64/64 -- full saturation of the 8x8 board.
- Frontier cells at (1,0), (0,1), (2,0) all contained correct nano-2x code:
  `00 F5 00 F6 D0 FA F0 F8`
- Extra byte `40` (RTI) appeared at offset 8 in some cells -- BRK handler artifact.

**Minimap dump at 100 interrupts (text art from `dump`):**
```
Active cells: 51/64
(0,0):14 (0,7):20 (6,4):5 (7,0):18 (7,7):21
  ... most cells had :1 (just 1 non-zero byte)
```
The `:N` count shows non-zero bytes, not program identity. You cannot tell which
cells have actual replicators vs which just have stray bytes from BRK noise.

---

## Challenge 2: Muller's Ratchet

**Setup:** `node cli/bin/terminal.js --size 8 --preset nano-2x --cell 0,0 --epsilon 0.001 --script /tmp/challenge2.txt`

**Observations after 1000 interrupts:**
- All cells still had nano-2x core bytes `00 F5 00 F6 D0 FA F0 F8` at page 0.
- Mutations scattered in non-code regions (stray bits flipped by noise).

**After 4000 interrupts (epsilon=0.001):**
- Cells (1,1), (4,4), (6,6) all showed mutated page-0 code:
  `00 F5 00 F6 D0 FA E1 FA` -- byte 6 changed from `F0` (BEQ) to `E1` (SBC),
  byte 7 from `F8` to `FA`. The trailing branch was corrupted.
- However, page-2 backup copies ($0200) still retained `00 F5 00 F6 D0 FA F0 F8`.
- Cell (0,0) page 0 was still correct.
- Muller's ratchet visible: mutations accumulate in running copies, but the
  replicator remains functional because only the BRK instructions (bytes 0-3)
  are essential for spreading.

**Commands used for deeper investigation:**
```
step 4000
cell 1,1
dump $0000 16
dump $0200 16
cell 4,4
dump $0000 16
dump $0200 16
```

---

## Challenge 3: Triplicator Self-Repair

**Setup:** `node cli/bin/terminal.js --size 8 --preset triplicator --cell 0,0 --epsilon 0 --script /tmp/challenge3.txt`

**Observations after 500 interrupts:**

Page 0 ($0000) and Page 2 ($0200) are identical and correct:
```
$0000  00 F5 C6 40 10 04 A9 30 85 40 A4 40 B9 00 02 39  ...@...0.@.@...9
$0010  00 03 85 41 B9 00 00 39 00 02 05 41 85 41 B9 00  ...A...9...A.A..
$0020  00 39 00 03 05 41 99 00 00 99 00 02 99 00 03 D0  .9...A..........
$0030  CF F0 CD                                          ...
```

**Bug found: Page 3 ($0300) is mostly empty!**
```
$0300  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00  ................
$0320  00 00 00 00 00 00 99 00 00 99 00 02 99 00 03 D0  ................
$0330  CF 00 00 00 00 00 ...
```

The triplicator's majority-vote repair needs three copies (pages 0, 2, 3). But the
preset loader (`terminal.js` lines 75-77) only writes to offset 0 (page 0) and
offset 0x200 (page 2). **Page 3 is never initialized.** This means the triplicator's
repair mechanism degrades: with page 3 empty, majority vote `(P0 AND P2) OR (P0 AND
P3) OR (P2 AND P3)` still works because P0 and P2 agree, but the repair can only
correct single-page errors, not multi-page corruption.

The partial fragment at $0326 (`99 00 ... D0 CF`) is from the triplicator's own
`STA $0000,Y / STA $0200,Y / STA $0300,Y` loop gradually building up page 3 as it
repairs -- but it repairs one byte per scheduling, so it takes many schedulings to
fully populate page 3.

---

## Challenge 4: Competition (nano-2x vs triplicator)

**Setup:** `node cli/bin/terminal.js --size 8 --preset nano-2x --cell 0,0 --script /tmp/challenge4.txt`

The script loaded triplicator at (4,4) after nano-2x at (0,0), then stepped.

**Results:**
- At 100 interrupts: triplicator cluster visible around (3,4)-(4,6) with ~88-92
  non-zero bytes. nano-2x spreading elsewhere with ~1-20 non-zero bytes.
- At 1000 interrupts: triplicator-heavy cells (100-120 non-zero bytes) form a
  cluster in the center-right. nano-2x (30-60 non-zero bytes) fills the periphery.
- At 10000 interrupts: **nano-2x completely dominates.** Every cell on the board
  shows `14 F5 00 F6 D0 FA F0 F8` -- the nano-2x code with byte 0 mutated from
  `00` to `14`. The triplicator was entirely overwritten.

nano-2x wins because:
1. It is 8 bytes vs triplicator's 51 bytes.
2. It copies to TWO neighbors per scheduling (BRK $F5, BRK $F6).
3. BRK copy overwrites the target's entire page 0 with the origin's page 0,
   so the triplicator code is erased when a nano-2x neighbor copies into its cell.

---

## Usability Issues

### Broken

1. **`dump` command name collision.** `dump` is both "hex dump of memory" (`dump ADDR N`)
   and "screen dump of all panes" (`dump` with no args or `dump FILE`). In script mode,
   `dump` with no args generates a screen dump to stdout. `dump $0000 64` does a hex dump.
   This is confusing -- a user typing `dump` expecting to see memory gets a 100-line
   screen dump instead.

2. **Preset loader does not write page 3.** The triplicator preset needs data at
   pages 0, 2, AND 3, but `terminal.js` only writes pages 0 and 2. This applies to
   any preset that uses page 3 for redundancy. The fix is to also do
   `writeCellBytes(controller, cellI, cellJ, 0x300, bytes)` when loading presets.

3. **`disasm` command in script mode shows nothing useful.** Running `disasm $0000`
   prints "Disassembler -> $0000" but does not output the actual disassembly -- it
   just moves the disassembler pane's cursor, which is invisible in script mode.
   Only `dump` shows the disassembly output.

### Missing

4. **No `mem` command.** CLAUDE.md documents `mem ADDR` but no such command exists.
   The actual command is `dump ADDR N` (hex dump) or `peek ADDR N` (per-byte).

5. **No way to compare cells in script mode.** Want: `diff 0,0 1,0` to see byte
   differences. This exists but requires `--listen` (probe mode), which is not available
   in `--script` mode.

6. **No minimap grid visualization.** The minimap dump is a flat list of
   `(i,j):nonzero_count` values. For an 8x8 board, a simple grid would be far more
   readable:
   ```
    014 001 001 001 001 001 001 020
    001 001 001 001 001 001 001 001
    ...
   ```

7. **No way to identify organism type.** The minimap only shows non-zero byte counts.
   There is no command to answer "which cells have nano-2x vs triplicator code?"
   without individually inspecting each cell. A `scan` command (like the probe's
   fingerprint scan) would be invaluable.

8. **No command to show just the code bytes.** When inspecting a cell, you get a
   full 1024-byte hex dump. Most cells have code only in the first 8-50 bytes.
   A `code` command that shows just the non-zero code region would cut noise.

9. **No `wait` documentation.** The `wait N` command (step N interrupts without
   output) exists in script mode but is not in `help` text and not available in
   interactive mode.

10. **No interrupt counter in step output.** `step 100` says "Stepped 100 interrupts.
    Total: 100" but does not say how many CPU cycles elapsed or how many BRK copies
    occurred. These would be useful for understanding dynamics.

### Awkward

11. **Screen dumps are enormous.** A single `dump` in script mode produces ~80 lines,
    including a full 1024-byte hex dump of the focus cell. When stepping and dumping
    repeatedly, output grows to tens of thousands of lines. Need: a compact dump mode.

12. **`dump` output not designed for diffing.** To compare two cells, you must run
    `dump` twice, scroll through 80 lines each, and visually diff. A side-by-side
    or unified diff would be much better.

13. **No way to "grep" for a byte pattern across cells.** To find which cells
    have nano-2x code, I had to inspect each cell individually. Want: `find 00F500F6`
    to search all cells for a byte pattern.

14. **`preset` command in script mode is async.** The command returns `null` and
    prints the result asynchronously. In script mode, there is a 100ms `await` to
    handle this, but it means the preset may not be fully loaded before the next
    command runs. This could cause race conditions.

15. **Command pane output duplicated in dump.** Every `dump` includes the full
    COMMAND OUTPUT section, which repeats all previous commands. After 10 commands,
    this section alone is 20+ lines of noise.

### Delightful

16. **Script mode itself.** Being able to write a script file and run it headlessly
    is extremely useful. The `#` comment support is nice.

17. **`dump` output format.** The structured output with labeled sections (DISASM,
    MEMORY, MINIMAP, COMMAND OUTPUT) is well-organized and parseable.

18. **Preset system.** `preset triplicator` just works. The preset list with
    descriptions is helpful.

19. **Register display.** `regs` gives a clean one-line summary with all registers
    and flags decoded.

20. **Hex dump with ASCII.** The hex dump shows both hex and ASCII, which is useful
    for spotting string-like data in cell memory.

---

## Proposed Improvements

### P0: Fix bugs

1. **Write page 3 when loading presets.** In `terminal.js` and the `preset` command
   in `commands.js`, add `writeCellBytes(controller, ci, cj, 0x300, bytes)`.

2. **Rename `dump` (screen dump) to `screen` or `snapshot`.** Keep `dump ADDR N`
   for hex dumps. Or: make bare `dump` do a compact summary instead of full dump.

### P1: Script mode essentials

3. **Add `disasm-print [ADDR] [N]` command** that outputs N lines of disassembly
   to stdout in script mode, instead of just moving the pane cursor.

4. **Add compact minimap grid output.** When board <= 16x16, render as a grid with
   3-digit non-zero counts or single-char activity indicators:
   ```
   --- MINIMAP GRID ---
    .  .  .  .  .  .  .  .
    .  8  .  .  .  .  .  .
    .  .  8  .  .  .  .  .
    .  .  .  .  .  .  .  .
    .  .  . 88 92 84 83  .
    ...
   ```

5. **Add `diff I,J I,J` without requiring --listen.** Just do a direct byte-by-byte
   comparison using `readCellMemory`.

6. **Add `find HEXBYTES` command.** Search all cells for a byte pattern, report matches.

### P2: Quality of life

7. **Add `compact-dump` or `summary` command** that shows:
   - Interrupt count and board size
   - Register summary for focus cell
   - First 2 lines of disassembly
   - Minimap grid
   - Skip the 32-line hex dump

8. **Add `step-dump N` convenience** that steps N interrupts and outputs a compact
   summary, for iterative exploration scripts.

9. **Document `wait` in help text.** Add note that it is a script-mode-only command.

10. **Add cycle/copy counters to `step` output.** "Stepped 100 interrupts
    (14,523 cycles, 37 BRK copies). Total: 500 interrupts."

---

## Key Dumps

### Challenge 1: nano-2x at (1,0) after 500 interrupts
```
--- DISASM: Cell (1,0) ---
A=F7 X=7B Y=73 S=83 PC=0000 P=10
> $0000  00        BRK
  $0001  F5 00     SBC $00,X
  $0003  F6 D0     INC $D0,X
  $0005  FA        ??? $FA
  $0006  F0 F8     BEQ $0000
  $0008  60        RTS
```
(Correct nano-2x code. Disassembler misinterprets BRK operands as instruction args.)

### Challenge 2: Mutated nano-2x at (6,6) after 4000 interrupts (epsilon=0.001)
```
$0000  00 F5 00 F6 D0 FA E1 FA  (page 0, mutated: F0->E1, F8->FA)
$0200  00 F5 00 F6 D0 FA F0 F8  (page 2, still correct)
```

### Challenge 3: Triplicator page 3 incomplete after 500 interrupts (epsilon=0)
```
$0000  00 F5 C6 40 10 04 A9 30 85 40 ...  (page 0, correct)
$0200  00 F5 C6 40 10 04 A9 30 85 40 ...  (page 2, correct)
$0300  00 00 00 00 00 00 00 00 00 00 ...  (page 3, EMPTY -- bug)
$0326                    99 00 00 99 ...  (partial repair in progress)
```

### Challenge 4: nano-2x wins at 10000 interrupts
```
Every cell on the 8x8 board:
$0000  14 F5 00 F6 D0 FA F0 F8
```
nano-2x completely overwrote the triplicator.
