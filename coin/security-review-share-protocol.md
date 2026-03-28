# Security Review: Share Protocol (Cell Exchange)
# Date: 2026-03-27

## Summary

This review analyzes the 2-party cell exchange protocol defined across `share.js`, `share-protocol.js`, `social-session.js`, `session.js`, and `merkle.js`. The protocol as described in the user's specification has a significant gap between the **described** multi-message protocol (PROPOSE/ACCEPT/COMMIT) and the **implemented** protocol, which is a single-function atomic local swap (`executeShare` in `share.js`). The implementation sidesteps most of the described attack vectors by being a trusted local operation rather than a network protocol. This review analyzes both: the described protocol as a hypothetical network protocol, and the actual implementation for what it does today.

**Critical finding**: The described protocol has a fundamental fairness vulnerability (Attack #2 / #7) that cannot be fixed without either a trusted third party, a cryptographic commitment scheme, or a simultaneous-exchange protocol. The current implementation avoids this by running both sides locally.

---

## Attack Analysis

### 1. Bail after ACCEPT (step 2)

**Severity: 1/5**
**Feasibility: Trivial**
**Impact: Negligible**

Alice proposes, Bob accepts, then neither sends COMMIT. No cell data or signatures have been exchanged. Alice loses nothing except the time spent waiting. Bob learns Alice's board state hash and which cells she wanted to trade, which is mild information leakage but not exploitable.

**Mitigation**: Add a timeout after ACCEPT. If no COMMIT arrives within T seconds, the negotiation expires. The board state hashes are already public-ish (they are in the session log), so leaking them is low-risk.

---

### 2. Bail after one COMMIT (step 4) -- THE CRITICAL VULNERABILITY

**Severity: 5/5**
**Feasibility: Trivial**
**Impact: Protocol-breaking**

This is the fundamental problem with any non-atomic 2-party exchange. Alice sends COMMIT containing her signature AND her cell data. Bob now has:

1. **Alice's actual cell data** -- he can inspect the cells, learn their code, and decide whether to complete the trade.
2. **Alice's signature on the attestation** -- this proves Alice agreed to the trade.

Bob can now:
- **Option A**: Ghost Alice. Keep the knowledge of her cell data (he can study the code) without giving his own cells. Alice gets nothing.
- **Option B**: Selectively complete. Only finish trades where Alice's cells are valuable. This creates an options market where Bob has a free call option on every trade.
- **Option C**: More subtly, Bob has Alice's signature on an attestation that covers specific cell hashes. If Bob later fabricates a share record claiming the trade happened, he has Alice's signature to prove it. However, he does NOT have his own cell data hashed into the attestation, so a verifier checking Bob's session log would see that Bob never provided a counter-signature. This limits the damage but does not eliminate it.

**What Bob CANNOT do**: Bob cannot forge a complete share record because the attestation requires cell hashes from BOTH sides, and a valid share log entry requires the counterparty's signature. Without Bob's own COMMIT, Alice's log will not contain a share entry, and neither will Bob's (if he's honest about his log). But Bob is the adversary here -- he can write anything to his own log.

**The real damage**: Bob gets Alice's cells for free. In a game about self-replicating programs, inspecting another player's cell code is the primary value of a trade. Even if Bob doesn't apply the cells to his board, he has learned the programs.

**Mitigation (required)**:
- **Hash-commit-reveal**: Both parties first exchange `COMMIT_HASH = SHA-256(signature || cellData)` simultaneously. Only after both commit-hashes are received do they reveal. If either party fails to reveal, the other knows they were cheated but no data was leaked.
- **Cut-and-choose**: Not applicable here since cells are not fungible.
- **Trusted mediator**: A third-party escrow holds both COMMITs and releases simultaneously. This conflicts with the peer-to-peer design.
- **Timed hash-lock (HTLC-style)**: Each party locks their cells behind a hash-lock. Both reveal the preimage or neither does. Requires a penalty mechanism.

---

### 3. Replay attack

**Severity: 2/5**
**Feasibility: Low (with current design)**
**Impact: Limited**

Bob takes Alice's COMMIT from a previous share and replays it. The attestation contains:
- `boardAHash`: Alice's board state hash at the time of the original share
- `boardBHash`: Bob's board state hash at the time of the original share
- `tick`: the tick at which the share occurred
- Cell hashes from both sides

For the replay to succeed, ALL of these would need to match the new context:
- Alice's board would need to be in the exact same state (same hash) -- astronomically unlikely after any simulation steps
- Bob's board would need to be in the same state
- The tick would need to match

**However**, there is a gap: the attestation does not contain a **nonce** or **session ID**. If Alice happens to propose a share at the same tick with the same board state (e.g., she reset her board), a replay could theoretically succeed.

**Mitigation**: Add a random nonce to the attestation. This is cheap and eliminates the attack entirely. The current `attestationString` function in `share.js` (line 46) does not include any nonce.

---

### 4. Board state manipulation (TOCTOU)

**Severity: 3/5**
**Feasibility: Moderate**
**Impact: Moderate -- the counterparty receives stale/incorrect cells**

Between PROPOSE (which snapshots Alice's board hash) and COMMIT (which sends actual cell data), Alice's board continues to evolve. The cells Bob receives may not match what was advertised.

In the actual implementation (`share.js` line 65-122), the board hash is computed AND cells are read in the same synchronous function call, so there is no TOCTOU gap. But in the described network protocol:

1. Alice hashes her board at PROPOSE time
2. Her board evolves
3. At COMMIT time, she reads (now-different) cells and sends them
4. The cell hashes in the attestation were computed at PROPOSE time and don't match the actual data

**The attestation catches this**: The attestation includes cell hashes. If Alice sends cells whose hashes don't match the attestation she signed, Bob can detect the mismatch using `verifyShareInput` (line 128). But the protocol as described computes the attestation at step 3, AFTER both parties have agreed but BEFORE cells are sent. The question is: are the cell hashes in the attestation computed from the PROPOSE-time snapshot or the COMMIT-time data?

Looking at the code, `executeShare` hashes the cells at execution time (lines 71-80) and builds the attestation from those hashes (lines 83-89). In a network protocol, the parties would need to agree: hash the cells at attestation-computation time, then verify the COMMIT data matches those hashes.

**Mitigation**: The attestation must be computed from a frozen snapshot. Either:
- Pause the board between PROPOSE and COMMIT (undesirable for gameplay)
- Include cell data hashes in the PROPOSE message, and the counterparty verifies COMMIT data against those hashes
- Accept that cells may drift and treat the attestation as binding on whatever data is actually sent (compute hashes at COMMIT time, not PROPOSE time)

---

### 5. Selective history (rewind attack)

**Severity: 4/5**
**Feasibility: Moderate**
**Impact: High -- breaks the integrity of the history model**

Bob completes a share, receives Alice's cells, but then rewinds his board to a checkpoint before the share. His Merkle tree and session log no longer contain the share event. He has:
- Learned Alice's cell code (information cannot be un-learned)
- His board is in a state where the share never happened
- Alice's board DOES contain the share

**What stops this?** The dual-witness model in `social-session.js` is the primary defense. If both parties sign each other's blocks, Bob cannot rewind without invalidating his witness signatures. But this only works if Alice retains Bob's signed blocks and can present them to a verifier.

**The gap**: The share protocol in `share.js` does NOT use the dual-witness signing from `social-session.js`. It produces `inputA` and `inputB` records (lines 100-119) but these are unsigned. There is no `counterpartySignature` field despite the user's description claiming one exists. The `attestation` object has no signatures at all -- it is just a data structure.

This is a significant discrepancy between the described protocol and the implementation:
- **Described**: "Each board's session log records: { ..., counterpartySignature }"
- **Implemented**: The input event contains `attestation` but no signatures

Without signatures, Bob can freely rewrite history. Even the Merkle tree (which commits to state hashes) only proves what Bob claims his state was -- it doesn't prove what inputs he received.

**Mitigation**:
- The share input events MUST include the counterparty's signature on the attestation
- Alice must retain Bob's signature as proof the share occurred
- Any verifier checking Alice's history can see: "Alice claims she received cells from Bob, and here is Bob's signature confirming it"
- Bob cannot deny the share without denying his own signature

---

### 6. Sybil shares

**Severity: 3/5**
**Feasibility: Trivial**
**Impact: Depends on what social proof buys you**

Alice creates board A and board B, both under her control. She executes a share between them. The attestation is valid, the cell hashes match, both "parties" sign. If shares earn coins at an accelerated rate (as suggested by `isSharing` in `session.js` line 54 and the social rate in `economics.js`), Alice earns extra coins for free.

**What makes this hard to detect?**
- Both boards have valid histories
- The share is cryptographically valid
- There is no identity system linking boards to humans

**What makes this somewhat detectable?**
- If the two boards share a keypair, that's a giveaway (but Alice can generate different keys)
- Network-level analysis: if both boards are always on the same IP, that's suspicious
- The social session model in `social-session.js` requires simultaneous operation of both engines, which is computationally expensive (double the work)

**Mitigation**:
- Make shares more valuable when the counterparty's board has a long independent history with diverse interactions
- Require proof-of-work on each board independently before shares are valid
- Rate-limit shares per board (already somewhat handled by the coin economics)
- Accept that Sybil attacks are the cost of a permissionless system and design the economics so that self-sharing provides marginal benefit (the `isSharing` bonus should be small relative to the cost of running two boards)

---

### 7. Timing manipulation (asymmetric risk)

**Severity: 5/5 (in network protocol) / 1/5 (in current implementation)**
**Feasibility: Trivial in network protocol**
**Impact: Equivalent to Attack #2**

The protocol as described is NOT symmetric in timing risk. The sequence is:
1. Alice sends COMMIT first (step 4)
2. Bob inspects Alice's cells
3. Bob decides whether to send his COMMIT (step 5)

This gives Bob a strict informational advantage. He sees Alice's cells before committing his own. This is exactly the free-option problem from Attack #2.

**Is there anything in the protocol that determines who goes first?** No. The protocol description says both COMMITs are steps 4 and 5, but doesn't specify ordering or simultaneity.

**In the implementation**: `executeShare` in `share.js` is a synchronous function that reads both boards and swaps atomically. There is no timing asymmetry because there is no network.

**Mitigation**: Same as Attack #2 -- hash-commit-reveal. The protocol MUST be:
1. Both parties compute `COMMIT_HASH = SHA-256(cellData)`
2. Both exchange COMMIT_HASHes simultaneously (or within a timeout window)
3. Both reveal cellData
4. Both verify cellData matches COMMIT_HASH
5. If either fails to reveal, the trade is void (but no data was leaked since only hashes were exchanged)

---

### 8. Simultaneous vs sequential COMMITs

**Severity: 2/5 (protocol design question, not an attack)**

**Simultaneous**: Both COMMITs arrive "at the same time." In practice, on a network, truly simultaneous delivery is impossible. You need to define a commitment window: both COMMITs must arrive within T seconds or the trade is void.

**Sequential**: Whoever goes first is disadvantaged (see Attack #7). The second party has the free-option advantage.

**The implementation avoids this entirely**: `executeShare` is atomic. Both reads and writes happen in a single synchronous function call.

**For a network protocol**: The hash-commit-reveal approach from the mitigation of Attack #2/#7 makes this a non-issue. The commit phase (exchanging hashes) can be sequential without risk because no data is leaked. The reveal phase can also be sequential because the commitment is already locked.

---

### 9. Attestation forgery

**Severity: 2/5**
**Feasibility: Computationally infeasible (assuming SHA-256)**

Can the attestation be forged if one party knows both board hashes but not the cell data?

The attestation (line 46 of `share.js`) is `JSON.stringify({boardAHash, boardBHash, cellsFromA, cellsFromB, tick})`. The cell entries include `{i, j, hash}` where `hash` is `SHA-256(cellData)`.

If the attacker knows both board hashes but not the cell data, they cannot compute the cell hashes (SHA-256 preimage resistance). They could:
- Guess cell hashes: 2^256 possibilities per cell, infeasible
- Use zero-hashes: detectable since the attestation would contain hashes of all-zero cells, which is unlikely to match real cells

**However**, there is a subtlety: the attestation is the `attestationString` (a JSON string), not its hash. The protocol description says "attestation = SHA-256(aliceBoard, bobBoard, hash(alice_cells), hash(bob_cells), tick)" but the implementation does NOT hash the attestation -- it uses the raw JSON string for signing. This means the attestation string itself is the signed content, and forging it requires forging cell hashes, which requires breaking SHA-256.

**Mitigation**: The current design is sound against this attack. No changes needed.

---

### 10. Atomicity (can the exchange be made atomic?)

**Severity: N/A (design question)**

Can both parties get cells or neither does, with no intermediate state where one party has cells and the other doesn't?

**In the current implementation**: YES. `executeShare` is already atomic -- it runs synchronously in a single process, reads both boards, writes both boards.

**In a network protocol**: This is the classic fair exchange problem, which is provably impossible without either:
1. A trusted third party (escrow)
2. A blockchain/smart contract (programmable escrow)
3. Gradual release (exchange cells bit-by-bit, so the advantage of defecting at any point is small)
4. Optimistic protocols with penalties (assume honesty, punish cheaters after the fact)

**Recommended approach for this game**: Given that this is a game (not a financial system), I recommend **option 4: optimistic with reputation**:
- Complete the swap optimistically (both send cells)
- Record the swap in both session logs with dual signatures
- If one party defects, the other publishes proof of defection (they have the signed attestation)
- Defectors lose reputation, making future trades harder

This matches the existing social-session model where dual-witness signatures create accountability.

---

## Cross-Cutting Issues

### A. Missing signatures in share.js

The most critical gap between the described protocol and the implementation: `share.js` produces attestation objects and input events but NO signatures. The `inputA` and `inputB` objects (lines 100-119) contain the attestation but not:
- Alice's signature
- Bob's signature
- Any proof that the counterparty agreed

The `social-session.js` module has a full Ed25519 signing infrastructure, but it is used for block-level dual-witness signing, not for individual share attestations. These two systems are not connected.

**Recommendation**: Either:
1. Sign the attestation string with both parties' keys and include signatures in the input events, OR
2. Ensure that shares only occur within social sessions where the dual-witness block signatures cover the share inputs (since inputs are included in blocks)

Option 2 is simpler and appears to be the intended design -- but it should be explicitly documented and enforced.

### B. No nonce in attestation

The attestation (`attestationString` in `share.js` line 46) contains `{boardAHash, boardBHash, cellsFromA, cellsFromB, tick}` but no random nonce. While replay is unlikely due to board hash uniqueness, a nonce is cheap insurance.

### C. Tick ambiguity

The attestation contains a single `tick` field, but boards A and B may be at different ticks. In `social-session.js`, engines are stepped in lockstep, but in a network protocol, there is no guarantee that both boards are at the same tick. The attestation should include `tickA` and `tickB` separately.

Looking at the implementation: `executeShare` takes a single `tick` parameter (line 65), and it's the caller's responsibility to pass the correct value. There is no verification that this tick matches either engine's actual clock.

### D. Cell data read twice (minor correctness issue)

In `share.js` lines 71-80, `readCellMemory` is called TWICE per cell -- once for data, once for hashing:
```js
data: readCellMemory(engineA.controller, i, j),
hash: hashCell(readCellMemory(engineA.controller, i, j)),
```

If the board is being mutated concurrently (which it isn't currently, but could be in a future async design), the two reads could return different data. The hash would not match the data. Should read once and hash the result.

### E. verifyShareInput has a logic gap

In `share.js` line 138:
```js
const sourceKey = input.action.sourceBoard === att.boardAHash ? 'cellsFromA' : 'cellsFromB';
```

This determines which attestation cells to check by comparing `sourceBoard` to `boardAHash`. But `sourceBoard` is set by the code that created the input (lines 106, 116) -- it's the OTHER board's hash. So for `inputA` (Alice's record), `sourceBoard` is `boardBHash`, which means `sourceKey` would be `'cellsFromB'`. This is correct: Alice received cells from B, and those cells should match `cellsFromB` in the attestation.

But what if an attacker crafts an input where `sourceBoard` does not match either hash in the attestation? The code falls through to `'cellsFromB'` (the else branch), which may or may not contain the right cells. There is no validation that `sourceBoard` is actually one of the two board hashes in the attestation.

### F. JSON.stringify for canonical serialization

Both `share.js` and `social-session.js` use `JSON.stringify` with manually-ordered object keys for canonical serialization. This is fragile:
- JavaScript engines are not required to preserve object key insertion order for integer-like keys
- The `sortObj` function in `social-session.js` sorts keys but `attestationString` in `share.js` does NOT sort keys -- it relies on insertion order
- Different JavaScript engines or versions could produce different JSON strings for the same logical object

This is not an attack vector per se, but it could cause spurious verification failures across different platforms.

---

## Summary Table

| Attack | Severity | Feasibility | Status |
|--------|----------|-------------|--------|
| 1. Bail after ACCEPT | 1/5 | Trivial | Low impact, add timeout |
| 2. Bail after COMMIT | **5/5** | Trivial | **Protocol-breaking**, needs hash-commit-reveal |
| 3. Replay | 2/5 | Low | Add nonce to attestation |
| 4. TOCTOU state drift | 3/5 | Moderate | Freeze snapshot or hash at COMMIT time |
| 5. History rewind | **4/5** | Moderate | **Signatures missing from share inputs** |
| 6. Sybil shares | 3/5 | Trivial | Economic design problem, not crypto problem |
| 7. Timing asymmetry | **5/5** | Trivial | **Same root cause as #2**, needs commit-reveal |
| 8. Simultaneous vs sequential | 2/5 | N/A | Design question, solved by commit-reveal |
| 9. Attestation forgery | 2/5 | Infeasible | SHA-256 preimage resistance is sufficient |
| 10. Atomicity | N/A | N/A | Impossible on network without TTP; current impl is atomic |

## Priority Recommendations

1. **[CRITICAL]** Implement hash-commit-reveal for the network protocol (fixes #2, #7, #8)
2. **[HIGH]** Add signatures to share input events, or ensure shares only occur within dual-witness sessions (fixes #5)
3. **[MEDIUM]** Add a random nonce to the attestation (fixes #3)
4. **[MEDIUM]** Validate `sourceBoard` in `verifyShareInput` (fixes #E)
5. **[LOW]** Fix double `readCellMemory` call (fixes #D)
6. **[LOW]** Use sorted keys in `attestationString` for cross-platform safety (fixes #F)
