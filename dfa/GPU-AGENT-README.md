# GPU Agent: Neural Oracle + Deep Learning for Replicator Generation

## What this is

A WFST (weighted finite-state transducer) pipeline for scoring and generating
self-replicating 6502 programs. The WFST handles structural constraints exactly;
a neural oracle accelerates training by replacing expensive simulation.

## Where you are

The WFST pipeline is **working end-to-end** but the neural oracle is a simple
log-linear model (CPU-only). Your job: replace it with a proper neural network
that can run on GPU, enabling 1000x more training evaluations.

## Key files to read

### WFST pipeline (the core — don't break this)
- `dfa/weighted-sampler.js` — Weighted Forward/sampler + AND-gate blame assignment (EM M-step)
- `dfa/compose.js` — Transducer composition + constraint injection
- `dfa/reviewers/opcode-multibyte.js` — Multi-byte-aware opcode reviewer (21 states)
- `dfa/active-learning.js` — Uncertainty-directed exploration + curriculum
- `dfa/pipeline.js` — Bridge from CopyTransducer → DFA for Forward/sampler

### Neural oracle (replace/upgrade this)
- `dfa/neural-oracle.js` — Current log-linear model (~8K params, CPU)
- `dfa/slide-training.js` — Multi-slide candidate generation + simulation

### Simulation (the ground-truth oracle — keep using for validation)
- `dfa/simulate.js` — BareSimCPU wrapper for testing replicator viability
- `webgpu/bare-sim-cpu.js` — The actual 6502 simulator

### LaTeX survey of approaches
- `tex/dl-survey.tex` — Full survey of 7 DL architectures for this problem

### Board initialization (just landed)
- `coin/chacha20.js` — ChaCha20 stream cipher for board init
- `coin/board-contract.js` — Board contract specifying all parameters

## What to build

### Priority 1: Neural surrogate oracle
Replace `dfa/neural-oracle.js` with a proper network:
- **Input:** Variable-length byte sequence (8-32 bytes), 256-token vocabulary
- **Output:** Predicted P(spread > 32) and/or predicted spread count
- **Architecture options** (see `tex/dl-survey.tex` for analysis):
  - 1D CNN (simplest, fastest)
  - Small transformer (2 layers, 64-dim, causal mask)
  - Mamba/S4 (state-space model — philosophically closest to the WFST)
- **Training data:** ~5000 (sequence, spread) pairs from existing experiments.
  Generate more via `dfa/simulate.js`
- **Integration:** The neural oracle plugs into `dfa/neural-oracle.js::innerOuterLoop`:
  - Outer loop: real simulation (slow, 100-500 per iter)
  - Inner loop: neural oracle (fast, 10K-100K per iter)
  - The WFST trains on oracle predictions, validated by IS against real sim

### Priority 2: Per-position blame attribution
The WFST's AND-gate M-step (`weighted-sampler.js::updateWeights`) computes:
```
P(FAIL_i | sequence failed) = (1 - w_i) / (1 - ∏ w_j)
```
A neural model with attention could learn this attribution directly —
which byte(s) caused the failure. This feeds back into WFST weight updates.

### Priority 3: Replicator mutator (seq2seq)
Given a viable program, generate mutations that are also viable.
Encoder-decoder or denoising autoencoder on viable sequences.

## Current results

- B_eff ≈ 60 bits (1 in 10^18 random 8-byte sequences is a viable replicator)
- WFST has 1050 product states (21 opcode × 50 offset)
- Multi-byte slides: 92 safe opcodes (1.08 bits/byte for 3-byte slides)
- Viable programs found up to L=25 via curriculum active learning
- IS validation confirms WFST calibration within 2-5 bits

## How to run

```bash
npm install
npm test                    # all 272 tests
npx vitest run dfa/test/   # just the WFST pipeline tests (148 tests)
npx vitest run coin/test/  # coin system tests (31 tests)
```

## The key insight

The WFST is a hand-designed state-space model with exact inference.
The neural network's job is NOT to replace it but to make its training
loop fast. The WFST samples → neural oracle scores → WFST updates weights.
Real simulation validates periodically via importance sampling.
