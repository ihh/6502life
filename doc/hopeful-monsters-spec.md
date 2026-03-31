# Hopeful Monsters: Spec for the Replicator Candidate Expert System

## Overview

A desktop client generates ~1 candidate replicator per day by
brute-forcing ChaCha20 seeds against a relaxed DFA pattern matcher.
Each candidate is a "hopeful monster" — a byte sequence that *looks
like* a replicator but may fail for any of several known reasons.

An expert system runs a cascade of increasingly expensive simulation
tests, diagnoses the failure mode, and produces a narrative report.
Over ~2000 candidates (~6 years), one is expected to be genuinely
viable. The narrative should sustain player interest across the journey.

## DFA Design

### Core pattern (strict, B_eff ≈ 55)

```
B5 NN 9D NN 04 (E8|CA) (90|B0) offset
```

where NN matches between bytes 1 and 3, the branch opcode matches the
flag state, and offset loops back exactly.

### Relaxed pattern (B_eff ≈ 42, ~2000× more candidates)

Relaxations (each ~1 bit):

| ID | Relaxation | Bits freed | Failure mode |
|----|-----------|-----------|--------------|
| R1 | NN mismatch (byte 1 ≠ byte 3) | 8 | Rotated copy |
| R2 | Flag state unknown | 1 | Branch falls through |
| R3 | All 7 branch opcodes (not just BCC/BCS) | ~2 | Z/N flag corruption |
| R4 | Branch offset ±2 (not exact) | ~1-2 | Lands on NOP or wrong instruction |
| R5 | Risky opcodes in NOP slides | ~2-3 | Register/memory corruption |
| R6 | Leading slide up to 8 bytes | ~0.5 | Entry point shift |
| R7 | Destination page ≠ $04 | ~3 | Copies to self or void |

The relaxed DFA accepts the union of patterns with any combination
of these relaxations. Total bits freed: ~11, giving B_eff ≈ 42.

### DFA sampling (for testing)

To test the expert system, we need unbiased samples from the DFA's
accepted language. Method:

1. Build the DFA as a state machine with byte-level transitions.
2. For each state s and remaining length n, precompute
   `count[s][n]` = number of accepting paths of length n from s.
   Recurrence: `count[s][n] = sum over (s→s') of count[s'][n-1]`.
3. To sample: start at initial state, n = pattern length.
   At each step, choose next byte b by sampling transition s→s'
   proportional to `count[s'][n-1]`. Emit b, advance to s', n--.
4. This yields a uniform sample over all accepted strings of
   length n. Pad remaining cell bytes with uniform random.

This is exact (not rejection sampling) and efficient: one DFA
traversal per sample. Precomputation is O(|states| × max_length).

### DFA state structure

```
States: S0 (init/slide), S1 (seen LDA), S2 (seen addr1),
        S3 (slide2), S4 (seen STA), S5 (seen addr2), S6 (seen $04),
        S7 (slide3), S8 (seen INC), S9 (slide4),
        S10 (seen branch), S11 (accept)

Transitions at each state include:
  - The required core byte(s) → advance to next state
  - Tolerable slide bytes → stay in current state
  - In relaxed mode: "risky" bytes → stay with flag set

Each state carries annotation bits:
  - addr1_value (byte 1)
  - addr_match (byte 3 == byte 1?)
  - branch_type (which opcode)
  - slide_lengths[4] (NOPs at each point)
  - risky_flags (which risky opcodes were encountered)
```

## Test Cascade

Each test is cheaper than the next. Fail early, report cheaply.

### Test 0: Static Analysis (instant)

Input: The matched byte sequence + DFA annotations.

Checks (no simulation):
- Which relaxations are active (R1-R7)?
- Is the branch offset correct for the actual code length?
- Does the NOP slide contain known-dangerous opcodes?
- If R1 (offset mismatch): what's the rotation amount?

Output: A `relaxation_set` and `risk_score` (0-10).

Narrative role: Classify the candidate. "This one uses BCS with
a DEX loop and 3 bytes of preamble..."

### Test 1: Single-Quantum Execution (microseconds)

Setup: Place candidate in cell (0,0) of a 2×2 board. Neighbor
is all zeros. Run 1 quantum (~4096 cycles).

Checks:
- Did PC loop back to (approximately) the start?
- Did the code write to the neighbor's page 0?
- How many bytes were written?
- Are the written bytes a copy of the source?

Failure modes:
- **T1a: No loop** — PC ran off into zeros/BRKs. Branch failed.
  Cause: wrong flag state (R2) or offset (R4).
- **T1b: No writes** — STA didn't execute or targeted wrong address.
  Cause: A was corrupted (R5) or destination page wrong (R7).
- **T1c: Partial copy** — some bytes copied, loop broke partway.
  Cause: mid-slide corruption, branch flag toggled.

Output: `{looped: bool, bytes_written: int, copy_fidelity: float}`

Narrative role: The first real test. Most R2/R4/R7 failures die here.
"Candidate ran for 342 instructions before veering off at byte $1A..."

### Test 2: Copy Fidelity (microseconds)

Precondition: Test 1 passed (some bytes written, PC looped).

Checks:
- Do the written bytes in the neighbor match the source cell?
- If R1 active: is the copy a rotation of the source?
- Specifically: do the CRITICAL bytes (the replicator pattern
  itself) appear intact in the neighbor?

Failure modes:
- **T2a: Garbled copy** — bytes don't match source at all.
  Cause: A corrupted between LDA and STA (R5 slide opcodes).
- **T2b: Rotated copy** — copy is shifted by NN bytes.
  Cause: byte 1 ≠ byte 3 (R1). The copy IS faithful, just
  rotated. Self-replication fails unless the rotation is 0 mod
  code_length (extremely unlikely).
- **T2c: Mostly faithful** — copy matches except a few bytes.
  Cause: a risky opcode in the slide occasionally fires.
  Interesting case — might still work probabilistically!

Output: `{fidelity: float, rotation: int, corrupted_offsets: [int]}`

Narrative role: "The copy is perfect except byte $0A — a rogue
SEC in the preamble set the carry flag, and the ADC at offset 3
added 1 to every copied byte..."

### Test 3: Second-Generation Copy (microseconds)

Precondition: Test 2 passed (high-fidelity copy).

Setup: Extract the neighbor's code. Place it in a fresh cell.
Run 1 quantum. Check if IT also copies faithfully.

Checks:
- Does the copy produce a faithful copy of itself?
- Is the second-generation copy identical to the first-generation?

Failure modes:
- **T3a: Copy doesn't run** — the copy's entry point is wrong.
  Cause: rotation (R1) means code doesn't start at byte 0.
- **T3b: Copy runs but doesn't copy** — branch offset is wrong
  in the copied version (because the code length changed).
- **T3c: Drift** — each generation introduces small changes.
  The replicator "works" but accumulates errors. Interesting!

Output: `{generations_until_failure: int, drift_rate: float}`

Narrative role: First real cliffhanger. "The copy ran! It even
started copying! But on the third generation, byte 6 drifted..."

### Test 4: Population Spread (seconds)

Precondition: Test 3 passed (at least 3 generations faithful).

Setup: 8×8 board. Candidate at (0,0). Run for 200 rounds.

Checks:
- What fraction of cells are alive (running the replicator)?
- How fast did it spread? (measure at 50, 100, 150, 200 rounds)
- Did any cells die after being colonized?

Failure modes:
- **T4a: Stuck at 1** — replicator copies but copy never executes.
  Cause: branch flag not preserved in copy's register save.
- **T4b: Stuck at small number** — spreads to a few cells then stops.
  Cause: directional bias in the pairing, or copy errors accumulate.
- **T4c: Expands then collapses** — population peaks then declines.
  Cause: marginal branch (BPL/BMI) fails for some X values,
  creating "dead zones" that corrupt neighbors.

Output: `{peak_population: int, final_population: int, spread_rate: float}`

Narrative role: The simulation runs! The player watches population
curves. "It spread to 12 cells by round 50... peaked at 23 by
round 120... then something went wrong. By round 200, only 4 remained."

### Test 5: Dominance (seconds)

Precondition: Test 4 passed (>50% alive at round 200).

Setup: 32×32 board. Run for 1000 rounds.

Checks:
- Does it reach 100% colonization?
- How long does it take?
- Is the population stable?

Output: `{colonized_pct: float, time_to_50pct: int, stable: bool}`

Narrative role: "Full colonization in 340 rounds. The board is alive."

### Test 6: Noise Tolerance (seconds)

Precondition: Test 5 passed.

Setup: 32×32 board, full colonization, then enable cosmic rays
at increasing rates: 1e-12, 1e-11, 1e-10, 1e-9, 1e-8.

Checks:
- At what noise level does population start declining?
- What's the half-life at each noise level?
- Does it reach a stable equilibrium (mutation-selection balance)?

Output: `{max_tolerable_noise: float, half_life_at_threshold: int}`

Narrative role: "It withstands 1e-10 without flinching. At 1e-9,
the population drops to 980/1024 but stabilizes — some cells are
constantly being corrupted and re-colonized. At 1e-8, it crashes
within 50 rounds. Noise tolerance: 1e-9."

### Test 7: Certification

Precondition: Test 6 passed (tolerates ≥ 1e-10).

Record: the ChaCha20 seed, the cell position, the DFA match
metadata, all test results. Generate a signed certificate.

Output: A `ReplicatorCertificate` containing the Merkle-committable
genesis state.

Narrative: "VIABLE REPLICATOR FOUND. Seed: a83f...29d1. Species:
BCC-INX-00, no NOPs, clean 8-byte pattern. Noise tolerance: 1e-9.
Dominance time: 340 rounds. This is organism #1 on your board."

## Narrative Engine

### Principles

1. **Don't repeat yourself.** Track which failure modes the player
   has seen. First occurrence gets full explanation. Later occurrences
   get abbreviated + callback ("same as #42").

2. **Celebrate progress.** Track the furthest test reached. When a
   candidate beats the record, note it prominently.

3. **Teach gradually.** Each failure mode has 3-4 levels of
   explanation depth. Level 1 on first encounter. Level 2 when
   the player has seen 10+ of the same type. Level 3 after 50+.
   Level 4 unlocks "asides" — tangential facts about 6502 biology.

4. **Build tension.** As candidates get further in the cascade,
   the reports get longer and more detailed. A Test 1 failure is
   2 lines. A Test 4 failure is a paragraph with population graphs.
   A Test 6 failure is a full page with noise curves.

5. **Connect the dots.** After 100+ candidates, the system can
   make statistical observations: "Of 147 candidates so far, 89%
   failed at Test 1 (branch failure), 8% at Test 2 (copy fidelity),
   3% at Test 3 (generational drift). No candidate has passed Test 4."

### State tracking

```
{
  candidates_seen: int,
  furthest_test: int,
  failure_counts: {T1a: int, T1b: int, ..., T6: int},
  first_seen: {T1a: int, T1b: int, ...},  // candidate # when first seen
  records: {
    most_bytes_copied: int,
    highest_fidelity: float,
    most_generations: int,
    highest_population: int,
    best_noise_tolerance: float
  },
  asides_unlocked: Set<string>,
  streak: int,  // consecutive T1 failures (for "dry spell" narrative)
}
```

### Example progression

**Day 1 (candidate #1):**
> Candidate #1: BCS replicator, src=$7A, DEX, 1-byte preamble (SEC)
>
> Test 0: Relaxations active: R2 (flag unknown), R5 (SEC in preamble).
> Risk score: 3/10.
>
> Test 1: Ran for 4096 cycles. PC ended at $0042 — no loop detected.
> The BCS branch requires carry SET, but the saved P register has
> carry CLEAR. The branch falls through every time.
>
> Result: FAILED (T1a — branch flag mismatch)
>
> [First failure of type T1a. In the 6502, BCS branches when the
> carry flag is set. The carry flag is saved in the P register at
> $FB, which was initialized to $30 — carry clear. BCS never fires.]

**Day 47 (candidate #47):**
> Candidate #47: BCC replicator, src=$00, INX, clean (no slides)
>
> Test 0: Only relaxation: R4 (offset $F9 instead of $F8).
> Risk score: 1/10.
>
> Test 1: Looped! 287 iterations. 255 bytes written.
>
> Test 2: Copy fidelity: 99.6% (254/255 bytes match).
> One byte wrong: offset $07 is $F9 in source but $F8 in copy.
> Wait — that IS the branch offset. The copy has offset $F9,
> which means IT will branch to byte 1 instead of byte 0. Close!
>
> Test 3: Second generation branches to byte 1, which is $00 (the
> source address operand). $00 is BRK — the copy yields immediately.
> Generation 2 is dead on arrival.
>
> Result: FAILED (T3a — entry point shift in copy)
>
> This is the closest any candidate has gotten. A single byte off.
> The branch offset $F9 (-7) targets byte 1 instead of byte 0.
> If there were a NOP at byte 0... but there isn't.

**Day 203 (candidate #203):**
> Candidate #203: BNE replicator, src=$00, INX, 2-byte slide
> (CLC, NOP) between STA and INX.
>
> Test 0: Relaxation R3 (BNE depends on Z flag). Risk score: 2/10.
>
> Test 1: Looped! 217 iterations. 255 bytes written.
>
> Test 2: Perfect copy. Fidelity 100%. The CLC and NOP between
> STA and INX don't affect A or X. Clean copy.
>
> Test 3: Generation 2 copies faithfully. Generation 3 also.
> Checked 10 generations: all identical. Stable replicator!
>
> Test 4: Population on 8×8 board...
> Round 50: 18/64 alive
> Round 100: 41/64
> Round 150: 58/64
> Round 200: 64/64 — FULL COLONIZATION
>
> NEW RECORD: First candidate to pass Test 4!
>
> Test 5: 32×32 board. Full colonization in 380 rounds.
>
> Test 6: Noise tolerance...
> 1e-12: stable (1024/1024)
> 1e-11: stable (1024/1024)
> 1e-10: stable (1023/1024 — 1 cell flickering)
> 1e-9: declining (1019/1024 at round 500, 1002/1024 at round 1000)
> 1e-8: crash (below 512 by round 100)
>
> However: BNE branches when Z=0. After INX, Z=0 unless X wrapped
> to 0. Every 256th iteration, Z=1 and BNE fails — the replicator
> loses one copying cycle per 256. In practice this is harmless
> (the next quantum restarts at byte 0) but it means the copy is
> slightly slower than a BCC/BCS variant.
>
> Result: VIABLE REPLICATOR
> Seed: 7d3f...a821. Cell: (14, 9). Species: BNE-INX-00-CLC.NOP

## Testing the Expert System

### Unit tests

For each test (T0-T7), provide:
- A known-passing byte sequence
- A known-failing byte sequence for each failure subtype
- Verify correct diagnosis

### DFA sampling tests

1. Generate 10,000 uniform DFA samples.
2. Verify all are accepted by the DFA.
3. Run all through the expert system.
4. Verify failure mode distribution matches expected relaxation probabilities.
5. Verify ~0.05% (≈5) pass all tests (B_eff delta of ~11 bits means
   1/2048 of relaxed candidates are viable).

### Narrative tests

1. Run the expert system on 2000 sequential DFA samples.
2. Verify no two consecutive reports have identical text.
3. Verify "NEW RECORD" appears at appropriate points.
4. Verify explanation depth increases over time.
5. Verify statistical summary appears after candidate 100.
6. Verify report length increases with test stage reached.

### Progression tests

1. Seed the DFA sampler with a known seed that produces a viable
   candidate at position #891.
2. Run the full 891-candidate progression.
3. Verify the narrative builds tension appropriately.
4. Verify the viable candidate gets the full celebration treatment.
5. Verify no information is revealed "early" that spoils the discovery.
