# 6502coin MVP Agent Brief

## Objective

Implement a minimal viable 6502coin client following the local-first
MVP strategy from `doc/gridcoin-architecture.md`. Work on a fork branch
`6502coin-mvp`.

## Scope

### What to build (Milestone 1-3 from architecture doc)

1. **Engine interface spec**: TypeScript/JS interfaces for the game-agnostic
   engine layer. Three reference engines:
   - **Game of Life**: simplest possible, for testing
   - **6502life**: use the existing `board/` engine
   - **SokoScript**: stub that imports from `~/sokoscript`

2. **Session recording and replay**: given initial state + timestamped
   inputs, reproduce the full trajectory. Hash chain for integrity.
   Use SHA-256 (Web Crypto API or `crypto` module).

3. **Solo mining**: local hash chain, coin minting (1 coin per unit of
   verified simulation time). Store sessions in IndexedDB (browser) or
   a JSON file (CLI).

### What to defer

- Bluetooth social mining (Milestone 4)
- Ledger sync and coin exchange (Milestone 5)
- Phone UI (can use CLI or simple web page)
- Real blockchain integration (use local ledger only)

### Key design requirements

- **100% deterministic replay**: initial state + inputs = full trajectory.
  All randomness from a seedable PRNG (xoshiro256** or similar).
- **Game-agnostic**: the engine interface must work for any 2D grid game.
  6502life, SokoScript, and Game of Life are just three implementations.
- **Minimal simulator/UI contract**: engine provides cell state, UI renders.
- **Trajectory summary stats**: each engine can define summary stats that
  are verifiable from the trajectory-determining info and reveal whether
  the simulation is "interesting" vs a dead board.

### Architecture layers (from gridcoin-architecture.md)

1. **Engine layer** (game-specific): `init()`, `step()`, `serialize()`,
   `deserialize()`, `applyInput()`, `getBoundary()`, `setBoundary()`
2. **Session layer**: manages state, input log, hash chain, verification
3. **Ledger layer**: local chain storage, coin minting, block creation
4. (Future) Network layer, UI layer

### Social mining prep

Even though social play is deferred, design the boundary interface now:
- `getBoundary(edge)`: returns the cells along one edge of the board
- `setBoundary(edge, data)`: writes neighbor data from another board
- Edge identification: based on real-world locations at time of connection
  (when available), else random assignment
- **Transport**: WebRTC via PeerJS (not Bluetooth — Web Bluetooth only
  supports Central role, can't do phone-to-phone discovery, no iOS support).
  See doc/phone-client-research.md for details.
- **Location proximity**: if a simple, cryptographically-secure way exists
  to prove real-world proximity without revealing locations (zero-knowledge
  proximity proof), note it. Not essential for MVP.

### Anti-cheat: trajectory summary stats

Each engine should define a `summarize(trajectory)` function returning
stats that:
- Are verifiable given trajectory-determining info (initial state, inputs)
- Reveal whether the simulation is "interesting" — e.g., for 6502life:
  number of BRK copy events, unique cell fingerprints, active cell count.
  For Game of Life: live cell count, oscillator detection. For SokoScript:
  rule-firing count, cell type diversity.
- Solo-mined coins from "dead" boards (all zeros, no activity) should be
  worth less than coins from active simulations.

### Infrastructure priority: fast WASM 6502life VM

A fast WebAssembly implementation of the 6502life Board/Controller is an
infrastructural asset for both the game and the coin. If building one,
prioritize it and feed it back to the main repo quickly. See
`doc/profiling-results.md` for the current bottleneck analysis (swapCells
address translation was the main issue, now fixed; CPU execution is only
2-12% of wall time).

### Dev toolchain

- CLI tools for session recording, replay, verification, hash inspection
- Determinism fuzzing: run same session on two runtimes, compare
- Mock social mining: simulate two boards sharing an edge without Bluetooth

### Tech stack (from architecture doc)

- TypeScript/JS (Node.js for CLI, browser for web)
- SHA-256 via Web Crypto / Node crypto
- IndexedDB (browser) or JSON files (CLI) for storage
- No external dependencies beyond the engine implementations

### Branch and commit strategy

- Work on branch `6502coin-mvp`
- Commit frequently with clear messages
- Keep the engine interface stable — it's the contract between games and
  the coin protocol

## Reference documents

- `doc/gridcoin-proposal.md` — concept and economics
- `doc/gridcoin-architecture.md` — architecture and MVP plan
- `doc/gridcoin-blockchain-options.md` — blockchain platform assessment
- `doc/gridcoin-math-review.md` — math/crypto review with issues found
- `CLAUDE.md` — 6502life VM spec (includes `boardParams` dictionary with
  feature flags: `implementsMove`, `implementsCopy`, `implementsSync`,
  `implementsAsync`, `hasCompass`, `pBitNoise`)
- `tex/6502life.tex` — full VM specification
