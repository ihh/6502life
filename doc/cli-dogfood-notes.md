# CLI/IDE Dogfooding Notes

Systematic exploration of the 6502life CLI tools, testing reproducibility,
investigating replicator dynamics, and noting improvements.

## Phase 1: Reproducible Screen Dumps

### What was added

Two new flags for `terminal.js`:

- `--script <file>`: Runs commands from a file in headless mode (no TUI).
  Supports `step N`, `wait N`, `dump`, comments (`#`), and all normal
  debugger commands. Exits after script completes.

- `--dump <file>`: When used with `--script`, saves a plain-text screen dump
  to the specified file after script execution.

The `dump` command generates an ANSI-free text representation of all four
panes: disassembler (registers + disassembly), memory (full 1024-byte hex
dump of focused cell), minimap (active cell list), and command output log.

### Determinism fix

The Sfotty CPU constructor leaves registers uninitialized and sets
`resetPending = true`, causing the first `run()` call to execute a reset
sequence that reads from memory in a non-deterministic way. The script mode
fix clears `resetPending`, resets `cycleCounter`, and calls
`readRegisters()` to initialize the CPU from the cell's register save area.

### Reproducibility test

```bash
echo "step 100" > /tmp/script.txt
echo "dump" >> /tmp/script.txt
node cli/bin/terminal.js --size 8 --preset nano-2x --cell 0,0 --script /tmp/script.txt > dump1.txt
node cli/bin/terminal.js --size 8 --preset nano-2x --cell 0,0 --script /tmp/script.txt > dump2.txt
diff dump1.txt dump2.txt   # identical
```

## Phase 2: CLI Exploration

### 2.1 nano-2x after 100k interrupts

```bash
node cli/bin/run.js --size 8 --seed 42 --asm presets/nano-2x.asm --cell 0,0 \
    --interrupts 100000 --save /tmp/nano2x-100k.json
node cli/bin/inspect.js --state /tmp/nano2x-100k.json --cell 0,0 --all
node cli/bin/disasm.js --state /tmp/nano2x-100k.json --cell 0,0 --lines 16
node cli/bin/heatmap.js --state /tmp/nano2x-100k.json --metric entropy
```

**Observations:**
- The nano-2x (8 bytes: `BRK $F5 / BRK $F6 / BNE @start / BEQ @start`)
  spreads aggressively across the 8x8 board.
- After 100k interrupts, cell (0,0)'s code is heavily corrupted. The
  original 8-byte pattern is no longer recognizable in most cells.
- The BRK copies introduce noise (default epsilon=1/2048), so copies
  accumulate mutations. Since nano-2x has no self-repair mechanism,
  the code degrades rapidly.
- Most cells remain "active" (non-zero) but the original replicator
  logic is largely destroyed. The board is in a post-replicator entropy
  state.
- Entropy heatmap shows uniform high entropy (0.716-0.732) across all
  cells, indicating the board has reached a statistically homogeneous
  state.
- The 10 most recently active cells show write and move times spread
  across the simulation, confirming ongoing (if degraded) activity.

### 2.2 Triplicator mid-spread at epsilon=0

```bash
node cli/bin/run.js --size 16 --seed 42 --asm presets/triplicator.asm --cell 0,0 \
    --interrupts 50000 --epsilon 0 --save /tmp/trip-50k-e0.json
node cli/bin/disasm.js --state /tmp/trip-50k-e0.json --cell 0,0 --cell 1,0 --diff
```

**Observations:**
- At epsilon=0 (perfect copy), the triplicator spreads without mutation.
- After 50k interrupts, the code is byte-identical between cells (0,0)
  and (1,0): all 51 bytes of the triplicator match exactly.
- The self-repair mechanism (majority vote over pages 0, 2, 3) is
  unnecessary at epsilon=0 but executes harmlessly.
- Census at 5000 interrupts: 34 of 256 cells are active, all copies
  sharing the same original fingerprint pattern.

### 2.3 Muller's Ratchet with the triplicator

```bash
# Run at epsilon=1/8192 at various checkpoints
for ints in 10000 50000 100000 200000; do
    node cli/bin/run.js --size 16 --seed 42 --asm presets/triplicator.asm --cell 0,0 \
        --interrupts $ints --epsilon 0.0001220703125 --save /tmp/trip-${ints}-e8192.json
done
# Disassemble cell (0,0) at each checkpoint
for ints in 10000 50000 100000 200000; do
    echo "=== $ints interrupts ==="
    node cli/bin/disasm.js --state /tmp/trip-${ints}-e8192.json --cell 0,0 --lines 24
done
```

**Observations show clear Muller's Ratchet degradation:**

| Checkpoint | Code status |
|------------|-------------|
| 10k | 2 mutations: `AND $0200,Y` -> `AND $2200,Y` (byte $18 bit flip); `ORA $41` -> `ORA $61` (byte $25 bit flip). Self-repair loop still mostly functional. |
| 50k | Additional corruption at byte $03: `DEC $40` / `BPL` sequence disrupted. Repair loop still running but repairing to a mutated consensus. |
| 100k | Significant degradation: `LDA $0200,Y` -> `STA $0200,Y` (opcode change!), `LDA $41` -> `LDA $41` (OK), but `SBC` replacing `LDA` at $14. The repair mechanism is now repairing to a broken consensus. |
| 200k | Heavily mutated: `DEC $40` -> `DEC $1068` (operand corruption), `BPL @go` -> `STY $A9` (opcode change). Self-repair loop is broken. Code is non-functional as a replicator. |

**Entropy over time:**

| Checkpoint | Min entropy | Max entropy | Avg entropy |
|------------|-------------|-------------|-------------|
| 10k   | 0.0046 | 0.2066 | 0.1862 |
| 50k   | 0.1888 | 0.2517 | 0.2214 |
| 100k  | 0.2579 | 0.2940 | 0.2811 |
| 200k  | 0.3313 | 0.3814 | 0.3621 |

Entropy increases monotonically as the triplicator's code degrades. The
min-max range narrows over time as all cells converge toward uniformly
high entropy. This is the classic Muller's Ratchet signature: without
recombination, deleterious mutations accumulate irreversibly.

The triplicator's majority-vote self-repair mechanism delays the ratchet
compared to nano-2x (which has no repair), but cannot prevent it
indefinitely. At epsilon=1/8192, the repair mechanism eventually gets
corrupted itself, leading to cascading failure.

## Phase 3: CLI/IDE Improvement Suggestions

### Missing features

1. **`--epsilon` flag for run.js / replay.js / terminal.js**: Neither
   `run.js` nor `replay.js` exposed the `pBitNoise` parameter, making it
   impossible to experiment with different mutation rates from the CLI.
   (Fixed during this dogfood session for run.js and terminal.js.)

2. **`--preset` flag for run.js**: The run.js tool does not support
   `--preset`, requiring the user to know the path to preset .asm files.
   The terminal.js tool supports presets but run.js does not.

3. **`--zero` flag for run.js**: No way to zero out the board before
   loading a program. The default board has random content from the
   Mersenne Twister initialization, which means cells other than the
   target cell have random (non-zero) data. This affects experiments
   since random bytes occasionally decode as valid BRK copy instructions.

4. **Multi-cell inject in run.js**: Cannot place programs in multiple
   cells in a single run.js invocation. Must use inject.js first, save
   state, then load it. Would be convenient to have
   `--asm prog.asm --cell 0,0 --asm prog2.asm --cell 5,5`.

5. **Census in run.js**: No way to get periodic census snapshots during
   a run.js execution. Must use replay.js, which has a different
   interface. A `--census N` flag for run.js would be useful.

6. **Diff between time points**: No tool to diff the same cell across
   two saved states. `disasm.js --diff` compares two cells within one
   state, but comparing cell (0,0) at 10k vs 50k interrupts requires
   manual inspection.

### Broken

1. **Write heatmap always shows zero**: The write heatmap
   (`heatmap.js --metric writes`) shows all zeros because it computes
   recency relative to `controller.totalCycles`, which is not preserved
   in the saved state (the state serialization saves memory and CPU
   registers but not the totalCycles/lastWriteTime/lastMoveTime arrays).
   The heatmap reconstructs a controller via `createBoard` + set state,
   but activity tracking data is lost.

2. **Sfotty non-determinism**: The Sfotty CPU constructor leaves
   registers uninitialized and sets `resetPending=true`. This means the
   first interrupt of any fresh board is non-deterministic: the reset
   sequence reads from memory addresses 0xFFFC/0xFFFD whose values
   depend on the memory mapper state. Fixed in script mode but the
   underlying issue affects all tools that create fresh boards.

3. **Phylo tree is empty**: `phylo.js --format ascii` with a lineage
   log from replay.js produces "251 nodes, 0 leaves, depth 0" even
   with 2000+ events. The tree builder does not seem to reconstruct
   parent-child relationships from brk-copy events correctly.

4. **"The 6502 CPU crashed" noise**: Sfotty prints `The 6502 CPU
   crashed` to stderr whenever it encounters an undocumented opcode.
   This is expected in 6502life (random cell content) and the controller
   handles it as BRK 0, but the message clutters stderr output of all
   CLI tools. The terminal.js patches `decode()` to suppress this, but
   run.js, replay.js, and other tools do not.

### Awkward

1. **No `--preset` on run.js**: Having to use `--asm presets/foo.asm`
   instead of `--preset foo` is a minor annoyance. The preset system
   is only available in terminal.js.

2. **State file is enormous**: Saving state for a 16x16 board produces
   a ~780KB JSON file (262144 bytes as a JSON array). For 256x256
   boards this would be ~200MB. Binary format or compression would help.

3. **No progress indicator in run.js**: Running 100k+ interrupts takes
   several seconds with no output. replay.js prints progress every 1000
   interrupts, but run.js is silent (unless `--quiet` is not set, in
   which case it prints results at the end but still no progress).

4. **Heatmap display in terminal**: The terminal-rendered heatmaps use
   half-block characters with ANSI colors, which look reasonable but are
   hard to interpret for small boards (8x8 = 8 characters wide). A
   numeric table mode would be more useful for scripted analysis. The
   `--json` flag works but produces raw data without summary statistics.

5. **disasm.js diff format**: The side-by-side diff works but doesn't
   highlight which bytes actually differ. At epsilon=0, identical code
   produces identical output (good), but at higher epsilon the diff
   doesn't mark changed bytes/instructions.

6. **No way to run terminal.js script with a preset and dump to stdout
   in a single pipeline**: The example `terminal.js --preset nano-2x
   --script script.txt > dump.txt` works, but you have to create the
   script file first. An inline `--exec` flag accepting a semicolon-
   separated command string would enable one-liners:
   `terminal.js --preset nano-2x --exec "step 100; dump" > dump.txt`
