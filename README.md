# 6502life

**[6502life.com](https://6502life.com)** -- A virtual grid of interconnected 6502 CPUs. Self-replicating programs emerge from cryptographic random seeds.

## The Primordial Soup

A 6502life board is a 2D grid of cells, each running a 6502 CPU with 1KB of memory.
Adjacent cells share memory, allowing programs to read and write their neighbors.
The board is initialized from a **ChaCha20 stream cipher** keyed by a 32-bit seed.

Most seeds produce gibberish. But roughly 1 in 2^60 random 8-byte sequences
encodes a viable **self-replicating program** -- a copy loop that spreads
across the board:

```
B5 00 9D 00 04 E8 90 F8    LDA $00,X / STA $0400,X / INX / BCC loop
```

Finding a seed that contains one of these replicators is a **cryptopuzzle**.
The ChaCha20 cipher ensures there is no shortcut -- you must search the space.

## Replicator Variants

The minimal replicator family has 4 viable 8-byte forms
(2 index registers x 2 branch opcodes):

| Hex | Instructions | Loop type |
|-----|-------------|-----------|
| `B5 00 9D 00 04 E8 90 F8` | LDA/STA/INX/BCC | Infinite (C unaffected) |
| `B5 00 9D 00 04 E8 50 F8` | LDA/STA/INX/BVC | Infinite (V unaffected) |
| `B5 00 9D 00 04 CA 90 F8` | LDA/STA/DEX/BCC | Infinite (C unaffected) |
| `B5 00 9D 00 04 CA 50 F8` | LDA/STA/DEX/BVC | Infinite (V unaffected) |

Longer variants (9-25 bytes) include **NOP slides** -- harmless opcodes
inserted between the core bytes. There are 92 safe slide opcodes
(22 single-byte + 43 two-byte + 27 three-byte). Many more variants
remain to be discovered.

## Effective Information Content

The probability that a random byte stream of length L contains a viable
replicator is governed by B_eff (effective information content):

| Constraint | Bits |
|-----------|------|
| LDA opcode = $B5 | 8 |
| Source address = $00 | 8 |
| STA opcode = $9D | 8 |
| Address match (byte 3 = byte 1) | 8 |
| Destination page = $04 | 8 |
| INX or DEX + BVC or BCC (4 pairs / 65536) | 14 |
| Branch offset correct for length | 8 |
| **Total** | **62 bits** |

With multi-length summation (viable programs of length 8-32 contribute
independently), cumulative B_eff converges to approximately **60 bits**.

## Verified Discovery

6502life provides a **Merkle tree** simulation history that allows
third-party verification of organism discovery:

1. A **Board Contract** specifies the ChaCha20 seed, board size,
   simulation parameters, and mining difficulty
2. The board runs, producing a hash-chained block history with
   Merkle proofs at each checkpoint
3. Anyone can replay the simulation from the seed and verify that
   a replicator emerged at the claimed tick

The cryptographic seed requirement serves as a **discovery throttle**:
you cannot engineer a replicator into the initial state without finding
a seed that produces it. This makes discovery meaningful.

## Coin Economy

A **coin mechanism** meters board writes:

- Coins are earned by running the simulation (1 coin per 1000 ticks)
- Coins are spent to write bytes to cells (moves)
- Coins decay with a half-life (use them or lose them)
- Sharing your board boundary with neighbors earns coins at 2x rate

This creates a resource constraint: what is the most successful organism
you can design with a limited byte budget? Contracts could grant users
a starting allowance (e.g., 20 bytes) plus a trickle (one bit per day),
making organism design a long-term strategic challenge.

## Try It

**[6502life.com](https://6502life.com)** runs the bare-sim demo in your browser.
Click **Soup** for a random board, or **Rep** to inject the canonical replicator
and watch it spread.

## Development

```bash
npm install
npm test          # 272 tests across 23 files
```

### Replicator Science (dfa/)

A WFST (weighted finite-state transducer) pipeline for scoring, generating,
and training replicator models. Trains transition weights from simulation
via EM with AND-gate blame assignment, validated by importance sampling.
See `dfa/GPU-AGENT-README.md` for details.

### Coin Protocol (coin/)

ChaCha20 board initialization, Merkle tree history, session recording,
block hash chains, coin economics. Board contracts commit to parameters
before seeing the initialization.

### Repository Layout

| Directory | Purpose |
|-----------|---------|
| `webgpu/` | Bare-sim engine + browser demo (the site at 6502life.com) |
| `dfa/` | WFST replicator pipeline: scoring, training, experiments |
| `coin/` | Coin protocol: ChaCha20 init, Merkle trees, sessions, contracts |
| `board/` | Full BoardController: 7x7 neighborhood, noise, BRK dispatch |
| `engine/` | Shared layer: board creation, assembler, formatting |
| `presets/` | Assembly presets (.asm files, auto-loaded) |
| `cli/` | Command-line tools: assembler, runner, inspector, debugger |
| `app/` | React+Vite web dashboard (legacy, being superseded by webgpu demo) |
| `tex/` | LaTeX: system spec, replicator probability, WFST training, DL survey |

### CLI Quick Reference

```bash
# Bare-sim (pair-based, no noise -- where the 8-byte replicators work)
node cli/bin/bare-run.js --preset bare-rep --cell 0,0 --passes 100
node cli/bin/bare-tui.js --preset bare-rep --cell 0,0        # interactive

# Full BoardController (noise, BRK dispatch, 7x7 neighborhood)
node cli/bin/run.js --preset nano --cell 0,0 --interrupts 5000
node cli/bin/terminal.js --preset spreader --cell 0,0         # four-pane debugger
```

## Inspirations

- [Avida](https://en.wikipedia.org/wiki/Avida_(software)) -- artificial life with evolvable machine code
- [Core War](https://en.wikipedia.org/wiki/Core_War) -- competitive programs in shared memory
- [Tierra](https://en.wikipedia.org/wiki/Tierra_(computer_simulation)) -- self-replicating programs competing for CPU time

## Full Specification

See [tex/6502life.pdf](tex/6502life.pdf) and the [CLAUDE.md](CLAUDE.md) for
the complete system spec (memory map, interrupt model, BRK operations,
board hyperparameters).
