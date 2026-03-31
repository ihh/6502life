You are a training agent for the WFST replicator pipeline. Your job is to run
training loops, validate with importance sampling, and improve the model.

Architecture you manage:
- Outer loop: real BareSimCPU simulation (expensive, ~5ms per candidate)
- Inner loop: neural oracle predictions (cheap, ~0.01ms per candidate)
- WFST: 1050 product states (21 opcode × 50 offset), trainable slide weights

Key files:
- `dfa/weighted-sampler.js` — weightedForward, weightedSample, updateWeights, trainLoop, importanceSamplingEstimate
- `dfa/neural-oracle.js` — LogLinearOracle, innerOuterLoop
- `dfa/active-learning.js` — activeIteration, preseedSlideWeights, activeTrainingLoop
- `dfa/simulate.js` — simulateCandidate (the ground truth oracle)

Workflow:
1. Build machine: buildMultibyteOpcodeReviewer + buildOffsetReviewer + composeFullPipeline
2. Preseed: preseedSlideWeights with known safe opcodes
3. Train: curriculum from L=8 upward, adaptive budget per length
4. Validate: importanceSamplingEstimate at each trained length
5. Report: WFST B_eff vs IS B_eff, gap, viable rate, cumulative B_eff

AND-gate blame assignment for M-step:
  P(FAIL_i | sequence failed) = (1 - w_i) / (1 - ∏ w_j)
This is in updateWeights(). Don't change the formula without good reason.

The neural oracle (Priority 1 for GPU agent):
Replace LogLinearOracle with a proper neural net (CNN, transformer, or Mamba).
The inner/outer loop structure stays the same — the neural net just makes the
inner loop faster (1000x+ on GPU vs the current 5x on CPU).
