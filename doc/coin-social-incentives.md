# Coin Social Incentives & Cell Provenance Design

## 1. Cell Provenance: lastWriter field

Every cell carries a `lastWriter` field — the wallet (board) ID of the player
whose board last wrote to this cell.

### Mechanics
- **MOVE (BRK swap)**: `lastWriter` is swapped along with cell content (provenance preserved)
- **Perfect COPY (BRK noisy copy, zero bit errors)**: `lastWriter` is copied from source to destination (provenance preserved — the copy "belongs to" the original writer)
- **Imperfect COPY (any bit flipped)**: `lastWriter` is CLEARED on the destination cell. The mutant is nobody's — it's a new organism with no provenance. This prevents false attribution of degraded code.
- **LDA/STA writes**: `lastWriter` is set to the currently executing cell's board owner. If cell A (owned by player X) writes into cell B, cell B's lastWriter becomes player X.
- **Cross-board edge sharing**: when boundary cells arrive from another board, they carry that board's wallet ID as lastWriter.

### Storage
- Per-cell, NOT in the 1024-byte cell memory (programs can't read or tamper with it)
- Part of the controller/board state, serialized in session blocks
- Just a wallet ID (32-byte Ed25519 public key, or a shorter hash of it)

### Non-interference principle
The `lastWriter` field has NO EFFECT on board dynamics. The VM does not
read it. Programs cannot read it. It is purely metadata for the coin
protocol and lineage tracking. ALife dynamics are completely unaffected.

## 2. "Niche!" Events

When a cell on Board B has a `lastWriter` matching Board A's wallet ID,
that's a **Niche exploration event** — Board A's content is thriving on
Board B's territory.

### Detection
Two orthogonal methods:
1. **Provenance-based**: `lastWriter` field matches. Works for perfect copies
   via BRK. Fast, deterministic, but misses cases where code propagated
   via LDA/STA or accumulated non-lethal mutations.
2. **MinHash-based**: fingerprint similarity ≥ threshold between cells on
   different boards. Catches mutated descendants. Slower, probabilistic,
   but complementary.

A Niche event is logged when EITHER method detects cross-board presence.

### Reward
- Default: **0.69 coin** bonus per Niche event (configurable board param)
- Awarded to the originating board's chain (Board A gets 0.69 coins when
  their content is found on Board B)
- Board B is NOT penalized — this is NOT zero-sum
- The bonus is recorded in the session block and is verifiable from the
  blockchain (the dual-witness signatures confirm both boards agree on
  the boundary data that produced the event)

### Non-zero-sum design
Critical: Niche events are **strictly additive**. Board B does not lose
anything when Board A's organisms arrive. Both players benefit from
pairing — Board A gets Niche bonuses, Board B gets a more diverse
ecosystem (which is interesting to watch, even if it doesn't directly
affect their coin rate).

This mirrors the Farmville model: helping someone else's farm gives YOU
social points, and they can reject your help, but the helper still benefits.
In our case: your organisms colonizing their board gives YOU Niche coins,
and their organisms colonizing yours gives THEM Niche coins. Both win.

## 3. Solo Mining Rate Decay (Pairing Incentive)

### The problem
Without explicit incentives, players could solo-mine forever and never
pair. We want to nudge toward social play without punishing solo play
too harshly.

### Mechanism: mining rate halving
- Solo mining starts at the **maximum rate** (1 coin per block)
- Every **N hours** since your last social pairing, the rate halves
- Minimum rate: **1/128** of maximum (never reaches zero)
- Any social pairing resets the clock to maximum rate

### Parameters (configurable)
- `soloHalfLife`: hours between halvings (default: 24 hours)
- `minSoloRate`: minimum fraction of max rate (default: 1/128 ≈ 0.0078)
- `socialResetBoost`: multiplier applied on pairing (default: 1.0 = full reset)

### Example timeline
| Hours since last pairing | Solo rate | Coins per block |
|:---:|:---:|:---:|
| 0 | 1.0 | 1.000 |
| 24 | 0.5 | 0.500 |
| 48 | 0.25 | 0.250 |
| 72 | 0.125 | 0.125 |
| 96 | 0.0625 | 0.063 |
| 120 | 0.03125 | 0.031 |
| 144 | 0.015625 | 0.016 |
| 168 (1 week) | 1/128 (floor) | 0.008 |

### Non-disruptive properties
- Never reaches zero — solo mining always works
- One pairing per day maintains full rate — minimal social obligation
- No penalty for the OTHER player when you pair — strictly beneficial
- The decay is per-board, not per-account — you can run multiple boards
- ALife dynamics are completely unaffected by the rate decay

## 4. Social Mining Bonus

### Options considered

**Option A: Social coins worth more (multiplier)**
- During a social session, coin rate is 2x (configurable)
- Simple, transparent, directly incentivizes pairing
- Risk: feels "grindy" if the multiplier is too high

**Option B: Cross-chain coin ownership**
- When you pair with Board B, you earn coins on BOTH chains
- Your chain and their chain each record the social session
- You "own" coins on their chain (your wallet ID is the minter)
- Complex but creates real cross-chain value

**Option C: Combine A and B**
- Social sessions earn at 1.5x rate on your own chain
- PLUS you earn 0.5x rate coins on their chain
- Total: 2x, split between chains

### Recommendation: Option A (simplest)
A flat 1.5x multiplier during social sessions. Combined with the solo
decay mechanism, this creates a clear incentive gradient:

| Mode | Rate |
|------|------|
| Solo, just paired | 1.0x |
| Social (during pairing) | 1.5x |
| Solo, 24h since pairing | 0.5x |
| Solo, 1 week since pairing | 0.008x |

The social premium is modest (50%) — enough to notice, not enough to
feel coercive. The real incentive comes from the solo decay: pairing
once per day maintains full rate.

## 5. Design Principles

1. **ALife dynamics are sacred.** No coin mechanic should change how cells
   execute, replicate, mutate, or die. The VM doesn't know about coins.

2. **Non-zero-sum.** Pairing should benefit both players. No mechanism
   should make one player's gain another's loss.

3. **Minimal disruption.** Coin incentives should nudge behavior gently,
   not coerce it. A player who only solo-mines should still have fun.

4. **Verifiable.** Every coin, Niche event, and social session should be
   cryptographically verifiable from the blockchain without trusting
   either player.

5. **Orthogonal parameters.** Social incentive strength (multiplier,
   decay rate, Niche bonus) should be configurable independently of
   ALife parameters (noise rate, board size, feature flags).

6. **Free-to-play friendly.** Don't create dynamics that punish casual
   players or reward grinding. The Farmville lesson: social features
   should feel like gifts, not obligations.
