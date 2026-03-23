# 6502coin Protocol Specification

Version 1.0 --- 2026-03-23

This is the canonical protocol specification for 6502coin. It supersedes all
previous proposal and economics documents (`gridcoin-proposal.md`,
`coin-social-incentives.md`, `pairing-model.md`, `coin-economics-review.md`).

---

## 1. Overview

6502coin is a cryptographically verifiable score derived from running
deterministic 6502life board simulations. Each player owns a board, proves
continuous simulation via a Merkle tree of state history, and earns score
proportional to simulation time, social connectivity, and trust.

There is no global blockchain. The protocol is fully peer-to-peer. Coins are
cosmetic scores --- cryptographically verifiable but not fungible tokens on a
shared ledger.

---

## 2. Definitions

**Board.** A B x B toroidal grid of 6502 cells, each with 1024 bytes of
memory. B is a power of 2 (typically 16 or 32 for mobile).

**Tick.** One scheduler interrupt cycle. The atomic unit of simulation time.

**Owner.** The entity holding the Ed25519 private key that signed the board's
contract. The owner is authoritative over their board's state and history.

**Move.** A timestamped player event applied to the board: keystroke, cell
write, preset injection, byte poke, or any action accepted by
`Engine.applyInput()`. Moves are the only source of non-deterministic external
input (beyond the initial state and PRNG seed).

**Edge sharing.** A time-bounded session in which two boards exchange boundary
cell data, allowing organisms to cross between them.

**Attestation.** A signed statement by two parties asserting that they shared
an edge, agreed on the history during the shared period, and observed no
protocol violations.

---

## 3. Board Ownership

### 3.1 Board Contract

A board is created by signing an initial contract with the owner's Ed25519
private key. The contract is a canonical JSON object containing:

```
{
  "version":          1,
  "ownerPubkey":      <hex-encoded Ed25519 public key>,
  "boardSize":        <integer, power of 2>,
  "seed":             <integer, PRNG seed>,
  "initialStateHash": <hex-encoded SHA-256 of serialized initial state>,
  "blockInterval":    <integer, ticks per block>,
  "maxMovesPerDay":   <integer, maximum player events per 24h wall-clock period>,
  "maxMoveSize":      <integer, maximum bytes per move payload>,
  "createdAt":        <ISO 8601 timestamp>,
  "gameId":           "6502life"
}
```

The contract is signed by the owner:

```
contractSignature = Ed25519.sign(canonicalJSON(contract), ownerPrivateKey)
```

The signed contract is the board's birth certificate. It is immutable. The
owner must provide it on demand to any challenger.

### 3.2 Proof of Ownership

Ownership is proven by responding to cryptographic challenges (Section 7).
The owner demonstrates they can produce Merkle proofs and board states that
are consistent with the signed contract and the claimed history. Only the
holder of the private key can sign blocks and respond to challenges.

---

## 4. Sufficient Statistics

The complete history of a board is determined by three things:

1. **Initial state** S_0 (the full serialized board state at tick 0).
2. **PRNG seed** (embedded in S_0).
3. **Ordered list of timestamped Moves** [(t_1, m_1), (t_2, m_2), ...].

Given these, any verifier can reproduce the board's state at any tick T by
replaying the simulation from S_0, applying each Move at its timestamp, and
stepping the engine forward. The final state at tick T is deterministic.

For autonomous 6502life boards with no player interaction, the Move list is
empty. The entire trajectory is determined by S_0 alone.

---

## 5. Board History as Merkle Tree

### 5.1 Structure

The board's state history is stored as a binary Merkle tree of checkpoint
state hashes.

- **Leaves** are SHA-256 hashes of the serialized board state at checkpoint
  ticks. Checkpoints occur at every block boundary (every `blockInterval`
  ticks).
- **Internal nodes** are `SHA-256(left_child || right_child)`, where `||`
  denotes concatenation of the two 32-byte child hashes.
- **Level K** of the tree covers 2^K consecutive checkpoints. Level 0 is
  the leaves. The root is at level ceil(log2(N)) for N checkpoints.
- The **root hash** commits to the entire history.

For N checkpoints (equivalently, T = N * blockInterval ticks of simulation),
the tree has O(N) nodes total, but only O(log N) nodes are needed to verify
any single checkpoint (a Merkle inclusion proof).

### 5.2 Incremental Construction

The tree is built incrementally as new blocks are produced. When a new
checkpoint is appended as leaf index I:

1. Store the leaf hash at level 0, index I.
2. If I is odd, compute the parent: `parent = SHA-256(sibling || leaf)`.
   Store at level 1, index floor(I/2).
3. Propagate upward: at each level, if the new node completes a pair,
   compute and store the parent. Continue until reaching an unpaired node.

This is O(log N) work per checkpoint and O(N) total storage.

### 5.3 Incomplete Trees

When the number of leaves is not a power of 2, unpaired nodes at each level
are hashed with a 32-byte zero hash (all zeros) to compute their parent.

### 5.4 Merkle Inclusion Proofs

To prove that a specific checkpoint (state hash H at tick T) is part of the
history, the owner provides:

- The leaf index I (derived from T / blockInterval).
- The state hash H.
- The sibling hashes along the path from the leaf to the root: O(log N)
  hashes.

A verifier recomputes the root from the leaf and the sibling path. If the
computed root matches the claimed root hash, the checkpoint is proven to be
part of the history.

---

## 6. Block Chain

### 6.1 Block Structure

Blocks are produced at every `blockInterval` ticks. Each block contains:

| Field              | Type       | Description                                      |
|--------------------|------------|--------------------------------------------------|
| `index`            | integer    | Block sequence number (0-indexed)                |
| `prevHash`         | hex string | SHA-256 of previous block's canonical content    |
| `startStateHash`   | hex string | SHA-256 of board state at block start            |
| `endStateHash`     | hex string | SHA-256 of board state at block end              |
| `inputs`           | array      | Moves applied during this block                  |
| `startTick`        | integer    | Simulation tick at block start                   |
| `endTick`          | integer    | Simulation tick at block end                     |
| `wallTimeMs`       | integer    | Wall-clock milliseconds elapsed during this block|
| `summary`          | object     | Engine summary statistics at block end           |

The genesis block (index 0) has `prevHash` = 64 hex zeros.

### 6.2 Block Hash

The block hash is `SHA-256(canonicalJSON(block))`, where `canonicalJSON`
produces a JSON string with keys sorted lexicographically at all nesting
levels, no whitespace, and arrays preserved in order.

### 6.3 Hash Chain Integrity

- `block[N].prevHash` = `block[N-1].hash`
- `block[N].startStateHash` = `block[N-1].endStateHash`

These two invariants ensure that blocks form an unbroken, tamper-evident
chain anchored to the initial state.

### 6.4 Social Blocks

During edge-sharing sessions (Section 8), blocks carry additional fields:

| Field                    | Type       | Description                              |
|--------------------------|------------|------------------------------------------|
| `boundaryFramesSent`     | string[]   | SHA-256 hashes of boundary data sent     |
| `boundaryFramesReceived` | string[]   | SHA-256 hashes of boundary data received |
| `partnerPubkeyHex`       | hex string | Partner's Ed25519 public key             |
| `edgeExport`             | string     | Which edge was exported (north/south/east/west) |
| `authorSignature`        | hex string | Owner's Ed25519 signature over block     |
| `witnessSignature`       | hex string | Partner's Ed25519 signature over block   |
| `nicheEvents`            | array      | Detected cross-board organism events     |
| `nicheBonus`             | number     | Bonus coins from niche events            |

Both the author and the witness sign the `canonicalJSON` of the block
content (excluding the signature fields themselves).

---

## 7. Challenge Protocol

### 7.1 Purpose

The challenge protocol allows any party to verify that a board owner
possesses a legitimate history consistent with their signed contract. It
is the primary mechanism for proving board ownership and simulation time
during edge-sharing encounters.

### 7.2 Challenge Derivation

Given two parties with public keys P_A and P_B:

1. Concatenate the keys in lexicographic order of their hex encodings:
   `seed = min(P_A, P_B) || max(P_A, P_B)`.
2. For challenge index i (i = 0, 1, 2, ...):
   - Compute `h = SHA-256(seed || uint32_be(i))`.
   - Extract `tick = uint32_be(h[0..3]) mod maxTick`.
3. Collect the first K unique tick values. K is a protocol parameter
   (recommended: 8-16).

The challenge ticks are deterministic given both public keys and the
claimed history length. Neither party can predict or influence the
specific ticks without changing their public key.

### 7.3 Recency Weighting

Recent history is more important than ancient history. The protocol
up-weights recent challenges: of the K challenge ticks, at least half
should fall within the most recent 10% of the board's history. To
achieve this, the challenger may specify a `recentWindow` parameter (a
tick count), and generate additional challenges constrained to
`[maxTick - recentWindow, maxTick)`.

The question "what was your board state K minutes ago?" is a natural
challenge during an edge-sharing encounter. The owner must be able to
answer it with a Merkle proof.

### 7.4 Challenge-Response Flow

1. **Challenger** sends: their public key, the number of challenges K,
   and the claimed maxTick of the owner's history.
2. **Owner** computes the K challenge ticks (both parties can compute
   the same ticks independently).
3. **Owner** responds with:
   - For each challenge tick: the Merkle inclusion proof (state hash,
     leaf index, sibling path).
   - The Moves between each pair of consecutive challenge ticks (so the
     challenger can spot-check by replaying segments).
   - The signed board contract.
   - The current Merkle root hash.
4. **Challenger** verifies:
   - Each Merkle proof resolves to the claimed root hash.
   - The board contract signature is valid.
   - The initial state hash in the contract matches the first leaf of
     the Merkle tree.
   - (Optional, expensive) The challenger replays one or more segments
     between consecutive challenge ticks, using the provided Moves and
     the checkpoint states, and verifies that the endpoint state hashes
     match.

### 7.5 Spot-Check Verification

Full replay of the entire history is expensive (proportional to simulation
time). Spot-checking provides probabilistic verification at bounded cost:

- The challenger picks two consecutive challenge ticks T_i and T_{i+1}.
- The owner provides the full board state at T_i (not just the hash) and
  all Moves in [T_i, T_{i+1}).
- The challenger deserializes the state at T_i, replays the simulation
  applying Moves, and checks that the resulting state hash at T_{i+1}
  matches the Merkle leaf.

A dishonest owner who fabricated history for fraction F of their chain has
probability F of being caught per spot-check.

---

## 8. Edge Sharing (Social Play)

### 8.1 Overview

Two B x B boards share one edge for a bounded duration D (measured in ticks).
During sharing, boundary cell data flows between the boards, allowing
organisms to cross the boundary.

### 8.2 Initiation

1. Both players exchange signed board contracts and current Merkle roots.
2. Both run the challenge protocol (Section 7) to verify each other's
   history.
3. If both challenges pass, they agree on sharing parameters:
   - Duration D (in ticks).
   - Share interval (ticks between boundary exchanges).
   - Export edges (which edge each board exports).

### 8.3 Boundary Exchange

During the shared session, at every share interval:

1. Each board serializes its export edge (a strip of cells along one side).
2. Each board transmits its export data to the partner.
3. Each board writes the received data to its import edge (the opposite side
   from the partner's export).
4. Both boards record the SHA-256 hash of the data sent and received.

For a B x B 6502life board, the export edge is B cells x 1024 bytes/cell =
B KB per exchange.

### 8.4 Board Sovereignty

Each board remains sovereign at all times:

- **No rollback.** Each board is authoritative over its own state. Boundary
  data is applied as a write, not a negotiation.
- **No shared state.** There is no merged board. Each board runs
  independently. The boundary exchange is a mutual read/write of edge cells.
- **Connection loss is seamless.** If the connection drops, both boards
  continue running with stale boundary data. When reconnected, fresh data
  flows again.
- **Asymmetric parameters.** The two boards may have different sizes,
  noise rates, or other parameters. The boundary data flows regardless.

### 8.5 Speed Asymmetry

If player A runs at 1000 ticks/sec and player B at 100 ticks/sec, A sends
more frequent boundary updates than B can consume. B applies whichever
update is latest when it processes its next share interval. There is no
concept of lag or desync because there is no shared clock.

### 8.6 PRNG State After Sharing

At the end of a sharing session, each board's PRNG state has diverged from
what it would have been in solo mode (due to boundary writes affecting
simulation dynamics). This divergence is captured in the Merkle tree.
The PRNG is NOT re-seeded from a combined hash; it continues naturally
from its current state. Preventing trivial replay loops is achieved by the
Merkle history: repeating an identical sharing session would produce
different PRNG states because the board's prior history differs.

### 8.7 Session Attestation

At the end of a sharing session, both players sign a joint attestation:

```
{
  "type":               "edge-sharing-attestation",
  "playerA":            <hex pubkey>,
  "playerB":            <hex pubkey>,
  "startTick":          <integer>,
  "endTick":            <integer>,
  "durationTicks":      <integer>,
  "startStateHashA":    <hex>,
  "startStateHashB":    <hex>,
  "endStateHashA":      <hex>,
  "endStateHashB":      <hex>,
  "boundaryFrameCount": <integer>,
  "signatureA":         <hex, A's Ed25519 signature over canonical attestation>,
  "signatureB":         <hex, B's Ed25519 signature over canonical attestation>
}
```

The attestation asserts:
- Both parties ran their boards for the stated duration.
- Boundary data was exchanged at the stated frequency.
- The initial and final state hashes are as recorded.
- Neither party observed protocol violations (no late Move flurries, no
  inconsistent boundary data, no fake histories).

Attestations are the edges in the trust graph (Section 10).

---

## 9. Player Moves (Timestamping Service)

### 9.1 Board Owner as Timestamper

The board owner is the sole timestamper for their board. All Moves must pass
through the owner and be incorporated into the block chain.

### 9.2 Move Lifecycle

1. **Client requests a Move.** The client specifies the desired board tick T
   and the action payload (e.g., inject preset at cell (3,4)).
2. **Client renders speculatively.** While waiting for the owner's response,
   the client may apply the Move locally for immediate visual feedback
   (predictive modeling).
3. **Owner grants a signed timestamp.** The owner applies the Move to their
   board at tick T' (which may be slightly later than T due to processing
   lag). The Move is recorded in the current block's `inputs` array with
   the actual tick T'.
4. **Client re-renders.** When the client receives the actual timestamp T',
   it reconciles its speculative state with the authoritative state.

### 9.3 Move Constraints

- The number of Moves per 24-hour wall-clock period must not exceed
  `maxMovesPerDay` (from the board contract).
- Each Move's payload must not exceed `maxMoveSize` bytes.
- Moves must be applied in tick order. A Move at tick T cannot be applied
  after the engine has advanced past T.

### 9.4 Optional Service

The timestamping service is optional. Most phone users will not run it.
Autonomous 6502life boards (no player interaction) have empty Move lists.
The timestamping service is relevant for:
- Injecting new programs or presets mid-simulation.
- Interactive debugging or experimentation.
- Future game modes with real-time player input.

---

## 10. Trust and Reputation (PageRank)

### 10.1 Attestation Graph

The set of all signed pairwise attestations (Section 8.7) forms a directed
graph:
- **Nodes** are board owner public keys.
- **Edges** are attestations. An edge from A to B means "A and B shared an
  edge and A signed an attestation confirming the session."

Each attestation creates two edges (A attests B, B attests A).

### 10.2 Trust Score

A player's trust score is computed as PageRank on the attestation graph.

- Well-connected players who have many attestations from other
  well-connected players receive high trust scores.
- Isolated cliques of mutually-attesting accounts have low PageRank because
  they are disconnected from the rest of the network.
- This provides natural Sybil resistance: a cluster of fake accounts can
  attest each other, but their PageRank remains low unless they are also
  connected to the legitimate network.

### 10.3 No Central Authority

There is no central ledger. The attestation graph is the union of all
pairwise attestations that any party has collected. Each player stores the
attestations they have participated in and any attestations they have
received from others. The graph is eventually consistent as attestations
propagate through the network.

### 10.4 Challenge Incentive

The protocol incentivizes checking partners' claims during edge sharing.
If you share an edge with a player who turns out to have a fabricated
history, your attestation of them damages your own trust score (you
attested a fraud). Rational players run challenges before signing
attestations.

---

## 11. Scoring

### 11.1 Score Formula

```
score = simulation_time * sharing_frequency * trust_score
```

Where:

- **simulation_time** is the total ticks proven by the board's Merkle tree,
  convertible to wall-clock time via the block chain's `wallTimeMs` fields.
- **sharing_frequency** is the average number of distinct edge-sharing
  sessions per day over the board's lifetime. A board that shares an edge
  with at least one partner per day on average scores a sharing_frequency
  of 1.0. A board that never shares scores a sharing_frequency approaching
  the protocol minimum (see Section 11.2).
- **trust_score** is the PageRank value from the attestation graph.

### 11.2 Solo Mining Rate Decay

Solo mining (no edge sharing) produces coins at a rate that decays over
time since the last sharing session:

- The rate starts at 1.0 immediately after a sharing session.
- Every `soloHalfLife` hours (default: 24) without sharing, the rate halves.
- The rate is floored at `minSoloRate` (default: 1/128).
- Any sharing session resets the rate to 1.0.

This creates a gentle incentive to share edges at least once per day. A
player who only solo-mines for a week earns 1/128th the rate of a socially
active player. The rate never reaches zero; solo mining always works.

### 11.3 Social Session Multiplier

During an active edge-sharing session, the coin rate is multiplied by
`socialMultiplier` (default: 1.5).

### 11.4 Niche Bonus

When a player's organisms are detected on a partner's board during an
edge-sharing session, the originating player earns a bonus of `nicheBonus`
(default: 0.69) coins per detected niche event.

Detection uses two methods:
1. **Provenance-based.** The `lastWriter` metadata field on cells tracks
   which board last wrote to each cell. A cell on board B with
   `lastWriter` = A's wallet ID is a niche event for A.
2. **MinHash-based.** Fingerprint similarity above a threshold between
   cells on different boards catches mutated descendants that lost their
   provenance due to copy noise.

Niche events are recorded in social blocks and are verifiable from the
block chain.

### 11.5 What Coins Are

Coins are cosmetic but cryptographically verifiable scores. They represent
proven simulation time weighted by social participation and network trust.
They are not fungible tokens on a shared ledger. There is no transfer
mechanism, no global balance, and no exchange. If a community decides to
make them tradeable (e.g., via an ERC-20 on a public chain), that is a
layer built on top of this protocol, not part of it.

---

## 12. Data Obligations

A board owner must be able to provide the following on demand:

### 12.1 Signed Board Contract

The immutable contract from Section 3.1, with its Ed25519 signature.
This proves: who owns the board, what its parameters are, and what the
initial state hash was.

### 12.2 Full Move History

The complete ordered list of timestamped Moves applied to the board since
creation. Combined with the initial state, this is sufficient to replay
the entire simulation.

### 12.3 Merkle Tree

The full Merkle tree of state checkpoint hashes (Section 5). This commits
to every block boundary state in the board's history.

### 12.4 Merkle Proofs

For any requested tick T (rounded to the nearest checkpoint), the owner
must provide:
- The state hash at T.
- The Merkle inclusion proof (O(log N) sibling hashes).
- Optionally, the full serialized board state at T (for spot-check
  verification).

### 12.5 Current Board State

The current serialized board state, including the PRNG state. The PRNG
state proves the simulation has advanced to the claimed tick (the PRNG
state is deterministic given the history, so it serves as a proof of
computation).

---

## 13. Cryptographic Primitives

| Primitive        | Algorithm     | Size       |
|------------------|---------------|------------|
| Hash function    | SHA-256       | 32 bytes   |
| Signing key      | Ed25519       | 32 bytes   |
| Signature        | Ed25519       | 64 bytes   |
| Key encoding     | DER (SPKI/PKCS8) | variable |
| PRNG             | xoshiro128**  | 16 bytes state |

All hashes in the protocol are SHA-256. All signatures are Ed25519.
Canonical JSON serialization uses lexicographically sorted keys at all
nesting levels, no whitespace, arrays in order.

---

## 14. Engine Interface

Any game engine participating in the protocol must implement the following
interface:

| Method              | Description                                      |
|---------------------|--------------------------------------------------|
| `init(config)`      | Initialize with board parameters                 |
| `step(n)`           | Advance simulation by n ticks, return actual ticks executed |
| `applyInput(input)` | Apply a timestamped Move deterministically        |
| `serialize()`       | Serialize complete state to canonical bytes       |
| `deserialize(data)` | Restore state from bytes                          |
| `getBoundary(edge)` | Read the boundary strip along an edge             |
| `setBoundary(edge, data)` | Write boundary data from a neighbor          |
| `clock()`           | Return current simulation tick                    |
| `summarize()`       | Return summary statistics for scoring             |

The engine must be fully deterministic: given identical initial state,
PRNG seed, and Move sequence, any conforming implementation must produce
identical state at every tick.

---

## 15. Protocol Parameters

| Parameter          | Default    | Description                                |
|--------------------|------------|--------------------------------------------|
| `blockInterval`    | 10000      | Ticks per block                            |
| `shareInterval`    | 100        | Ticks between boundary exchanges           |
| `soloHalfLife`     | 24 hours   | Hours between solo rate halvings            |
| `minSoloRate`      | 1/128      | Minimum solo mining rate fraction           |
| `socialMultiplier` | 1.5        | Coin rate multiplier during edge sharing    |
| `nicheBonus`       | 0.69       | Bonus coins per niche event                 |
| `maxMovesPerDay`   | (per contract) | Maximum player events per 24h          |
| `maxMoveSize`      | (per contract) | Maximum bytes per move payload          |
| `challengeCount`   | 8          | Number of challenge ticks per verification  |

---

## 16. Security Considerations

### 16.1 Speedup Attacks

A miner running the simulation faster than real time accumulates blocks
faster than honest miners. Blocks record `wallTimeMs` but this field is
self-reported and trivially forgeable without hardware attestation.

Mitigations:
- Validators may reject blocks with implausible wall-clock ratios.
- External entropy injection (mixing in a public random beacon at block
  boundaries) prevents pre-computation but requires connectivity.
- The trust/PageRank system naturally down-weights players whose claims
  are challenged and found inconsistent.

### 16.2 Sybil Attacks

A single entity operating multiple identities to inflate social sharing
attestations. PageRank provides natural resistance: a clique of fake
accounts has low PageRank unless connected to the legitimate network. The
social multiplier is modest (1.5x) to limit the incentive for Sybil
farming.

### 16.3 Fake History

A miner who fabricates a long history (pre-computing blocks on fast
hardware) can be caught by the challenge protocol. Each spot-check has
probability F of catching fabrication affecting fraction F of the chain.
Multiple challenges compound the detection probability.

### 16.4 Colluding Partners

Two partners can run trivial boards, exchange trivial boundary data, and
earn social multipliers. The niche detection mechanism partially addresses
this (dead boards produce no niche events), and the activity summary in
each block enables validators to discount dead-board sessions.

### 16.5 Privacy

Edge-sharing attestations reveal the social graph of who paired with whom.
The protocol does not mandate pseudonymity or ephemeral keys, but
implementations may use per-session keypairs to limit linkability at the
cost of fragmenting trust scores.

---

## 17. Reference Implementation

The reference implementation is in `coin/` in the 6502life repository:

| Module                | Role                                      |
|-----------------------|-------------------------------------------|
| `coin/hash.js`        | SHA-256, hex encoding                     |
| `coin/merkle.js`      | Board Merkle tree (append, prove, verify) |
| `coin/challenge.js`   | Challenge derivation and verification     |
| `coin/session.js`     | Solo session recording and block production |
| `coin/social.js`      | Boundary exchange and EdgeSession         |
| `coin/social-session.js` | Dual-witness social session with Ed25519 |
| `coin/verify.js`      | Solo session replay verification          |
| `coin/economics.js`   | Solo decay, social multiplier, scoring    |
| `coin/niche.js`       | Cross-board organism detection            |
| `coin/engine.js`      | Engine interface specification             |
| `coin/engines/life.js` | Conway's Life engine (reference)         |
| `coin/engines/board6502.js` | 6502life engine                     |
| `coin/prng.js`        | xoshiro128** PRNG                         |
