# WFST Decomposition for Replicator Recognition

## The Pipeline

The replicator recognition problem decomposes naturally into a
Machine Boss-style WFST composition pipeline:

```
ChaCha20 generator → byte tokenizer → opcode lexer → NOP inserter → replicator profile → score
```

Each stage is a separate machine. Composition gives us the end-to-end
model. The decomposition is modular: we can swap components, add new
"hopeful monster" relaxations, and train weights from simulation data.

## Stage 1: Generator (input PSWM)

A uniform IID byte generator. In Machine Boss terms, this is a
single-state generator that emits each of the 256 byte values with
equal weight (1/256):

```json
{"state": [{"id": "S", "trans": [
  {"out": "0x00", "to": "S", "weight": {"/": [1, 256]}},
  {"out": "0x01", "to": "S", "weight": {"/": [1, 256]}},
  ...
]}]}
```

This is the "null model" — what random bytes look like. The
acceptance probability of the full pipeline under this generator
gives us P_replicator = 2^{-B_eff}.

## Stage 2: Opcode Tokenizer-Lexer (transducer)

Maps raw bytes to structured tokens. This is a transducer that
consumes 1-3 bytes (depending on the opcode) and emits a single
token describing the instruction:

```
Input: raw bytes      Output: tokens
B5 00        →        LDA_ZPX(addr=$00)
9D 00 04     →        STA_ABX(addr=$0400)
E8           →        INX
CA           →        DEX
EA           →        NOP1
80 xx        →        NOP2(imm=xx)
0C xx xx     →        NOP3(abs=xxxx)
90 F8        →        BCC(offset=-8)
...
```

The tokenizer knows the 6502 instruction encoding. Multi-byte
instructions consume their operand bytes. The output alphabet is
the set of all instruction tokens, annotated with operand values.

In Machine Boss: this is a transducer with ~256 states (one per
opcode class), consuming 1-3 input bytes per output token.

### Why this helps

Separating tokenization from pattern recognition means:
- The pattern recognizer operates on TOKENS, not bytes
- NOP insertion becomes a simple transducer (insert NOP tokens)
- The byte-level details (instruction encoding, operand parsing)
  are isolated in the tokenizer
- We can handle multi-byte instructions cleanly

## Stage 3: NOP/Safe-Opcode Inserter (transducer)

A transducer that passes through "core" tokens (LDA, STA, INX,
branch) and optionally inserts "safe" tokens between them. This
models the tolerable-opcode slides.

At each insertion point, the inserter can:
- Pass the next core token through (weight 1)
- Insert a safe token and stay (weight = prior probability of
  the safe opcode occurring in random bytes)

The WEIGHT on each safe-opcode insertion is the key innovation.
Instead of a binary safe/unsafe classification, each tolerable
opcode gets a weight reflecting its probability of preserving
replicator function:

```
At insertion point 1 (between LDA and STA, must preserve A and X):
  NOP ($EA):     weight = p_survive = 1.0    (definitely safe)
  CLC ($18):     weight = p_survive = 1.0    (safe, doesn't touch A/X)
  TAY ($A8):     weight = p_survive = 1.0    (safe, reads A to Y)
  STA zp ($85):  weight = p_survive = 0.996  (writes A to random addr,
                  ~0.4% chance of hitting critical bytes 0-7)
  INC zp ($E6):  weight = p_survive = 0.99   (RMW at random addr)
```

### Fitting weights from simulation

This is where Baum-Welch comes in. Given:
- A corpus of DFA-matched byte sequences (from brute-force)
- Simulation results for each (pass/fail at each test stage)

We can treat the simulation outcome as observed data and the
tolerable-opcode weights as parameters to estimate. The E-step
computes expected opcode-path usage under current weights. The
M-step updates weights to maximize the likelihood of observed
pass/fail outcomes.

In practice: generate 10K matched sequences, simulate each,
record which survived. Use Baum-Welch to fit the safe-opcode
weights to the survival data. The fitted weights give us
calibrated viability scores.

## Stage 4: Replicator Profile Recognizer

A profile HMM over the token sequence. This is the core pattern:

```
Position 1: LDA_ZPX(addr=NN)     — any NN
Position 2: STA_ABX(addr=$04NN)  — must match NN from position 1
Position 3: INX or DEX
Position 4: branch back to start — correct offset
```

The NN-matching constraint (positions 1 and 2) is handled by
expanding the profile into 256 parallel paths (one per NN value),
or by using a transducer that tracks the "remembered" NN.

In Machine Boss: this is a 4-position profile recognizer. The
branch variant adds the flag-state constraint (BCC needs C=0,
BCS needs C=1, etc.), modeled as a weight on the branch token.

### Relaxed profiles (hopeful monsters)

Each relaxation from the spec maps to a profile variant:

| Relaxation | Profile change |
|-----------|---------------|
| R1: NN mismatch | Remove NN-matching constraint |
| R2: Wrong flag | Remove flag-weight on branch |
| R3: More branch types | Wider branch token set |
| R4: Offset ±2 | Fuzzy match on branch offset |
| R7: Wrong page | Wider STA destination set |

The relaxed profile is the UNION of the strict profile and all
relaxation variants. Each variant path has a different weight
reflecting its estimated viability (from Stage 3 fitting).

## Composition

The full pipeline:

```
generator ∘ tokenizer ∘ nop-inserter ∘ profile-recognizer
```

Machine Boss composes these into a single WFST. The Forward
algorithm on the composed machine gives:
- **Log-likelihood** = log P(random bytes match the pattern)
  = -B_eff × log(2)
- **Viterbi path** = most likely replicator structure for a
  given byte sequence
- **Posterior path sampling** = uniform samples from the
  matched language (our DFA sampler, but now with weights!)

## Advantages of the WFST Framework

### 1. Modular experimentation

To test a new "hopeful monster" relaxation:
1. Add new tokens to the tokenizer (if needed)
2. Add new safe-opcode rules to the inserter
3. Add the relaxation path to the profile
4. Recompose. B_eff updates automatically.

No need to rebuild the DFA from scratch.

### 2. Weighted scoring (not just pass/fail)

Each matched sequence gets a **viability score** from the
path weights. High-scoring matches are more likely to survive
simulation. This lets us:
- Prioritize candidates by estimated viability
- Set dynamic thresholds (not just pass/fail)
- Generate "the most viable hopeful monster of the day"

### 3. Trainable weights

Baum-Welch on simulation data calibrates the safe-opcode
weights. As we gather more simulation results, the weights
improve. The system LEARNS which mutations are actually safe.

### 4. Code generation

Machine Boss can compile a composed WFST to:
- **JavaScript** for the browser/Node.js client
- **C++** for fast server-side matching
- **WebGPU/WGSL** for GPU-accelerated search

This means the DFA matcher can be auto-generated from the
WFST specification, not hand-coded.

## Implementation Path

### Phase A: JSON machine specification

Define the four pipeline stages as Machine Boss JSON files:
- `machines/byte-generator.json`
- `machines/opcode-tokenizer.json`
- `machines/nop-inserter.json`
- `machines/replicator-profile.json`

### Phase B: Composition and verification

```bash
boss byte-generator.json \
  -m opcode-tokenizer.json \
  -m nop-inserter.json \
  -m replicator-profile.json \
  --loglike
```

Verify the composed machine's acceptance probability matches
our hand-computed B_eff.

### Phase C: JavaScript compilation

```bash
boss composed.json --javascript > replicator-matcher.js
```

This auto-generated matcher replaces our hand-built DFA.

### Phase D: Weight training

1. Generate 10K DFA-matched byte sequences (sampler)
2. Simulate each (test cascade)
3. Record pass/fail + test stage reached
4. Baum-Welch to fit safe-opcode weights
5. Recompose with fitted weights
6. New matcher scores candidates by estimated viability

### Phase E: Narrative integration

The Viterbi path through the composed WFST tells us:
- Which tokens were recognized (for the diagnostic)
- Which NOP insertions occurred (for the narrative)
- Which relaxations are active (for the failure mode)
- The viability score (for prioritization)

This is richer than the flat DFA trace — it's a structured
parse of the candidate, decomposed into meaningful layers.

## Relation to Current DFA Infrastructure

The DFA engine (dfa/dfa.js) we just built IS the inner loop
of this pipeline. The WFST framework wraps it with:
- Modular composition (instead of monolithic DFA construction)
- Weighted transitions (instead of binary accept/reject)
- Trainable parameters (instead of hand-tuned thresholds)
- Auto-generated matchers (instead of hand-coded tables)

The current DFA can serve as a fast compiled form of the
composed WFST. The WFST is the design-time representation;
the DFA is the runtime representation.
