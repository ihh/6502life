# Organism Generator: Implementation Plan

## Overview

A WFST-based pipeline for generating, scoring, and narratively
diagnosing candidate replicators in 6502life. Built on Machine Boss
composition semantics, implemented in JavaScript (Node.js + browser),
with simulation-based weight training.

## Architecture

```
uniform IID byte generator
  ∘ opcode tokenizer (copy-transducer, emits inline PASS/FAIL)
  ∘ NOP/safe-opcode reviewer (copy-transducer, emits inline PASS/FAIL)
  ∘ replicator profile reviewer (copy-transducer, emits inline PASS/FAIL)
  ∘ branch-offset reviewer (copy-transducer, emits inline PASS/FAIL)
  ∘ AND-gate filter (collapses inline verdicts to single PASS/FAIL)
```

Each reviewer is a copy-transducer: reads bytes, echoes them, inserts
PASS or FAIL tokens inline at the positions it cares about. Reviewers
are independently testable and composable. The AND-gate at the end
discards bytes and collapses all verdicts to one.

Weighted reviewers emit FAIL with probability p_fail (trainable) for
risky mutations, enabling Baum-Welch training from simulation data.

## Refactoring

The existing `dfa/` infrastructure (dfa.js, forward.js, sampler.js)
provides the computational core but needs extension:

### Keep as-is
- `dfa/dfa.js` — DFA engine with named states, trace(), annotations
- `dfa/forward.js` — Forward path counting (BigInt + Float64)
- `dfa/sampler.js` — Backward stochastic traceback
- All existing tests (40 tests, Phases 1-5)

### Extend
- `dfa/dfa.js` — Add support for output symbols on transitions
  (currently input-only recognizer; needs input/output for transducers)
- `dfa/forward.js` — Add output-conditioned Forward (condition on
  final output being PASS; sum over paths ending in PASS)
- `dfa/sampler.js` — Add output-conditioned sampling (sample from
  posterior of byte sequences given PASS output)

### New modules
- `dfa/transducer.js` — Copy-transducer with inline verdict emission
- `dfa/compose.js` — Transducer composition (A ∘ B)
- `dfa/filter.js` — AND-gate verdict filter
- `dfa/reviewers/` — Individual reviewer implementations
- `dfa/training.js` — Baum-Welch parameter fitting
- `dfa/narrative.js` — Diagnostic narrative engine
- `dfa/generate.js` — End-to-end candidate generation

## Implementation Phases

### Phase 1: Transducer Primitives

**Files:** `dfa/transducer.js`, `dfa/test/transducer.test.js`

Extend the DFA engine to support transducers (input/output pairs):
- Transition: `{from, to, in, out, weight, tag, label, meta}`
  - `in`: input symbol (byte or null for silent)
  - `out`: output symbol (byte, PASS, FAIL, or null)
  - `weight`: transition weight (default 1.0)
- A "copy-transducer" is one where most transitions have out=in
  (echo the input byte to output)
- PASS and FAIL are special output symbols (not bytes)

Builder helpers:
- `copyTransducer(numStates, rules)` — build a copy-transducer where
  default transitions echo input to output
- `addVerdict(state, byte_condition, verdict)` — at a specific state,
  emit PASS or FAIL based on byte value

Tests:
- Echo transducer: input bytes pass through unchanged
- Verdict emission: FAIL inserted at correct position
- Weighted verdict: FAIL with probability p, PASS with (1-p)

### Phase 2: Reviewer Library

**Files:** `dfa/reviewers/*.js`, `dfa/test/reviewers.test.js`

Each reviewer is a copy-transducer factory:

#### `reviewers/opcode.js` — Core opcode reviewer
- Checks byte 0 = $B5 (LDA zp,X)
- Checks byte 2 = $9D (STA abs,X)
- Checks byte 4 = $04 (destination page)
- Checks byte 5 ∈ {$E8, $CA} (INX/DEX)
- Emits FAIL at each position that doesn't match
- State count: ~7 (one per core byte position)

#### `reviewers/addr-match.js` — Address matching reviewer
- Remembers byte 1, checks byte 3 matches
- 256 states (one per possible byte 1 value)
- Emits FAIL at byte 3 if mismatch
- Weighted: in relaxed mode, mismatch emits FAIL with weight p_mismatch

#### `reviewers/branch.js` — Branch opcode reviewer
- At the branch position: checks opcode ∈ {$90, $B0, $D0, ...}
- Checks flag compatibility (BCC needs C=0, etc.)
- Emits FAIL if wrong opcode or incompatible flag state
- Flag state determined by saved P register byte ($FB in the cell)

#### `reviewers/offset.js` — Branch offset reviewer (the 256-state counter)
- Counts bytes consumed so far
- At the branch offset position: checks byte = -(total_length) mod 256
- Emits FAIL if offset wrong
- This is the "correct final branch opcode" recognizer, lifted to
  a copy-transducer

#### `reviewers/nop-slide.js` — NOP/safe-opcode insertion reviewer
- Between core positions, allows insertion of tolerable opcodes
- Each tolerable opcode: emit PASS with weight p_safe (trainable)
- Intolerable opcodes: emit FAIL
- Multi-byte opcodes consume their operand bytes (state tracks this)
- Safe-opcode sets differ per insertion point (preserve A, X, flags)

Tests per reviewer:
- Known-passing byte sequences → all PASS verdicts
- Known-failing sequences → FAIL at expected position
- Edge cases per reviewer's specific constraint

### Phase 3: Composition Engine

**Files:** `dfa/compose.js`, `dfa/test/compose.test.js`

Compose two copy-transducers into one:
- Input: transducer A (bytes+verdicts → bytes+verdicts),
  transducer B (bytes+verdicts → bytes+verdicts)
- Output: composed transducer A ∘ B
- A's output feeds B's input
- Both A and B echo bytes; verdicts accumulate

Implementation: product-state construction.
- State = (stateA, stateB)
- On input byte b: A transitions, emitting b (and maybe a verdict).
  B receives whatever A emitted.
- Verdicts from A pass through B unchanged (B echoes them).
- B may add its own verdicts.

The composition follows Machine Boss's algorithm:
1. Classify B's states as "waiting" (need input) or "silent" (no input)
2. DFS from (startA, startB) to find accessible product states
3. Handle silent transitions (A emits, B is silent; or B advances silently)

Tests:
- Compose two trivial echo transducers → still an echo
- Compose opcode reviewer with offset reviewer → combined checker
- Verify composed machine accepts/rejects correctly
- Verify verdict positions match individual reviewers

### Phase 4: AND-Gate Filter

**Files:** `dfa/filter.js`, `dfa/test/filter.test.js`

The final stage: reads bytes+verdicts, outputs single PASS or FAIL.

Two states: OK and BAD.
- Read byte: discard (no output)
- Read PASS: stay in current state (no output)
- Read FAIL: transition to BAD (no output)
- End of input: OK → emit PASS. BAD → emit FAIL.

Composed with the reviewer pipeline:
```
(reviewer pipeline) ∘ (AND-gate filter)
```
Produces: nothing until end, then PASS or FAIL.

Tests:
- All-PASS stream → PASS
- One FAIL anywhere → FAIL
- Multiple FAILs → FAIL
- Empty stream → PASS (vacuously)

### Phase 5: Forward/Backward on Composed Pipeline

**Files:** extend `dfa/forward.js` and `dfa/sampler.js`

The composed pipeline is:
```
uniform generator ∘ reviewers ∘ AND-gate
```

Forward algorithm conditioned on PASS output at length L:
- This is the standard Forward, but only counting paths that end
  in the PASS output state
- `forwardCountsBigInt()` already handles this (accepting states
  = states where AND-gate is in OK and at end position)

Sampler conditioned on PASS:
- `sampleSequence()` already samples from accepted paths
- The "accepted" paths are exactly those ending in PASS

B_eff = -log2(P(PASS at length L under uniform input))

Tests:
- Compose full reviewer pipeline for the strict replicator pattern
- Verify B_eff ≈ 55 bits at length 8
- Verify B_eff decreases with relaxed reviewers
- Sample 1000 sequences → all accepted by individual reviewers
- Cross-validate sampler vs fuzzer (reuse Phase 5 methodology)

### Phase 6: Simulation Integration

**Files:** `dfa/simulate.js`, `dfa/test/simulate.test.js`

Bridge between the WFST pipeline and the bare-sim:

`simulateCandidate(cellBytes, options)`:
1. Place cellBytes in cell (0,0) of a small board (8×8)
2. Set registers: PC=0, S=$FF, P from cellBytes[$FB]
3. Run N quanta (configurable)
4. Return: { copied: bool, fidelity: float, spread: int, survived: bool }

The test cascade from the Hopeful Monsters spec, but automated:
- T1: single quantum, check for loop + writes
- T2: copy fidelity check
- T3: second-generation test
- T4: spread test (8×8 board, 200 rounds)
- T5: dominance test (optional, expensive)

Uses `BareSimCPU` from `webgpu/bare-sim-cpu.js`.

Tests:
- Known replicator (REP_CODE) → all tests pass
- Known non-replicator (random bytes) → fails at T1
- Alien-killer → passes with specific characteristics

### Phase 7: Baum-Welch Training

**Files:** `dfa/training.js`, `dfa/test/training.test.js`

Given:
- A set of DFA-matched byte sequences (from sampler)
- Simulation results for each (pass/fail + which test stage)
- The composed pipeline with trainable weights on risky transitions

Fit the weights:

1. **E-step**: For each training sequence, run Forward-Backward on
   the composed machine. Compute expected transition counts.
   Partition by outcome: successful sequences contribute to
   "should be PASS" counts, failed sequences to "should be FAIL."

2. **M-step**: For each trainable weight p_safe on a risky opcode:
   - p_safe = (expected PASS count) / (expected PASS + FAIL count)
   - Subject to constraints: 0 < p_safe < 1

3. Iterate E/M until convergence (typically 5-10 iterations).

Output: fitted weights for all risky transitions. These become the
viability scores used by the narrative engine.

Tests:
- Synthetic data: generate sequences with known survival probability,
  verify Baum-Welch recovers the true weights
- Sanity: definitely-safe opcodes (NOP) should get weight ≈ 1.0
- Sanity: definitely-unsafe opcodes (JMP random) should get weight ≈ 0.0

### Phase 8: Narrative Engine

**Files:** `dfa/narrative.js`, `dfa/test/narrative.test.js`

Takes a candidate + its WFST trace + simulation results, produces
a narrative report. Uses the reviewer annotations (tags, labels,
metadata) and the trace path to generate human-readable text.

Components:

#### Diagnosis generator
- Maps each FAIL verdict to a human-readable explanation
- Uses the reviewer tag to select the explanation template
- Uses the byte values and state annotations for specifics

#### Progression tracker
State persisted across candidates:
```
{
  candidates_seen, furthest_test, failure_counts,
  records, asides_unlocked, streak
}
```

#### Template engine
Per failure type, 4 depth levels:
- Level 1: first encounter, full explanation
- Level 2: 10+ encounters, abbreviated
- Level 3: 50+ encounters, one-liner + callback
- Level 4: "aside" unlocked — tangential biology fact

#### Report generator
Assembles diagnosis + progression + records into a report.
Adjusts length based on test stage reached.

Tests:
- Generate 100 candidates from the sampler, run narrative engine
- Verify no two consecutive reports are identical
- Verify "NEW RECORD" appears when warranted
- Verify explanation depth increases over time
- Verify report length correlates with test stage

### Phase 9: End-to-End Pipeline

**Files:** `dfa/generate.js`, `dfa/test/generate.test.js`

The complete flow:
1. Build the reviewer pipeline (strict or relaxed)
2. Compose all stages
3. Compute Forward tables
4. For each "day" (1 to 2000):
   a. Sample one candidate from the posterior (conditioned on PASS)
   b. Simulate the candidate
   c. Score with the fitted weights
   d. Generate narrative report
5. Output: a JSON array of 2000 {candidate, simulation, score, narrative}

CLI tool: `node dfa/generate.js --seed 42 --days 2000 --relaxed`

Tests:
- Generate 2000 candidates with a known seed → reproducible
- Verify ~1/2000 passes all simulation tests
- Verify narrative progression (variety, records, tension)
- Verify viability scores correlate with simulation outcomes

### Phase 10: Machine Boss Integration (Optional/Future)

Export the composed pipeline as Machine Boss JSON:
- Each reviewer → JSON transducer
- Composition → `{"compose": [...]}`
- Forward/sampling → `boss --sample-path`
- Training → `boss --baum-welch`

This enables:
- Using Machine Boss's optimized C++ algorithms for large-scale training
- GPU-accelerated Forward/Backward via Machine Boss's JAX backend
- Visualization via Machine Boss's GraphViz DOT export
- Cross-validation: Machine Boss results should match our JS implementation

## File Structure

```
dfa/
├── dfa.js                  # DFA engine (existing, extended)
├── transducer.js           # Copy-transducer with verdict emission
├── compose.js              # Transducer composition
├── filter.js               # AND-gate verdict filter
├── forward.js              # Forward algorithm (existing, extended)
├── sampler.js              # Backward traceback (existing, extended)
├── simulate.js             # Bare-sim integration
├── training.js             # Baum-Welch weight fitting
├── narrative.js            # Diagnostic narrative engine
├── generate.js             # End-to-end pipeline + CLI
├── reviewers/
│   ├── opcode.js           # Core opcode checker
│   ├── addr-match.js       # Byte 1 = byte 3 checker
│   ├── branch.js           # Branch opcode + flag checker
│   ├── offset.js           # Branch offset counter (256 states)
│   └── nop-slide.js        # Safe-opcode insertion reviewer
├── test/
│   ├── dfa.test.js         # (existing, 23 tests)
│   ├── forward.test.js     # (existing, 9 tests)
│   ├── sampler.test.js     # (existing, 8 tests)
│   ├── transducer.test.js
│   ├── reviewers.test.js
│   ├── compose.test.js
│   ├── filter.test.js
│   ├── simulate.test.js
│   ├── training.test.js
│   ├── narrative.test.js
│   └── generate.test.js
└── machines/               # Machine Boss JSON (Phase 10)
    ├── uniform-generator.json
    ├── opcode-reviewer.json
    ├── addr-match-reviewer.json
    ├── branch-reviewer.json
    ├── offset-reviewer.json
    ├── nop-slide-reviewer.json
    └── and-gate-filter.json
```

## Dependencies

- `webgpu/bare-sim-cpu.js` — simulation engine (Phase 6)
- `webgpu/prng.js` — seeded PRNG (all sampling)
- `vitest` — test framework (all phases)
- Machine Boss (`~/machineboss`) — optional Phase 10

## Verification Strategy

Each phase has its own test suite. Cross-phase invariants:

1. **Forward ↔ Sampler**: sampled distribution matches Forward probabilities
   (existing Phase 5 cross-validation, extended to composed machines)

2. **Composition ↔ Individual**: composed machine accepts/rejects the same
   sequences as running reviewers individually

3. **B_eff consistency**: Forward B_eff from composed machine matches
   hand-computed B_eff from byte-constraint analysis (within 0.1 bits)

4. **Training convergence**: Baum-Welch on synthetic data recovers
   known weights. On real data, log-likelihood increases monotonically.

5. **End-to-end**: 2000-candidate generation produces ~1 viable replicator
   (within statistical expectation for B_eff ≈ 42)

## Estimated Effort

| Phase | Complexity | Tests |
|-------|-----------|-------|
| 1. Transducer primitives | Small | ~10 |
| 2. Reviewer library | Medium | ~25 |
| 3. Composition engine | Medium-Large | ~15 |
| 4. AND-gate filter | Small | ~5 |
| 5. Conditioned Forward/Sampler | Medium | ~10 |
| 6. Simulation integration | Medium | ~10 |
| 7. Baum-Welch training | Large | ~10 |
| 8. Narrative engine | Medium | ~15 |
| 9. End-to-end pipeline | Medium | ~10 |
| 10. Machine Boss export | Small (future) | ~5 |
| **Total** | | **~115 new tests** |
