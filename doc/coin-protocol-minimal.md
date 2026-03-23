# 6502coin Minimal Protocol

This is the stripped-down protocol. Three primitives only.

## 1. Signed Board

You create a board by signing an initial contract with your Ed25519 key:

```json
{
  "owner": "<public key hex>",
  "boardParams": { "pBitNoise": 0.000488, ... },
  "initialStateHash": "<SHA-256 of initial board state>",
  "maxMovesPerDay": 100,
  "created": "<ISO timestamp>",
  "signature": "<Ed25519 signature>"
}
```

You own the board. You run it. Nobody else needs to know or care.

## 2. Merkle History

Your board history is a Merkle tree of state checkpoints. You maintain
it locally. Structure: binary tree, level K covers 2^K ticks, leaves
are SHA-256 of board state at checkpoint ticks.

You keep this because anyone COULD ask to see it. If you can't produce
it, people stop trusting you. But nobody is forced to ask. It's there
for "trust but verify."

The tree plus your signed contract plus your move log is sufficient to
reconstruct your entire board history from time 0 to now.

## 3. Mutual Attestation (Edge Sharing)

When you meet another player:

1. You merge boards temporarily (your B×B + their B×B → one larger board)
2. Run the merged board for an agreed duration
3. Split back into two boards (new PRNG states derived from merged final state)
4. Both sign a statement: "We shared from time T1 to T2. Here are our
   initial and final state hashes. Here is the move log for the shared
   period."

That's it. The signed attestation goes on both chains. It proves you
met, shared, and agreed on what happened.

## Score

```
score = (I - αA)^{-1} Y
```

Where:
- Y_i = your total simulation time (from your board's clock)
- A_ij = fraction of your board time spent sharing with player j
- α ≈ 0.3 (bounds collusion amplification to 1.43×)

In words: your simulation time, plus a bonus from your partners'
simulation time (attenuated by social distance), recursively through
the network.

New players with no social history score Y_i > 0 (not zero).
Frequent sharers score higher. Sybil cliques score their intrinsic
Y but get no network bonus (no connections to real players).

## What's NOT in the protocol

- No forced challenges (you maintain history because others might ask)
- No mandatory spot-checks
- No global blockchain
- No on-chain settlement
- No token economics
- No inflation schedule
- No difficulty adjustment

The score is a cosmetic, cryptographically verifiable number.
The social graph of attestations IS the distributed ledger.
The game is the product. The score is just a score.
