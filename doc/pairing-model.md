# Live Pairing Model

## Core principle: both boards are sovereign

Each board is its own blockchain. It ALWAYS runs. Pairing is just
periodic edge data exchange between two independent simulations.

## What happens during pairing

1. **Both boards run independently.** Neither waits for the other.
   Your board ticks at its own speed regardless of partner status.

2. **Every N ticks, exchange boundary data.** You send your north
   edge (or whichever edge faces your partner). They send their
   corresponding edge. Both apply the received data to their
   local board. This is the only interaction.

3. **No rollback, no re-simulation.** Each board is authoritative
   over its own state. The boundary data is just "here's what my
   edge looks like right now." You apply it and continue.

4. **Connection loss is seamless.** If the connection drops, your
   board keeps running with stale boundary data. The edge cells
   freeze in their last-received state. When you reconnect, fresh
   data flows again. No gap, no desync.

## What happens when one player is faster

If player A runs at 1000 ticks/sec and player B at 100 ticks/sec,
A sends 10x more boundary updates than B receives. B applies whatever
the latest data is when they process their next edge share. A gets
B's data less frequently but that's fine — it's just like having a
slow neighbor.

There is no concept of "lag" or "desync" because there is no shared
state to be in sync about. Each board is its own reality.

## Side-by-side view

When paired, the UI shows:
- Your board on the left (or top on phone)
- Partner's board on the right (or bottom)
- The shared edge highlighted between them
- Organisms visibly crossing the boundary

The partner's board is rendered from the boundary data you receive —
you only see their edge strip, not their full board. The rest is
inferred (greyed out or shown as a gradient fading to dark).

## Edge ownership: each player owns their own board

There is no "shared edge." Each player is authoritative over their
own board at all times. The edge share is a mutual read:

- You SEND your edge strip to them
- They SEND their edge strip to you
- You APPLY their data to your boundary cells
- They APPLY your data to their boundary cells

This means:
- **Simultaneous writes:** not a problem. Each player's writes affect
  their local board. Edge shares overwrite boundary cells with the
  partner's latest state. Last-share-wins.
- **Missed messages:** your board keeps running with stale boundary
  data. No rollback needed. Next successful share brings fresh data.
- **Ignoring messages:** you're solo mining with a frozen boundary.
  No social multiplier (partner won't sign your blocks). The chain
  reveals the truth.

## Niche reward: 0.69 bonus on next coin

One Niche detection per pairing session (not per event). Requires
minimum session duration to prevent connect/disconnect gaming.
The bonus applies to the next coin mined after Niche is detected.

## No "moves" — just boundaries

Unlike sokoscript where players send keystroke commands, 6502life
has no player inputs during simulation. The only "multiplayer" data
is the boundary cells. There's nothing to timestamp or speculate
about — boundary data arrives, you apply it, done.

If we add player inputs (e.g. injecting presets mid-game), those
ARE timestamped in the session blocks. But they're local to your
board — you don't need the partner to validate them. The dual-witness
signatures just confirm "we were both running and exchanging data
at these times."

## Asymmetric pairing

Player A can be running a noisy board (high epsilon) while player B
runs a clean board (zero epsilon). The boundary data flows regardless.
Organisms from A's noisy environment might cross into B's clean
environment and vice versa. Different board params create different
ecological niches — this is a feature, not a bug.
