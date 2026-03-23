# 6502coin Protocol / SokoScript Engine Compatibility Analysis

## Summary

SokoScript is a strong candidate as a 6502coin backend engine, with most of the
Engine interface mapping naturally. The main friction points are: (1) SokoScript's
BigInt time model vs. the protocol's integer tick model, (2) boundary exchange
semantics that have no precedent in SokoScript, and (3) the Mersenne Twister PRNG
state being large (2500 bytes) which inflates serialized checkpoints. None of
these are blockers; all have clear paths to resolution.

---

## 1. Engine Interface Compatibility

### `init(config)`

**Compatible.** The `Board` constructor (`src/board.js:86-89`) accepts an options
object and calls `initFromJSON()`, which handles `size`, `seed`, `grammar`, and
`cell` array. The 6502coin `EngineConfig` fields map as follows:

| EngineConfig field | SokoScript equivalent |
|---|---|
| `width`, `height` | `size` (SokoScript uses square boards; would need extension for rectangular) |
| `seed` | `json.seed` passed to `new MersenneTwister(seed)` at `board.js:394` |
| `gameId` | New field; trivially added |
| `rules` | `json.grammar` (the SokoScript grammar source string) |

**Gap:** SokoScript only supports square boards (`size x size`). The protocol
specifies `width` and `height` independently. For a SokoScript engine, constraining
to square boards (width === height) is acceptable since 6502life itself uses square
boards.

### `step(n)`

**Partially compatible.** SokoScript's `evolveToTime(t, hardStop)` (`board.js:309-327`)
advances to a target time, not by a step count. There is no discrete "tick" concept
in the same sense as Game of Life. SokoScript uses BigInt time where 2^32 ticks = 1
second, and events occur at fractional times computed from exponential distributions.

The mapping requires defining what "one tick" means for a SokoScript engine:
- **Option A (natural):** One tick = one SokoScript time unit (1/2^32 second). Then
  `step(n)` calls `evolveToTime(this.time + BigInt(n), true)`. This preserves the
  protocol's integer tick model but means most ticks are no-ops (events are sparse).
- **Option B (practical):** One tick = one async rule firing. Then `step(n)` fires
  `n` successive `nextRule()` calls (`board.js:212-249`). This is more meaningful
  but breaks the protocol's assumption that `step(n)` advances by exactly n ticks,
  since each rule firing advances the clock by a variable amount.
- **Option C (recommended):** Define a fixed tick duration (e.g., 2^20 time units
  ~ 0.25ms) and step by those fixed intervals. `step(n)` calls
  `evolveToTime(this.time + BigInt(n) * tickSize, true)`. This gives deterministic,
  uniform steps compatible with the protocol's block interval model.

**Verdict:** Option C is recommended. Requires a thin wrapper, not a SokoScript
change.

### `serialize()` / `deserialize()`

**Compatible.** `Board.toJSON()` (`board.js:369-379`) and `Board.initFromJSON()`
(`board.js:389-418`) provide full state serialization. The JSON includes:
- `time` (BigInt as string)
- `lastEventTime` (BigInt as string)
- `rng` (Mersenne Twister state as base64, via `MersenneTwister.toString()` at
  `MersenneTwister.js:50-52`)
- `grammar` (source string)
- `types` (array of type names)
- `size` (integer)
- `cell` (array of `[typeIdx, state, meta?]` tuples)

The canonical JSON library (`canonical-json.js`) produces deterministic output with
sorted keys, matching the protocol's `canonicalJSON` requirement.

**Gap:** The protocol's `serialize()` returns `Uint8Array`, not a JSON string.
`Board.toString()` (`board.js:382-383`) returns a canonical JSON string, which can
be trivially encoded to UTF-8 bytes. Alternatively, a binary format could be designed,
but the canonical JSON approach is simpler and already deterministic.

**Size concern:** The Mersenne Twister state is 625 32-bit integers (2500 bytes as
raw data, ~3332 bytes as base64). For a 64x64 board with 4096 cells, each
checkpoint is ~50-100 KB as canonical JSON. This is larger than Life engine
checkpoints (which are ~500 bytes for a 64x64 board) but acceptable for the Merkle
tree model where only hashes are stored at most levels.

### `applyInput(input)`

**Compatible.** SokoScript's `Board.processMove()` (`board.js:251-283`) handles
three move types that map well to the protocol's `Input` interface:

| SokoScript move type | Protocol mapping |
|---|---|
| `command` | Player keystroke/command: `{ tick, action: { type: 'command', id, dir, command, key } }` |
| `write` | Cell placement: `{ tick, action: { type: 'write', cells: [...] } }` |
| `grammar` | Rule change: `{ tick, action: { type: 'grammar', grammar } }` |

SokoScript moves carry a `time` field (BigInt), which maps to the protocol's `tick`
field. The `evolveAndProcess()` method (`board.js:332-338`) already sorts moves by
time and interleaves them with evolution, exactly as the protocol requires.

**Gap:** The SokoScript move `time` is a BigInt in the 2^32-ticks-per-second system.
The protocol uses plain integer ticks. The adapter must convert between these time
scales consistently (using the tick duration defined for `step()`).

### `getBoundary(edge)` / `setBoundary(edge, data)`

**Not natively supported.** SokoScript has no concept of boundary exchange. The
`Board` class treats the grid as toroidal (coordinates wrap via modular arithmetic
at `board.js:13`). There is no method to extract or inject an edge strip.

**Implementation path:** Straightforward to add. For a size x size board:
- `getBoundary('north')`: serialize cells at row 0, columns 0..size-1.
- `setBoundary('north', data)`: overwrite those cells.

Each cell is `{type, state, meta}` -- a few bytes. For a 64-cell edge, boundary
data would be ~1-5 KB depending on state complexity.

**Semantic question:** When boundary data is written, do the injected cells participate
in rule matching on the next tick? Yes -- they become regular board cells. This is
correct for the edge-sharing model. However, the toroidal wrap means the north edge
is also adjacent to the south edge in solo mode. During edge sharing, the engine
should either:
- Temporarily break toroidal wrapping on the shared edge (making the shared edge
  adjacent to the partner's edge instead of the opposite edge), or
- Accept that the shared edge cells are also adjacent to the opposite edge (double
  influence).

The first option is cleaner but requires modifying `xy2index` or the neighbor
lookup during sharing sessions. The second option requires no code changes but
produces slightly different dynamics.

### `clock()`

**Compatible.** `Board.time` (`board.js:103-105`) tracks the current simulation
time as a BigInt. The adapter converts to the protocol's integer tick count by
dividing by the tick duration.

Note: `Board.timeInSeconds()` returns `Number(this.time) / 2**32`, confirming
the 2^32-ticks-per-second convention.

### `summarize()`

**Compatible.** No standard summary exists, but meaningful stats are easy to compute:

```javascript
summarize() {
  const typeCounts = this.board.typeCountsIncludingUnknowns(); // board.js:347-356
  const totalCells = this.board.size * this.board.size;
  const emptyCells = this.board.byType[0].total(); // type 0 = empty
  return {
    clock: this.clock(),
    totalCells,
    emptyCells,
    occupiedCells: totalCells - emptyCells,
    typeCount: Object.keys(typeCounts).length,
    typeCounts,
    rulesPerSecond: this.board.grammar.transform.reduce(
      (s, rules) => s + rules.length, 0
    )
  };
}
```

### `dimensions()` / `getCell()`

**Compatible.** `Board.getCell(x,y)` exists (`board.js:115-117`). It returns
`{type, state, meta}` which maps to the protocol's `CellView` with
`state = encode({type, state})` and `meta = cell.meta`.

---

## 2. Determinism

### PRNG: Fully deterministic and serializable

SokoScript uses Mersenne Twister (`MersenneTwister.js`), initialized from a seed
(`board.js:394`). The PRNG state is serializable via `toString()`/`initFromString()`
(`MersenneTwister.js:50-67`), which encode the full 625-integer state vector as
base64.

The PRNG is consumed in a deterministic order:
1. `nextRule()` (`board.js:212-249`) draws 3 random values per rule attempt:
   `r1` for wait time, `r2` for type/rule selection, `r3` for accept/reject and
   direction.
2. `knuthShuffle()` (`board.js:72-79`) for synchronous rule ordering.
3. `randomDir()` (`board.js:285-287`) for sync rule directions.

Given identical seed and move sequence, the PRNG state trajectory is identical.

### No floating-point in simulation logic

All SokoScript simulation arithmetic uses:
- **Integer BigInt** for time (`board.js:103`, `291-306`)
- **Integer lookup tables** for state character arithmetic (`lookups.js:36-39`)
- **Integer RNG** (`MersenneTwister.int()` returns `uint32`)

The only floating-point operation is in `fastLn_leftShift26()` (`log2.js`), used
to compute exponential waiting times. However, this function uses a piecewise-linear
approximation with integer arithmetic (left-shifted by 26 bits), not IEEE 754
floating point.

**Potential issue:** `randomInt()` (`board.js:62`) uses BigInt multiplication and
right-shift, which is exact. `randomBigInt()` (`board.js:63-70`) similarly uses
BigInt arithmetic. These are platform-independent.

**Verdict: Fully deterministic.** Given seed + moves, any conforming implementation
produces identical state at every tick. No floating-point or platform-dependent
operations in the simulation path.

---

## 3. Board Merge/Split

### Can two SokoScript boards be merged?

**Partially.** Two N x N boards can be concatenated into a 2N x N board by:
1. Remapping cell indices (cell array is row-major, `board.js:13`)
2. Merging type registries (both boards must use the same grammar)
3. Merging `byType` RangeCounters (requires reconstruction)

**Constraint:** `RangeCounter` (`board.js:19-59`) requires the cell count to be a
power of 2. Two N x N boards produce 2N^2 cells, which is a power of 2 only if
N^2 is a power of 2 (i.e., N is a power of 2). For the standard case of square
boards with power-of-2 sizes, merging into a rectangular board would require either:
- Extending `RangeCounter` to support non-power-of-2 sizes, or
- Merging into a 2N x 2N board with half the cells empty.

### Do rules work on arbitrary board sizes?

**Yes.** Rules are purely local (pattern-match on neighbors). The board size affects
only the toroidal wrapping in `xy2index()`. Rules fire correctly on any size board.

### Rules at the merge boundary

**Yes, rules fire across boundaries.** After merging, cells from Board A are adjacent
to cells from Board B at the merge seam. Since rules use relative neighbor lookups
(via `computeAddr` in `engine.js:103-115`), they will match across the boundary
naturally. This is exactly the desired behavior for edge sharing.

---

## 4. Player Moves as Timestamped Events

### Does the "owner as timestamper" model work?

**Yes.** SokoScript's existing multiplayer architecture (`lambda/boards.js`) already
implements exactly this pattern:
- Moves are timestamped with `moveTime` (BigInt, stored in DynamoDB at
  `boards.js:132-139`)
- The server (analogous to the board owner) is authoritative over move ordering
- Blocks accumulate moves over fixed time intervals (`TicksBetweenBlocks` at
  `boards.js:17`)

The protocol's `maxMovesPerDay` and `maxMoveSize` constraints are not present in
SokoScript but are trivially enforced at the adapter level.

### Speculative rendering + re-render on timestamp

**Compatible.** SokoScript's `evolveAndProcess()` (`board.js:332-338`) replays
moves at their assigned timestamps. The web client can:
1. Apply a move speculatively at the client's current time.
2. When the owner assigns an authoritative timestamp, re-evolve from the last
   checkpoint applying the move at the correct time.

The `Board.replayLog()` method (`board.js:454-458`) and `Board.replay()` static
method (`board.js:460-471`) already support deterministic replay from an initial
state plus a move list, which is exactly what re-rendering requires.

**Concern:** SokoScript's continuous-time Markov process means that changing a
move's timestamp by even one tick can cascade into different PRNG draws, producing
a completely different board state. This makes speculative rendering less useful
than in, say, Game of Life where deterministic steps are independent of input
timing. The re-render cost is proportional to the time since the last checkpoint.

---

## 5. Merkle Tree / Challenge Protocol

### Can SokoScript state be hashed consistently?

**Yes.** `Board.toString()` (`board.js:382-383`) produces canonical JSON via the
`stringify()` function from `canonical-json.js`, which sorts keys lexicographically
at all nesting levels. SHA-256 of this canonical string is a consistent hash.

The canonical JSON includes the full PRNG state, so the hash commits to the entire
simulation trajectory (past and future, modulo future moves).

### Is state + PRNG + future moves sufficient to determine the future?

**Yes.** The `Board.replay()` method (`board.js:460-471`) demonstrates this
directly: given an initial board JSON and a move list, the final state is
deterministic. The protocol's sufficient statistics (Section 4 of the spec) --
initial state S_0, PRNG seed, and ordered timestamped moves -- exactly match
SokoScript's replay model.

### Checkpoint/replay model

**Compatible with caveats.**

The protocol produces checkpoints at fixed `blockInterval` tick boundaries. For
SokoScript, this means calling `evolveToTime(checkpointTime, true)` at each
boundary. The `hardStop=true` parameter (`board.js:291-306`) ensures the clock
advances to exactly the checkpoint time and the PRNG state is well-defined.

**Caveat:** SokoScript's `evolveAsyncToTime()` has a subtle PRNG rewind mechanism
(`board.js:300: this.rng.mt = mt`) when `hardStop=false`. This saves and restores
the MT state array to allow consistent resumption when no event occurs in the
remaining interval. With `hardStop=true` (required for checkpoints), this rewind
does not occur, and the PRNG state is consumed up to the checkpoint time. This
is correct behavior for the protocol.

**Replay cost:** Spot-check verification (protocol Section 7.5) requires replaying
between two checkpoint ticks. For SokoScript, this means re-evolving the board
for `blockInterval` ticks of simulation time. If `blockInterval = 10000` and each
tick represents a fixed fraction of a second, the replay cost depends on the
configured tick duration and event rate. With Option C from Section 1 (fixed tick
duration), this is bounded and predictable.

---

## 6. Gaps and Incompatibilities

### 6.1 Time Model Mismatch (Medium -- requires adapter)

The protocol uses integer ticks; SokoScript uses BigInt sub-microsecond time.

**Resolution:** The SokoScript engine adapter defines a fixed tick duration (e.g.,
`const TICK = BigInt(2**20)` ~ 0.25ms). Protocol ticks map to SokoScript time via
`sokoTime = BigInt(tick) * TICK`. This is a one-time design decision in the adapter,
transparent to both the protocol and SokoScript internals.

### 6.2 No Native Boundary Exchange (Low -- straightforward to implement)

SokoScript has no `getBoundary()`/`setBoundary()` methods.

**Resolution:** Add to the adapter:

```javascript
getBoundary(edge) {
  const { size } = this.board;
  const cells = [];
  for (let i = 0; i < size; i++) {
    const [x, y] = edge === 'north' ? [i, 0]
                  : edge === 'south' ? [i, size-1]
                  : edge === 'west'  ? [0, i]
                  : [size-1, i];
    const cell = this.board.getCell(x, y);
    cells.push({ type: this.board.grammar.types[cell.type], state: cell.state, meta: cell.meta });
  }
  return new TextEncoder().encode(stringify(cells));
}

setBoundary(edge, data) {
  const cells = JSON.parse(new TextDecoder().decode(data));
  const { size } = this.board;
  cells.forEach((cell, i) => {
    const [x, y] = edge === 'north' ? [i, 0]
                  : edge === 'south' ? [i, size-1]
                  : edge === 'west'  ? [0, i]
                  : [size-1, i];
    this.board.setCellTypeByName(x, y, cell.type, cell.state, cell.meta);
  });
}
```

### 6.3 Square-Board-Only Constraint (Low -- acceptable)

SokoScript boards are square. The protocol allows rectangular. For SokoScript as a
backend, constrain to `width === height` in the board contract.

### 6.4 Mersenne Twister vs. xoshiro128** (Low -- cosmetic)

The protocol specifies xoshiro128** (16-byte state). SokoScript uses Mersenne
Twister (2500-byte state). This does not affect protocol correctness -- the PRNG
is internal to the engine and the protocol only cares about determinism. However,
the larger state inflates checkpoint sizes.

**Resolution:** Either accept the larger checkpoints, or migrate SokoScript to
xoshiro128**. Migration is straightforward (drop-in replacement for `rng.int()`)
but changes all existing board trajectories.

### 6.5 Synchronous Rules and Speculative Rendering (Medium -- design decision)

SokoScript synchronous rules (`sync=N`) fire at fixed-Hz boundaries and require
a global shuffle of all matching cells. During edge sharing, sync rules on boundary
cells would need to account for freshly injected boundary data.

**Resolution:** Sync rules fire on whatever state is present at the sync boundary.
Boundary data injected via `setBoundary()` before the sync tick is visible to sync
rules. This is natural and correct -- no special handling needed.

### 6.6 Grammar Changes as Moves (Low -- protocol supports it)

SokoScript supports changing the grammar mid-simulation via `processMove({type: 'grammar', ...})`
(`board.js:277-280`). This is a powerful feature not present in the Life reference
engine. The protocol's `applyInput()` interface is opaque to the action payload, so
grammar-change moves are supported without protocol changes. However, a grammar
change effectively changes the game rules, which could be a concern for validators
expecting consistent rule systems.

**Resolution:** Grammar-change moves can be allowed or disallowed per board contract.
Add an optional `allowGrammarChanges: boolean` field to the contract. Validators
that don't understand SokoScript grammar changes can treat them as opaque.

### 6.7 Cell Identity (ID) System (Low -- additive feature)

SokoScript cells can have unique IDs (`meta.id`) tracked in `byID` (`board.js:96,
133-148`). This enables player-controlled agents (the "Sokoban" in SokoScript).
The protocol has no concept of cell identity, but it doesn't need one -- IDs are
internal engine state serialized in the checkpoint.

### 6.8 Niche Detection for SokoScript (Medium -- needs new heuristics)

The protocol's niche detection (Section 11.4) uses two methods:
1. `lastWriter` metadata -- SokoScript has no equivalent. Could be added as a
   `meta` field on cells, tracking which board last wrote to each cell during
   edge sharing.
2. MinHash fingerprinting -- requires defining a meaningful fingerprint for
   SokoScript cells. For 6502life, the fingerprint is over 1024 bytes of raw
   memory. For SokoScript, the fingerprint would be over `(type, state)` tuples,
   which are much smaller and less unique. MinHash may be less effective here.

**Resolution:** Add `lastWriter` to cell `meta` during `setBoundary()`. For
MinHash, define the fingerprint as the hash of a window of cells (e.g., 3x3)
including types and states. This is less rich than the 6502life fingerprint but
still detects cross-board organism propagation.

---

## 7. Overall Assessment

| Aspect | Compatibility | Effort |
|---|---|---|
| `init(config)` | Direct mapping | Trivial adapter |
| `step(n)` | Requires tick duration definition | Small adapter |
| `serialize()` / `deserialize()` | Canonical JSON already exists | Trivial adapter |
| `applyInput(input)` | Direct mapping via `processMove()` | Trivial adapter |
| `getBoundary()` / `setBoundary()` | Not native; easy to add | ~50 lines |
| `clock()` | Direct mapping with time conversion | Trivial |
| `summarize()` | No standard; easy to define | ~20 lines |
| Determinism | Fully deterministic | No changes needed |
| Merkle tree / challenges | Compatible | No changes needed |
| Speculative rendering | Compatible but high cascade divergence | Acceptable |
| Niche detection | Needs `lastWriter` + adapted MinHash | Medium effort |

**Conclusion:** SokoScript is compatible with the 6502coin protocol as a backend
engine. The required adapter is ~200 lines wrapping `Board` with the `Engine`
interface. No changes to the SokoScript core are required. The main design decision
is the tick duration mapping (Section 1, Option C recommended). The protocol itself
requires no changes -- the engine interface is already sufficiently abstract.
