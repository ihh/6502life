# Gridcoin: A Cryptocurrency for Deterministic 2D Grid Simulations

## 1. Abstract

We propose **Gridcoin**, a cryptocurrency minted by running deterministic 2D grid simulations on mobile phones. Coins are produced as proof that a player sustained a legitimate simulation over time, with the simulation's full trajectory reproducible from a compact record of initial state plus timestamped interactions. Two minting modes exist: **solo mining**, where a player runs a board independently on their phone, and **social mining**, where two nearby players connect over Bluetooth, share a boundary interface between their boards, and collaboratively simulate a coupled system. Social-mined coins are more valuable because they require physical co-presence and mutual record-keeping---each player is incentivized to faithfully record the other's contributions, creating a dual-witness structure analogous to how Bitcoin nodes are incentivized to record others' transactions. The protocol is designed to be game-agnostic: any 2D grid simulation satisfying a small set of properties (deterministic evolution, serializable state, compact interaction logs) can participate, including the 6502life artificial life platform and the SokoScript reaction-diffusion game framework.

## 2. Game Model

### 2.1 Required Properties

A 2D grid game eligible for Gridcoin minting must satisfy the following properties:

1. **Finite discrete grid.** The game world is a finite 2D grid of cells, typically square and toroidal (wrapping at boundaries). Each cell holds a finite-sized state.

2. **Deterministic evolution.** Given identical initial state and identical RNG seed, the simulation produces identical output on any conforming implementation. All randomness must come from a seedable, serializable pseudorandom number generator (PRNG).

3. **Serializable state.** The complete board state---cell contents, RNG state, simulation clock---can be serialized to a compact representation and deserialized to resume simulation exactly.

4. **Timestamped interactions.** Player inputs (moves, commands, cell edits) are recorded as timestamped events. The simulation can be paused at any event timestamp, the event applied, and evolution resumed.

5. **Replay determinism.** Given an initial state snapshot and an ordered list of timestamped interactions, the full simulation trajectory---including all intermediate states---can be reproduced exactly by any verifier.

6. **Decomposable boundary.** For social mining, the grid must support a well-defined boundary interface: a strip of cells along one or more edges that can be read by a neighboring board, enabling coupled simulation between two devices.

### 2.2 Conforming Games

**6502life** satisfies these properties. Each cell runs a virtual 6502 CPU with 1024 bytes of memory on a toroidal grid (up to 256x256). All randomness---scheduling order, cell orientation, inter-interrupt timing, RNG bytes at 0xFC-0xFF, copy noise---derives from a single Mersenne Twister PRNG whose state is serializable. The board state (64MB at full size, smaller for phone-sized boards) is fully serializable. There are no player interactions during autonomous evolution; the only external inputs are initial program loading and optional cell injection. The simulation is purely deterministic given seed and initial state.

**SokoScript** also satisfies these properties. Cells on a toroidal grid evolve according to declarative pattern-matching grammar rules. All randomness comes from a serializable Mersenne Twister. Player interactions are recorded as timestamped move objects (commands, key presses, cell writes) and the `evolveAndProcess()` method replays them deterministically. The `Board.replay()` static method already implements exact replay from an initial board snapshot plus a move list. SokoScript's `canonical-json.js` module provides deterministic JSON serialization, and the lambda backend already uses MD5 hashing of board states and move lists for block integrity.

### 2.3 Board Size for Mobile

Full-scale 6502life (256x256 cells, 64MB state) is infeasible on phones. Mobile boards would use smaller grids: 16x16 (256 cells, 256KB state) or 32x32 (1024 cells, 1MB state). These are computationally tractable while still producing interesting emergent behavior. SokoScript boards are typically 64x64 with much smaller per-cell state (a type index plus a short state string), making them lighter weight.

## 3. State Trajectory and Verification

### 3.1 Minimal Reproducibility

The key insight enabling Gridcoin is that a complete simulation trajectory can be reproduced from minimal data:

- **Initial state snapshot** S_0: the serialized board state at time t_0 (cell contents, RNG state, clock).
- **Interaction log** I: an ordered list of timestamped player interactions [(t_1, m_1), (t_2, m_2), ...].
- **Final time** t_f: the simulation clock value at the end of the mining session.

A verifier reconstructs the trajectory by deserializing S_0, then alternately evolving the simulation forward and applying interactions at their recorded timestamps, arriving at final state S_f at time t_f. If the verifier's computed S_f matches the miner's claimed S_f, the trajectory is valid.

For solo-mined 6502life boards (no player interactions), the interaction log is empty: the entire trajectory is determined by S_0 alone, plus the duration.

### 3.2 Hash Chain

To provide tamper-evident integrity, mining sessions are structured as a chain of **blocks**, each covering a fixed time interval (e.g., 10 minutes of simulation time):

```
Block_n = {
    prev_hash:    H(Block_{n-1}),
    start_state:  H(S_n),        // hash of board state at block start
    end_state:    H(S_{n+1}),    // hash of board state at block end
    interactions:  I_n,           // interactions during this block
    sim_duration:  delta_t,       // simulation time elapsed
    wall_duration: delta_w,       // wall-clock time elapsed
    miner_id:      pubkey,        // miner's public key
    signature:     sig            // miner's signature over block contents
}
```

The hash chain ensures that blocks cannot be reordered or omitted. The `start_state` of block n+1 must equal the `end_state` of block n. A verifier can spot-check any block by replaying that segment.

### 3.3 State Hashing

Hashing the full board state is straightforward: apply a cryptographic hash (SHA-256) to the canonical serialization of the board. For 6502life, this is the raw storage bytes plus the RNG state vector. For SokoScript, this is the canonical JSON serialization of the board (using sorted keys, as already implemented in `canonical-json.js`). The existing SokoScript lambda backend already computes MD5 hashes of board states; a production system would use SHA-256.

### 3.4 Checkpoint Compression

Storing full board snapshots at every block boundary is expensive for 6502life (up to 1MB per checkpoint at 32x32). Two mitigations:

1. **Delta encoding.** Store only the bytes that changed since the previous checkpoint. For slowly-evolving boards, most cells are unchanged between blocks.
2. **Periodic full snapshots.** Store a full snapshot every N blocks (e.g., N=100), with deltas in between. This bounds the replay cost for verification to at most N blocks.

## 4. Solo Mining Protocol

### 4.1 Overview

A player runs a 2D grid simulation on their phone. The phone continuously evolves the board, producing blocks at regular intervals. Each block represents proof that the player's device performed a certain amount of deterministic computation.

### 4.2 Session Lifecycle

1. **Initialize.** The player selects a game (6502life or SokoScript), board size, and initial configuration (random seed, loaded programs, grammar rules). The initial state S_0 is serialized and hashed.

2. **Evolve.** The phone runs the simulation, evolving the board forward in time. For games with player interaction (SokoScript), the player's inputs are recorded as timestamped events.

3. **Block production.** At regular intervals (e.g., every 10 minutes of simulation time, or every N scheduler interrupts for 6502life), the phone:
   - Serializes the current board state and computes its hash.
   - Constructs a block containing the previous block hash, start/end state hashes, interaction log, and timing metadata.
   - Signs the block with the player's private key.
   - Appends the block to the local chain.

4. **Submit.** When the player has network connectivity, they submit their chain of blocks to the Gridcoin network for validation and coin minting.

### 4.3 Proof of Compute

Solo mining is essentially proof-of-compute: the miner demonstrates that they ran a non-trivial deterministic computation for a sustained period. The "work" is the simulation itself. The cost of this work is:

- **6502life:** Each scheduler interrupt involves loading a 49-cell neighborhood, executing 6502 instructions until the next interrupt (~4096 cycles), handling BRK copy/swap operations with noise, rotating oriented registers, and saving/restoring CPU state. At the reference clock rate of 2MHz across all cells, a 32x32 board requires ~62.5 interrupts/second, each involving hundreds of 6502 instruction emulation steps.

- **SokoScript:** Each rule application involves pattern matching against the board, state expression evaluation using precomputed lookup tables, and cell updates. The event rate depends on the grammar's total rate sum across all cell types.

### 4.4 Coin Emission

Solo-mined coins are awarded per valid block. The coin value could scale with:
- Simulation duration (longer sessions = more coins)
- Board complexity (larger boards, more active cells)
- Computational intensity (6502 CPU emulation is more expensive per step than SokoScript rule application)

## 5. Social Mining Protocol

### 5.1 Overview

Two players with phones in physical proximity connect over Bluetooth. Their boards share a boundary interface: one or more rows/columns of cells along the edge of each board become visible to the other's simulation. The coupled system evolves as a single larger simulation split across two devices, with each device recording both its own computation and the boundary data received from the other.

### 5.2 Boundary Interface

Each player's board has a designated **export edge** (e.g., the eastern edge) and an **import edge** (e.g., the western edge). The export edge is a strip of cells whose state is periodically transmitted to the other player. The import edge receives the other player's export data, which populates cells in the local board's neighborhood.

For 6502life, this is natural: the memory-mapped 7x7 neighborhood already extends 3 cells beyond the board edge. In a social mining setup, cells in the boundary region would be populated from the partner's board rather than wrapping toroidally. For a 32x32 board, the shared interface would be a 32x3 strip (96 cells, 96KB of state).

For SokoScript, the toroidal grid can be "unwrapped" at one edge and coupled to the partner's board, so that rules referencing neighbors across the boundary see cells from the partner's grid.

### 5.3 Synchronization Protocol

The two phones must maintain loose synchronization:

1. **Handshake.** Devices exchange public keys, game configuration (grammar/programs, board size, RNG seeds), and initial boundary states. Both devices record the full handshake.

2. **Boundary exchange.** At regular intervals (every B simulation time units), each device:
   - Serializes its export edge cells.
   - Transmits the serialized boundary to the partner over Bluetooth.
   - Receives the partner's boundary and applies it to its import edge.
   - Records both the sent and received boundary data with timestamps.

3. **Block production.** Each device produces blocks as in solo mining, but blocks additionally contain:
   - The boundary data sent and received during that block interval.
   - The partner's public key and block hash (cross-reference).

4. **Disconnection.** When the Bluetooth connection drops, both devices revert to solo mining (toroidal wrapping resumes on the boundary edges).

### 5.4 Dual-Witness Incentive

The critical design insight is that **each player is incentivized to faithfully record the other player's boundary data**. This parallels Bitcoin's incentive structure:

- In Bitcoin, miners are incentivized to include others' transactions in blocks because transaction fees are revenue. A miner who censors transactions loses fee income.

- In Gridcoin, social-mined coins are more valuable than solo-mined coins (see Section 6). A player can only claim social mining rewards by presenting a block chain that includes consistent boundary exchange records. Both players' chains must agree on what boundary data was exchanged and when. If Alice's chain claims she received boundary B_1 from Bob at time t, then Bob's chain must show that he sent B_1 at time t.

- A player who fabricates boundary data cannot produce a chain that is consistent with their partner's chain. The verifier cross-references both chains and rejects inconsistencies.

- A player who fails to record received boundary data cannot claim the social mining bonus. Thus, each player wants to faithfully record what the other player sent.

This creates a **dual-witness** structure: each player is both a miner and a recorder of the other's contributions, and both roles are rewarded.

### 5.5 Proximity Enforcement

Social mining is meant to reward physical co-presence. Bluetooth Low Energy (BLE) has a range of roughly 10-30 meters, which provides a weak but useful proximity constraint. Additional measures:

- **Latency bounds.** The synchronization protocol can enforce round-trip latency bounds on boundary exchanges. Bluetooth latency is typically under 10ms; internet relay latency is typically higher and more variable.

- **Signal strength.** BLE RSSI (received signal strength indicator) can be logged and included in block metadata as a proximity heuristic, though it is easily spoofed.

- **Challenge-response.** Periodic random challenges requiring low-latency responses can help distinguish local Bluetooth from relayed internet connections.

None of these are cryptographically secure against a determined adversary (see Section 9), but they raise the cost of faking proximity.

## 6. Coin Valuation

### 6.1 Why Social Coins Are Worth More

Social-mined coins carry a higher base reward than solo-mined coins for several reasons:

1. **Proof of interaction.** A social-mined coin proves that two distinct devices were in physical proximity and actively cooperating. This is a strictly stronger claim than proof-of-compute alone. It certifies a social event: two humans (or at least two phones) were together, running simulations that interacted.

2. **Harder to fake.** Solo mining can be trivially parallelized on a server farm. Social mining requires at least the appearance of co-located Bluetooth devices, which raises the cost of industrial-scale farming.

3. **Network effect.** Social mining creates a natural incentive for players to seek each other out, forming a physical social network. This is valuable for adoption.

4. **Richer computation.** Coupled boards produce more complex and unpredictable dynamics than isolated boards. The boundary interaction introduces genuine cross-device state dependencies that cannot be pre-computed.

### 6.2 Network-Effect Valuation

The most natural valuation model avoids centrally determined exchange rates entirely.

**You are always minting coins just by running your board.** The minting rate is constant: one coin per unit of verified simulation time. There is no "social mining mode"---there is just mining.

What changes is the **exchange value** of your coins, which emerges from market dynamics driven by a key biological insight: **your life forms may end up thriving on other players' boards.** When two boards share a boundary over Bluetooth, organisms can cross between them. If your replicator colonizes a partner's board, and that partner continues running their simulation for days or weeks, your organism is accumulating "real estate" and compute-time on foreign hardware---for free.

This creates a natural economic logic:
- **It's worth playing with someone who does a lot of simulation.** Your organisms get more territory to evolve on.
- **Coins from well-connected, heavily-simulated lineages trade higher.** A coin that represents compute-time on a board whose organisms have spread to 50 other boards is more "interesting" (and verifiably so) than a coin from an isolated board.
- **The exchange rate is not set by the protocol.** It emerges from how players choose to trade. The protocol only provides the verifiable history: which boards interacted, for how long, and what crossed the boundary.

The expected equilibrium: coins from players who are active, social, and run boards with successful organisms will naturally trade higher, because those players' boards represent a larger share of the network's total biological activity. This mirrors how "interesting" blockchains attract more value without any central price-setting mechanism.

## 7. Blockchain / Ledger Design

### 7.1 High-Level Architecture

Gridcoin uses a hybrid ledger:

- **Local chains.** Each player maintains a local chain of simulation blocks, as described above. These are produced offline on the phone and do not require network connectivity.

- **Global ledger.** A shared ledger (blockchain or DAG) records validated coin minting events and transfers. Players submit their local chains to the network for validation; if accepted, the corresponding coins are credited to their account.

### 7.2 Validation

Full validation of a block requires replaying the simulation segment---deserializing the start state, applying interactions, and checking that the end state hash matches. This is computationally expensive (roughly as expensive as the original simulation). Several approaches to managing this cost:

1. **Probabilistic verification.** Validators spot-check random blocks rather than verifying entire chains. A chain with N blocks might have sqrt(N) blocks verified. Cheaters risk detection proportional to the fraction of fraudulent blocks.

2. **Optimistic submission with challenges.** Blocks are accepted optimistically, but any participant can challenge a block by posting a bond. The challenged block is then fully verified. If the block is fraudulent, the miner's stake is slashed; if it is valid, the challenger loses their bond. This is similar to optimistic rollup designs in Ethereum L2s.

3. **Trusted execution.** If phones support trusted execution environments (TEEs), the simulation can run inside the TEE, and the TEE can attest to the block's validity without full replay. This is the strongest guarantee but requires hardware support.

### 7.3 Consensus

The global ledger could use a lightweight consensus mechanism:

- **Proof of stake** for the global ledger, with Gridcoin itself as the staking token.
- **Minting** is separate from consensus: blocks are validated and coins minted independent of the consensus layer.
- **Transfers** are recorded on the global ledger using standard blockchain techniques.

### 7.4 Cross-Referencing Social Mining Blocks

For social mining, both players submit their local chains. The validator checks:
1. Each player's chain is internally consistent (hash chain integrity, state transitions).
2. The boundary exchange records in both chains are mutually consistent (what Alice says she sent matches what Bob says he received, and vice versa).
3. The simulation time intervals overlap appropriately.

Only if both chains pass validation are social mining rewards issued to both players.

## 8. Game-Specific Considerations

### 8.1 6502life

**Computational weight.** 6502life is computationally heavy per simulation step. Each scheduler interrupt requires: (a) loading 49 cells (49KB) into the memory-mapped neighborhood, (b) emulating 6502 instructions cycle-by-cycle (averaging ~4096 cycles per interrupt), (c) handling BRK operands including noisy copy with per-bit randomization, (d) rotating oriented registers at 0xF0-0xF9, and (e) saving/restoring CPU registers to/from zero page. On a modern phone, a 32x32 board at the reference 2MHz clock rate is feasible but non-trivial. The emulation cost serves as natural proof-of-work: it is genuinely expensive to simulate and cannot be shortcut without breaking the determinism guarantee.

**State size.** At 1024 bytes per cell, a 32x32 board is 1MB of state. Hashing is fast (SHA-256 of 1MB takes ~1ms on a modern phone), but serializing and transmitting full snapshots is heavier. Delta encoding is important: in a stable 6502life board, most cells may be idle (executing BRK 0 loops) and unchanged between blocks.

**Noise model.** The noisy copy operation (BRK operands 245-252) introduces controlled bit errors, making exact copy reproduction dependent on the PRNG state. This is already deterministic given the Mersenne Twister seed, but verifiers must use the exact same noise model (pBitNoise = 1/2048 by default).

**Atomic transactions.** The SEI/CLI interrupt masking creates atomic write semantics: writes accumulate and either commit (on BRK) or revert (on timer interrupt with I set). Boundary coupling must respect these semantics---boundary data should only reflect committed writes.

**BRK copy/swap semantics.** BRK operands 1-244 perform cell swaps, and 245-252 perform noisy copies. In a coupled social mining setup, swaps or copies targeting cells in the boundary region would affect the shared interface, creating genuine cross-board interactions. The source-destination indexing (src = floor(b/49), dest = b%49 within the 7x7 neighborhood) means that cells within 3 positions of the board edge can interact with the boundary.

**No player interaction.** Standard 6502life has no player input during simulation---programs are loaded before simulation begins, and evolution is autonomous. This means solo mining interaction logs are always empty, and the entire trajectory is determined by the initial state plus duration. This simplifies verification but also means that solo-mined 6502life blocks are more susceptible to pre-computation attacks (see Section 9).

### 8.2 SokoScript

**Computational weight.** SokoScript is lighter per step than 6502life. Rule application involves pattern matching (the `Matcher` class tests cell types and state strings against LHS patterns) and cell updates, using precomputed O(1) lookup tables for all vector and character operations. The computational cost scales with the total rate sum across all cell types and the board size. A 64x64 board with a moderately active grammar (total rate ~1000 Hz) is easily tractable on a phone.

**Player interaction.** SokoScript games often involve player input: key presses move player-controlled cells, commands trigger rule applications. These interactions are already recorded as timestamped move objects and replayed deterministically via `Board.evolveAndProcess()`. The existing `Board.replay()` method implements exact replay from initial state plus move list, directly supporting the Gridcoin verification model.

**Existing block infrastructure.** The SokoScript lambda backend (`lambda/boards.js`) already implements a block-based model with many Gridcoin-relevant features:
- Blocks are keyed by board ID and block hash, with previous-block-hash references forming a chain.
- Board state hashes (`boardHash`) and move list hashes (`moveListHash`) are computed using canonical JSON serialization and MD5.
- Blocks record `boardTime`, `boardState`, `moveList`, and `previousBlockHash`.
- A `claimantList` tracks which users have claimed a block, with a `firstClaimant` priority.

This infrastructure is a natural starting point for Gridcoin's ledger layer.

**Grammar as game identity.** In SokoScript, the grammar defines the game. Two players social-mining together must agree on the grammar (rules) in addition to the board configuration. The grammar source string, already stored in the board JSON, serves as a game identifier. Different grammars produce fundamentally different dynamics, so the coin valuation formula might weight grammars differently based on computational complexity.

**Synchronous rules.** SokoScript supports synchronous rules (`sync=N`) that fire at fixed time intervals, in addition to the default asynchronous (Poisson-process) rules. Synchronous rules create natural synchronization points that could serve as boundary exchange timestamps in social mining.

**State encoding.** SokoScript cell state is a variable-length string of ASCII characters (33-126) encoding integers mod 94, 2D vectors, and matrix transforms. This is much more compact than 6502life's 1024 bytes per cell, making state hashing and boundary exchange cheaper.

## 9. Feasibility and Issues

### 9.1 Simulation Speedup Attacks

**Threat.** A miner runs the simulation faster than real time (e.g., on a desktop GPU or server farm) to produce blocks faster than honest phone miners.

**Mitigation.** Blocks include wall-clock timestamps. The protocol can enforce that wall-clock duration roughly matches simulation duration (within a tolerance factor, e.g., 0.5x-2x). Blocks produced implausibly fast are rejected.

**Residual risk.** A miner with a faster device can still mine at the maximum allowed speed factor. This is inherent to any proof-of-compute system and acceptable as long as the speed advantage is bounded. The wall-clock constraint means that a server farm gains at most a 2x advantage over a phone, not a 1000x advantage.

**For 6502life specifically,** the lack of player interaction makes pre-computation trivial: a miner can compute the entire trajectory on a server, then "play it back" on a phone at 1x speed, signing blocks with valid wall-clock timestamps. Mitigations include:
- Requiring periodic external entropy injection (e.g., hashes from the global ledger's latest block mixed into the PRNG state at checkpoint boundaries).
- Making the block interval short enough that the pre-computation advantage is small.

### 9.2 Fake Interaction Attacks (Social Mining)

**Threat.** Two colluding phones simulate a Bluetooth connection without physical proximity, relaying data over the internet to farm social mining bonuses.

**Mitigation.** Latency-based proximity checks (see Section 5.5) raise the cost but do not prevent sophisticated relay attacks.

**Residual risk.** This is fundamentally difficult to prevent in software. Hardware attestation (e.g., UWB ranging, which provides centimeter-accurate distance measurement and is available on recent iPhones and Android flagships) would be much stronger. Without hardware support, the social mining bonus should be modest enough that internet-relay farming is only marginally profitable.

### 9.3 Sybil Attacks

**Threat.** A single entity operates many phone identities to multiply mining rewards.

**Mitigation.** Standard Sybil defenses apply: proof-of-stake (new identities must stake coins), rate limiting per device (using hardware attestation or app-store identity), or social-graph-based trust (social mining connections form a graph; isolated clusters of mutually-mining Sybil accounts can be detected).

**For social mining,** Sybil attacks are partially self-limiting: operating N fake phones requires N physical devices, each consuming battery and compute resources. The marginal cost of an additional Sybil device is the cost of a phone, which is nonzero.

### 9.4 Battery and Compute Constraints

**6502life** is CPU-intensive. Running a 32x32 board at 2MHz clock rate involves emulating ~2 million 6502 cycles per second. On a modern phone SoC (e.g., Apple A-series or Snapdragon), this is feasible but will consume significant battery. Realistic deployment might use a lower clock rate (e.g., 500KHz) or smaller boards (16x16).

**SokoScript** is lighter but still non-trivial at high rule rates. A grammar with a total rate of 1000 Hz on a 64x64 board means ~1000 rule applications per second, each involving pattern matching and state updates. This is easily tractable.

**Bluetooth.** BLE communication for boundary exchange adds modest power draw. Transmitting 96KB of boundary data (32x3 cells at 1KB each for 6502life) every few seconds is within BLE throughput limits (~1Mbps for BLE 5.0) but will affect battery life.

**Thermal throttling.** Sustained CPU-intensive simulation on a phone will cause thermal throttling, reducing performance over time. The wall-clock tolerance in block validation must account for this.

### 9.5 Economic Design Challenges

**Emission rate.** If coins are minted per block and blocks are produced every 10 minutes per miner, the total emission rate scales linearly with the number of miners. A halving schedule or difficulty adjustment is needed to control inflation.

**Game balance.** Different games (6502life vs. SokoScript) and different configurations (board sizes, grammars, programs) have wildly different computational costs per block. The valuation formula must normalize across these, which is technically and economically complex.

**Utility.** A cryptocurrency needs utility beyond speculation. Gridcoin's natural utility could be:
- Paying for game-related services (hosting persistent boards, entering competitions).
- Governance (voting on protocol parameters, approved games).
- Staking for social mining multiplier boosts.

**Cold start.** Early adoption requires that mining be rewarding enough to justify the battery drain, before the coin has established market value.

### 9.6 Verification Cost

Full verification of a block requires re-running the simulation. For a 10-minute 6502life block on a 32x32 board, this is ~10 minutes of CPU time---potentially too expensive for validators to check routinely. The optimistic verification model (Section 7.2) addresses this but introduces its own complexity.

### 9.7 Determinism Across Implementations

The protocol requires bit-exact determinism: any conforming implementation must produce identical state transitions given identical inputs. This is achievable for integer arithmetic (6502 emulation is purely integer-based; SokoScript uses integer RNG and precomputed tables) but requires careful attention to:
- Floating-point avoidance (both 6502life and SokoScript use integer/BigInt arithmetic for timing).
- Consistent PRNG implementation (Mersenne Twister is well-specified, but implementations must agree on seeding, state serialization, and output mapping).
- Canonical serialization (both projects have this).
- Platform-independent behavior (JavaScript number semantics, BigInt handling).

A reference implementation in a portable language (e.g., Rust compiled to WebAssembly) would provide a single canonical verifier for all platforms.

## 10. Related Work

### 10.1 Proof of Useful Work

Most cryptocurrencies use proof-of-work (arbitrary hash computation) or proof-of-stake. Several projects have explored proof-of-useful-work, where the computation serves a secondary purpose:

- **Primecoin** (2013) mines coins by finding Cunningham chains of prime numbers.
- **Gridcoin (existing)** rewards participants in the BOINC distributed computing network, though it bears only a naming coincidence to this proposal.
- **Proof of Learning** proposals tie coin minting to machine learning training progress.

Gridcoin (our proposal) is proof-of-useful-play: the "useful work" is running an entertaining simulation, which has value to the player independent of the coin reward.

### 10.2 Proof of Play / Play-to-Earn

The play-to-earn (P2E) model, popularized by Axie Infinity (2018) and similar blockchain games, rewards players with tokens for gameplay. Key differences from our proposal:

- P2E games typically run on-chain or on centralized servers; Gridcoin runs entirely on the player's phone.
- P2E rewards are typically awarded by game-specific smart contracts; Gridcoin's proof is the simulation trajectory itself.
- P2E games are specific titles; Gridcoin is game-agnostic.

### 10.3 Location-Based and Proximity Crypto

- **FOAM** (2018) proposed a proof-of-location protocol using radio beacons.
- **XYO Network** (2018) uses Bluetooth-based bound witnesses for location verification.
- **Helium** (2019) rewards operators of LoRaWAN hotspots, with proof-of-coverage requiring physical deployment.

Gridcoin's social mining shares the spirit of these projects: rewarding physical co-presence. The dual-witness model for boundary exchange is directly analogous to XYO's bound witness protocol.

### 10.4 Deterministic Replay and Verifiable Computation

- **TrueBit** (2017) proposed a verification game for off-chain computation, using an optimistic model with interactive dispute resolution. Gridcoin's optimistic verification (Section 7.2) draws on similar ideas.
- **Verifiable delay functions (VDFs)** enforce that a computation took at least a certain amount of sequential time. Gridcoin's simulation acts as a natural VDF---the sequential nature of the simulation (each step depends on the previous state) means it cannot be parallelized.

### 10.5 Cellular Automata and Blockchain

- **Wolfram's Physics Project** (2020) explores computational irreducibility of rule-based systems, which is relevant to the non-shortcuttable nature of grid simulation.
- **HashLife** (Gosper, 1984) demonstrates that some cellular automata (notably Conway's Life) can be exponentially accelerated using memoization. This is a potential attack vector: if a game's dynamics permit HashLife-style acceleration, miners with sophisticated implementations gain an unfair advantage. 6502life is resistant to this because the 6502 CPU semantics are too complex for memoization, and the random scheduling/orientation prevents pattern reuse. SokoScript grammars may be more vulnerable depending on the specific rules.

### 10.6 SokoScript's Block Model

The SokoScript lambda backend already implements a blockchain-like structure: boards have clocks, moves are timestamped and recorded, blocks aggregate moves and state snapshots with hash chains, and multiple users can claim blocks. The `TimeInSecondsBetweenBlocks` parameter (600 seconds = 10 minutes, matching Bitcoin's block interval) and the block data model (`boardTime`, `boardState`, `moveList`, `previousBlockHash`, `boardHash`, `moveListHash`) are directly reusable for Gridcoin. The existing `firstClaimant`/`claimantList` mechanism could be extended to handle social mining's dual-claimant model.
