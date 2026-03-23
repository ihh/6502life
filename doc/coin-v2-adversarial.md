# Adversarial Analysis: 6502coin Protocol v2

Date: 2026-03-23

This document is a hostile analysis of `doc/coin-protocol-v2.md`. It examines
v2's per-board currency model against the attack surface identified in the v1
adversarial analysis (`doc/coin-protocol-adversarial.md`) and raises new attack
vectors specific to v2's design.

---

## V1 Attack Triage: What v2 Fixes, What Remains, What's New

| V1 Attack | V2 Status | Explanation |
|-----------|-----------|-------------|
| #1 Sybil attestation farming (CRITICAL) | **Structurally mitigated** | No global PageRank. 1000 fake boards produce 1000 worthless currencies. But see Attack A below. |
| #2 History fabrication / fast-forward (CRITICAL) | **Unchanged** | Merkle tree of checkpoints still exists. No real-time enforcement specified. See Attack B. |
| #3 Challenge protocol evasion (HIGH) | **Removed (no challenge protocol)** | V2 has no challenge protocol. The board owner's chain is authoritative. This trades one problem for another: see Attack C. |
| #4 Trivial edge sharing (HIGH) | **Structurally mitigated** | No social multiplier. Sharing with trivial boards earns coins on those trivial boards, which are worthless. |
| #5 Timestamper griefing (MEDIUM) | **Preserved, now explicit** | V2 says the owner can offer timestamping. Owner discretion is by design. See Attack D. |
| #6 Merkle tree forgery (LOW) | **Moot** | No third-party challenge protocol. The owner's chain is self-attested. Forgery is now the owner's prerogative (see Attack C). |
| #7 Selective attestation / PageRank manipulation (MEDIUM) | **Eliminated** | No PageRank, no global reputation. |
| #8 State size DoS (MEDIUM) | **Reduced** | No challenge protocol means no mandatory state transfer to verifiers. But share events still exchange state. |
| #9 PRNG manipulation after merge (LOW) | **Likely moot** | V2 describes sharing as "temporarily merge boards, simulate, split." If PRNG handling is unspecified, the issue persists in implementation. |
| #10 Time dilation (CRITICAL) | **Unchanged** | See Attack B. |
| #11 Merkle checkpoint ambiguity (LOW) | **Unchanged** | Merkle tree still referenced. Same ambiguity. |
| #12 Board merge determinism gap (HIGH) | **Possibly still present** | V2 says "temporarily merge your boards" but does not specify the merge model in detail. |
| #13 Challenge freshness (MEDIUM) | **Eliminated** | No challenge protocol. |
| #14 Attestation revocation (MEDIUM) | **Reduced** | Attestations are now "both sign each other's chain for the shared period." This is narrower: you attest a specific period, not the whole history. Revocation is less critical but still absent. |
| #15 Score formula ambiguities (MEDIUM) | **Eliminated** | No score formula. V2 explicitly delegates scoring to the policy layer. |
| #16 Tragedy of the commons (MEDIUM) | **Structurally mitigated** | No score means no incentive to run empty boards for score farming. But see Attack E. |
| #17 Collusion equilibrium (HIGH) | **Structurally mitigated** | Without a global score, collusion produces worthless coins on worthless boards. |
| #18 Cold start (HIGH) | **Eliminated** | No global score means no multiplicative collapse. You earn coins on your own board from day one. |

**Summary:** V2 eliminates 8 of 18 v1 issues outright, structurally mitigates 4 more, and leaves 3 unchanged. The remaining issues cluster around a single new theme: **ledger sovereignty means the board owner is a dictator**, which creates a new class of attacks.

---

## Attack A: Parasitic Sharing -- The "Interesting Fake Board" Sybil

**Severity: MEDIUM**

### The claim under scrutiny

V2 says: "Coins on fake boards are worthless because nobody wants to Move
there." The implicit argument: demand drives value, fake boards have no demand,
therefore fake-board coins are worthless.

### The attack

I create a board. I pre-seed it with copied organisms from a well-known
interesting board (the organisms are just byte patterns; nothing prevents
copying). My board looks interesting. I advertise it. Real players share with me.

During the share event:
1. I earn coins on THEIR boards (Grant operation).
2. They earn coins on MY board.
3. We can trade: they give me their-board-coins, I give them my-board-coins.

The coins they earn on my board are arguably worth something -- my board IS
running interesting organisms (copied, but functioning). The coins I earn on
their boards are definitely worth something.

### Why "worthless fake board" is not fully enforceable

The v2 claim rests on a circular argument:
- Coins are worthless if nobody wants to Move on the board.
- Nobody wants to Move on a board with nothing interesting.
- Therefore fake boards have worthless coins.

But "interesting" is subjective and gameable. A board seeded with copied
organisms IS interesting in the simulation sense. The organisms run, interact,
evolve. The only difference from a "real" board is provenance -- and v2 defines
no provenance mechanism.

Furthermore, the attacker does not need their own coins to be valuable. They
need coins on OTHER players' boards. They earn those via the Grant operation
during shares. The attack is: create a superficially interesting board, attract
share partners, accumulate coins on real boards.

### What limits this attack

1. **Scale.** Each share event requires actual interaction with a real player.
   The attacker cannot automate this without the partner's cooperation. This
   bounds the rate of coin accumulation on real boards.

2. **Reputation is out-of-band.** If the community notices that a player is
   running copied organisms and churning through share partners, they can
   socially ostracize them. V2 deliberately delegates reputation to the policy
   layer.

3. **Coins earned on real boards still require the real board owner to record
   them.** The owner can refuse to record grants if they suspect bad faith (but
   see Attack C -- this creates its own problems).

### Assessment

This is a real but bounded attack. It is less severe than v1's Sybil farming
because it requires genuine interaction and produces coins only on boards whose
owners consented to the share. The circular "worthless coins" argument has a
hole, but the hole is narrow.

### Mitigations

1. **Provenance tracking.** Allow boards to record which organisms were
   introduced during share events vs. which evolved natively. This lets policy
   layers distinguish "interesting because of imports" from "interesting
   because of native evolution."
2. **Grant rate limits.** Cap the number of coins granted per share event (e.g.,
   proportional to the duration of the shared simulation, not the number of
   events).
3. **Accept it.** If the attacker is creating genuinely interesting boards
   (even via copying) and real players voluntarily share with them, the system
   is arguably working as intended. The attacker is providing a service (an
   interesting board to interact with).

---

## Attack B: Fast-Forward Minting

**Severity: HIGH**

### The attack

V2 says: "You earn coins by simulating your board (one coin per T_coin ticks)."
The Earn operation is: simulate T_coin ticks, mint 1 coin on your chain.

I run the simulation at maximum speed. On modern hardware, a mostly-idle board
can execute millions of ticks per second. If T_coin = 10,000 (a plausible
default), I mint 100+ coins per second of wall time. In one hour, I mint
360,000 coins on my own board.

### Why v2 does not address this

V2 inherits v1's fundamental problem: there is no real-time enforcement. The
Merkle tree records checkpoints, but checkpoint timestamps are self-reported.
Nobody verifies that my simulation ran in real time.

### Impact under v2's per-board model

Under v2, the impact is different from v1. In v1, minted coins fed into a
global score. In v2, minted coins are per-board: I can only spend them on my
own board (to make Moves). Fast-forward minting on my own board inflates MY
board's coin supply, which:

1. Lets me make unlimited Moves on my own board (but I already control my own
   board, so this is circular).
2. Gives me coins to TRADE during share events. If a share partner accepts
   my-board-coins at some exchange rate, I have a nearly unlimited supply.

The real question: **will anyone trade for fast-minted coins?** If the
community or policy layer can detect that my board has implausibly many coins
for its age, the coins are discounted. But v2 specifies no mechanism for this
detection.

### Who sets T_coin?

V2 says "one coin per T_coin ticks" but does not specify who sets T_coin or
whether it is a global protocol parameter or per-board.

If T_coin is per-board (set by the owner):
- I set T_coin = 1. Every tick mints a coin. I have billions of coins.
- These coins are nominally only spendable on my board, but I can trade them
  at share events.
- A rational partner should refuse a trade where the exchange rate is
  denominated in a hyper-inflated currency. But the protocol does not enforce
  this -- it "just records that the trade happened."

If T_coin is a global protocol constant:
- All boards mint at the same rate. Fast-forwarding still works but produces
  the same per-tick density as honest simulation.
- The advantage is purely temporal: I have more coins sooner.

### Assessment

This is a high-severity issue because T_coin is unspecified and fast-forward
is unaddressed. The per-board model limits the blast radius (you cannot
directly inflate other boards' economies), but trading creates a channel for
the inflation to leak.

### Mitigations

1. **Fix T_coin as a global protocol constant.** Document it. Make it
   immutable per-board (set at board creation, recorded in the signed contract).
2. **Require share partners to verify minting rate.** During a share event,
   both parties inspect each other's chain. If total_coins / total_ticks
   exceeds 1/T_coin, refuse the share. This is a policy-layer check but
   should be recommended in the protocol.
3. **External entropy injection.** Same as v1 mitigation: require a public
   random beacon hash at block boundaries to force real-time simulation.
4. **Accept inflation as local.** If the community understands that my-board-
   coins are only as valuable as demand for Moves on my board, fast-minted
   coins are self-limiting: nobody trades real-board-coins for hyper-inflated
   ones.

---

## Attack C: Ledger Authority -- The Sovereign Dictator Problem

**Severity: CRITICAL**

### The core issue

V2 says: "Each board's chain is the sole authoritative ledger for that board's
coins. All entries are signed by the board owner."

This means the board owner has absolute, unilateral, irrevocable control over:
- Who has coins on their board
- How many coins exist
- Whether trades are recorded
- Whether grants are honored

The owner IS the central bank AND the court system for their board's economy.

### Attack C1: Retroactive ledger editing

I am the owner of Board A. Player B earned 10 coins on my board during a
share event. Both of us signed the share event. Later, I want to deny B's
balance.

I rewrite my chain, omitting the grant to B. My chain is the sole
authoritative ledger. B has a signed share event, but v2 says "Your balance on
someone else's board is a function of THEIR chain, not yours." If I rewrite my
chain, B's balance is gone.

**Can B prove fraud?** B has the mutually-signed share event record. This
record says a share happened. But does it specify the exact coin amounts
granted? V2 says "during a share, your partner earns coins on your board" but
does not specify what the share event signature covers. If the signature covers
only "a share happened between A and B from tick X to tick Y" but not "B earned
N coins," then B cannot prove the specific balance was owed.

Even if the signature covers specific amounts, B can only prove that I
committed fraud -- they cannot force my chain to record the correct balance.
There is no enforcement mechanism. The remedy is reputational: B tells
everyone I cheated, and nobody shares with me again.

### Attack C2: Selective trade recording

Player B and I agree to a trade: B gives me 5 of their-board-coins, I give B
5 of my-board-coins. We both sign the trade. B records the trade on their
chain (B received 5 of my-board-coins, B sent 5 of their-board-coins). I
record only the part where I received 5 of B's-board-coins. I "forget" to
record that I sent 5 of my-board-coins to B.

Now B claims they have 5 of my-board-coins. My chain says they have 0. My chain
is authoritative. B has the signed trade record but (same issue as C1) cannot
force my chain to reflect it.

### Attack C3: Phantom spending

I claim that Player B spent 3 coins on a Move on my board. My chain records
this spend. B never requested that Move. But my chain is authoritative, and
the Move entry is signed by ME (the board owner signs all entries). B cannot
contest the deduction from their balance on my chain.

V2 says "All entries are signed by the board owner." It does NOT say Move-
spending entries must be co-signed by the spender. This is a critical gap.

### Assessment

This is the central architectural vulnerability of v2. The per-board sovereignty
that defeats Sybils creates a dictator who can defraud individual participants.
The protocol provides evidence (signed share/trade records) but no enforcement.

The severity is critical because it affects every cross-player interaction:
every grant, every trade, every timestamped Move.

### Mitigations

1. **Co-signatures on all balance-affecting operations.** Every ledger entry
   that changes another player's balance (grant, trade, spend) must be
   co-signed by the affected player. This means:
   - Grants: signed by both parties (already covered by share event signature,
     IF the signature covers specific amounts).
   - Trades: signed by both parties (already specified).
   - Spends: signed by the spender, not just the board owner.
   The board owner can still refuse to RECORD the entry, but cannot fabricate
   entries affecting others.

2. **Specify what share/trade signatures cover.** The protocol must mandate
   that the mutually-signed record includes: exact coin amounts granted to
   each party, exact coins traded in each direction, tick range of the shared
   simulation. Without this, the signatures are meaningless for dispute
   resolution.

3. **Cross-chain receipts.** After a share/trade, each party records a receipt
   on their OWN chain referencing the other party's chain. This creates a
   verifiable cross-reference. If my chain says "I traded 5 coins to B on
   Board A" and Board A's chain has no record of this, the discrepancy is
   publicly detectable.

4. **Accept sovereign risk.** Document explicitly: "Coins on another player's
   board are held at the board owner's discretion. The owner can defraud you.
   Your only recourse is reputation." This is honest but may limit adoption.

---

## Attack D: Timestamp Griefing and Move Denial

**Severity: MEDIUM**

### The scenario

I buy coins on your board via trading during a share event. I now have 10 coins
on your board. I request Moves: I want to write garbage to your board (wipe
cells, overwrite organisms, inject hostile code).

You are the timestamper. You can see my Move before applying it. You refuse.

### Is refusing a protocol violation?

V2 says timestamping is optional ("Most players won't offer this"). It says
you "may optionally offer to timestamp other players' Moves." The word
"optionally" applies to offering the service at all, not to individual Moves.

But once you have accepted coins for timestamping (or the player earned coins
via grants), can you refuse to execute their Moves?

V2 does not say. Two interpretations:

1. **Owner sovereignty:** The owner can refuse any Move for any reason. Coins
   are a necessary but not sufficient condition for a Move. This is consistent
   with v2's "board owner controls everything" philosophy.

2. **Contractual obligation:** If someone has coins on your board, they have a
   right to spend them on Moves. Refusing to timestamp their Moves is theft
   (they paid for a service you refuse to deliver).

### The destructive Move problem

Even under interpretation 2, there is a real tension. Suppose I have coins on
your board and I request a Move that writes 0xFF to every cell (total wipe).
This is a legitimate Move -- the protocol does not define "valid" vs "invalid"
Move content. Should you be forced to execute it?

If yes: any player with coins on your board can destroy it. Coins become
weapons.

If no: the owner has arbitrary censorship power over Moves, which makes coins
less valuable (you might not be able to spend them).

### Assessment

This is a fundamental design tension, not a bug. V2 must choose: either coins
buy unconditional Move rights (which weaponizes them) or the owner retains
veto power (which makes coins unreliable). Both have game-theoretic
consequences.

### Mitigations

1. **Explicit owner veto.** State clearly: "The board owner may refuse any
   Move request. Coins are a prerequisite, not a guarantee." Players
   understand the risk before acquiring coins.
2. **Move classes.** Define a set of "standard Moves" that the owner commits
   to honoring (e.g., writes only to specific cells, bounded in scope). Moves
   outside this class can be rejected. This creates a contract.
3. **Escrow.** Coins spent on Moves are held in escrow until the Move is
   confirmed. If the owner refuses, the coins are returned. This requires
   a mechanism for "returning" coins, which v2 does not have.
4. **Rate limiting, not censorship.** The owner cannot refuse Moves but can
   rate-limit them (e.g., max 1 Move per N ticks per player). This bounds
   destructive impact.

---

## Attack E: Grant Gaming -- The Share-and-Run Strategy

**Severity: MEDIUM**

### The attack

V2 says: "During a share, your partner earns coins on your board (and vice
versa)." The Grant operation.

Questions the protocol does not answer:
- How many coins does each party earn?
- Is it automatic (fixed rate) or negotiated?
- Is it proportional to the duration of the shared simulation?

### If grants are automatic (e.g., 1 coin per share event):

I share with 100 partners in rapid succession. Minimum viable shares: merge
boards, simulate 1 tick, split, sign. Each share earns me 1 coin on my
partner's board. In 100 shares, I have 1 coin on 100 different boards.

These coins are individually worth little (1 coin = 1 Move, maybe), but the
strategy scales. I am accumulating options on many boards without providing
meaningful simulation time.

### If grants are proportional to shared simulation duration:

The incentive flips: longer shares produce more coins. But then the attacker
shares with one partner for a very long duration, earning many coins on that
specific board. The partner earns many coins on the attacker's board (which
may be worthless). Asymmetric value extraction.

### If grants are negotiated:

Each party agrees on the grant amount. This is the most flexible but hardest
to exploit -- and hardest to abuse, since either party can refuse. The failure
mode: a powerful player demands unfavorable terms from a weaker player ("share
with me or I won't share with you at all").

### Assessment

The protocol underspecifies the Grant mechanism. Any of the three models has
exploitable properties. The severity is medium because exploitation is bounded
by the need for real partners and the per-board nature of coins.

### Mitigations

1. **Specify the grant formula.** Tie grants to the duration of the shared
   simulation: `coins_granted = floor(shared_ticks / T_coin)`. This makes
   grants proportional to actual shared computation and uses the same minting
   rate as solo simulation.
2. **Minimum share duration.** Require a minimum number of ticks for a share
   event to produce grants. This prevents share-and-run.
3. **Symmetric grants.** Both parties earn at the same rate. The asymmetry is
   only in the value of the respective boards' coins, which is determined by
   demand.

---

## Attack F: Double-Spend via Absent Ledger Owner

**Severity: HIGH**

### The attack

I have 5 coins on Board A (owned by Alice). I share with Player C. During the
share event with C, I trade 3 of my Board-A-coins to C in exchange for 3 of
C's-board-coins. C and I both sign this trade.

But Alice (Board A's owner) was not present. Board A's chain has not been
updated. My balance on Board A's chain is still 5.

Now I share with Player D. I trade the same 3 Board-A-coins to D. D and I
sign this trade.

I have now "spent" 3 Board-A-coins twice (to C and to D). Total spent: 6.
Balance on Board A's chain: 5. When Alice's chain finally records these trades,
one of them must fail.

### The core problem

V2 says: "Coins on your board can only be recorded on your chain." But trades
of those coins happen between third parties WITHOUT the board owner present.

How does Alice's chain learn about the trade between me and C? Three
possibilities:

1. **The trading parties notify Alice.** After the share event, C or I send
   the signed trade record to Alice, who updates her chain. But if I am the
   double-spender, I have no incentive to notify Alice promptly. C might
   notify Alice, but C might not know Alice (C just accepted Board-A-coins
   without verifying my balance in real time).

2. **Balance checks require querying the board chain.** Before accepting
   Board-A-coins, C queries Board A's chain to verify my balance. This
   requires Alice's chain to be accessible (Alice must be online) and
   up-to-date. In a mobile-first p2p protocol, this is a strong assumption.

3. **Trades are invalid until recorded on the board chain.** The trade is
   "pending" until Alice records it. C does not consider the Board-A-coins
   received until Board A's chain confirms. This is safe but makes trading
   slow and requires Alice's cooperation.

V2 does not specify which model applies. This is a critical omission.

### Assessment

This is a classic double-spend problem. Every multi-ledger accounting system
must solve it. V2 does not address it. The severity is high because it
undermines the fundamental reliability of the trade operation.

### Mitigations

1. **Real-time balance verification.** Before accepting Board-X-coins in a
   trade, require the recipient to verify the sender's balance on Board X's
   chain. This requires the board chain to be accessible during the trade.

2. **Board owner as trade co-signer.** All trades involving Board-A-coins
   require Alice's co-signature. Alice verifies the sender's balance before
   signing. This prevents double-spends but requires Alice to be online during
   every trade of her coins.

3. **Nonce-based spending.** Each coin has a unique serial number (or each
   spend has a monotonic nonce). The board chain rejects spends with
   duplicate serials or out-of-order nonces. The recipient verifies the nonce
   is valid before accepting the trade.

4. **Accept eventual consistency.** Document that trades are not finalized
   until the board chain records them. The first trade to be recorded wins.
   Late arrivals are rejected. Players bear the risk of accepting unconfirmed
   coins.

---

## Attack G: Trade Fairness and Information Asymmetry

**Severity: LOW**

### The issue

V2 says: "The exchange rate is negotiated between players." There is no
market, no order book, no price discovery mechanism.

### The exploitation

An experienced player knows which boards are popular and which are dead. A
new player does not. The experienced player offers a trade: "I'll give you 10
of my Popular-Board-coins for 100 of your Niche-Board-coins." The new player,
not knowing the relative values, accepts.

### Why this is low severity

1. **Bilateral negotiation is a feature, not a bug.** V2 explicitly says
   exchange rates are not protocol-defined. This is a deliberate design
   choice.

2. **Information asymmetry exists in all markets.** The protocol cannot
   prevent bad trades any more than a flea market can.

3. **Per-board coins are inherently illiquid.** There is no fungibility
   across boards. Each trade is bespoke. Expecting market efficiency in
   this context is unrealistic.

4. **The stakes are low.** These are coins for making Moves in a cellular
   automaton simulation, not financial instruments.

### Mitigations (optional, policy-layer)

1. **Public trade history.** If chains are public, anyone can see past trades
   and infer approximate exchange rates.
2. **Client-side warnings.** The app could show recent trade rates for
   comparable boards and warn if a proposed trade is far outside the norm.

---

## Attack H: The Protocol Is Just Sovereign Accounting -- Known Failure Modes

**Severity: INFORMATIONAL**

### The observation

V2 is isomorphic to a **multi-issuer mutual credit system**. Each board owner
issues their own currency. Trade between currencies is bilateral. There is no
central bank, no clearing house, no lender of last resort.

Known analogues:
- **Hawala networks:** Informal value transfer based on bilateral trust between
  brokers. Same structure: each broker maintains their own ledger, cross-broker
  settlement is bilateral.
- **LETS (Local Exchange Trading Systems):** Community currencies where each
  participant can issue credit. Known failure mode: participants accumulate
  large negative balances and then leave the system.
- **Ripple (original, pre-XRP):** Trust lines between users defining bilateral
  credit limits. Transaction routing finds paths through the trust graph.

### Known failure modes of these systems

1. **Exit scam.** A board owner accumulates coins on other boards (via trades),
   then abandons their own board. Their counterparties hold worthless
   board-coins. This is not preventable in a sovereign system.

2. **Liquidity fragmentation.** With N boards, there are O(N^2) possible
   currency pairs. Most pairs have zero liquidity. Meaningful exchange is
   limited to boards that have directly shared. There is no transitive payment
   routing (unlike Ripple).

3. **Concentration of influence.** Popular boards attract many share partners
   and become hubs. Their coins are more liquid (tradeable with more
   counterparties). This creates a de facto hierarchy even without a formal
   reputation system. The hub board owner has outsized influence.

4. **No recourse for disputes.** Sovereign ledgers mean there is no arbiter.
   Every dispute is "your word against mine." The signed records provide
   evidence but no enforcement.

### Assessment

These are structural properties of the architecture, not bugs. V2 has chosen
sovereignty over safety. This is a legitimate design choice, but users should
understand the tradeoffs.

---

## Summary of V2-Specific Severity Ratings

| # | Attack | Severity | Core Problem |
|---|--------|----------|--------------|
| A | Parasitic sharing (fake interesting board) | MEDIUM | "Worthless coins" argument has a hole via organism copying |
| B | Fast-forward minting | HIGH | No real-time enforcement, T_coin unspecified |
| C | Ledger authority (sovereign dictator) | CRITICAL | Board owner can rewrite history, fabricate spends, deny grants |
| D | Timestamp griefing / Move denial | MEDIUM | Tension between owner sovereignty and coin-holder rights |
| E | Grant gaming (share-and-run) | MEDIUM | Grant mechanism underspecified |
| F | Double-spend via absent ledger owner | HIGH | Trades happen without the board owner, no reconciliation protocol |
| G | Trade fairness | LOW | Information asymmetry, but by design |
| H | Sovereign accounting failure modes | INFORMATIONAL | Known structural properties of multi-issuer credit systems |

---

## V2 vs V1: Net Assessment

V2 is a dramatically simpler protocol than v1. It eliminates the global score
formula, PageRank, challenge protocols, and social multipliers that were the
source of most v1 vulnerabilities. The per-board currency model is an elegant
Sybil defense: creating fake boards creates fake currencies that nobody values.

However, v2 trades global-system attacks for **per-interaction attacks**. The
board owner's absolute authority over their chain is both the core strength
(sovereignty, simplicity, no coordination overhead) and the core weakness
(no recourse against a malicious owner).

The most critical gap is **Attack C** (ledger authority): the protocol does not
specify what signatures cover, does not require co-signatures on balance-
affecting operations, and does not provide any mechanism for dispute resolution
when a board owner rewrites their chain.

The second most critical gap is **Attack F** (double-spend): the protocol
does not specify how trades are reconciled with the authoritative board chain
when the board owner is absent during the trade.

### Recommended Priority Order for V2 Fixes

1. **Specify signature coverage (Attack C).** Define exactly what the mutual
   signatures on share events and trades cover: tick ranges, coin amounts
   granted, coins traded in each direction. Without this, the signatures
   provide no evidentiary value.

2. **Require co-signatures on all balance mutations (Attack C).** Spends must
   be signed by the spender. Grants and trades are already bilaterally signed
   (if the signature coverage is defined). Fabricated ledger entries become
   detectable.

3. **Define trade reconciliation (Attack F).** Specify how trades of Board-X-
   coins are communicated to Board X's chain. Options: require Board X owner
   as co-signer, or require real-time balance checks, or accept eventual
   consistency with clear rules for conflict resolution.

4. **Fix T_coin (Attack B).** Specify whether T_coin is global or per-board.
   If per-board, document that boards with low T_coin produce inflationary
   currencies that rational partners should discount.

5. **Specify the grant formula (Attack E).** Tie grants to shared simulation
   duration. Require a minimum share duration. Make grants symmetric.

6. **Document owner sovereignty explicitly (Attacks C, D).** Be transparent:
   "Your coins on another player's board are held at their discretion."
   Users should understand this before interacting.
