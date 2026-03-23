# 6502coin Protocol v2

## What the protocol defines

Four things only. Everything else is policy.

### 1. Board

You create a board. You sign it with your Ed25519 key. You simulate it.
Your history is a Merkle tree of state checkpoints. You can reconstruct
any point from initial state + move log.

### 2. Coins

Each board has its own coins. You earn coins by simulating your board
(one coin per T_coin ticks). You spend coins to make Moves (player
input events) on your board.

Coins are per-board. My-board-coins can only be spent on my board.
There is no universal currency.

**Ledger:** Each board's chain is the sole authoritative ledger for
that board's coins. It records: coins minted (one per T_coin ticks),
coins earned by visitors (from shares/timestamps), coins spent on
Moves, coins traded in/out at share events. All entries are signed
by the board owner.

**Balances:** Your balance on someone else's board is a function of
THEIR chain, not yours. Anyone can compute it by reading their public
chain. You can't forge a balance because it requires their signature.

### 3. Signing (Sharing)

You and another player temporarily merge your boards, simulate the
merged board for an agreed duration, split, and both sign the shared
period. During this:

- You each earn coins on the OTHER's board
- You can trade coins between your two boards (I give you N of
  my-board-coins, you give me M of your-board-coins)
- Both sign each other's chain for the shared period

Trades are between the two boards involved. No third-party currencies.
The exchange rate is negotiated between players. The protocol just
records that the trade happened (signed by both).

Signing events are one of two opportunities to exchange coins.

### 4. Timestamping

You may optionally offer to timestamp other players' Moves on your
board. They send you a Move request, you grant a signed timestamp,
they pay you in your-board-coins. This is the second opportunity to
exchange coins.

Most players won't offer this. It requires uptime, opens your board
to others' inputs, and drains battery. It's for enthusiasts running
persistent nodes, or briefly during share events.

## What the protocol does NOT define

- **Score / reputation.** How simulation time and signings translate to
  reputation is a policy layer. Different clients can compute different
  scores. Bonacich centrality, PageRank, simple attestation count —
  it's up to the viewer.

- **Exchange rates.** How coins on Board A trade against coins on Board B
  is negotiated between players. The protocol just records that an
  exchange happened (signed by both parties).

- **Board interestingness.** Whether a board is "worth" interacting with
  is subjective. The protocol doesn't judge. A board full of dead cells
  has worthless coins because nobody wants to make Moves on it.

- **Sybil defense.** Per-board currencies provide natural economic Sybil
  resistance (coins on fake boards are worthless). Additional defenses
  (PageRank, identity cost) are policy.

- **Move pricing.** How much a Move costs in coins is set by the board
  owner (in the initial contract or dynamically). The protocol just
  enforces that the owner signed the Move and the spender had enough
  coins.

## The provable record

At any time you can prove:
1. You own the board (signed contract with your public key)
2. How long it has been running (board clock in the Merkle tree)
3. Who has signed it (mutual attestations from share events)
4. What Moves have occurred (timestamped, signed move log)
5. Your coin balances (derived from simulation time + shares + trades)

All of this is verifiable by any third party from the public data.

## Why per-board currencies defeat Sybils

Creating 1000 fake boards creates 1000 worthless currencies. The only
valuable coins are on boards that other players want to interact with
(make Moves on). Value comes from demand, which comes from the board
being interesting. You cannot manufacture demand by creating fake boards.

A Sybil attacker with 1000 self-attesting boards has:
- 1000 sets of worthless coins (no one wants to Move on empty boards)
- High simulation time (but that alone doesn't buy anything)
- Mutual attestations (but from worthless partners)
- No coins on any real player's board (because no real player shared with them)

The attack produces nothing of value without engaging real players.

## Summary

The protocol is minimal:
- **Earn** coins by simulating
- **Spend** coins to make Moves
- **Trade** coins at share events or when selling timestamps
- **Prove** your history via Merkle tree

Everything else — reputation, score, exchange rates, interestingness,
trust — is emergent, subjective, and lives outside the protocol.
