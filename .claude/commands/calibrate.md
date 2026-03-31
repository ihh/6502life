Run full WFST calibration: train at multiple lengths, IS-validate, report gaps.

This is the "is our model still accurate?" diagnostic. Reports the WFST's
self-assessed B_eff vs the IS ground truth at each length, plus cumulative.

Arguments: none (or optional max length, default 16)

Steps:
1. Build constrained multi-byte WFST, preseed slides
2. Curriculum training: L=8 through max, adaptive budget per length
3. At each length: report WFST B_eff, IS B_eff, gap, viable rate
4. Compute cumulative B_eff
5. Flag any lengths where gap > 5 bits (model is miscalibrated)
6. Report total simulation budget used

Key imports: same as /beff plus dfa/active-learning.js (activeIteration)
