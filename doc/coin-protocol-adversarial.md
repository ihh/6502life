# Adversarial Analysis: 6502coin Protocol Specification

Date: 2026-03-23

This document is a hostile analysis of `doc/coin-protocol-spec.md` (Version 1.0,
2026-03-23). Every attack assumes a rational adversary who has read the spec and
the reference implementation in `coin/`. Severity ratings reflect exploitability
and impact on the protocol's stated goals.

---

## Attack 1: Sybil Farming via Attestation Rings

**Severity: CRITICAL**

### The attack

I generate 1000 Ed25519 keypairs. I run 1000 boards on a single server. I pair
them in a round-robin schedule: every hour, each board shares an edge with 3
other boards from my cluster. After one week, my 1000 identities have a dense
attestation graph with ~21,000 edges.

### Why PageRank does not save you

Section 10.2 claims "isolated cliques of mutually-attesting accounts have low
PageRank because they are disconnected from the rest of the network." This is
true for a *completely* disconnected clique. But I do not stay disconnected.

I connect a handful of my Sybil identities to the legitimate network. I share
edges with 5-10 real players. Those real players now attest my Sybil nodes,
which inject PageRank into my cluster. PageRank flows freely within the cluster
because it is densely connected.

Quantitatively: if the legitimate network has N=10,000 nodes and I control
S=1,000 Sybils, with 10 edges from real nodes into my cluster, PageRank will
allocate roughly S/(N+S) = 9.1% of total PageRank to my cluster, amplified by
the internal density. The 10 "bridge" edges are enough to bootstrap significant
trust. PageRank is designed for web pages, where creating fake inbound links is
hard. Here, creating fake attestations costs only compute time.

The spec provides no mechanism for:
- Rate-limiting attestation frequency per identity
- Detecting cluster structure in the attestation graph
- Penalizing identities with suspiciously high attestation rates
- Any cost to identity creation (no proof-of-work, no stake, no captcha)

### Mitigation suggestions

1. **Identity cost.** Require a non-trivial cost to register a board identity:
   proof-of-work on the public key, a small on-chain deposit, or phone number
   verification. Without identity cost, Sybil resistance is impossible.
2. **Personalized PageRank.** Instead of global PageRank, compute personalized
   PageRank from the verifier's own identity. This makes the trust score
   subjective: I trust people my friends trust. A Sybil cluster I have no
   connection to gets zero trust from my perspective.
3. **Attestation rate limits.** Cap the number of distinct attestation partners
   per time period. If a node attests 100 partners per day, that is suspicious.
4. **Graph analysis.** Run community detection (e.g., Louvain algorithm) on the
   attestation graph. Flag clusters with anomalously high internal density and
   few external edges.

---

## Attack 2: History Fabrication via Fast-Forward

**Severity: CRITICAL**

### The attack

I want to claim 1 year of simulation time. The simulation is fully deterministic
given initial state and PRNG seed. I run it on a fast server at 10,000x speed.
A year of simulated time takes ~53 minutes of wall-clock time. I now have a
valid Merkle tree, valid block chain, and valid state hashes for 365 days of
"mining."

### Why the protocol cannot detect this

Section 16.1 admits: "Blocks record `wallTimeMs` but this field is self-reported
and trivially forgeable without hardware attestation." The spec lists mitigations
but none are mandatory:

- "Validators may reject blocks with implausible wall-clock ratios." -- The
  `wallTimeMs` field is self-reported (Section 6.1). I set it to whatever I
  want. The reference implementation (`session.js` line 145) uses `Date.now()`
  which I trivially mock.
- "External entropy injection" -- described as optional, requires connectivity,
  and is not part of the protocol. Section 16.1 says it "prevents
  pre-computation but requires connectivity." It is not specified.
- "The trust/PageRank system naturally down-weights players whose claims are
  challenged and found inconsistent." -- But my history IS consistent. Every
  state hash is correct. The Merkle tree is valid. The challenge protocol
  (Section 7) will pass because I actually ran the simulation -- I just ran
  it fast.

The challenge protocol (Section 7.4-7.5) verifies that the *claimed history is
internally consistent*, not that it was produced in real time. A fast-forwarded
history is perfectly consistent.

Section 4 says the complete history is determined by initial state + PRNG seed
+ moves. For autonomous boards (no moves), the history is determined entirely
by initial state. I can compute the state at any tick without storing
intermediate states, making challenge responses trivial.

### Impact

This completely undermines the "simulation time" component of the score formula
(Section 11.1). A well-resourced attacker can produce centuries of
"simulation time" in hours.

### Mitigation suggestions

1. **Mandatory external entropy.** At every block boundary, require inclusion
   of a hash from a public random beacon (e.g., drand, or the latest Ethereum
   block hash). This forces block production to happen in real time. Offline
   mining becomes impossible, which may be an unacceptable tradeoff.
2. **Interactive proof-of-elapsed-time.** During edge-sharing, the partner
   sends random nonces that must be incorporated into the block being produced.
   This proves the block was produced during the sharing session, not
   pre-computed.
3. **Accept it and re-weight the score formula.** If simulation time cannot be
   proven to be real-time, it should carry less weight. The score formula should
   weight `sharing_frequency * trust_score` much more heavily than
   `simulation_time`.

---

## Attack 3: Challenge Protocol Evasion

**Severity: HIGH**

### The attack: selective recomputation

The challenge protocol (Section 7.2) generates K pseudorandom challenge ticks
from both parties' public keys. K is recommended as 8-16 (Section 7.2, step 3).

I claim a history of T ticks but only actually computed states at the K
challenge ticks (plus a small neighborhood for spot-checks). For K=16 and
T=100,000,000 ticks (blockInterval=10,000, so 10,000 checkpoints), I need to
compute 16 specific checkpoints instead of 10,000.

But wait -- the challenge ticks are deterministic given both public keys
(Section 7.2). I know my public key. When I encounter a challenger, I learn
their public key, compute the challenge ticks, and then I only need the states
at those ticks. If I have the full move list and initial state, I can compute
any specific checkpoint on demand by replaying from the initial state.

**The cost of responding to challenges equals the cost of honest simulation.**
Replaying from S_0 to a challenge tick at position T_c costs O(T_c) steps.
For K challenges spread uniformly across [0, T], the total replay cost is
O(K * T/2) = O(K * T). Honest simulation costs O(T). So challenge response
is K/2 times MORE expensive than honest mining, not less.

This means the attack is actually impractical for challenge *response*, but
the attacker can pre-compute responses. Since the challenge ticks depend on
the partner's public key, which is known before the sharing session, the
attacker can:
1. Learn the partner's public key during initiation (Section 8.2, step 1).
2. Compute the K challenge ticks.
3. Replay only those segments to produce valid Merkle proofs.
4. This costs O(K * T) replay but can be parallelized.

### The deeper problem: Merkle proofs without intermediate states

Section 5 specifies the Merkle tree stores checkpoint hashes at block boundaries.
Section 12.3 says the owner must provide the "full Merkle tree." But the
reference implementation (`merkle.js`) stores ALL leaves and ALL internal nodes.
An attacker who fabricates history does not have the intermediate state hashes
-- they only have the states they computed.

However, they can fabricate the Merkle tree by:
1. Computing hash(S_0) as leaf 0.
2. For leaves 1 through N-1 that they did NOT compute, using random 32-byte
   values.
3. Building a valid Merkle tree from these "leaves."
4. When challenged at a specific leaf, claiming the random value IS the state
   hash. The challenger cannot distinguish a real state hash from a random one
   without replaying the simulation themselves.

The spot-check (Section 7.5) catches this: the challenger requests the FULL
board state at a challenge tick, replays a segment, and checks the endpoint
hash. But Section 7.5 is labeled "optional, expensive" and the probability
of catching fabrication affecting fraction F of the chain is F per spot-check.
For K=16 spot-checks and F=0.99 (99% fabricated), the probability of catching
at least one is 1 - (1-0.99)^16 which is essentially 1.0. But the catch is:
the spec says "two consecutive challenge ticks T_i and T_{i+1}" so the
challenger replays BETWEEN challenge ticks, not the full history. If I
fabricate the Merkle tree but honestly compute the K challenged segments, I
pass all spot-checks.

The attacker's strategy: honestly compute the segments between consecutive
challenge ticks (K-1 segments, total cost = O(T) in the worst case), fabricate
everything else. This costs the same as honest simulation, so the attack
provides no advantage.

**Net assessment:** The challenge protocol is sound against rational attackers
IF spot-checks are mandatory (not optional). With K=16 mandatory spot-checks,
the cost of fooling the protocol equals the cost of honest simulation.
The vulnerability is that Section 7.4 step 4 marks spot-check replay as
"(Optional, expensive)."

### Mitigation suggestions

1. **Make spot-checks mandatory, not optional.** Remove the "(Optional,
   expensive)" qualifier from Section 7.4.
2. **Increase K for high-value verifications.** K=16 provides good probabilistic
   guarantees. K=8 is marginal. Consider K=32 for high-stakes verifications.
3. **Require the challenger to choose which segments to spot-check AFTER
   receiving the Merkle proofs.** This prevents the prover from knowing which
   segments will be replayed until after committing to the full tree.

---

## Attack 4: Trivial Edge Sharing Fraud

**Severity: HIGH**

### The attack

I create two boards. Both are initialized with all zeros (or all BRK 0 -- the
cheapest possible state). I share edges between them. The boundary data is 32
strips of 1024 zero bytes. The SHA-256 hashes are computed and recorded. Both
boards produce valid dual-signed blocks. I earn the social multiplier (1.5x per
Section 11.3) and potentially niche bonuses.

### What the protocol misses

Section 8 does not specify any quality check on the boundary data. The
attestation (Section 8.7) asserts "boundary data was exchanged at the stated
frequency" but not that the data was non-trivial.

Section 16.4 acknowledges this: "Two partners can run trivial boards, exchange
trivial boundary data, and earn social multipliers." The spec says "the niche
detection mechanism partially addresses this (dead boards produce no niche
events)." But:

1. The social multiplier (1.5x) is earned regardless of niche events.
2. The `sharing_frequency` component of the score (Section 11.1) increases
   regardless of board content.
3. The activity `summary` in blocks "enables validators to discount dead-board
   sessions" but there is no specification of HOW validators discount them, what
   thresholds to use, or whether this is mandatory.

The niche detection (Section 11.4) uses `lastWriter` and MinHash. For two
identical zero boards, there are no niche events. But the 1.5x social
multiplier is still earned. Combined with Sybil attack (Attack 1), a fleet of
1000 boards sharing trivial data earns 1.5x the rate of honest solo miners with
zero biological content.

### Mitigation suggestions

1. **Tie the social multiplier to niche events.** The multiplier should scale
   with the number of detected niche events, not be a flat bonus for pairing.
   No niche events = no social bonus.
2. **Require minimum activity in social blocks.** Define mandatory thresholds
   on block `summary` stats (e.g., `activeCells > 0`, `totalCopies > threshold`)
   for social blocks to earn the multiplier.
3. **Entropy-based boundary validation.** Compute the Shannon entropy of
   boundary data. All-zero boundaries have zero entropy and should not qualify
   for social bonuses.

---

## Attack 5: Timestamper Griefing

**Severity: MEDIUM**

### The attack

I am the owner of Board A (Section 9.1: "The board owner is the sole
timestamper for their board"). Player B sends me move requests. I:

1. Selectively delay Player B's moves, applying them many ticks after requested.
2. Reorder moves to my advantage (applying my moves first).
3. Drop Player B's moves entirely.

Section 9.2 step 3 says the owner applies the move at tick T' which "may be
slightly later than T due to processing lag." There is no bound on how much
later T' can be. The owner has complete discretion.

### Impact

This only affects boards that accept external moves (Section 9.4: "The
timestamping service is optional. Most phone users will not run it."). For
autonomous boards (no player input), this attack is irrelevant.

For interactive game modes, a malicious board owner has absolute power over
move ordering and inclusion. There is no recourse: the board owner is
"authoritative over their board's state and history" (Section 8.4).

### Why this is by design

Section 3.2 and 8.4 establish owner sovereignty. The owner IS the authority.
There is no appeal mechanism because there is no shared state. If you do not
trust the board owner, do not submit moves to their board.

### Mitigation suggestions

1. **Document this explicitly.** Section 9 should state clearly that the board
   owner has absolute discretion over move inclusion and timing. Users should
   understand this before submitting moves.
2. **Move receipts.** The owner signs a receipt for each accepted move, including
   the actual tick T'. The submitter can prove the move was accepted and verify
   it appears in the block. This does not prevent griefing but provides evidence.
3. **Commit-reveal for moves.** The submitter commits to a move (sends hash),
   the owner assigns a tick, the submitter reveals. This prevents the owner
   from seeing the move content before assigning the tick, reducing strategic
   manipulation.

---

## Attack 6: Merkle Tree Forgery

**Severity: LOW (if spot-checks are mandatory)**

### The attack

I construct a Merkle tree where the leaf hashes are not actually state hashes
of my simulation -- they are random 32-byte values. The tree structure is valid
(parent = SHA-256(left || right)). The root hash commits to my fake history.

### Why it mostly fails

A Merkle inclusion proof (Section 5.4) proves a specific leaf is part of the
tree. The verifier recomputes the root from the leaf and sibling path. This
check passes for my fake tree because the tree structure is valid.

However, the spot-check (Section 7.5) requests the FULL BOARD STATE at the
challenge tick. The challenger deserializes the state, replays forward, and
checks the endpoint hash. If I provide a fake state, the replay produces a
different endpoint hash, and I am caught.

The only way to pass a spot-check is to provide the REAL state, which means
I must have actually computed it. If spot-checks are mandatory, Merkle forgery
buys me nothing.

### The residual risk

If spot-checks are optional (as currently specified in Section 7.4), a lazy
verifier who only checks Merkle inclusion proofs (not full state replay) will
accept my fake tree. The spec says spot-checks are "Optional, expensive."

### Mitigation: Make spot-checks mandatory (same as Attack 3).

---

## Attack 7: Selective Attestation for PageRank Manipulation

**Severity: MEDIUM**

### The attack

I am a legitimate high-reputation player. I only share edges with other
high-reputation players. I refuse to share with newcomers or low-reputation
players. This concentrates PageRank among the elite and creates a barrier to
entry for new players.

### Is this a problem or a feature?

The spec is silent on this. Section 10 describes PageRank as a trust mechanism
but does not discuss whether selective attestation is desirable.

Arguments that it is a **feature**:
- High-reputation players should be selective -- attesting a fraudster damages
  your own reputation (Section 10.4).
- Players have sovereign choice over who they interact with.
- This creates a natural hierarchy where trust is hard-earned.

Arguments that it is a **problem**:
- New players cannot earn trust without partners, creating a cold-start problem.
- It creates a plutocracy: early adopters accumulate PageRank and can gatekeep
  new entrants.
- It incentivizes social climbing (only pair with high-rank players) over
  genuine social interaction.

### The cold start is the real issue

The first player in the network has zero sharing frequency and zero trust score.
Their score is 0 forever until they find a partner. But potential partners have
no incentive to pair with a zero-trust newcomer (it cannot boost their PageRank).

Section 11.2 guarantees a minimum solo mining rate (1/128), so the first player
is not completely stuck. But the score formula (Section 11.1) multiplies by
`sharing_frequency * trust_score`. If trust_score = 0 (no attestations) and
sharing_frequency = 0 (no sessions), the score is literally zero regardless of
simulation time.

### Mitigation suggestions

1. **Additive score formula.** Change the score from multiplicative to additive:
   `score = simulation_time * solo_rate + sharing_bonus * trust_score`. This
   ensures solo mining always produces nonzero score.
2. **Seed trust.** Give new identities a small initial trust score that decays
   if not reinforced by attestations.
3. **Newcomer bonus.** Award extra attestation weight for sharing with
   low-reputation players. This incentivizes mentorship.

---

## Attack 8: State Size DoS

**Severity: MEDIUM**

### The attack

My board is 256x256. Each cell has 1024 bytes. Total state: 256 * 256 * 1024 =
64 MB. During a challenge (Section 7.5), the challenger requests my full board
state at a challenge tick. I must transmit 64 MB per challenge point. For K=16
challenges, that is 1 GB of data.

The challenger must receive, deserialize, and replay this state. For a mobile
device on a cellular connection, receiving 1 GB is expensive and slow.

### Amplification

I can amplify this by claiming a very long history (e.g., T = 10^9 ticks). The
challenger must verify my Merkle tree (Section 5) which has O(T/blockInterval)
= O(10^5) leaves. The tree itself is manageable (~3 MB for 100,000 leaves * 32
bytes), but the spot-check replay between two challenge ticks separated by 10^7
ticks requires computing 10^7 ticks of 256x256 6502life simulation. On a phone,
this could take hours.

### Why the spec does not address this

The spec says boards are "typically 16 or 32 for mobile" (Section 2) but does
not mandate a maximum board size. Section 3.1 specifies `boardSize` is "an
integer, power of 2" with no upper bound. A 256x256 board is valid per the
spec.

The challenger can refuse to verify (just do not sign the attestation), but they
have already spent resources receiving the data. There is no negotiation of
board size before the challenge begins.

### Mitigation suggestions

1. **Specify maximum board size.** Add a protocol parameter `maxBoardSize`
   (e.g., 64) and reject contracts with larger boards.
2. **State compression.** Use delta encoding or run-length encoding for state
   transmission. A mostly-dead 256x256 board compresses well.
3. **Lightweight challenges.** Instead of full board state, allow challenges
   based on a subset of cells (e.g., a random 16x16 subgrid). This bounds
   the data to 256 KB regardless of board size.
4. **Challenge negotiation.** Before running the challenge protocol, peers
   exchange board parameters. Either party can refuse to proceed if the
   parameters are too expensive to verify.

---

## Attack 9: PRNG Manipulation After Board Merge

**Severity: LOW (the spec contradicts the implementation)**

### The contradiction

Section 8.6 of the spec says: "The PRNG is NOT re-seeded from a combined hash;
it continues naturally from its current state."

But `coin/board-merge.js` (line 42-48) does the opposite:

```javascript
const combined = new Uint8Array(serA.length + serB.length);
combined.set(serA, 0);
combined.set(serB, serA.length);
const hashBytes = sha256(combined);
const seed = (hashBytes[0] | (hashBytes[1] << 8) | ...
```

The implementation re-seeds the merged board's PRNG from SHA-256(stateA ||
stateB). This contradicts Section 8.6.

### The attack (against the implementation, not the spec)

If the implementation is authoritative: I choose my initial state to influence
the merged PRNG seed. SHA-256 is preimage-resistant, so I cannot target a
specific seed. But I can try many initial states and pick the one whose merged
seed produces the most favorable simulation dynamics (e.g., my organisms
replicate faster).

The cost is O(N) SHA-256 evaluations for N candidate initial states. SHA-256
is fast (~10 million hashes/second on modern hardware). If "favorable dynamics"
can be evaluated cheaply (e.g., by running a short simulation from each
candidate seed), the attack becomes practical.

### Spec vs implementation divergence

The spec's design (Section 8.6) is actually the right one: the PRNG continues
naturally, so neither player can influence it by choosing their initial state.
But the implementation contradicts this. Additionally, `board-merge.js` exists
in the codebase but the spec describes edge sharing as boundary exchange
(Section 8.3), not board merging. There are two different social play models
in the codebase, and the spec describes only one of them.

### Mitigation: Align the implementation with the spec. Remove PRNG re-seeding.

---

## Attack 10: Time Dilation (Running at Arbitrary Speed)

**Severity: CRITICAL (same core issue as Attack 2)**

### The attack

Section 8.5 explicitly says: "There is no concept of lag or desync because
there is no shared clock." The protocol "has no expectations about how much
actual time translates to clocked time" (this is implied by the design).

I run my simulation at 1,000,000x speed. My board accumulates 1 year of
simulation time per 31.5 seconds of wall time. My score grows proportionally
to `simulation_time` (Section 11.1). In 8 hours, I accumulate ~913 years of
simulation time.

This is Attack 2 restated. The fundamental issue: the score formula weights
`simulation_time` but there is no enforceable link between simulation time and
real time.

### Mitigation: Same as Attack 2.

---

## Protocol Consistency Issues

### Issue 11: Merkle Tree Checkpoint Spacing

**Severity: LOW**

Section 5.1 says "Level K of the tree covers 2^K consecutive checkpoints."
Section 5.2 says checkpoints are "appended as leaf index I." Section 6.1 says
blocks are produced every `blockInterval` ticks. Section 5.1 says "checkpoints
occur at every block boundary."

The spec does not say whether the initial state (tick 0) is a checkpoint. The
reference implementation (`session.js` line 76) appends the initial state as
the first checkpoint, PLUS the end-of-block state as another checkpoint
(line 135). So checkpoint 0 = initial state, checkpoint 1 = state at tick
blockInterval, checkpoint 2 = state at tick 2*blockInterval, etc.

For N blocks, there are N+1 checkpoints (initial + N end-of-block states).
This is not documented in the spec. Section 5 implies checkpoints are at
block boundaries only, which would give N checkpoints for N blocks.

The comment in `merkle.js` line 5 says "Level K covers 2^K ticks" but should
say "Level K covers 2^K checkpoints." A checkpoint covers `blockInterval`
ticks. Level K covers 2^K * blockInterval ticks.

**Impact:** Minor ambiguity. Any implementation that reads the spec literally
will produce a tree with N leaves instead of N+1, producing different root
hashes.

### Issue 12: Board Merge Determinism / Spec-Implementation Gap

**Severity: HIGH**

The spec (Section 8) describes edge sharing as boundary exchange: each board
reads its export edge, transmits to the partner, and writes the received data.
Both boards remain separate at all times.

The codebase contains TWO different social play models:
1. `coin/social.js` + `coin/social-session.js`: Boundary exchange model
   (matches the spec).
2. `coin/board-merge.js` + `coin/share-protocol.js`: Full board merge model
   (NOT described in the spec).

The merge model creates a (2B)x(2B) board from two BxB boards, runs a single
unified simulation, then splits back. This is fundamentally different from
boundary exchange.

The spec does not mention board merging at all. If two implementations exist
(JS and Rust), they must agree on which model to use, and the merge model
requires bit-exact agreement on cell placement, PRNG derivation, and parameter
merging.

**The board merge model is under-specified.** The merge creates a (2B)x(2B)
board where B occupies one half and the other half is "zeroed (inert cells)."
But 6502life cells are not "inert" when zeroed -- zero bytes decode as BRK 0,
which is a no-op. The "unused quadrants" still consume scheduler interrupts.
The dynamics of a (2B)x(2B) board with two occupied quadrants differ from two
separate BxB boards exchanging boundary data.

### Issue 13: Challenge Freshness / Replay

**Severity: MEDIUM**

The challenge protocol (Section 7.2) derives challenge ticks deterministically
from both public keys. This means the same two players always generate the same
challenge ticks for the same maxTick. If I passed your challenge last week, and
my history has not changed, I can replay last week's response.

This is by design for verification of a static history. But it means there is
no freshness guarantee. If I fabricated responses to your challenges last week
(e.g., by exhaustive computation), the same fake responses work this week.

**The recency weighting (Section 7.3) partially addresses this.** If my maxTick
has increased since last week, the challenge ticks change (because
`tick = uint32_be(h[0..3]) mod maxTick` changes when maxTick changes). But if
I have not mined any new blocks, the challenges are identical.

**Missing:** There is no nonce or session-specific randomness in the challenge
derivation. Adding a random nonce from the challenger would ensure fresh
challenges every time, at the cost of making challenges non-reproducible by
third parties.

### Issue 14: Attestation Revocation

**Severity: MEDIUM**

Section 8.7 defines attestations as signed statements. Section 10.4 says
"If you share an edge with a player who turns out to have a fabricated history,
your attestation of them damages your own trust score (you attested a fraud)."

But there is no revocation mechanism. If I discover my partner was cheating
AFTER we signed attestations, I cannot:
1. Revoke my attestation.
2. Remove the edge from the attestation graph.
3. Signal to the network that this attestation should be discounted.

The damage is permanent and one-directional. An honest player who was deceived
by a sophisticated cheat is permanently penalized.

**Worse:** the spec does not define how "attesting a fraud" damages your trust
score. Section 10.4 is aspirational, not mechanical. The PageRank algorithm
does not have a concept of "bad edges." All edges are equal in standard
PageRank. To penalize attestors of fraudsters, the protocol would need a
separate mechanism for flagging fraudulent nodes and propagating the penalty.

### Issue 15: Score Computation Ambiguities

**Severity: MEDIUM**

Section 11.1 defines: `score = simulation_time * sharing_frequency * trust_score`

Problems:

1. **Multiplicative collapse.** If any factor is zero, the score is zero. A new
   player with no sharing history and no attestations has sharing_frequency = 0
   and trust_score = 0. Their score is 0 * 0 * 0 = 0 regardless of simulation
   time. Section 11.2 defines solo mining rate decay but does not address the
   zero-trust-score problem.

2. **Units mismatch.** `simulation_time` is in ticks (or convertible to
   wall-clock time). `sharing_frequency` is sessions per day. `trust_score`
   is a PageRank value (sums to 1 over all nodes). Multiplying these together
   produces a dimensionally nonsensical quantity. The score of a player in a
   1000-node network is 1000x lower than the identical player in a 10-node
   network (because PageRank sums to 1).

3. **Not monotonically increasing.** If my trust score drops (e.g., a
   well-connected partner leaves the network), my total score DECREASES even
   though I have been mining continuously. This violates the intuition that
   "mining accumulates value."

4. **Sharing frequency over lifetime is ill-defined for young boards.** A board
   created 1 hour ago that shares once has a sharing_frequency of 24
   sessions/day. A board created 1 year ago that shares daily has a
   sharing_frequency of 1.0. The young board has 24x the sharing_frequency
   despite being less socially active. The "average over the board's lifetime"
   definition rewards frequent early pairing and punishes long-lived boards.

---

## Game Theory Issues

### Issue 16: Tragedy of the Commons (Empty Boards)

**Severity: MEDIUM**

Running an empty board (all zeros) is the cheapest simulation: every cell
executes BRK 0 (2 cycles) and halts. This is ~10x faster than a board with
active replicators (which execute many instructions per interrupt).

The spec provides no mandatory mechanism to reward "interesting" simulations
over empty ones. Section 11 does not include any activity-based multiplier.
The economics review (`coin-economics-review.md`) notes that the implementation
has an activity multiplier, but the protocol spec does not specify one.

Without an activity requirement in the spec, the cheapest strategy is:
1. Run 1000 empty boards (Sybil attack).
2. Share edges between them (trivial edge sharing, Attack 4).
3. Accumulate score at 1.5x rate with minimal compute.

The niche bonus (Section 11.4) provides some incentive for non-trivial boards
(empty boards produce no niche events), but 0.69 coins per event is small
compared to the base rate of 1 coin per block.

### Issue 17: Collusion Equilibrium

**Severity: HIGH**

Two players agree: "We will share edges and sign attestations. We will not
run challenges. We will run trivial boards."

This is cheaper than honest participation because:
1. No need to run interesting simulations (cheap compute).
2. No need to respond to challenges (skip Section 7 entirely).
3. Both earn the 1.5x social multiplier.
4. Both build PageRank (mutual attestation).

The spec says attestations assert "Neither party observed protocol violations"
(Section 8.7). If both parties agree to skip challenges, neither "observes" a
violation. The attestation is technically true: they exchanged boundary data
as stated.

Section 10.4 says "Rational players run challenges before signing attestations."
But the rationality argument only holds if there is a COST to attesting a
fraudster. The spec says this cost exists ("your attestation of them damages
your own trust score") but as noted in Issue 14, the mechanism for this penalty
is unspecified.

**Collusion is a stable Nash equilibrium** under the current spec. Both players
benefit from colluding, and neither has an incentive to defect (running an
honest challenge gains them nothing if they both know the other's history is
fabricated).

The only unstable scenario: if one colluder eventually encounters an honest
verifier who catches the fraud. But this requires:
1. The honest verifier to request a spot-check (optional per Section 7.4).
2. The fraudster to have actually fabricated history (not just run an empty
   board -- an empty board is a valid honest simulation).
3. The honest verifier to have the resources to replay the simulation.

Empty-board collusion is unfalsifiable: the boards are real, the boundary
data is real, the Merkle tree is valid. There is nothing to "catch."

### Issue 18: Cold Start

**Severity: HIGH**

The first player in the network has:
- `simulation_time`: positive (they are mining).
- `sharing_frequency`: 0 (no partners exist).
- `trust_score`: undefined (PageRank on a 1-node graph with no edges).

Their score is `positive * 0 * undefined = 0`.

The second player joins. They can share with the first player. Now both have:
- `sharing_frequency`: positive.
- `trust_score`: positive (one mutual attestation).

But until the second player joins, the first player's score is permanently
stuck at zero. All blocks mined during the pre-social period earn zero score.
There is no retroactive credit.

This creates a perverse incentive: do not start mining until you have a partner
lined up. Early adopters are punished.

**The solo mining rate (Section 11.2) does not help.** The solo rate affects the
coin rate within the `simulation_time` factor, but the overall score still
multiplies by `sharing_frequency * trust_score`, both of which are zero.

### Mitigation for issues 16-18 (unified)

1. **Make the score formula additive, not multiplicative.** Example:
   `score = simulation_time * solo_rate + social_bonus * trust_score`
   where `social_bonus` accumulates from sharing sessions. This ensures
   solo mining always produces nonzero score.
2. **Specify mandatory activity thresholds.** Define minimum values for block
   summary statistics that must be met for blocks to count toward the score.
3. **Introduce challenge obligation.** Require that at least one spot-check
   must pass before an attestation is signed. Make this a protocol requirement,
   not a recommendation.
4. **Bootstrap trust.** Give new identities a small initial trust score
   (e.g., epsilon = 0.01) that persists until they either accumulate real
   attestations or it decays after a timeout.

---

## Summary of Severity Ratings

| # | Attack / Issue | Severity | Core Problem |
|---|---------------|----------|-------------|
| 1 | Sybil attestation farming | CRITICAL | No identity cost, PageRank insufficient |
| 2 | History fabrication via fast-forward | CRITICAL | No real-time enforcement |
| 3 | Challenge protocol evasion | HIGH | Spot-checks optional, not mandatory |
| 4 | Trivial edge sharing | HIGH | Social multiplier not tied to content quality |
| 5 | Timestamper griefing | MEDIUM | By design (owner sovereignty), but undocumented |
| 6 | Merkle tree forgery | LOW | Caught by mandatory spot-checks |
| 7 | Selective attestation / PageRank manipulation | MEDIUM | Cold start, elite gatekeeping |
| 8 | State size DoS | MEDIUM | No max board size, unbounded verification cost |
| 9 | PRNG manipulation after merge | LOW | Spec contradicts implementation |
| 10 | Time dilation | CRITICAL | Same as Attack 2 |
| 11 | Merkle checkpoint spacing ambiguity | LOW | Off-by-one between spec and implementation |
| 12 | Board merge determinism gap | HIGH | Two incompatible social models in codebase |
| 13 | Challenge freshness / replay | MEDIUM | No session nonce in challenge derivation |
| 14 | Attestation revocation | MEDIUM | No revocation mechanism, penalty unspecified |
| 15 | Score formula ambiguities | MEDIUM | Multiplicative collapse, units, non-monotone |
| 16 | Tragedy of the commons | MEDIUM | No mandatory activity requirement |
| 17 | Collusion equilibrium | HIGH | Empty-board collusion is unfalsifiable |
| 18 | Cold start problem | HIGH | Score is zero until first social session |

---

## Recommended Priority Order for Fixes

1. **Fix the score formula** (Issues 15, 18). Switch from multiplicative to
   additive. Ensure solo mining always produces nonzero score. This unblocks
   the cold-start problem and removes the multiplicative collapse.

2. **Make spot-checks mandatory** (Issues 3, 6). The challenge protocol is
   the primary verification mechanism. It must not be optional.

3. **Add mandatory activity thresholds** (Issues 4, 16, 17). Social multiplier
   should require minimum block activity statistics. This makes empty-board
   collusion unprofitable.

4. **Address identity cost** (Issue 1). Without some barrier to identity
   creation, all other defenses are undermined by Sybils. Even a modest
   proof-of-work (e.g., find a nonce such that SHA-256(pubkey || nonce) has
   20 leading zero bits) raises the cost from zero to ~1 minute of GPU time
   per identity.

5. **Specify mandatory external entropy** (Issues 2, 10). Accept the tradeoff:
   offline mining earns at a reduced rate; online mining with entropy injection
   earns at full rate. This creates a tiered system rather than an all-or-nothing
   choice.

6. **Resolve the two social play models** (Issue 12). Pick one: boundary
   exchange (as specified) or board merge (as partially implemented). Remove
   the other. Document the chosen model with sufficient precision for
   cross-implementation determinism.

7. **Add challenge nonce** (Issue 13). Include a random nonce from the
   challenger in the challenge derivation seed. This ensures fresh challenges
   at negligible cost.

8. **Add attestation revocation** (Issue 14). Allow a player to publish a
   signed revocation that nullifies a previous attestation. Define the
   PageRank impact.
