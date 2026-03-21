# Gridcoin: Game-Agnostic Architecture and MVP Development Plan

This document distills the Gridcoin proposal into a concrete, game-agnostic architecture for a cryptocurrency minted by running deterministic 2D grid simulations on phones. No specific game is assumed. The core idea: players run reproducible simulations, the protocol verifies them, and coins are minted as proof of sustained computation.

## 1. Core Abstractions

### Engine Interface

Every game must implement this interface. The engine is a black box that advances a grid simulation deterministically.

```typescript
interface Engine {
  // Initialize the engine with a configuration (board size, seed, rules, etc.)
  init(config: EngineConfig): void;

  // Advance the simulation by one atomic step (one tick, one rule application,
  // one scheduler interrupt -- whatever the game defines as its smallest unit).
  // Returns the number of steps actually executed (may be 0 if idle).
  step(n?: number): number;

  // Apply a timestamped player input. The engine must handle this deterministically:
  // given the same state and input, the result is always the same.
  applyInput(input: Input): void;

  // Serialize the complete engine state (grid contents, RNG state, clock, all
  // internal state) to a byte array. Must be canonical: same state always
  // produces identical bytes.
  serialize(): Uint8Array;

  // Restore engine state from a previous serialize() output. After deserialize(),
  // the engine behaves identically to the point where serialize() was called.
  deserialize(data: Uint8Array): void;

  // Read the boundary strip along the given edge. Returns an opaque byte array
  // representing the state of cells along that edge, to the depth required by
  // the game's neighborhood radius.
  getBoundary(edge: Edge): Uint8Array;

  // Write a boundary strip received from a neighboring board. Replaces the
  // cells along the given edge with the provided data.
  setBoundary(edge: Edge, data: Uint8Array): void;

  // Return the current simulation clock value (integer ticks, not wall time).
  clock(): bigint;
}

type Edge = 'north' | 'south' | 'east' | 'west';
```

### Cell Interface

The engine exposes per-cell state for rendering. The UI never reaches into engine internals; it only reads what the engine provides through this interface.

```typescript
interface CellView {
  // Grid coordinates
  x: number;
  y: number;

  // Opaque state blob -- the UI can render this however it wants.
  // For a Game of Life, this is 1 bit. For a 6502 grid, it's 1024 bytes.
  // The UI must know how to interpret it for the specific game.
  state: Uint8Array;

  // Optional metadata the engine can attach for rendering hints.
  // Examples: "alive", "idle", "active", last-write-time, color, icon name.
  // The engine defines what keys exist; the UI decides what to do with them.
  meta?: Record<string, string | number>;
}

interface EngineView {
  // Board dimensions
  width: number;
  height: number;

  // Read a single cell's view
  getCell(x: number, y: number): CellView;

  // Iterate all cells (for full-board rendering)
  getCells(): Iterable<CellView>;
}
```

### Input Interface

Player actions are timestamped and serializable. The engine replays them deterministically.

```typescript
interface Input {
  // Simulation clock tick at which this input is applied.
  // The engine evolves to this tick, applies the input, then continues.
  tick: bigint;

  // Opaque action payload. The engine defines what actions exist.
  // Examples: { type: "keypress", key: "ArrowUp" }
  //           { type: "poke", cell: [3,5], offset: 0x10, value: 0xFF }
  action: Record<string, unknown>;
}
```

### Session Interface

A session is the minimal record needed to reproduce an entire simulation trajectory.

```typescript
interface Session {
  // Unique session ID (random UUID, generated at init)
  id: string;

  // Engine configuration (game ID, board size, seed, rules/grammar/program)
  config: EngineConfig;

  // Initial state snapshot (serialized engine state at session start)
  initialState: Uint8Array;

  // Ordered list of all player inputs during the session
  inputs: Input[];

  // Final simulation clock value
  finalTick: bigint;

  // Hash chain of blocks produced during this session
  blocks: Block[];
}
```

A verifier can reproduce the session by calling `engine.init(config)`, `engine.deserialize(initialState)`, then stepping through, applying inputs at their timestamps, and checking block hashes at each checkpoint.

### Block Interface

Blocks are the unit of the hash chain. Each covers a fixed interval of simulation time.

```typescript
interface Block {
  index: number;
  prevHash: Uint8Array;         // SHA-256 of the previous block (zero for genesis)
  startStateHash: Uint8Array;   // SHA-256 of serialized state at block start
  endStateHash: Uint8Array;     // SHA-256 of serialized state at block end
  inputs: Input[];              // Player inputs during this block
  simTicks: bigint;             // Simulation ticks elapsed in this block
  wallTimeMs: number;           // Wall-clock milliseconds elapsed
  minerPubkey: Uint8Array;      // Ed25519 public key of the miner
  signature: Uint8Array;        // Ed25519 signature over all fields except signature

  // Social mining fields (null for solo mining)
  boundary?: BoundaryExchange;
}
```

### Boundary Interface

How two boards share an edge during social mining.

```typescript
interface BoundaryExchange {
  partnerPubkey: Uint8Array;      // Partner's public key
  partnerBlockHash: Uint8Array;   // Hash of partner's corresponding block
  edge: Edge;                      // Which edge is shared
  sent: BoundaryFrame[];           // Boundary data this device sent to partner
  received: BoundaryFrame[];       // Boundary data received from partner
}

interface BoundaryFrame {
  tick: bigint;                    // Simulation tick at time of exchange
  data: Uint8Array;                // Serialized boundary strip
  hash: Uint8Array;                // SHA-256 of data
}
```

## 2. Architecture Layers

```
+----------------------------------------------------------+
|  UI Layer                                                |
|  Renders cells, captures input, displays coins/status    |
+----------------------------------------------------------+
|  Session Layer                                           |
|  Manages state, input log, block production, hash chain  |
+----------------------------------------------------------+
|  Network Layer                                           |
|  Bluetooth peer discovery, boundary sync, dual-witness   |
+----------------------------------------------------------+
|  Ledger Layer                                            |
|  Local chain storage, coin minting, block validation     |
+----------------------------------------------------------+
|  Engine Layer                                            |
|  Game-specific simulation (implements Engine interface)   |
+----------------------------------------------------------+
```

### Engine Layer (game-specific)

Implements the `Engine` interface. This is the only layer that knows about the specific game. Everything above is game-agnostic. The engine:

- Owns the grid state and simulation logic
- Provides canonical serialization (same state = same bytes, always)
- Handles boundary reads/writes for coupling with adjacent boards
- Exposes `CellView` objects for rendering

A reference Game of Life engine is trivially implementable (a few hundred lines) and serves as the test vehicle for all higher layers.

### Session Layer (game-agnostic)

Manages a running simulation session:

- Calls `engine.step()` in a loop, at a rate governed by the game's clock
- Records player inputs with simulation-clock timestamps
- Produces blocks at fixed tick intervals (configurable, e.g., every 60,000 ticks)
- Computes SHA-256 hashes of serialized state at block boundaries
- Signs blocks with the player's Ed25519 keypair
- Maintains the hash chain (each block references the previous block's hash)
- Stores full state snapshots periodically (every N blocks) and deltas in between

The session layer enforces the wall-clock constraint: it records real elapsed time alongside simulation ticks and rejects blocks where `wallTimeMs / simTicks` is outside the allowed ratio.

### Network Layer (game-agnostic)

Handles Bluetooth peer discovery and boundary synchronization:

- **Discovery**: Uses BLE advertising to find nearby Gridcoin players. Advertises a service UUID specific to Gridcoin. Discovered peers are shown in the UI.
- **Handshake**: Two players exchange public keys, engine configs (must be compatible -- same game, same rules, compatible board sizes), and initial boundary states.
- **Boundary sync**: At regular tick intervals, both devices exchange boundary strips via BLE. Each device calls `engine.getBoundary()` to read its export edge and `engine.setBoundary()` to apply the partner's data to its import edge. All exchanges are logged with timestamps and hashes.
- **Dual-witness recording**: Each device records what it sent and what it received. Both records must agree for social mining validation.
- **Disconnect handling**: When BLE connection drops, the session layer reverts to solo mode (toroidal wrapping or zero-fill on the boundary edge).

### Ledger Layer (game-agnostic)

Local-first storage with eventual network sync:

- **Local storage**: Blocks are stored in IndexedDB (browser/PWA) or SQLite (native app). Each block is a row keyed by `(session_id, block_index)`.
- **Coin minting**: One coin per valid block. The coin record references the block hash, miner pubkey, and session metadata.
- **Validation**: Verifying a block means deserializing the start state, replaying the simulation for the block's tick duration while applying inputs, and checking that the computed end state hash matches. This is expensive (roughly real-time cost) so verification is probabilistic or challenge-based.
- **Sync**: When network is available, blocks and coins are gossiped to peers or submitted to a relay. Social mining blocks are cross-referenced between the two participants' chains.

### UI Layer (game-specific rendering, game-agnostic framework)

- Calls `engine.getCells()` or `engine.getCell(x, y)` to read cell state
- Interprets the game-specific `CellView.state` bytes and renders them (this part is game-specific)
- Captures player input and passes it to the session layer as `Input` objects
- Displays: coin balance, mining status (solo/social), nearby players, session history
- The framework (grid layout, coin display, peer list) is game-agnostic; only the cell renderer is game-specific

## 3. MVP Development Plan

### Milestone 1: Engine Interface Spec + Reference Implementation

**Goal**: Define the interface and prove it works with the simplest possible game.

**Deliverables**:
- `engine.d.ts`: TypeScript interface definitions (as above)
- `life-engine.js`: Conway's Game of Life on a toroidal NxN grid, implementing the full Engine interface. Rules: B3/S23. State per cell: 1 bit. Canonical serialization: packed bits + RNG state (use a seedable xoshiro256** PRNG -- fast, well-specified, small state).
- `engine.test.js`: Tests proving determinism: init with same config, step 10,000 times, compare serialized state. Repeat on different JS runtimes (Node, browser). Must be bit-identical.

**Tech**: Pure JavaScript ESM. No dependencies except a bundled PRNG. Tests via vitest.

**Effort**: 1-2 days.

### Milestone 2: Session Recording and Replay Verification

**Goal**: Record a simulation session and verify it independently.

**Deliverables**:
- `session.js`: Session manager that wraps an Engine, records inputs, produces blocks with SHA-256 hashes and a hash chain. Blocks are serialized as canonical JSON (sorted keys, no whitespace).
- `verify.js`: Standalone verifier that takes a session record (initial state + inputs + blocks), replays the simulation, and checks every block's state hashes.
- CLI tools:
  - `record.js`: Run a simulation for N ticks, save the session to a JSON file.
  - `verify.js`: Load a session file, replay it, report pass/fail per block.
  - `inspect.js`: Print block details, hash chain, timing metadata.

**Tech**: SHA-256 via Web Crypto API (available in Node 18+ and all browsers). Ed25519 signing via libsodium-wrappers-sumo (npm package, ~200KB, works in Node and browser, no native dependencies). Alternatively, use tweetnacl (smaller, pure JS, also supports Ed25519).

**Effort**: 3-5 days.

### Milestone 3: Solo Mining (Local Hash Chain, Coin Minting)

**Goal**: A working solo mining loop on a phone. Player opens the app, simulation runs, blocks are produced, coins accumulate.

**Deliverables**:
- `miner.js`: Mining loop that runs the session, produces blocks, signs them, stores them locally.
- `wallet.js`: Local coin storage. Each coin = a reference to a valid signed block. Coins stored in IndexedDB.
- `keygen.js`: Generate an Ed25519 keypair, store in IndexedDB (or prompt user to back up the seed phrase).
- Phone UI (minimal):
  - Grid view showing the simulation running
  - Coin counter
  - Session status (ticks, blocks produced, time elapsed)
  - Start/stop button

**Tech**:
- PWA (Progressive Web App). No app store needed. Works on iOS Safari and Android Chrome.
- UI framework: Preact (3KB) or vanilla JS with Canvas for grid rendering. Avoid React for bundle size.
- Storage: IndexedDB via idb (tiny wrapper, ~1KB).
- Crypto: tweetnacl (Ed25519, 24KB, pure JS, no WASM needed).
- Service worker for offline support and background keep-alive (limited -- see Milestone 5 notes).

**Effort**: 1-2 weeks.

### Milestone 4: Social Mining over Bluetooth

**Goal**: Two phones discover each other, connect, share a boundary, and produce cross-referenced blocks.

**Deliverables**:
- `bluetooth.js`: Wrapper around Web Bluetooth API for peer discovery and data exchange.
  - Advertise a Gridcoin GATT service with a characteristic for boundary data.
  - Scan for nearby Gridcoin peers.
  - Exchange handshake (pubkeys, config, initial boundary).
  - Periodic boundary frame exchange.
- `social-session.js`: Extended session manager that handles boundary sync, logs sent/received frames, produces blocks with `BoundaryExchange` fields.
- `social-verify.js`: Verifier that takes two session files (one from each player), cross-references boundary exchanges, and validates consistency.
- Phone UI additions:
  - "Nearby players" list with BLE signal strength
  - "Connect" button to initiate social mining
  - Visual indicator showing the shared boundary on the grid
  - Dual coin counter (solo coins vs. social coins)

**Critical constraint**: Web Bluetooth API is available on Android Chrome but **not on iOS Safari**. On iOS, the options are:
1. Use a native wrapper (Capacitor with `@capacitor-community/bluetooth-le` plugin) to access CoreBluetooth.
2. Use a React Native app with `react-native-ble-plx`.
3. Accept that the MVP is Android-only for social mining.

For an MVP, option 3 (Android-only social mining) is the pragmatic choice. iOS users can still solo-mine via the PWA.

**Effort**: 2-3 weeks.

### Milestone 5: Ledger Sync and Coin Exchange

**Goal**: Players can sync their block chains and transfer coins.

**Deliverables**:
- `ledger.js`: Local ledger that stores validated blocks and coin balances for all known players.
- `sync.js`: Peer-to-peer sync protocol. When two players connect (BLE or internet), they exchange block headers and request missing blocks. No central server required.
- `transfer.js`: Coin transfer: player A signs a transfer message ("I send X coins to pubkey B"), both players record it. Transfer validity requires the sender's chain to show sufficient balance.
- Optional relay server: A simple WebSocket relay (deployable on free tier of Fly.io, Railway, or Cloudflare Workers) that stores block headers and facilitates sync when players are not co-located. Not required for the core protocol.

**Effort**: 2-4 weeks.

**Total MVP timeline**: ~8-12 weeks for a solo developer working part-time.

## 4. Dev Client / Debugging Toolchain

All tools are CLI scripts (Node.js ESM, zero dependencies beyond the engine and crypto libs).

### Session Replay and Verification

```bash
# Record a session: run Game of Life for 100,000 ticks, save session
node cli/record.js --game life --size 32 --seed 42 --ticks 100000 --out session.json

# Verify the session: replay and check all block hashes
node cli/verify.js session.json

# Verify with verbose output (print each block's computed vs. recorded hash)
node cli/verify.js --verbose session.json
```

### Hash Chain Inspection

```bash
# Print the block chain summary
node cli/chain.js session.json
# Output:
#   Block 0: ticks 0-10000, hash a3f2..., wall 12.3s
#   Block 1: ticks 10000-20000, hash 7bc1..., wall 11.8s, prev a3f2... OK
#   ...

# Export block hashes as JSON (for cross-referencing social sessions)
node cli/chain.js --json session.json
```

### Determinism Fuzzing

The critical invariant is that the same session produces identical results on any platform. The test harness runs the same session on multiple JS runtimes and compares serialized state at every block boundary.

```bash
# Run determinism test: execute the same session on Node and Bun, compare
node cli/fuzz-determinism.js --game life --size 64 --seed 12345 --ticks 50000

# Cross-platform: save a session on one machine, verify on another
# Machine A:
node cli/record.js --game life --size 32 --seed 99 --ticks 100000 --out session.json
# Machine B:
node cli/verify.js session.json
```

### Boundary Simulation (Mock Social Mining)

Test boundary coupling without Bluetooth by running two engines in the same process, exchanging boundary data programmatically.

```bash
# Run two boards sharing an east-west boundary for 50,000 ticks
node cli/mock-social.js --game life --size 16 --seed-a 42 --seed-b 99 --ticks 50000

# Verify both sessions are cross-consistent
node cli/verify-social.js session-a.json session-b.json
```

### Wallet and Ledger Inspection

```bash
# Show local coin balance
node cli/wallet.js balance

# List all blocks in local ledger
node cli/wallet.js blocks

# Export keypair (for backup)
node cli/wallet.js export-key --out key.json
```

## 5. Phone Client(s)

### Platform Choice: PWA First

A Progressive Web App is the right starting point:

- **Zero distribution cost.** No app store fees, no review process, no platform-specific builds. Players visit a URL and add to home screen.
- **Cross-platform.** Works on Android Chrome and iOS Safari.
- **Web Crypto API.** SHA-256 and other crypto primitives are available natively.
- **Canvas API.** Sufficient for rendering a grid at 30fps.
- **IndexedDB.** Persistent local storage for blocks, sessions, and keys.

The main PWA limitation is background execution (see below).

### When to Go Native

If the project gains traction and needs features unavailable in PWA:

- **Bluetooth on iOS**: Requires native (Capacitor or React Native). This is the first forcing function.
- **Background execution**: Native apps have more options (see below).
- **Performance**: For CPU-heavy engines, a native app with WASM or native code is faster.

If going native, **Capacitor** (wraps the existing web app in a native shell) is the lowest-effort path. It provides plugins for Bluetooth LE, background tasks, and local notifications. The web code stays the same; only the native bridge code is new.

### Battery and Compute Constraints

- **CPU budget**: A Game of Life engine on a 32x32 grid is trivial (~0.1% CPU). A more complex engine (e.g., 6502 emulation) on a 32x32 grid will use 5-20% CPU, which is acceptable for active use but drains battery in the background.
- **Target**: Keep CPU usage under 10% during active mining, under 2% when backgrounded (by reducing tick rate).
- **Thermal**: On sustained load, phones throttle. The wall-clock tolerance in block validation (e.g., allow 0.5x-2x ratio of sim time to wall time) accommodates this.

### Bluetooth API Availability

| Platform | API | Status |
|----------|-----|--------|
| Android Chrome | Web Bluetooth | Available (origin trial, then shipped) |
| iOS Safari | Web Bluetooth | **Not available** |
| Android native | `android.bluetooth.le` | Full support |
| iOS native | CoreBluetooth | Full support |
| Capacitor | `@capacitor-community/bluetooth-le` | Wraps native APIs on both platforms |
| React Native | `react-native-ble-plx` | Wraps native APIs on both platforms |

**MVP decision**: Ship PWA for solo mining on both platforms. Social mining is Android-only via Web Bluetooth in the PWA. Add Capacitor wrapper for iOS Bluetooth if demand justifies it.

### Background Simulation

Running the simulation when the app is not in the foreground:

- **PWA (both platforms)**: Service workers cannot run arbitrary compute. The `periodicSync` API exists but is throttled to once per ~12 hours on Android and unavailable on iOS. Not viable for continuous simulation.
- **Android native**: `ForegroundService` with a persistent notification. Can run indefinitely. Battery cost is visible to the user.
- **iOS native**: `BGProcessingTask` allows ~30 seconds of background work, invoked at system discretion. Not sufficient for continuous simulation. A `BGAppRefreshTask` is even shorter. There is no iOS equivalent of Android's foreground service.
- **Practical approach**: The simulation runs only while the app is in the foreground. On Android, an optional foreground service can keep it running. On iOS, simulation pauses when backgrounded. This is acceptable: mining rewards are proportional to simulation time, and forcing users to keep the app open creates natural engagement.

### Minimal UI

```
+----------------------------------+
|  [Gridcoin]       [42 coins] [#] |
|                                  |
|  +----------------------------+  |
|  |                            |  |
|  |     32x32 grid view        |  |
|  |     (Canvas, 1px/cell      |  |
|  |      or 4px/cell)          |  |
|  |                            |  |
|  +----------------------------+  |
|                                  |
|  Block 47 | 12,340 ticks | 2:13  |
|  [Start/Stop]                    |
|                                  |
|  Nearby: Alice (3m), Bob (8m)    |
|  [Connect to Alice]              |
+----------------------------------+
```

Four screens total:
1. **Main**: Grid view + mining status + start/stop
2. **Social**: Nearby players list + connect button + active boundary indicator
3. **Wallet**: Coin balance + block history + transfer
4. **Settings**: Game selection, board size, seed, export key

## 6. Infrastructure / Investment

### Zero Budget (fully open source, no servers)

Everything works peer-to-peer:

- **Code hosting**: GitHub (free).
- **PWA hosting**: GitHub Pages or Cloudflare Pages (free). Static files only.
- **Storage**: All data in IndexedDB on the user's device. No server-side storage.
- **Sync**: Bluetooth only. Players sync when physically co-present. No internet sync.
- **Crypto**: tweetnacl (Ed25519) and Web Crypto (SHA-256). Both free, no API keys.
- **CI/CD**: GitHub Actions (free for public repos). Run determinism tests on every PR.
- **Build**: Vite (free). Bundle the PWA, deploy to Pages.

**What you give up**: No internet-based ledger sync, no relay server, no way to transfer coins except in person. This is fine for an MVP -- it's a feature, not a bug. The local-first, proximity-only model is exactly the social mining thesis.

### With $100

- **Domain name**: ~$10/year. `gridcoin.game` or similar. Gives the PWA a real URL.
- **Relay server**: Deploy a WebSocket relay on Fly.io free tier (3 shared VMs) or Cloudflare Workers (100K requests/day free). This enables internet-based block sync and coin transfers between sessions. ~$0-5/month if usage stays within free tier.

### With $1,000

- **Apple Developer account**: $99/year. Required to ship a Capacitor-wrapped native app on iOS for Bluetooth support.
- **Google Play developer account**: $25 one-time.
- **Relay server with persistence**: A small Postgres instance on Supabase free tier or Railway ($5/month) to store block headers and enable ledger queries. Not required for the protocol, but improves UX (players can see their coin balance without syncing in person).
- **Remaining budget**: Spend on user testing, design polish, or a small bounty for a second game engine implementation.

### With $10,000

- **Contract a second engine implementation**: Pay someone to implement the Engine interface for a different game (e.g., a reaction-diffusion system, a cellular automaton with player interaction). This proves the game-agnostic architecture works.
- **Security audit of the crypto**: Review the Ed25519 signing, hash chain, and verification logic. Even an informal review by a cryptographer friend is valuable.
- **Reference verifier in Rust/WASM**: A WASM build of the Engine + Session + Verify stack, providing a canonical verifier that runs identically on all platforms. This is the strongest defense against cross-platform determinism bugs. Use the `wasm-bindgen` toolchain.
- **UX/design work**: Hire a designer for a day to make the app not look like a developer tool.

### Where Real Costs Appear

| Cost | When | Amount |
|------|------|--------|
| Apple Developer Program | iOS native app | $99/year |
| Google Play | Android native app | $25 one-time |
| Domain name | PWA branding | $10-15/year |
| Relay server (if usage exceeds free tier) | >1000 daily active users | $5-20/month |
| WASM reference verifier development | Cross-platform determinism is critical | 2-4 weeks of Rust dev time |
| App store compliance (privacy policy, content review) | Publishing native apps | Time, not money |

## 7. Risks and Mitigations

### Determinism Across Platforms

**Risk**: JavaScript number semantics are mostly IEEE 754 compliant, but edge cases exist. Different engines (V8, JavaScriptCore, SpiderMonkey) might produce different results for the same computation if floating-point is involved.

**Mitigation**:
- **No floating point in the engine.** All simulation logic must use integer arithmetic only. RNG output, cell state, coordinates, timing -- all integers. JavaScript's `Number` is a 64-bit float, but integer arithmetic up to 2^53 is exact. Use `BigInt` for anything that might exceed that.
- **Specify the PRNG exactly.** Use xoshiro256** with a fixed implementation (not a library that might change). Include the PRNG source in the engine package. Test: same seed produces same sequence on Node, Chrome, Safari, Firefox.
- **Canonical serialization.** Use `Uint8Array` for state, not JSON (which has issues with key ordering, whitespace, and number formatting). If JSON is used for interchange, use sorted keys and no whitespace (`JSON.stringify(obj, Object.keys(obj).sort(), 0)` is not sufficient -- use a canonical JSON library or just avoid JSON for state).
- **Fuzz testing.** CI runs the same session on Node (V8), Bun (JavaScriptCore), and Deno (V8) and compares output byte-for-byte. Add Firefox via Playwright if the PWA targets it.
- **WASM reference verifier.** The ultimate defense: a Rust implementation compiled to WASM that produces bit-identical output on all platforms. If the JS engine disagrees with the WASM verifier, the WASM verifier is canonical.

### Cheating: Simulation Speedup

**Risk**: A player runs the simulation on a fast machine (desktop, server, GPU) and produces blocks faster than honest phone miners.

**Mitigation**:
- **Wall-clock constraint.** Blocks include wall-clock timestamps. The protocol rejects blocks where `wallTimeMs` is less than `simTicks * minMsPerTick * 0.5` (50% tolerance for fast hardware). This bounds the speedup advantage to 2x.
- **External entropy injection.** At block boundaries, mix in entropy from an external source (e.g., the hash of the latest block from a public blockchain, or a random beacon). This prevents pre-computation: the miner cannot compute future blocks without knowing future entropy. This requires internet connectivity at block boundaries, which conflicts with offline solo mining. A compromise: external entropy is optional but blocks with it are worth more.
- **Accept bounded advantage.** A 2x speedup from better hardware is tolerable. The coin emission rate is low enough that 2x more coins is not game-breaking.

### Cheating: Fake Bluetooth / Social Mining Fraud

**Risk**: Two colluding devices simulate a Bluetooth connection over the internet to farm social mining bonuses without physical co-presence.

**Mitigation**:
- **Latency checks.** During boundary exchange, measure round-trip time. BLE latency is <10ms; internet relay is typically 20-200ms. Reject exchanges with latency consistently above a threshold (e.g., 30ms).
- **RSSI logging.** Record BLE signal strength in block metadata. Not cryptographically secure (easily spoofed), but raises the effort bar.
- **Keep the social bonus modest.** If social coins are only 1.5-2x more valuable than solo coins, the incentive to fake proximity is limited. The real value of social mining should come from the network effect (organisms crossing boundaries, richer dynamics), not from a protocol-mandated multiplier.
- **Accept imperfection.** Perfect proximity enforcement is impossible without hardware (UWB ranging). The protocol should be designed so that fake social mining is not catastrophically damaging -- it produces slightly more coins, but the fundamental value proposition (interesting simulations, social interaction) is not undermined.

### Economic: Bootstrapping Value from Nothing

**Risk**: Coins have no inherent value. Early adopters mine coins that nobody wants to buy.

**Mitigation**:
- **Intrinsic entertainment value.** The simulation itself should be fun to watch and interact with. Players run it because it is interesting, and coins are a bonus. If the game is boring, no token economy will save it.
- **No exchange rate.** The protocol does not define a coin price. Coins are a record of computation and social interaction. If players want to trade them, they can -- but the protocol does not promise they are "worth" anything.
- **Social proof.** Social mining creates verifiable records of who interacted with whom, when, and for how long. This social graph has intrinsic value independent of any exchange rate.
- **Start small.** Target a specific community (e.g., a university campus, a hackerspace, a game jam) where players are physically co-located and intrinsically motivated. Let value emerge organically.

### Technical: Battery Drain

**Risk**: Continuous simulation drains the phone battery in a few hours. Users stop mining because it kills their phone.

**Mitigation**:
- **Adaptive tick rate.** Reduce simulation speed when battery is low (the `navigator.getBattery()` API provides charge level on Android; not available on iOS, so use a conservative default).
- **Pause when backgrounded.** Do not attempt to run in the background on iOS. On Android, only use foreground service if the user explicitly opts in.
- **Efficient rendering.** Only redraw the grid when cells change. Use `requestAnimationFrame` and dirty-cell tracking, not full-grid redraws.
- **Game of Life is cheap.** The reference engine (Game of Life) is computationally trivial. Battery drain only becomes an issue with heavier engines. Let engine implementors specify a recommended board size / tick rate for mobile.

### Technical: Background Execution Limits on iOS

**Risk**: iOS aggressively suspends background apps. The simulation stops when the user switches to another app.

**Mitigation**:
- **Accept it.** Mining happens while the app is open. This is fine. It means players mine during idle moments (commuting, waiting, hanging out) rather than 24/7. The coin emission rate should be calibrated so that 30-60 minutes of daily active mining produces a satisfying amount.
- **Notification reminder.** Send a local notification ("Your simulation has been paused. Open Gridcoin to resume mining.") after N minutes of inactivity.
- **Web Audio keep-alive trick.** Playing a silent audio stream can keep a PWA alive on some platforms, but this is a hack that drains battery and may be patched. Not recommended for production.
