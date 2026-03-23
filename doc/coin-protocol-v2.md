# 6502coin Protocol v2

## What the protocol defines

Three things only.

### 1. Board

You create a board. You sign it with your Ed25519 key. You simulate it.
Your history is a Merkle tree of state checkpoints. You can reconstruct
any point from initial state + move log.

### 2. Coins

Coins are a metering mechanism. They exist on your board, stay on your
board, and cannot be transferred.

**Earn:** One coin per T_coin ticks of simulation. Earning is faster
during share events (e.g. 2× rate while merged with a partner).

**Spend:** Making a Move (player input event) on your board costs coins.
No coins, no Moves. You must simulate (and share) to earn the right to
write.

**Decay:** Coins halve in value over a fixed half-life. Hoarding doesn't
help — unspent coins lose value exponentially. This ensures continuous
simulation and sharing.

Coins are purely local. No transfers, no trading, no exchange rates,
no ledger disputes, no double-spend. Your board, your coins, your
Moves.

### 3. Signing (Sharing)

You and another player temporarily merge your boards, simulate the
merged board for an agreed duration, split, and both sign the shared
period.

During a share:
- Both earn coins at an accelerated rate
- Both sign each other's chain for the shared period

That's it. Sharing earns you Moves faster and builds your attestation
history.

## The provable record

At any time you can prove:
1. You own the board (signed contract with your public key)
2. How long it has been running (board clock in the Merkle tree)
3. Who has signed it (mutual attestations from share events)
4. What Moves have occurred (timestamped, signed move log)
5. Your coin balance (deterministic: simulation ticks earned minus
   Moves spent, with decay applied)

## Timestamping (optional)

You may optionally let other players request Moves on your board.
They ask, you timestamp. They don't pay you — there are no transfers.
You do it because it makes your board more interesting, or because
you're running a public server. You can refuse any request.

## Why this defeats gaming

- **Sybil:** Creating fake boards earns coins nobody can use elsewhere.
  Coins don't transfer. Worthless.
- **Hoarding:** Coins decay. You must keep simulating and sharing to
  maintain your Move budget.
- **Fast-forward:** You can simulate fast, earning coins fast. But you
  also need share attestations to earn at the accelerated rate. Fast
  solo simulation earns at the base rate only.
- **Collusion:** Two players sharing with only each other earn accelerated
  coins. Fine — they're actually playing the game. The coins meter their
  Moves, nothing more.

## Summary

- **Earn** coins by simulating (faster during shares)
- **Spend** coins to make Moves
- **Coins decay** exponentially (use them or lose them)
- **Coins never leave your board**

Everything else — reputation, score, board interestingness — is
emergent and lives outside the protocol.
