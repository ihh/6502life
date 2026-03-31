Compute B_eff (effective information content) for viable replicators.

Run the WFST pipeline at the specified lengths, train briefly, validate with importance sampling, and report a table of per-length and cumulative B_eff.

Arguments: optional space-separated lengths (default: 8 9 10 11 12 14 16)

Steps:
1. Build the multi-byte opcode reviewer and compose with offset
2. Inject hard constraints (addr=0, BVC/BCC, offset)
3. Pre-seed slide weights from known safe opcodes
4. For each length L: run 3 training iterations (50 samples each), then IS validation (30 samples)
5. Report table: L | WFST B_eff | IS B_eff | viable rate
6. Report cumulative B_eff across all lengths

Use `node --input-type=module` to run inline. Key imports:
- `dfa/reviewers/opcode-multibyte.js` (buildMultibyteOpcodeReviewer)
- `dfa/reviewers/offset.js` (buildOffsetReviewer)
- `dfa/compose.js` (composeCopyTransducers, injectOffsetVerdicts, injectAddrConstraint, injectBranchConstraint)
- `dfa/weighted-sampler.js` (weightedForward, weightedSample, updateWeights, weightedBeff, importanceSamplingEstimate)
- `dfa/simulate.js` (simulateCandidate)
- `dfa/active-learning.js` (preseedSlideWeights)
- `webgpu/prng.js` (PRNG)

Print results as a markdown table.
