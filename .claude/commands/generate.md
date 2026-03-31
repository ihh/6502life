Sample viable replicator candidates from the trained WFST.

Arguments: N (number of candidates, default 10) L (length, default 8)

Steps:
1. Build the constrained multi-byte WFST (composeFullPipeline)
2. Pre-seed slide weights
3. Train briefly at the target length (3 iterations, 50 samples)
4. Sample N candidates from the trained model
5. Simulate each to verify viability
6. Report: hex bytes, spread, viable (boolean)
7. Show any novel patterns found (not the canonical 4 programs)

Use `node --input-type=module`. Key imports:
- `dfa/compose.js` (composeFullPipeline)
- `dfa/weighted-sampler.js` (weightedForward, weightedSample, trainLoop)
- `dfa/simulate.js` (simulateCandidate)
- `dfa/active-learning.js` (preseedSlideWeights)
- `dfa/reviewers/opcode-multibyte.js`, `dfa/reviewers/offset.js`
- `webgpu/prng.js` (PRNG)
