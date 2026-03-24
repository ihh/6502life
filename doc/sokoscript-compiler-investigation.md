# SokoScript to 6502life Compiler: Feasibility Investigation

## 1. SokoScript Semantics

SokoScript defines 2D cellular automata via declarative pattern-matching grammar rules
on a toroidal grid. Key aspects:

### Cell Model
- Each cell has a **type** (a named string like `bee`, `tree`, `fire`) and a **state**
  (a variable-length string of ASCII characters 33-126, encoding integers mod 94 and
  2D vectors in range [-4,+4]).
- The empty type `_` represents an unoccupied cell. The type `?` matches any cell.
- Types support **single inheritance** (`child = parent1, parent2.`), where children
  inherit all transformation rules from their parents.

### Rule Structure
Each rule has the form:
```
subject [address] neighbor [address] neighbor ... : replacement ..., attributes.
```

**Left-hand side (LHS)**: A pattern matching the subject cell and its neighbors.
- The subject is always first; subsequent terms specify neighbors.
- Neighbor addresses are relative (`>F>`, `>R>`, `>B>`, `>L>`) or absolute (`>N>`, `>E>`, `>S>`, `>W>`), or computed from state characters.
- State patterns support wildcards (`?`), character classes (`[abc]`), negation (`^type`), and alternatives (`(a|b|c)`).

**Right-hand side (RHS)**: What the matched cells become.
- Can reference LHS cells (`$1`, `$2`), apply new state (`$1/newState`), or create new types.
- State expressions compute new values: `@add`, `@sub` (cyclic arithmetic), `@clock`/`@anti` (rotation), matrix transforms (`%R`, `%L`), and back-references to matched state (`$#1`, `$g#n`).

### Evolution Model
SokoScript supports two evolution modes:

1. **Asynchronous (default)**: The engine samples random cells weighted by type rates.
   Each rule has a `rate=N` (events/second). A random cell of the appropriate type
   is picked, a random direction chosen, and if the LHS pattern matches, the RHS
   replacement is applied. This is a continuous-time Markov process with exponential
   inter-event times.

2. **Synchronous** (`sync=N`): All matching instances fire simultaneously at N Hz.
   The engine collects all cells matching the rule, shuffles them, and applies all
   updates in that shuffled order within a single synchronous tick.

Rules involving 2-3 cells are typical. The sandpile grammar is the most complex
example, using state arithmetic and directional propagation across up to 2 cells.

### Example Grammars (complexity range)
- **Diffusion** (`x _ : _ x.`): 1 rule, 2 cells, no state -- simplest possible.
- **Ecosystem**: 8 rules, 5 types, no state -- predator-prey dynamics.
- **Rock-Paper-Scissors**: 10 rules, 4 types with inheritance, no state.
- **Sandpile**: 7 rules, 3 types, state arithmetic with `@add`/`@sub`/`@clock`, direction-encoded state.
- **Sokoban**: 16 rules, 5 types, 3-cell push patterns, keyboard-driven.

## 2. 6502life Target

### What Compiled Code Must Do
Each cell runs an independent 6502 program in 1024 bytes of local RAM. The program:
1. Wakes from an interrupt at a random orientation (N/E/S/W).
2. Reads its own state and the states of neighbors in a 7x7 memory-mapped window (49 cells, each 1024 bytes, mapped at 0x0000-0xBFFF).
3. Decides what transformation to apply based on pattern-matching rules.
4. Writes new state values to its own cell and/or neighbor cells.
5. Optionally issues a BRK to swap cells (operands 1-244) or noisily copy self (operands 245-252), then yields to the scheduler.

### Key VM Constraints
- **1024 bytes per cell**: Divided into zero page (0x00-0xEF usable), stack (0x100-0x1FF), code/data (0x200-0x3BF), display area (0x3C0-0x3FF). Effectively ~800 bytes for code+data.
- **7x7 neighborhood**: 49 cells visible, addressed via memory pages.
- **Random orientation**: Each interrupt randomly rotates the neighborhood by 0/90/180/270 degrees. Programs see a consistent relative frame, but absolute directions change.
- **Asynchronous scheduling**: One cell runs at a time, with Poisson-distributed interrupts (~4096 cycles between interrupts on average).
- **BRK semantics**: Swap two cells (for movement) or noisy-copy self to a neighbor (for replication). No mechanism for arbitrary cell creation.
- **ROM lookup tables** at 0xE000-0xEE3F: Vector addition, rotation, reflection, coordinate-to-cell-index mapping.

## 3. Key Challenges

### 3.1 Declarative vs. Imperative
SokoScript rules are declarative pattern-matching; 6502 is imperative machine code.

**Mitigation**: This is a standard compilation problem. Each rule compiles to a sequence of: (a) load neighbor cell bytes, (b) compare against pattern, (c) branch on mismatch, (d) compute new state, (e) write results. The compiler generates a chain of if-then-else blocks, one per rule, tried in priority order.

**Difficulty**: Low. This is the most tractable part of the problem.

### 3.2 Typed Cells with String State vs. Raw Bytes
SokoScript cells have a named type and a variable-length state string of ASCII characters. 6502life cells are 1024 bytes of raw memory with no type system.

**Mitigation**: Reserve a fixed byte (e.g., offset 0x00 or 0xE0) as a **type tag** -- an integer 0-255 encoding the cell type. Reserve a small region (e.g., 0xE1-0xEF, 15 bytes) for the **state string**. This is generous: most SokoScript grammars use 0-4 state characters, and the sandpile (the most complex) uses at most 2.

The type tag byte is the key coordination mechanism: every compiled SokoScript program reads neighbor type tags to decide which rules match. All SokoScript programs on the board must agree on the type-tag encoding.

A grammar with N types needs N+1 tag values (including `_` = empty). Since most grammars have fewer than 20 types, a single byte is ample. The empty type `_` could be encoded as tag 0x00 (matching random/uninitialized memory).

**Difficulty**: Low. The encoding is straightforward.

### 3.3 Multi-Cell Pattern Matching
SokoScript rules reference patterns across 2-3 cells (subject + 1-2 neighbors). The compiled 6502 program must read the type tags and state bytes of those specific neighbors.

**Mitigation**: The 6502life memory map provides direct access to all 49 neighbor cells. Reading a neighbor's type tag is a single `LDA` from the appropriate page offset. For a rule like `player >N> crate >N> _ : _ player crate`, the compiler emits:
```
LDA $04E0    ; read North neighbor type tag (cell 1, offset 0xE0)
CMP #TYPE_CRATE
BNE next_rule
LDA $09E0    ; read North-North type tag (cell 9 = N^2, offset 0xE0)
CMP #TYPE_EMPTY
BNE next_rule
; ... apply transformation
```

The ROM lookup tables at 0xE000 can resolve computed addresses (e.g., `>1>` direction from state) at runtime.

**Difficulty**: Medium. Simple directional patterns are easy. State-dependent addressing (`>1>`) requires runtime lookup table access, adding ~10-15 instructions per computed address. Still feasible.

### 3.4 Synchronous vs. Asynchronous Update (CRITICAL)
This is the most fundamental mismatch between the two systems.

**SokoScript synchronous rules** (`sync=N`): All matching cells update simultaneously based on the board state at the start of the tick. No cell sees another cell's updates until the next tick.

**SokoScript asynchronous rules** (`rate=N`): A random cell is picked; if the rule matches, it fires immediately. Other cells see the update on their next evaluation.

**6502life**: Cells are scheduled one at a time, in random order, with Poisson timing. There is no global synchronization barrier. Each cell sees the current (possibly partially-updated) board state.

**Implications**:
- **Asynchronous SokoScript rules map well to 6502life.** The stochastic scheduling of 6502life naturally implements rate-based asynchronous evolution. The `rate` parameter maps to how aggressively the program applies rules when it wakes up (e.g., always apply = maximum rate; apply with probability p = reduced rate). Since 6502life already uses Poisson scheduling, the statistical behavior will be qualitatively similar.
- **Synchronous SokoScript rules cannot be faithfully implemented.** 6502life has no mechanism for global barriers or double-buffering. Possible workarounds:
  - **Double-buffer in cell memory**: Each cell maintains a "current" and "next" state region. A global clock byte (e.g., in a special cell type) toggles which buffer is active. Cells read from the "current" buffer and write to the "next" buffer. But there is no global clock mechanism in 6502life -- the clock cell itself is subject to random scheduling.
  - **Approximate with async**: For many practical grammars, synchronous semantics are not essential. The `sync_diffuse.txt` grammar (`x _ : _ x, sync=1.`) behaves similarly to its async counterpart. For most CA applications, async updates are an acceptable approximation.
  - **Accept race conditions**: In practice, 6502life's random scheduling with random orientation already introduces stochasticity. For grammars where synchronous semantics are not critical to correctness (most of them), the async approximation is fine.

**Verdict on sync**: Synchronous rules are the single biggest blocker for *faithful* compilation. For *approximate* compilation (which is arguably in the spirit of 6502life), this is acceptable. Grammars that rely on sync semantics for correctness (e.g., parity-based CA like Rule 110) would not work.

**Difficulty**: High for faithful sync; Low for async-only or approximate compilation.

### 3.5 Code Size Budget
Is 1024 bytes enough for compiled rules?

**Per-rule cost estimate**:
- Type-tag check: 5 bytes (LDA addr, CMP #imm, BNE offset)
- State character check: 5 bytes per character
- State write: 5 bytes per character
- Type-tag write: 5 bytes
- Branch to next rule: 3 bytes
- Total per simple 2-cell rule: ~25-35 bytes

**Grammar size estimates**:
- Diffusion (1 rule): ~40 bytes (rule + setup + BRK)
- Ecosystem (8 rules, no state): ~300 bytes
- Rock-Paper-Scissors (10 rules): ~350 bytes
- Sandpile (7 rules, state arithmetic): ~400-500 bytes
- Sokoban (16 rules, 3-cell patterns): ~600 bytes (but keyboard rules are irrelevant in 6502life)

With ~736 usable bytes, all existing SokoScript grammars fit comfortably. A grammar with ~20 rules and moderate state complexity would approach the limit. Very large grammars (50+ rules) might not fit.

**Difficulty**: Low for existing grammars. Medium for hypothetical large grammars.

### 3.6 Movement and Replication Semantics
SokoScript rules that move cells (e.g., `bee _ : _ bee`) destroy the source cell and create the destination cell. In 6502life:
- **Cell movement** maps to BRK swap operations (operands 1-244). The subject cell can swap with any of the 49 neighbors.
- **Cell creation** (e.g., `herbivore plant : herbivore herbivore`) maps to BRK noisy-copy (operands 245-252), but only the origin cell can be copied, and only to the 8 nearest neighbors. The copy is noisy (bit-flip probability ~1/2048).
- **Cell destruction** (changing a cell to `_`) maps to zeroing out the type tag byte of a neighbor.
- **Type transmutation** (e.g., `tree fire : fire fire`) can be done by writing a new type tag and state to the neighbor cell.

Most SokoScript transformations are actually type/state rewrites, not physical cell movements. These map naturally to 6502 store instructions writing to neighbor memory pages.

**Difficulty**: Low-Medium. Most rules are just memory writes. The noisy-copy limitation means that SokoScript rules creating identical copies (`$1 $1`) would need to use byte-by-byte STA copying instead of BRK noisy-copy, which is exact but slower.

### 3.7 Random Orientation
6502life randomly rotates the memory map each interrupt. SokoScript rules with absolute directions (`>N>`, `>E>`, `>S>`, `>W>`) would need to be remapped.

**Mitigation**: The oriented registers at 0xF0-0xF9 are auto-rotated. The ROM tables provide rotation lookups. The compiler can either:
- Use only relative directions (`>F>`, etc.) -- already orientation-invariant.
- For absolute directions, use the ROM rotation tables to undo the random orientation. The orientation is implicitly encoded by which physical neighbor maps to which logical address. The ROM at 0xEC40-0xECFF provides rotation lookups.

Actually, since SokoScript rules with relative directions (`>F>`) pick a random direction anyway (via `dir = lookups.dirs[r3 >>> 30]` in `nextRule()`), the random orientation of 6502life naturally implements this. The compiled program simply treats "forward" as whatever direction the memory map happens to present.

For absolute directions, the program would need to track or recover its true orientation -- which 6502life does not easily support across interrupts (orientation is re-randomized). This means **absolute-direction rules are problematic** in 6502life unless the grammar can tolerate directional randomization.

**Difficulty**: Low for relative-direction grammars. High for absolute-direction grammars (e.g., Sokoban with NSEW movement). However, most autonomous CA grammars (the primary use case) use relative directions or are direction-independent.

## 4. Compilation Approach (If Feasible)

### 4.1 Cell State Encoding
```
Offset 0x00:      Type tag (1 byte: 0=empty, 1..N=type index)
Offset 0x01-0x10: State string (up to 16 chars, ASCII 33-126)
Offset 0x11:      State length (1 byte)
```
Total overhead: 18 bytes per cell for type+state metadata. With 49 cells visible, the compiled program can read any neighbor's type/state by loading from the right page and offset.

### 4.2 Rule Compilation
Each rule compiles to a block of 6502 assembly:

```asm
rule_N:
  ; Check subject type (cell 0 = self)
  LDA $00E0          ; own type tag at chosen offset
  CMP #TYPE_SUBJECT
  BNE rule_N_plus_1

  ; Check subject state (if any)
  LDA $00E1
  CMP #EXPECTED_CHAR
  BNE rule_N_plus_1

  ; Check neighbor type (e.g., cell 1 = North/Forward)
  LDA $04E0          ; neighbor type tag
  CMP #TYPE_NEIGHBOR
  BNE rule_N_plus_1

  ; Pattern matched -- apply transformation
  ; Write new type tag to self
  LDA #TYPE_NEW_SELF
  STA $00E0
  ; Write new type tag to neighbor
  LDA #TYPE_NEW_NEIGHBOR
  STA $04E0
  ; Write state characters
  LDA #NEW_STATE_CHAR
  STA $04E1

  ; Yield
  BRK
  .byte $00
```

### 4.3 Handling the Sync Mismatch
For async rules: compile directly as above. The 6502life Poisson scheduler naturally implements stochastic async evolution.

For sync rules: accept approximate behavior. The compiler emits the same pattern-match-and-rewrite code. Document that synchronous semantics are approximated as high-rate asynchronous rules.

### 4.4 BRK Usage for Movement
SokoScript movement rules (`x _ : _ x`) can compile to:
```asm
  ; After writing empty type to self and x type to forward neighbor:
  ; Optionally use BRK swap to physically move the cell
  ; BRK operand = src*49 + dest
  ; src=0 (origin), dest=1 (North) => operand = 1
  BRK
  .byte $01          ; swap origin with North neighbor
```

However, for SokoScript purposes, physical swapping is unnecessary -- simply rewriting the type tags achieves the same logical effect. BRK swaps would only matter if the cell's *code* needs to move (self-replicating programs), which is not a SokoScript concern.

### 4.5 Compiler Architecture
The compiler would be a JavaScript tool (fitting the existing CLI ecosystem):
1. Parse SokoScript grammar (reuse existing PEG parser from sokoscript/src/grammar.js)
2. Compile types and expand inheritance (reuse gramutil.js)
3. For each type, emit a 6502 assembly program that:
   - Checks which rules match (type tag + state comparisons on neighbors)
   - Applies the first matching rule (writes new type tags + states)
   - Yields via BRK
4. Assemble to hex using 6502life's assembler (engine/assembler.js)
5. Output a board state JSON with the compiled programs loaded into cells

## 5. Verdict

### Feasibility: FEASIBLE (with caveats)

**What works well**:
- Async SokoScript rules map naturally to 6502life's stochastic scheduling
- The 1024-byte cell budget is sufficient for all existing SokoScript grammars
- Pattern matching on neighbor types/states compiles straightforwardly to 6502 load-compare-branch sequences
- The 7x7 neighborhood provides ample reach for SokoScript's 1-2 neighbor patterns
- State encoding (type tag + state bytes) fits easily in the cell memory layout
- The existing toolchain (assembler, CLI runner, TUI debugger) supports the full development workflow

**What does not work**:
- **Synchronous rules** cannot be faithfully implemented (no global barrier). Approximate async behavior is acceptable for most use cases.
- **Absolute-direction rules** (Sokoban-style `>N>`/`>E>`/`>S>`/`>W>`) conflict with 6502life's random orientation. Player-controlled grammars (keyboard input) are not applicable to 6502life anyway.
- **Noisy copy**: BRK noisy-copy introduces bit errors (~4 per cell), so SokoScript replication rules that need exact copies should use byte-by-byte STA instead.

**What is interesting**:
- Once compiled, SokoScript programs become self-sustaining 6502 organisms. They could coexist and compete on the same board, creating an ecosystem of declarative rule systems encoded as machine code.
- The compiler could generate "species" that implement different SokoScript grammars, then release them on the same 6502life board to see which rule systems dominate.
- SokoScript grammars with self-replication rules (e.g., `bee _ : bee bee`) would produce 6502 programs that replicate via byte-by-byte copying, evolving under 6502life's mutation model.

### Estimated Effort
- **Prototype compiler** (async rules, simple types, no state): 2-3 days
- **Full compiler** (state expressions, inheritance, character classes): 1-2 weeks
- **Testing and polish**: 1 week
- **Total**: 2-4 weeks for a working compiler

### Key Blockers
1. **Sync rules**: Not faithfully implementable. Acceptable if documented as async approximation.
2. **Absolute directions**: Would require orientation tracking, which is at odds with 6502life's design philosophy. Workaround: restrict to relative-direction grammars, or accept that "North" means "forward" (whichever direction the random orientation gives).
3. **No real blockers for async, direction-independent grammars** -- these are the most natural fit for 6502life's cellular automata model, and they compile cleanly.
