# 6502coin Economics and Architecture Review

Date: 2026-03-22

This document reviews the full 6502coin implementation as it exists in `coin/`,
cross-referenced against the design proposals in `doc/gridcoin-proposal.md`,
`doc/gridcoin-architecture.md`, `doc/gridcoin-blockchain-options.md`, and
`doc/gridcoin-math-review.md`. The goal is to assess what is built, what is
missing, and where the design has unresolved problems before launch.

---

## 1. Blockchain Structure

### What is implemented

**Every board is its own blockchain.** A `Session` (`coin/session.js`) wraps an
`Engine` and produces a linear hash chain of blocks. Each block covers a fixed
tick interval (default 10,000 ticks, configurable via `blockInterval`). The
session captures initial state, timestamped inputs, and the block chain. This
is sufficient to reproduce the full trajectory.

**There is one coin per player, per board.** Each player runs their own board
and mints coins locally. There is no shared ledger or global coin. A coin is
simply a reference to a valid block in a player's local chain. The `economics.js`
module computes a *value estimate* for each session's coins, but coins from
different sessions/players are not fungible on-chain — they are scored locally.

**Block contents.** Each block (`coin/session.js`, lines 120-129) contains:

```
index, prevHash, startStateHash, endStateHash, inputs[],
startTick, endTick, wallTimeMs, summary{}
```

The block hash is computed from a canonical JSON string of these fields
(sorted keys, via `canonicalBlockString()`). Social blocks add:
`boundaryFramesSent`, `boundaryFramesReceived`, `partnerPubkeyHex`, `edgeExport`.

**Hash chain linkage.** Each block's `prevHash` is the SHA-256 hash of the
previous block's canonical content. The genesis block uses 64 zero bytes.
The `endStateHash` of block N must equal the `startStateHash` of block N+1
(enforced during verification).

### What is NOT implemented

**No Merkle tree.** The math review (`gridcoin-math-review.md`, section A3)
flags this: proving inclusion of a specific block requires the full chain of
hashes. A Merkle tree would allow O(log N) inclusion proofs. For a player who
mines for months (thousands of blocks), this becomes a scalability issue for
anyone wanting to verify a subset.

**No delta encoding or checkpoint compression.** The proposal calls for delta
encoding of state snapshots and periodic full snapshots (every N blocks). The
implementation stores nothing between blocks — the initial state hex is saved
once, and each block records only the hash of the end state, not the state
itself. This means:

- A verifier must replay from the initial state to verify any block.
- There is no way to "skip ahead" to verify block 500 without replaying
  blocks 0-499 first.
- The player must retain the initial state forever.

This is the gap identified in the math review (section A1): "Where does the
verifier get the start state?" The answer in the current implementation: you
replay from the very beginning. This makes spot-checking expensive.

**No on-chain component.** The blockchain-options doc recommends deploying an
ERC-20 on Base or Arbitrum (Phase 2). Nothing in `coin/` connects to any
external blockchain. The entire system is local-first with no settlement layer.

### Reconstruction challenge protocol

A verifier reconstructs a claimed trajectory by:

1. Deserializing the `initialStateHex` from the session record.
2. Initializing a fresh engine with the session's `config`.
3. Stepping through tick-by-tick, applying inputs at their timestamps.
4. At each block boundary, serializing state, computing SHA-256, and comparing
   against the block's `endStateHash`.
5. Checking that `prevHash` links are unbroken.

This is implemented in `coin/verify.js` (`verifySession()`) and works correctly
for solo sessions. For social sessions, `coin/social-session.js`
(`verifySocialSession()`) additionally replays both boards with edge-sharing
and cross-checks boundary frame hashes.

### Minimum data for proof of mining history

A player must store:

- **Session record**: `initialStateHex` (the full serialized initial state),
  `config`, and all blocks with their hashes.
- **For social mining**: all boundary frame hashes (not full frame data — the
  implementation stores only hashes in blocks).

For a Game of Life engine on a 32x32 grid, the initial state is 168 bytes.
For 6502life on a 16x16 board, the initial state is a JSON blob containing
the full controller state (hundreds of KB to low single-digit MB depending
on board activity).

**Storage cost estimate (6502life, 16x16 board):**

- Initial state: ~1-3 MB (JSON-serialized controller state)
- Per block: ~500-2000 bytes (hashes, tick counts, summary stats)
- At 1 block per 10,000 ticks, mining 100,000 ticks: ~10 blocks, ~15 KB
- Social mining adds boundary frame hashes: ~64 bytes per hash, 100 frames
  per block = ~6.4 KB per block

Total for a typical session: initial state dominates. A day of mining might
produce 50-500 blocks depending on tick rate, adding 25-1000 KB.

**Problem: the initial state for `Board6502Engine` is bloated.** The
`serialize()` method (`coin/engines/board6502.js`, line 117) dumps the
entire `controller.state` (which is the full `BoardMemory` + PRNG + CPU
state) as JSON. For a 16x16 board this is ~256 KB minimum. The proposal
envisioned 1MB for 32x32; a 16x16 board is smaller but still large for
a mobile device over time. If a player accumulates 100 sessions, that is
25+ MB of initial states alone.

---

## 2. Solo Mining Economics

### Emission rate

**1 coin per block.** The `computeCoinValue()` function in `economics.js`
(line 60) sets `baseValue = session.blockCount`. Every block is worth 1 base
coin. There is no halving schedule, no difficulty adjustment, and no cap on
total supply. Mining more blocks = more coins, linearly.

**No emission curve.** The proposals mention "one coin per unit of verified
simulation time" without defining the unit. The implementation defines it
as "one coin per block" where a block is `blockInterval` ticks (default
10,000). The math review (section S2) flagged that the unit is unspecified.
The implementation resolves this ambiguity: 1 block = 1 coin.

**No inflation control.** With N miners each producing B blocks/day, total
daily emission = N * B coins. At 1000 miners, 48 blocks/day each, that is
48,000 coins/day with no cap. The proposal mentions a halving schedule
(section 9.5) but the implementation has none. This is a critical gap for
any token that aims to have exchange value.

### What makes one coin worth more than another?

The `economics.js` module applies three multipliers to the base value:

1. **Activity multiplier (1.0-2.0):** Rewards "interesting" simulations.
   For Game of Life: density near 0.35, high birth rate. For 6502life:
   copies/swaps (replication events), unique cell hashes (diversity).
   A dead board (all BRK 0) gets 1.0x; an active board with replicators
   can get up to 2.0x.

2. **Social multiplier (1.0-1.5):** 1.3x base for having a partner, +0.1x
   for sessions > 5 minutes, +0.1x for sessions > 30 minutes. Cap: 1.5x.

3. **Network multiplier (1.0-2.0):** Based on network-wide stats: how many
   unique players exist, social graph density. Requires a `NetworkHistory`
   object (number of unique players, social graph edges).

**Maximum theoretical multiplier:** 2.0 * 1.5 * 2.0 = 6.0x. A highly
active social miner on a well-connected network gets 6x the coins of an
isolated player running a dead board.

### Anti-cheat: dead board detection

The `computeActivityMultiplier()` function checks engine summary stats:

- **Game of Life:** `density`, `totalBorn` — a static board with no births
  scores 0 activity bonus.
- **6502life:** `totalCopies`, `uniqueHashes`, `activeCells` — a board
  where nothing is writing or moving scores 0 activity bonus.

**Gap:** The activity check uses the `lastSummary` from the final block only.
A miner could run a dead board for 99% of the session and then inject an
active program in the last block to inflate the summary stats. The fix:
average summary stats across all blocks, or check each block independently.

### Anti-cheat: speedup detection

Blocks include `wallTimeMs` (wall-clock time for the block). The proposal
says to reject blocks where the ratio `wallTimeMs / simTicks` is outside
[0.5x, 2x]. **The implementation records `wallTimeMs` but never checks it.**
Neither `verify.js` nor `social-session.js` validates the wall-clock ratio.
The field is present in the data but unenforced.

The math review (section A5) is devastating on this point: wall-clock
timestamps are self-reported. The miner controls the device. Without
hardware attestation (TEE/secure enclave) or external entropy injection,
the wall-clock field is entirely unenforced and trivially forgeable. The
implementation confirms this: the timestamp is `Date.now()` at block
production time, and nothing prevents a miner from running the simulation
at 1000x speed and setting `wallTimeMs` to whatever they want.

**No external entropy injection.** The proposal mentions mixing in hashes
from a public blockchain at block boundaries. The implementation has no
such mechanism. All entropy comes from the deterministic PRNG seed, making
pre-computation trivial for 6502life (which has no player inputs).

### Proof-of-interesting-life

The `summarize()` method on each engine provides trajectory stats:

- **LifeEngine:** `liveCells`, `density`, `totalBorn`, `totalDied`, `clock`
- **Board6502Engine:** `activeCells`, `totalCopies`, `totalSwaps`,
  `uniqueHashes`, `ticks`

These are included in each block's `summary` field and hashed into the
block hash, making them tamper-evident (changing a summary invalidates the
block hash). However, a miner who fabricates the entire trajectory from
scratch can produce valid blocks with whatever summary stats they want.
The summary stats are only meaningful if the trajectory itself is verified
by replay.

---

## 3. Social/Paired Mining

### Implementation status

Social mining is fully implemented across three modules:

- **`coin/social.js`:** `shareBoundary()` exchanges boundary data between
  two engines. `EdgeSession` manages lockstep execution with periodic
  boundary exchanges at a configurable interval (default 100 ticks).

- **`coin/social-session.js`:** `SocialSession` wraps two engines and an
  `EdgeSession`, producing dual-signed blocks for both players. Each block
  carries:
  - Author signature (player signs their own block)
  - Witness signature (partner signs the other player's block)
  - Boundary frame hashes (what was sent and received)
  - Partner's public key

- **`coin/social-session.js` verification:** `verifySocialSession()` checks:
  1. Hash chain integrity for both sessions
  2. Author signature validity on each block
  3. Witness signature validity on each block
  4. Cross-consistency of boundary frames (A's sent = B's received)
  5. Full replay with edge-sharing (optional, expensive)

### Edge-sharing mechanics

The `EdgeSession` runs both engines in lockstep. Every `shareInterval` ticks
(default 100), it calls `shareBoundary()` which:

1. Reads each engine's export edge via `getBoundary(edge)`
2. Writes each engine's data to the partner's import edge (opposite side)
3. Records `BoundaryFrame` objects with tick, data, and SHA-256 hash

For the LifeEngine, a boundary is a single row/column of cells (e.g., 32
bytes for a 32x32 board). For Board6502Engine, a boundary is B * 1024 bytes
(e.g., 16 KB for a 16x16 board). This is the data that flows over the
network between two players.

### How edge-sharing affects coin value

The `socialMultiplier` in `economics.js` gives a flat 1.3x-1.5x bonus for
social mining sessions, regardless of what actually crosses the boundary.
**There is no mechanism to detect whether organisms actually colonized the
partner's board.** The colonization thesis from the proposal (section 6.2 —
"your replicator colonizes a partner's board") is not implemented. The bonus
is purely for having a partner, not for biological success.

### Organism identification across boards

**Not implemented.** The proposal envisions tracking "your organisms" across
boards using lineage tracking or MinHash fingerprinting (which exists in
the main 6502life engine). The coin layer has no concept of organism
identity or lineage. The `Board6502Engine.summarize()` counts total copies
and unique hashes but does not attribute them to a source player.

This is the largest gap between the proposal's vision and the implementation.
The proposal's economic thesis — that coins from boards where your organisms
thrive are more valuable — has no implementation support. There is no way
to verify "player A's replicator spread to player B's board" from the data
recorded in blocks.

### Dual-witness Ed25519 signed blocks

The implementation uses Node.js built-in `crypto` module for Ed25519
(available since Node 19+). Key generation uses DER-encoded SPKI/PKCS8
format. Signing and verification work correctly.

**Concern from the math review (section A4):** The dual-witness structure
incentivizes *consistency* but not *quality*. Two colluding players can
run empty boards, faithfully record trivial boundary exchanges, and earn
the social mining bonus. The activity multiplier partially addresses this
(dead boards get 1.0x), but the social multiplier is independent of
simulation activity. A dead social session gets 1.0 * 1.3 = 1.3x, which
is still better than an active solo session at 2.0 * 1.0 = 2.0x, but
worse than an active social session at 2.0 * 1.5 = 3.0x.

---

## 4. Coin Trading

### Current state: not implemented

There is no trading mechanism in `coin/`. The `economics.js` module computes
a *score* for sessions, but there is no:

- Transfer function (signing a message: "I send N coins to pubkey X")
- Wallet abstraction (tracking coin balances across sessions)
- Transfer validation (checking sender has sufficient balance)
- Any concept of "spending" a coin

The architecture doc specifies a `transfer.js` module with signed transfer
messages and mutual recording (Milestone 5), but this does not exist.

### Design questions unresolved

**Are coins from different boards fungible?** The current scoring model
treats each session independently. A player who runs 3 sessions has 3
separate coin scores, not a combined balance. There is no mechanism to
aggregate coins across sessions into a single balance.

**How would trading work?** The architecture doc proposes:
- Player A signs a transfer message with their private key
- Both parties record the transfer
- Transfer validity requires the sender's chain to show sufficient balance

This is a simple bilateral ledger, not a blockchain. It works for
peer-to-peer transfers but has no global consensus — two parties can
disagree about who owns what, and there is no arbiter.

**When would coins move on-chain?** The blockchain-options doc recommends
deploying an ERC-20 on Base (Phase 2). The trigger for moving coins
on-chain would be: player submits their local chain to a smart contract,
the contract stores the block hash commitment and mints ERC-20 tokens.
This is specified but not implemented.

---

## 5. Matchmaking

### Current state: partially specified, not implemented

The phone-client-research doc recommends **WebRTC via PeerJS** for
peer-to-peer connections, not Bluetooth. Key findings from that research:

- **Web Bluetooth cannot do phone-to-phone discovery.** It is Central-only;
  neither phone can advertise as a BLE peripheral. The proposal's Bluetooth
  vision requires native code (Capacitor or React Native).

- **WebRTC is the practical choice.** 97% browser coverage including iOS
  Safari. PeerJS provides a free signaling server and establishes direct
  peer-to-peer data channels in ~10 lines of code.

**The pivot from Bluetooth to WebRTC is significant.** The proposal's
proximity guarantees rely on BLE's limited range (~10-30m). WebRTC works
over the internet, which means:

- No inherent proximity enforcement
- Latency-based proximity checks are weaker (WebRTC latency on LAN is
  <50ms, on internet <100ms — the gap is small)
- The "social mining = physical co-presence" thesis is fundamentally
  weakened unless the app uses Capacitor for native BLE

### Player discovery

**PeerJS signaling server:** A player creates a room (gets a peer ID),
shares it as text or QR code, and the partner joins. This is manual
discovery — no automatic scanning for nearby players.

**No geolocated discovery.** The proposal mentions this but the research
doc does not recommend it. No implementation exists.

**No decentralized matchmaking.** PeerJS uses a central signaling server
for connection setup. The data channel is peer-to-peer after setup, but
discovery requires the server.

### Incentives for connectors

**Not addressed.** There is no mechanism for rewarding players who help
others connect. The network multiplier in `economics.js` rewards players
who have many unique partners, but this rewards the players themselves,
not intermediaries.

---

## 6. Token Design

### Current architecture: purely local, no on-chain component

The implementation is entirely local. There is no smart contract, no ERC-20
token, no connection to any blockchain. Coins exist as local session records
scored by `economics.js`.

### The recommended path (from blockchain-options.md)

The blockchain-options doc recommends a phased approach:

1. **Phase 1 (now):** Local-first mining. This is what exists.
2. **Phase 2:** ERC-20 on Base or Arbitrum. A `commitBlock()` function
   stores block header hashes on-chain and mints tokens. Cost: ~$0.001/tx
   on Base. A player mining 48 blocks/day pays ~$0.05/day.
3. **Phase 3:** Fraud proofs. An off-chain verifier replays challenged
   sessions. Challenge/response with bond posting.
4. **Phase 4:** Re-evaluate (Solana, ZK proofs, or stay peer-to-peer).

### What triggers moving coins on-chain?

Not defined in the implementation. The natural trigger: when a player wants
to trade coins with someone who is not physically present, they need a
shared ledger. The on-chain component provides:

- Globally consistent balances (no double-spending)
- Trustless transfers to strangers
- DEX listing possibility

Until then, the local-first model works for the social gaming use case.

### Hybrid model assessment

The hybrid approach (local mining, on-chain settlement) is sound. The
expensive computation stays on the phone; the cheap commitment goes on-chain.
Per the blockchain-options analysis:

- **Base:** ~$0.001/tx, lowest fees, Coinbase Wallet integration
- **Arbitrum:** ~$0.008/tx, most mature L2
- **Solana:** ~$0.00025/tx, best fees but steeper dev curve (Rust/Anchor)

For a JavaScript developer, Base with Solidity + ethers.js is the path of
least resistance. The contract would be ~200-300 lines of Solidity.

---

## 7. Open Questions and Risks

### 7.1 Sybil attacks (fake social partners)

**Risk:** A single entity runs two instances of the app, connects them via
WebRTC, and earns the social mining bonus with no real second player.

**Current defense:** None. The `SocialSession` constructor takes two engines
and two keypairs. Nothing prevents one process from generating both keypairs
and running both engines. The test suite (`coin/test/social.test.js`)
literally does this to test the feature.

**Impact:** With the current multipliers, a Sybil attacker earns 1.3-1.5x
base rate vs. 1.0x for solo mining. This is a modest advantage — the
proposal deliberately keeps the social bonus low to limit Sybil incentives.

**Proposed fix:** Short-term, accept it. The 1.3-1.5x bonus is small
enough that Sybil attacks are only marginally profitable. Long-term, if
native BLE (via Capacitor) provides proximity enforcement, require BLE
attestation for the social bonus. Alternatively, use a rate limiter: each
public key can participate in at most K social sessions per day.

### 7.2 Speedup attacks (run simulation faster than real-time)

**Risk:** A miner runs the 6502life simulation on a fast machine at 100x
speed, accumulating blocks far faster than a phone miner.

**Current defense:** The `wallTimeMs` field is recorded but never validated.
The field is self-reported. There is zero enforcement.

**This is the most critical vulnerability in the system.** A miner with a
desktop can produce 100x more blocks than a phone miner in the same wall
time. The coins all verify correctly because the hash chain and state
transitions are valid.

**Proposed fixes (ordered by feasibility):**

1. **Enforce wall-clock ratio in `verify.js`.** Add a check:
   `if (wallTimeMs < expectedMinMs) reject`. This is trivially bypassable
   (set `wallTimeMs` to any value you want) but raises the bar from
   "completely unenforced" to "must at least forge the timestamp."

2. **External entropy injection.** At block boundaries, require the miner
   to include a hash from a public source (e.g., a recent Bitcoin block
   hash, or a random beacon). This prevents pre-computation. The miner
   cannot compute block N+1 until the external entropy for that block
   boundary is published. **Tradeoff:** requires internet connectivity at
   block boundaries, breaking offline mining.

3. **Commitment scheme.** The miner publishes a commitment (hash of block
   header) before the block interval begins, then reveals the block later.
   A verifier checks that the commitment was published before the block
   interval started, proving the miner did not pre-compute. Requires a
   timestamping service.

4. **Interactive challenges.** A verifier sends a random nonce to the miner
   mid-block. The miner must incorporate the nonce into the block. This
   proves the miner was running in real-time but requires a live connection
   to a verifier during mining.

5. **Accept it.** If the coin has no exchange value, speedup attacks do not
   matter. This is the pragmatic position for an early-stage game.

### 7.3 Economic bootstrapping (why are the coins worth anything?)

**Current answer: they are not.** Coins are a score in a game. They have
no exchange value, no utility beyond bragging rights, and no connection to
any market.

**The proposal's answer:** Value emerges from network effects. Coins from
boards with thriving organisms and many social connections are "more
interesting" and trade higher. But this requires:

1. A functioning market (not implemented)
2. Informed participants who can evaluate "interesting" (unrealistic at
   scale)
3. A mechanism to verify "interesting" (the `summarize()` stats are a
   weak proxy, and the math review flags that they are easily gamed)

**Pragmatic path:** Do not try to make coins valuable. Make the game fun.
Let the simulation be intrinsically interesting to watch. Coins are a
record of play time, like an achievement badge. If a community forms
around the game and decides coins are worth trading, that is organic
value creation. Do not engineer token economics before there is a
community.

### 7.4 State bloat (storage on mobile)

**6502life state sizes:**

| Board size | Per-state JSON | 100 sessions | Notes |
|-----------|---------------|-------------|-------|
| 8x8 | ~50-100 KB | 5-10 MB | Minimal board |
| 16x16 | ~250-500 KB | 25-50 MB | Recommended for mobile |
| 32x32 | ~1-3 MB | 100-300 MB | Upper limit for phone |

**Game of Life state sizes:**

| Board size | Per-state binary | 100 sessions | Notes |
|-----------|----------------|-------------|-------|
| 32x32 | 168 bytes | 16 KB | Trivial |
| 64x64 | 552 bytes | 54 KB | Trivial |

The Game of Life engine uses compact binary serialization (packed bits +
PRNG state). The 6502life engine uses JSON serialization of the entire
controller state. **The 6502life serialization is 1000x larger than it
needs to be.** A binary format (raw storage bytes + PRNG state + counters)
would reduce a 16x16 board state from ~300 KB JSON to ~256 KB binary, and
enable delta encoding.

**Block metadata storage:** Negligible. Each block is ~1-2 KB. Even
10,000 blocks (months of mining) is ~10-20 MB.

**Proposed fix:** Implement binary serialization for `Board6502Engine`.
Add delta encoding (store only changed bytes between checkpoints). Add
periodic full snapshots (every N blocks) to bound replay cost.

### 7.5 Privacy (does social mining reveal your location?)

**With WebRTC:** Yes, partially. WebRTC ICE candidates include local and
public IP addresses. A WebRTC peer can see your IP address. PeerJS
signaling traffic is not encrypted beyond HTTPS. However, WebRTC data
channels use DTLS encryption, so the actual simulation data is encrypted
in transit.

**With BLE (if implemented via Capacitor):** Physical proximity is implied
(BLE range ~10-30m) but no location data is transmitted. No IP address
exposure.

**Social graph exposure:** The social mining blocks record partner public
keys. Over time, this builds a graph of who mined with whom. If public
keys are linkable to real identities, the social graph reveals physical
co-location patterns. This is a privacy concern for any deployment where
users are identifiable.

**Proposed fix:** Use ephemeral public keys per session. Each social
mining session generates a fresh keypair. This prevents linking sessions
to a persistent identity, at the cost of making the network multiplier
(which rewards many unique partners) meaningless.

---

## 8. Implementation Quality Assessment

### What is well-implemented

- **Engine interface (`coin/engine.js`):** Clean, minimal, game-agnostic.
  The `Engine` base class defines exactly the right set of methods. Both
  `LifeEngine` and `Board6502Engine` implement it correctly.

- **Session recording (`coin/session.js`):** Solid. Hash chain production,
  canonical JSON serialization, block boundary detection — all work
  correctly. The `finalize()` method handles partial final blocks.

- **Verification (`coin/verify.js`):** Thorough. Replays the full
  simulation, checks every block's state hashes, validates hash chain
  linkage and block hash integrity.

- **Social session (`coin/social-session.js`):** Complete dual-witness
  implementation. Author signatures, witness signatures, cross-consistency
  checks, replay verification with edge-sharing. This is the most complex
  module and it is well-structured.

- **PRNG (`coin/prng.js`):** xoshiro128** is a good choice — fast,
  well-specified, small state (16 bytes), excellent statistical quality.
  Avoids the Mersenne Twister variance problem flagged in the math review
  (different MT implementations have different seeding procedures).

- **Game of Life engine (`coin/engines/life.js`):** Clean reference
  implementation with compact binary serialization.

### What needs work

- **Board6502Engine serialization:** JSON-based, bloated. Should use binary
  format matching the main engine's state save/load.

- **Board6502Engine.applyInput() is async:** It uses `await assemble()`
  for preset injection. But the `Session.applyInput()` method and
  `verifySession()` do not await it. This is a latent bug: if a player
  injects a preset mid-session, the verification replay may not wait for
  the assembly to complete before stepping the engine.

- **Wall-clock validation:** Recorded but never checked. Should at
  minimum be validated in `verify.js`.

- **No wallet or balance tracking:** The architecture doc specifies
  `wallet.js` and `keygen.js` as Milestone 3 deliverables. Neither exists.

- **No CLI for mining:** The `coin/bin/` directory has `mine.js`,
  `social-mine.js`, and `social-verify.js` but I have not verified their
  functionality.

- **Duplicated `sortObj()` function:** Appears identically in `session.js`,
  `social-session.js`, and `verify.js`. Should be extracted to a shared
  utility.

- **`canonicalBlockString()` duplicated and divergent:** The solo version
  (`session.js`) and social version (`social-session.js`) have different
  field sets. The `verify.js` version constructs the object inline. These
  should be unified to prevent hash mismatches.

### Divergences from proposals

| Proposal says | Implementation does | Impact |
|--------------|-------------------|--------|
| Bluetooth social mining | WebRTC (per phone-client-research) | No proximity enforcement |
| Wall-clock validation with 0.5-2x tolerance | Records wallTimeMs, never validates | Speedup attacks undefended |
| External entropy injection at block boundaries | No external entropy | Pre-computation trivial |
| Delta encoding for state snapshots | Full state only, no deltas | Storage bloat |
| Merkle tree for block inclusion proofs | Linear hash chain only | O(N) inclusion proofs |
| Halving schedule or difficulty adjustment | Fixed 1 coin/block, no cap | Unbounded inflation |
| Organism tracking across boards | Not implemented | Core value thesis unverifiable |
| ERC-20 on Base/Arbitrum (Phase 2) | No on-chain component | No global settlement |
| PRNG: Mersenne Twister | xoshiro128** | Good change — avoids MT variance |
| bigint for clock | number for clock | Overflow after 2^53 ticks (~285 million years at 1 tick/ms, not a practical concern) |

---

## 9. Recommendations

### Must-fix before any launch

1. **Validate wall-clock ratio in `verify.js`.** Even if forgeable, it
   filters naive speedup attempts.

2. **Fix async `applyInput()` in Board6502Engine.** Either make it
   synchronous (pre-assemble presets at init time) or make the session
   layer async-aware.

3. **Unify `canonicalBlockString()` and `sortObj()`.** Extract to
   `coin/hash.js` or a new `coin/canonical.js`.

### Should-fix before social launch

4. **Implement binary serialization for Board6502Engine.** Reduce state
   size by ~10-100x.

5. **Add periodic full state snapshots.** Store a full state every N
   blocks to bound verification replay cost.

6. **Add organism tracking to social mining.** Use MinHash fingerprinting
   (already in the main engine) to detect when organisms cross boundaries.
   Record lineage attribution in blocks. This is the core differentiator.

### Nice-to-have

7. **Merkle tree for block chains.** Enables O(log N) inclusion proofs.

8. **External entropy injection.** Mix in a public random beacon at
   block boundaries (when online).

9. **Wallet module.** Track balances across sessions.

10. **ERC-20 contract on Base.** The architecture doc has the spec;
    implementation is ~2-4 weeks of Solidity work.

---

## 10. Summary

The `coin/` implementation is a solid foundation for session recording,
verification, and dual-witness social mining. The Engine interface is
clean, the hash chains work, and the social session verification is
thorough. The Game of Life engine serves as an excellent reference
implementation.

The critical gaps are in the *economics* layer: no inflation control, no
wall-clock enforcement, no organism tracking, and no trading mechanism.
The token value thesis ("coins from boards with thriving organisms trade
higher") has no implementation support — there is no way to verify
organism provenance, no market to trade on, and no on-chain settlement.

The most pragmatic path forward: treat coins as game scores, not
financial instruments. Make the simulation fun. Build the social gaming
experience (WebRTC connection, shared edge, watching organisms cross
boundaries). Add token economics later if a community forms that wants
to trade. The blockchain plumbing is the least important part of the
system right now.
