# Board Chain Protocol Specification

A cryptographically verifiable history of a 6502life board, from creation
through simulation and interaction with other boards.

This document specifies the chain layer that sits on top of the bare sim
controller (see `doc/bare-sim-spec.md`). Together, the two documents define
a complete system in which a verifier can confirm that a board was initialized
from a specific seed, simulated faithfully at a rate bounded by coin mining,
and that all interactions (moves, shares) are properly signed and paid for.

---

## Layer 0: Bare Sim Controller

Defined in `doc/bare-sim-spec.md`. Provides:
- Deterministic 6502 execution on a 2KB memory window
- Checkerboard pair scheduling with seeded PRNG
- Cycle-exact cross-platform reproducibility

All higher layers depend on this. Any conforming emulator (JS, WebGPU, JAX,
Rust/WASM) can verify any chain, because the simulation is deterministic from
the seed.

---

## Layer 1: Board Contract (Creation)

A **board contract** is an immutable specification that commits to everything
needed to reproduce a board's initial state and simulation rules.

### Fields

```
BoardContract {
    initSeed:       string      // ChaCha20 seed for initial memory
    size:           int         // Board dimension (size × size cells)
    boardParams:    object      // Simulation hyperparameters
    difficulty:     int         // Mining difficulty (leading zero bits)
    saltWithParams: bool        // Commit to params before seeing init
    coinParams:     object      // Coin economics
}
```

### Board identity

```
boardId = SHA-256(canonicalJSON(contract))
```

Canonical JSON: sorted keys, no whitespace, deterministic serialization.

### Initial state generation

```
key   = SHA-256(initSeed)                    // 32-byte ChaCha20 key
nonce = SHA-256(size | boardParams | difficulty)[:12]  // 12-byte nonce
                                              // (only if saltWithParams)
init  = ChaCha20(key, nonce, size² × 1024)   // Full board memory
```

When `saltWithParams = true`, the board owner commits to the simulation
rules (noise rate, BRK ops, scheduler mode, difficulty) *before* seeing
the random initialization. This prevents cherry-picking params after
finding a seed with a viable replicator.

### Board parameters

```
boardParams {
    pBitNoise:      float   // Per-bit noise on writeback (default 1/2048)
    pBitNoiseZero:  float   // P(resampled bit = 0) (default 0.5)
    decayRate:      float   // Cosmic ray bit-flip rate (default 0)
    hasCompass:     bool    // Write orientation to $FA (default false)
    schedulerMode:  string  // 'random' | 'checkerboard' (default 'random')
    brkOps: {               // BRK operand dispatch
        reset: { range: [0, 0],   enabled: bool }
        swap:  { range: [1, 48],  enabled: bool }
        copy:  { range: [49, 96], enabled: bool }
        sync:  { range: [97, 97], enabled: bool }
        async: { range: [98, 98], enabled: bool }
    }
}
```

Note: the bare sim (Layer 0) implements only the minimal controller
(checkerboard scheduling, register save/restore, no BRK dispatch, no noise).
Board-level features (BRK copy/swap, noise, compass, oriented registers)
are controller extensions that run between quanta on the host side. They are
deterministic given the same PRNG state and must be implemented identically
across all platforms that claim to support them.

### Coin parameters

```
coinParams {
    T_coin:       int     // Ticks per coin earned (default 1000)
    shareBoost:   int     // Earn rate multiplier during shares (default 2)
    coinHalfLife: int     // Half-life of balance in ticks (default 100000)
    moveCost:     int     // Coins spent per Move (default 1)
}
```

---

## Layer 2: Session Chain (Simulation History)

A **session** records the execution of a board from its initial state.
The session produces a **hash chain** of blocks, each covering a fixed
number of simulation ticks.

### Genesis

```
1. Create BoardContract → boardId
2. Generate initial state: init = contract.generateInit()
3. initialStateHash = SHA-256(init)
4. Initialize engine with init + contract.boardParams
5. Append initialStateHash to Merkle tree at tick 0
```

### Blocks

The session is divided into blocks of `blockInterval` ticks (default 10,000).
Each block records:

```
Block {
    index:          int         // Sequential block number
    prevHash:       hex         // SHA-256 of previous block (zeros for genesis)
    startStateHash: hex         // SHA-256 of board state at block start
    endStateHash:   hex         // SHA-256 of board state at block end
    inputs:         Input[]     // Moves applied during this block
    startTick:      int         // Simulation tick at block start
    endTick:        int         // Simulation tick at block end
    wallTimeMs:     int         // Wall-clock elapsed (informational)
    summary:        object      // Engine stats (cell counts, activity, etc.)
    merkleRoot:     hex         // Merkle root of all checkpoints so far
    coinBalance:    float       // Current coin balance at block end
}

blockHash = SHA-256(canonicalJSON({
    endStateHash, endTick, index, inputs, merkleRoot,
    prevHash, startStateHash, startTick, summary, wallTimeMs
}))
```

### Hash chain integrity

```
block[0].prevHash = 0x000...000
block[i].prevHash = block[i-1].blockHash
block[i].startStateHash = block[i-1].endStateHash
```

### Merkle tree

A binary Merkle tree over board state checkpoints:
- Leaf `i` = SHA-256 of board state at tick `i × blockInterval`
- Internal nodes = SHA-256(left || right)
- O(log T) storage for T checkpoints
- Supports inclusion proofs: prove that a specific state existed at a
  specific tick without revealing the entire history

### Verification

Given a session record (initial state + inputs + blocks), a verifier:

1. Deserializes the initial state into a fresh engine
2. Verifies `SHA-256(initialState) == blocks[0].startStateHash`
3. For each block:
   a. Verify `prevHash` links to previous block
   b. Verify `startStateHash` matches current engine state
   c. Replay simulation from `startTick` to `endTick`, applying inputs
   d. Verify `endStateHash` matches engine state after replay
   e. Verify `blockHash` matches recomputed hash of block contents
4. Verify Merkle tree root

The verifier uses *any* conforming emulator. Cross-platform determinism
(Layer 0) guarantees identical results regardless of which implementation
the verifier uses.

---

## Layer 3: Coin Mining (Rate Limiting)

Coins are a **local** rate-limiting mechanism. They exist on your board,
cannot be transferred, and control how fast you can make Moves.

### Earning

```
earned = elapsed_ticks / T_coin
```

During a share session (see Layer 5), the earn rate is multiplied by
`shareBoost` (default 2×). This incentivizes cooperation.

### Decay

```
balance(t) = balance(t₀) × 0.5^((t - t₀) / coinHalfLife)
```

Coins decay exponentially. Use them or lose them. This prevents
hoarding and ensures the rate limit is continuous.

### Spending

Each **Move** (Layer 4) costs `moveCost` coins (default 1). If your
balance is insufficient, the Move is rejected.

### Mining difficulty

The board contract specifies a `difficulty` D. To earn coins, you must
produce blocks whose hashes have at least D leading zero bits. This is
a proof-of-work that bounds the rate at which a player can interact
with their board.

At difficulty 0 (default), coins are earned automatically by simulating.
At difficulty > 0, the player must find a nonce that makes the block hash
meet the difficulty target, analogous to Bitcoin mining but local to one
board.

### Verification

A verifier checks:
- Coin balance at each block boundary matches the economics formula
- No Move was applied when balance was insufficient
- Block hashes meet the declared difficulty (if D > 0)

---

## Layer 4: Moves (Player Inputs)

A **Move** is a timestamped, signed action that modifies the board state.
Moves are recorded in the session chain and are deterministically replayable.

### Move types

```
Input {
    tick:   int         // Simulation tick at which to apply
    action: {
        type: string    // 'poke' | 'inject' | 'share_receive' | ...
        ...             // Type-specific payload
    }
}
```

- **poke**: Write specific bytes to a cell at a given offset
- **inject**: Load a preset or assembled program into a cell
- **share_receive**: Apply cells received from another board (see Layer 5)

### Ordering

Moves are applied at their declared tick during replay. Between moves,
the simulation advances deterministically. The ordering is:

```
for each block:
    while tick < endTick:
        apply any inputs scheduled at current tick
        step simulation by 1 tick (= 1 checkerboard pass)
```

### Cost

Each Move costs `moveCost` coins. The session refuses to apply a Move
if the player's decayed balance is insufficient.

---

## Layer 5: Shares (Board Interaction)

Shares allow two boards to exchange cell data. The protocol provides
**non-repudiation** (you can prove what was offered and accepted) without
requiring trust or a central authority.

### Primitives

**Offer**: "Here are cells from my board, signed by me."

```
Offer {
    type:        'offer'
    boardHash:   hex            // SHA-256 of my board state at offer time
    tick:        int            // My board's tick
    cells: [{
        i, j:    int            // Cell coordinates on my board
        data:    byte[1024]     // Full cell contents
        hash:    hex            // SHA-256 of cell data
    }]
    contentHash: hex            // SHA-256 of canonical offer content
    signature:   bytes          // Signer's signature over contentHash
}
```

**Receipt**: "I received your offer and applied it to my board, signed by me."

```
Receipt {
    type:           'receipt'
    offerHash:      hex         // contentHash of the offer I'm receipting
    offerBoardHash: hex         // boardHash from the offer
    myBoardHash:    hex         // SHA-256 of my board BEFORE applying
    applied: [{
        srcI, srcJ:  int        // Source cell on sender's board
        dstI, dstJ:  int        // Destination cell on my board
        hash:        hex        // Cell data hash (must match offer)
    }]
    tick:           int         // My board's tick when applied
    receiptHash:    hex         // SHA-256 of canonical receipt content
    signature:      bytes       // My signature over receiptHash
}
```

### Successful share

A **successful share** between Alice and Bob is the pattern:

1. Alice creates an Offer of cells from her board → sends to Bob
2. Bob creates an Offer of cells from his board → sends to Alice
3. Alice accepts Bob's Offer → creates Receipt, records `share_receive` input
4. Bob accepts Alice's Offer → creates Receipt, records `share_receive` input

Both chains now contain cross-referencing offers and receipts. Neither
party can deny the exchange. Either party can back out at any point
without consequence — incomplete shares are simply absent from the chain.

### Share incentive

During a share session, the earn rate is boosted by `shareBoost` (default 2×).
This means cooperating boards accumulate coins faster, enabling more Moves.
The boost is recorded in the session and verifiable.

### Verification

A verifier checks:
- The `share_receive` input in the chain includes the offer's contentHash
  and signature
- The cell data hashes match between offer and receipt
- The `share_receive` input was applied at the declared tick
- The player had sufficient coins to afford the Move (share_receive costs
  the same as any other Move)

---

## Layer 6: Matchmaking (Discovery & Negotiation)

The matchmaking layer is **out of scope** for the verifiable chain. It is
a convenience layer that helps players find each other and negotiate shares.
Nothing in this layer needs to be cryptographically verified — it's just
plumbing.

### Functions

- **Board discovery**: Broadcast your board's contract, current state summary,
  and willingness to share
- **Offer routing**: Forward offers between players (any transport: WebSocket,
  WebRTC, relay server, even email)
- **Chat**: Free-form communication between players negotiating shares
- **Matchmaking heuristics**: Suggest compatible boards based on size,
  activity, replicator diversity, etc.

### Non-requirements

- No consensus protocol (each board is sovereign)
- No global state (no blockchain, no shared ledger)
- No trust in the relay (offers and receipts are self-authenticating)
- No guaranteed delivery (if an offer is lost, just make another one)

### Implementation options

- **WebSocket relay server**: Players connect, advertise boards, relay offers
- **WebRTC peer-to-peer**: Direct connections between players after discovery
- **Static file exchange**: Export offers as JSON files, share via any channel
- **Pub/sub topics**: One topic per board size / board type

---

## Full Verification Flow

A verifier who wants to confirm an entire board history:

```
1. Parse the BoardContract
2. Regenerate initial state via ChaCha20(key, nonce, size² × 1024)
3. Verify SHA-256(initial state) matches chain's genesis
4. Initialize a conforming emulator (any implementation)
5. For each block in the chain:
   a. Verify hash chain linkage (prevHash)
   b. Verify startStateHash matches current emulator state
   c. Verify coin balance permits all Moves in this block
   d. Apply Moves at their declared ticks
   e. Step simulation from startTick to endTick
   f. Verify endStateHash matches emulator state
   g. Verify blockHash
   h. If block contains share_receive: verify offer signatures and
      cell data integrity
   i. If difficulty > 0: verify blockHash has sufficient leading zeros
6. Verify Merkle tree root matches final block's merkleRoot
7. Optionally: verify Merkle inclusion proofs for specific checkpoints
```

The verifier does not need to trust the original player, the relay, or
any specific emulator implementation. The only trust assumption is the
correctness of the 6502 CPU specification (Layer 0), which is testable
against the reference implementation via random opcode soup.

---

## Summary: Layer Stack

```
Layer 6: Matchmaking    — Discovery, offer routing, chat (unverified)
Layer 5: Shares         — Signed offers + receipts between boards
Layer 4: Moves          — Timestamped signed inputs, coin-gated
Layer 3: Coins          — Local rate limiter: earn/decay/spend
Layer 2: Session Chain  — Hash chain + Merkle tree of board history
Layer 1: Board Contract — Immutable spec: seed, params, difficulty, economics
Layer 0: Bare Sim       — Deterministic 6502 execution (cross-platform)
```

Each layer depends only on the layers below it. Verification starts at
Layer 0 (deterministic execution) and builds up. The system is fully
decentralized — no global consensus, no shared state, no central authority.
Each board is a sovereign chain verified by deterministic replay.
