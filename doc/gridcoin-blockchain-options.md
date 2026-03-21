# Gridcoin: Blockchain Platform Assessment

An independent assessment of implementing the Gridcoin concept on existing blockchain
platforms versus building a new chain from scratch. This document assumes familiarity
with the Gridcoin proposal and architecture documents.

## 1. What Gridcoin Needs from a Blockchain

Gridcoin has an unusual transaction profile compared to typical DeFi or NFT applications.
Distilling the requirements:

**Verified compute proofs.** The core operation is submitting a claim that a deterministic
simulation ran for N ticks and produced a specific end-state hash. Verification means
replaying that simulation segment -- which is as expensive as the original computation.
No blockchain can do this on-chain for a 6502life session. The question is: what goes
on-chain as a commitment, and how is verification handled?

**Timestamped session records.** Each mining session produces a chain of blocks (10-minute
segments). These block headers -- containing start/end state hashes, interaction logs,
wall-clock timestamps, and miner signatures -- need to be recorded immutably. A 32x32
6502life board running for 8 hours produces ~48 blocks. Each block header is roughly
200-500 bytes.

**Coin minting and transfer.** Coins are minted per valid block. At 48 blocks/day per
active miner, with (say) 1000 miners, that is 48,000 minting transactions per day.
Transfers between users add more, but likely fewer than minting events in early stages.

**Social mining dual-witness records.** When two players mine together over Bluetooth,
both submit corroborating block chains. The ledger must store cross-references between
their blocks and validate consistency. This roughly doubles the transaction count for
social sessions.

**Low transaction costs.** Minting happens frequently (every 10 minutes per miner).
If each mint costs even $0.01, a player mining 8 hours/day pays $0.48/day in gas --
tolerable but not free. At $0.10/mint, it is $4.80/day -- unacceptable for a game
that mints coins with no established market value.

**Mobile-friendly (light clients).** Players run on phones. They cannot run full nodes.
They need to submit transactions from a mobile wallet or PWA and verify their own
balance without downloading the full chain.

**Summary of transaction characteristics:**
- High frequency, low value (many small mints, not few large swaps)
- Small payloads (block headers, not full state)
- Asymmetric verification (cheap to commit, expensive to verify)
- Offline-first (sessions happen without connectivity; submission is batched)

## 2. Existing Platform Assessment

### 2.1 Ethereum L1

**Smart contracts.** A Gridcoin ERC-20 token is straightforward. A `GridcoinMining`
contract would accept session commitments (block header hashes, miner signatures),
mint tokens, and handle transfers. Solidity tooling (Hardhat, Foundry, ethers.js)
is mature. MetaMask integration gives immediate wallet support.

**Gas costs.** As of early 2026, Ethereum L1 gas averages ~3 gwei. A simple ERC-20
transfer costs ~$0.15. Minting with a `commitBlock()` call that stores a hash and
mints tokens would cost roughly $0.50-2.00 per transaction, depending on storage
operations. At 48 mints/day, that is $24-96/day per miner. This is a non-starter
for a game with no established token value.

**On-chain verification.** Replaying even one 10-minute 6502life session segment
on the EVM is impossible. The EVM has a ~30M gas limit per block. Emulating a 6502
CPU for 10 minutes of simulation time would require billions of EVM opcodes. The
verification logic cannot run on-chain. Period.

**Verdict: Too expensive for minting frequency. Good tooling, wrong economics.**

### 2.2 Ethereum L2s

**General L2 picture.** Post-Dencun (EIP-4844) and Pectra upgrades, L2 transaction
costs have dropped dramatically:

| L2 | Avg. swap cost (Mar 2026) | Notes |
|----|---------------------------|-------|
| Base | ~$0.001 | Coinbase-subsidized; sequencer runs at a loss |
| Arbitrum | ~$0.008 | Most mature optimistic rollup |
| Optimism | ~$0.012 | OP Stack ecosystem |
| zkSync Era | ~$0.015 | ZK-rollup, EVM-compatible |
| StarkNet | ~$0.01-0.02 | STARK proofs, Cairo language |

At $0.001-0.01 per transaction, minting 48 blocks/day costs $0.05-0.48/day.
This is acceptable, especially on Base or Arbitrum.

**Base** is the most attractive L2 for Gridcoin:
- Lowest fees (though partly subsidized -- a risk if Coinbase stops subsidizing)
- Strong mobile wallet support via Coinbase Wallet
- EVM-compatible, so standard Solidity/Hardhat tooling works
- Large user base (Coinbase funnels retail users to Base)

**Arbitrum** is the safest bet:
- Most mature L2 with the largest TVL
- Fees are low enough ($0.008/tx = $0.38/day for 48 mints)
- Not dependent on a single company's subsidy
- Strong developer ecosystem

**zkSync Era / StarkNet -- ZK verification angle.** Could ZK proofs verify
simulation determinism? In theory, yes: you could compile the 6502 emulator to
a zkVM (e.g., RISC Zero or SP1), run the simulation inside it, and produce a
proof that the computation was correct. The verifier contract on-chain would
check the proof in constant time (~200-300K gas, ~$0.05 on L1, fractions of a
cent on L2).

However, the practical obstacles are severe:
- **Proving cost.** Generating a ZK proof for 10 minutes of 6502 emulation
  (millions of CPU cycles) would take minutes to hours on a server-class machine
  and is currently infeasible on a phone. StarkWare's upcoming S-two prover
  promises "instant proving on phones" but this targets small computations, not
  millions of 6502 instruction emulations.
- **Circuit complexity.** The 6502 emulator has complex branching logic (256
  opcodes, memory-mapped I/O, interrupt handling). Expressing this as an
  arithmetic circuit is a major engineering effort.
- **Prover infrastructure.** Either miners need access to a proving service
  (centralization risk, cost) or they prove on-device (currently impractical).

ZK verification is the long-term dream but not a viable MVP path.

**Verdict: Base or Arbitrum are strong candidates. $0.001-0.01/tx is workable.
ZK verification is theoretically elegant but years away from being practical
for this use case.**

### 2.3 Solana

**Fees.** Average transaction cost is ~$0.00025 (a quarter of a cent). Even with
priority fees during congestion, rarely exceeds $0.01. At 48 mints/day, total
cost is ~$0.01/day. Essentially free.

**Throughput.** Solana handles 4,000+ TPS. Gridcoin's 48,000 daily transactions
from 1,000 miners is trivial (~0.5 TPS).

**Smart contracts.** Solana programs are written in Rust (via the Anchor framework)
and compiled to BPF bytecode. The Anchor framework provides a reasonable developer
experience, though the learning curve is steeper than Solidity. Account model is
different from EVM (explicit account creation, rent, PDAs), which adds complexity.

**Mobile wallet support.** Solana has invested heavily in mobile: the Saga phone,
Mobile Wallet Adapter (MWA), and Phantom/Solflare mobile wallets. MWA allows
a mobile app or PWA to request transaction signing from a locally-installed
wallet app, which is a good UX for Gridcoin.

**Ecosystem.** Solana has a large gaming/consumer-app ecosystem. Play-to-earn
projects (e.g., Star Atlas, Aurory) have built on Solana specifically because of
low fees. This is the closest existing ecosystem to Gridcoin's use case.

**Downsides:**
- Network stability has improved but Solana has had outages historically
- Rust/Anchor is harder than Solidity for a solo developer
- Smaller DeFi liquidity than Ethereum L2s (though growing)
- Different programming model (no EVM, so no code reuse from Ethereum)

**Verdict: Best fee economics of any established chain. Good mobile story. Steeper
smart contract development curve. Strong candidate.**

### 2.4 Polygon / Avalanche / Other EVM Chains

**Polygon (PoS / zkEVM).** Polygon PoS has fees of ~$0.001-0.01 per transaction.
The ecosystem is large. However, Polygon has been migrating toward its zkEVM
(Polygon 2.0 / Agglayer), which is still maturing. The PoS chain works fine for
Gridcoin's needs but feels like a "previous generation" choice when Base and
Arbitrum exist.

**Avalanche.** C-Chain fees are ~$0.01-0.05 per transaction. Subnets (now called
Avalanche L1s) allow deploying a custom chain with its own fee structure, which
is interesting but adds operational complexity. Not a compelling advantage over
Ethereum L2s for this use case.

**Verdict: These work but offer no clear advantage over Base/Arbitrum/Solana.
Polygon PoS is a reasonable fallback. Avalanche subnets are overkill for MVP.**

### 2.5 ICP (Internet Computer)

**Unique value proposition.** ICP canisters run WebAssembly on-chain. This is the
only platform where you could theoretically run the 6502 simulation verifier
entirely on-chain -- deserialize a board state, replay N ticks of 6502 emulation,
and check the end-state hash, all within a canister.

**Compute costs.** 1 XDR = 1 trillion cycles (~$1.35 USD). A canister creation
costs ~$0.65. Compute allocation is cheap per second. The question is whether
a canister can execute enough WASM instructions to replay a 10-minute 6502life
session within the per-message instruction limit (currently ~20 billion
instructions per round, with inter-canister calls for longer computations).

A 10-minute 6502life session on a 32x32 board involves roughly:
- 62.5 interrupts/second * 600 seconds = 37,500 interrupts
- Each interrupt: ~4,096 6502 cycles of emulation + overhead
- Total: ~150 million 6502 instruction emulations
- In WASM, each 6502 instruction takes ~50-200 WASM instructions to emulate
- Total WASM instructions: ~7.5-30 billion

This is at the edge of what a canister can do in a single call chain. It might
work with chunked execution across multiple rounds, but it would be slow
(seconds to minutes of wall time) and cost cycles.

**Reverse gas model.** On ICP, the developer pays for computation, not the user.
This is interesting for Gridcoin: the project would fund canisters with cycles,
and miners submit sessions for free. However, this means the project needs
ongoing funding for verification compute. With potentially thousands of sessions
to verify, costs could mount.

**Ecosystem concerns.** ICP has a small developer ecosystem compared to Ethereum
or Solana. Tooling is less mature. The network's long-term trajectory is
uncertain. Building on ICP is a bet on a platform with limited adoption.

**Mobile.** ICP has reasonable mobile support via Internet Identity (WebAuthn-based
authentication), but there is no equivalent of MetaMask or Phantom. Users would
interact via a web interface.

**Verdict: The only platform where on-chain verification is even theoretically
possible. But ecosystem risk is high, tooling is immature, and the reverse gas
model requires project funding. Interesting for research, risky for production.**

### 2.6 Cosmos / Appchain Approach

**Concept.** Build a Gridcoin-specific blockchain using the Cosmos SDK. The chain
has custom transaction types (`CommitBlock`, `MintCoin`, `Transfer`,
`SocialWitness`), a custom verification module, and its own validator set.
Connects to the broader Cosmos ecosystem via IBC (Inter-Blockchain Communication).

**Advantages:**
- Full control over transaction types, fee structure, and verification logic
- No gas costs for users (the chain can make minting transactions free)
- Custom consensus: could use a lightweight PoS with Gridcoin as the staking token
- IBC enables bridging Gridcoin to Cosmos DEXes (Osmosis) for liquidity

**Development effort.** The Cosmos SDK is written in Go. Building a custom module
requires:
- Learning Go and the Cosmos SDK (significant ramp-up for a JS developer)
- Implementing custom message types, keepers, and state management
- Setting up a validator set (minimum viable: 4-10 validators)
- Operating infrastructure (at least one seed node, block explorer)

Realistic effort for a solo developer: 3-6 months of full-time work to reach
a testnet. This is a major commitment.

**Validator bootstrap problem.** An appchain needs validators. Who runs them?
Early on, probably just the developer and a few friends. This is effectively
centralized. Decentralization comes later -- if ever.

**Sovereign rollup option.** Projects like Celestia offer "sovereign rollups"
where you build an appchain that posts data to a DA layer (Celestia, Avail)
instead of running its own consensus. This reduces operational overhead but
adds dependency on the DA layer.

**Verdict: Maximum control, maximum effort. Only makes sense if the project
gains enough traction to justify the infrastructure. Not an MVP choice.**

### 2.7 Sui / Aptos (Move-based)

**Transaction costs.** Sui averages ~$0.002 per transaction (competitive with
Solana). Aptos is similar. Both offer sub-second finality.

**Object-centric model (Sui).** Sui's object model could map naturally to Gridcoin:
each miner's session chain could be an on-chain object, with blocks appended as
owned objects. Cell ownership on a board could theoretically be represented as
Sui objects, though this is over-engineering for Gridcoin's needs.

**Developer experience.** Move is a new language (neither Solidity nor Rust).
Learning curve is steep. Sui has ~950 monthly active developers (growing but
small). Tooling is improving but not at Solidity/Anchor maturity levels.

**Ecosystem.** Sui has positioned itself for gaming (Sui Play, partnerships with
game studios). This aligns with Gridcoin's identity. Aptos has leaned more
toward enterprise/DeFi.

**Verdict: Low fees, good gaming alignment (especially Sui). But Move is yet
another language to learn, and the ecosystem is young. Not enough advantage
over Solana or Base to justify the language investment.**

## 3. Existing Platform: What Goes On-Chain vs Off-Chain

For the most promising platforms (Base/Arbitrum and Solana), here is what the
architecture looks like:

### On-Chain (Smart Contract / Program)

```
GridcoinToken (ERC-20 or SPL Token)
  - Standard fungible token: balances, transfers, approvals

GridcoinMining
  - commitBlock(blockHeader):
      Store: H(blockHeader), minerPubkey, simTicks, timestamp
      Mint: N tokens to miner
      Emit: BlockCommitted event

  - commitSocialBlock(blockHeaderA, blockHeaderB, crossRef):
      Verify: both headers reference each other
      Store: both headers + cross-reference
      Mint: N tokens to each miner (with social bonus)
      Emit: SocialBlockCommitted event

  - challengeBlock(blockHash, bond):
      Post a challenge bond claiming a block is fraudulent
      Start a challenge window (e.g., 7 days)

  - resolveChallenge(blockHash, proof):
      If challenger provides a valid fraud proof:
        slash miner's committed blocks, reward challenger
      If challenge window expires without proof:
        return bond to miner, slash challenger's bond
```

**What the contract stores per block (~160 bytes):**
- Block hash (32 bytes)
- Start state hash (32 bytes)
- End state hash (32 bytes)
- Miner address (20 bytes on EVM, 32 bytes on Solana)
- Simulation ticks (8 bytes)
- Wall-clock timestamp (8 bytes)
- Social partner address (20-32 bytes, zero if solo)

At 48 blocks/day per miner, 1000 miners: 48,000 * 160 bytes = 7.7 MB/day of
on-chain storage. On Ethereum L2s, this is stored in calldata/blobs, not
permanent contract storage (which would be far more expensive). The contract
stores only the latest block hash per miner and a Merkle root of historical
blocks, keeping permanent storage minimal.

### Off-Chain (Phone)

- Full simulation state (1MB for 32x32 6502life board)
- Complete block chain with full block data (state hashes, interaction logs)
- Serialized state snapshots (periodic full + deltas)
- Boundary exchange logs (for social mining)
- Ed25519 keypair

The phone is the source of truth for simulation data. The chain only stores
commitments (hashes) and token balances.

### Verification Model

**Optimistic with fraud proofs (recommended for MVP):**

1. Miner submits block headers to the contract. Tokens are minted immediately.
2. Anyone can challenge a block within a 7-day window by posting a bond.
3. To resolve a challenge, the miner must provide the full block data
   (start state, interaction log, end state) to an off-chain verifier.
4. The verifier replays the simulation and posts the result on-chain.
5. If the block is fraudulent, the miner's tokens from that block are burned
   and the challenger receives a reward. If valid, the challenger's bond is
   slashed.

This mirrors optimistic rollup mechanics (Arbitrum/Optimism use exactly this
pattern). The key difference: Gridcoin's verification is too expensive for
on-chain dispute resolution, so the "verifier" is a trusted off-chain service
or a committee of verifiers. This is a centralization trade-off.

**Probabilistic spot-checking (alternative):**

A network of volunteer verifiers randomly selects blocks to verify. Each
verified block gets a "verified" flag on-chain. Blocks with more verifications
are more trustworthy. This is weaker than fraud proofs but requires no bonds
or challenge windows.

## 4. New Chain from Scratch

### What the Architecture Doc Proposes

The architecture document describes a local-first system:
- Each player maintains a local hash chain on their phone
- Blocks are produced offline, no network needed
- Sync happens peer-to-peer (Bluetooth or optional WebSocket relay)
- Coins are local records referencing valid blocks
- Transfer requires mutual agreement (both parties record the transfer)

This is not a blockchain in the traditional sense. It is a network of
local ledgers with eventual consistency, more like a CRDT-based system or
a gossip protocol than a consensus chain.

### Effort Estimate

Building this from scratch (as described in the architecture doc):

| Component | Effort | Skills |
|-----------|--------|--------|
| Engine interface + reference impl | 1-2 days | JavaScript |
| Session recording + verification | 3-5 days | JavaScript, crypto |
| Solo mining loop + local wallet | 1-2 weeks | JavaScript, IndexedDB |
| Social mining over Bluetooth | 2-3 weeks | Web Bluetooth API, BLE |
| Ledger sync + coin transfer | 2-4 weeks | P2P networking |
| **Total** | **8-12 weeks** | |

This is the timeline from the architecture doc for a solo developer working
part-time. It is aggressive but plausible for the "local chains, no global
consensus" model described there.

**However**, this is not a blockchain. It is a local-first app with peer-to-peer
sync. Adding a real blockchain (global consensus, permissionless validation,
trustless transfers to strangers) would add:

| Component | Additional Effort | Skills |
|-----------|-------------------|--------|
| Consensus protocol | 2-4 months | Distributed systems, Go/Rust |
| Networking layer (gossip, peer discovery) | 1-2 months | libp2p or similar |
| Block explorer + RPC API | 2-4 weeks | Backend dev |
| Light client protocol | 1-2 months | Cryptography |
| Security audit | 1-2 months + budget | External reviewer |
| **Total additional** | **6-12 months** | |

### Advantages of a New Chain

- **No gas costs.** Transactions are free by design. The chain's validators
  are compensated through token inflation, not per-transaction fees.
- **Full control.** Custom transaction types, custom verification logic,
  custom economics. No need to fit Gridcoin's model into EVM/Solana constraints.
- **No platform dependency.** No risk from L2 shutdowns, fee changes, or
  ecosystem collapse.
- **Offline-first is native.** The local chain model maps directly to the
  phone-first, intermittent-connectivity reality.

### Disadvantages of a New Chain

- **No existing ecosystem.** No wallets, no DEXes, no block explorers, no
  indexers. Everything must be built or adapted from scratch.
- **No liquidity.** The token cannot be traded on any exchange without
  building bridges or listings (which require traction and/or money).
- **Bootstrap problem.** A chain with 1 validator is a database. Getting to
  meaningful decentralization requires attracting validators, which requires
  token value, which requires users, which requires a working product.
- **Security.** A custom consensus protocol is a massive attack surface. Even
  well-funded teams (Solana, Sui) ship bugs. A solo developer's chain will
  have undiscovered vulnerabilities.
- **Maintenance burden.** Operating a blockchain is a full-time job:
  upgrades, monitoring, incident response, validator coordination.

## 5. Comparison Table

| Criterion | Ethereum L2 (Base/Arbitrum) | Solana | Cosmos Appchain | New Chain (local-first) |
|-----------|---------------------------|--------|-----------------|------------------------|
| **Cost per mint** | $0.001-0.01 | $0.00025 | $0 (custom fee) | $0 |
| **Development effort** | 2-4 weeks (Solidity) | 3-6 weeks (Rust/Anchor) | 3-6 months (Go) | 8-12 weeks (JS, no consensus) or 6-12 months (with consensus) |
| **Mobile UX** | Good (MetaMask, Coinbase Wallet) | Good (Phantom, MWA) | Poor (no wallets) | Custom (must build) |
| **Verification capability** | Off-chain only; fraud proofs possible | Off-chain only | Custom on-chain module possible | Custom (full control) |
| **Ecosystem / liquidity** | Excellent (DEXes, bridges, wallets) | Strong (growing DeFi) | Moderate (IBC, Osmosis) | None |
| **Decentralization** | Inherited from Ethereum (strong) | Moderate (validator concentration) | Must bootstrap validators | None initially |
| **Long-term viability** | High (Ethereum is Lindy) | Moderate-high | Depends on Cosmos ecosystem | Depends entirely on project traction |
| **Solo developer feasibility** | High | Moderate | Low | High (without consensus) / Very low (with consensus) |
| **Offline-first support** | Batch submission works | Batch submission works | Native if custom | Native |
| **Language / tooling** | Solidity, ethers.js, Hardhat | Rust, Anchor, @solana/web3.js | Go, Cosmos SDK | JavaScript (existing codebase) |

**Rating summary (1-5, higher is better for Gridcoin):**

| Criterion | Ethereum L2 | Solana | Cosmos Appchain | New Chain |
|-----------|-------------|--------|-----------------|-----------|
| Cost | 4 | 5 | 5 | 5 |
| Effort | 4 | 3 | 1 | 4 (no consensus) / 1 (with) |
| Mobile UX | 4 | 4 | 1 | 2 |
| Verification | 3 | 3 | 3 | 4 |
| Ecosystem | 5 | 4 | 2 | 1 |
| Decentralization | 5 | 3 | 2 | 1 |
| Viability | 5 | 4 | 2 | 2 |

## 6. Recommendation

### What a solo developer with zero budget should do first

**Phase 1: Build the local-first system (weeks 1-12).** Follow the architecture
doc's MVP plan. Engine interface, session recording, solo mining, social mining
over Bluetooth. This produces a working app where players mine coins locally.
No blockchain needed. The local hash chain IS the ledger. This is the plan
already laid out in `gridcoin-architecture.md` and it is the right starting
point regardless of eventual chain choice.

**Why start here, not with a chain?** Because the hard problems are in the
simulation engine, session recording, deterministic replay, and Bluetooth
social mining -- not in the token contract. If the simulation is not fun, or
determinism fails across devices, or Bluetooth boundary sync does not work,
then no blockchain will save the project. Build the core product first.

**Phase 2: Deploy a token on Base or Arbitrum (weeks 13-16).** Once the local
mining loop works and sessions can be verified, deploy a minimal smart contract:

- ERC-20 token (GridcoinToken)
- `commitBlock(bytes32 blockHash, bytes32 endStateHash, uint64 simTicks)` -- stores commitment, mints tokens
- `commitSocialBlock(...)` -- stores dual commitment, mints with social multiplier

This is a few hundred lines of Solidity. Deployment cost on Base: under $1.
Per-mint cost: ~$0.001. A player mining 8 hours/day pays ~$0.05/day in gas.

Why Base over Solana? For a solo JS developer:
- Solidity is easier to learn than Rust/Anchor
- ethers.js integrates directly with the existing JavaScript codebase
- MetaMask/Coinbase Wallet provide immediate mobile wallet support
- The EVM ecosystem has more tutorials, Stack Overflow answers, and tooling
- Base has the lowest fees among mature L2s

If Base's fee subsidy ends and costs rise, migrating to Arbitrum is trivial
(same Solidity contracts, same ethers.js calls, just a different RPC URL).

**Phase 3: Add fraud proofs (months 4-6, optional).** Once there are enough
users that cheating matters, add the challenge/response mechanism. This
requires an off-chain verifier service (a Node.js server that replays
sessions on demand) and a contract extension for bond posting and dispute
resolution. This can run on a free-tier cloud instance initially.

**Phase 4: Re-evaluate (month 6+).** With real usage data:
- If transaction volume is high and Base fees rise, consider Solana
- If the community wants true decentralization, consider a Cosmos appchain
- If ZK proving becomes practical on phones (StarkWare's S-two, RISC Zero),
  consider migrating to a ZK-verified model on StarkNet
- If the local-first model works well enough and nobody cares about on-chain
  trading, skip the chain entirely and keep it peer-to-peer

### The pragmatic path, summarized

1. Build the game and local mining loop first (JavaScript, no chain)
2. Add Base L2 token when you need transferability beyond Bluetooth range
3. Add fraud proofs when you need to punish cheaters
4. Re-evaluate chain choice when you have real users and real data

Do not over-engineer the blockchain layer before the game layer works. The
blockchain is plumbing. The game is the product.
