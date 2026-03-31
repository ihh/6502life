import { describe, it, expect } from 'vitest';
import {
    buildCandidate, sweepBranch, sweepInc, sweepAddr, fullSweep,
    estimateWeights, theoreticalBranchPredictions, computeEffectiveBeff,
    sampleWithWeights, runTrainingLoop,
    BRANCH_NAMES, INC_NAMES, BRANCHES,
} from '../experiment.js';
import { PRNG } from '../../webgpu/prng.js';

describe('buildCandidate', () => {
    it('builds canonical replicator with default params', () => {
        const c = buildCandidate({});
        expect([...c]).toEqual([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]);
    });

    it('builds with custom addr', () => {
        const c = buildCandidate({ addr: 0x42 });
        expect(c[1]).toBe(0x42);
        expect(c[3]).toBe(0x42);
    });
});

describe('Branch opcode sweep: INX', () => {
    it('matches theoretical predictions', async () => {
        const results = await sweepBranch({ inc: 0xE8, passes: 80, seed: 42 });
        const theory = theoreticalBranchPredictions().INX;

        const report = [];
        let correct = 0;
        for (const r of results) {
            const predicted = theory[r.branch];
            const match = r.copied === predicted;
            if (match) correct++;
            report.push({
                opcode: r.name,
                predicted: predicted ? 'replicates' : 'fails',
                actual: r.copied ? 'replicates' : 'fails',
                match: match ? '✓' : '✗',
                spread: r.spread,
                fidelity: r.fidelity.toFixed(3),
            });
        }
        console.table(report);
        expect(correct).toBe(8);
    }, 10000);
});

describe('Branch opcode sweep: DEX', () => {
    it('matches theoretical predictions', async () => {
        const results = await sweepBranch({ inc: 0xCA, passes: 80, seed: 42 });
        const theory = theoreticalBranchPredictions().DEX;

        const report = [];
        let correct = 0;
        for (const r of results) {
            const predicted = theory[r.branch];
            const match = r.copied === predicted;
            if (match) correct++;
            report.push({
                opcode: r.name,
                predicted: predicted ? 'replicates' : 'fails',
                actual: r.copied ? 'replicates' : 'fails',
                match: match ? '✓' : '✗',
                spread: r.spread,
            });
        }
        console.table(report);
        expect(correct).toBe(8);
    }, 10000);
});

describe('Address sweep', () => {
    it('addr=0 replicates, non-zero may or may not', async () => {
        const addrs = [0, 1, 2, 4, 8, 0x10, 0x40, 0x80, 0xF8];
        const results = await sweepAddr({ addrs, passes: 80, seed: 42 });

        const report = results.map(r => ({
            addr: `$${r.addr.toString(16).padStart(2, '0')}`,
            copied: r.copied,
            spread: r.spread,
            fidelity: r.fidelity.toFixed(3),
        }));
        console.table(report);

        // addr=0 must replicate
        expect(results.find(r => r.addr === 0).copied).toBe(true);
    }, 15000);
});

describe('Full parameter sweep + B_eff', () => {
    it('discovers all functional mutants and computes B_eff', async () => {
        const results = await fullSweep({ passes: 80, seed: 42 });
        const weights = estimateWeights(results);
        const beff = computeEffectiveBeff(weights);

        console.log('\n=== Joint Weights (inc:branch → P(replicates)) ===');
        for (const [key, w] of Object.entries(weights.jointWeights)) {
            if (w > 0) {
                const [inc, branch] = key.split(':').map(Number);
                console.log(`  ${INC_NAMES[inc]}+${BRANCH_NAMES[branch]}: ${w.toFixed(2)}`);
            }
        }

        console.log('\n=== Marginal Weights ===');
        console.log('Branch opcodes:');
        for (const b of BRANCHES) {
            console.log(`  ${BRANCH_NAMES[b]}: P(replicates) = ${weights.branchWeights[b].toFixed(2)}`);
        }

        console.log(`\nBase rate: ${weights.baseRate.toFixed(3)} (${weights.nSuccess}/${weights.n})`);

        console.log('\n=== Effective B_eff ===');
        console.log(`  LDA=$B5 (pos 0): ${beff.bitsLDA.toFixed(1)} bits`);
        console.log(`  addr (pos 1): ${beff.bitsAddr.toFixed(1)} bits (free)`);
        console.log(`  STA=$9D (pos 2): ${beff.bitsSTA.toFixed(1)} bits`);
        console.log(`  addr match (pos 3): ${beff.bitsAddrMatch.toFixed(1)} bits`);
        console.log(`  page=$04 (pos 4): ${beff.bitsPage.toFixed(1)} bits`);
        console.log(`  inc+branch (pos 5-6): ${beff.bitsIncBranch.toFixed(1)} bits [${beff.workingPairs} working pairs]`);
        console.log(`    (marginal inc: ${beff.bitsInc.toFixed(1)} bits [${beff.workingInc}], branch: ${beff.bitsBranch.toFixed(1)} bits [${beff.workingBranch}])`);
        console.log(`  offset (pos 7): ${beff.bitsOffset.toFixed(1)} bits`);
        console.log(`  TOTAL: ${beff.total.toFixed(1)} bits`);
        console.log(`  → 1 in 2^${beff.total.toFixed(1)} ≈ 1 in ${(2 ** beff.total).toExponential(1)} random bytes`);

        // Should have exactly 6 functional mutants (from empirical observation)
        expect(weights.nSuccess).toBe(6);
        expect(beff.workingPairs).toBe(6);

        // List all functional mutants with spread classification
        const mutants = results.filter(r => r.copied);
        console.log(`\n=== Functional Mutants (${mutants.length}) ===`);
        console.log('Tier 1 (infinite loop, spread=63):');
        for (const m of mutants.filter(m => m.spread > 50)) {
            const hex = m.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
            console.log(`  ${hex}  ${m.incName}+${m.branchName}`);
        }
        console.log('Tier 2 (finite loop, spread<50):');
        for (const m of mutants.filter(m => m.spread <= 50)) {
            const hex = m.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
            console.log(`  ${hex}  ${m.incName}+${m.branchName} spread=${m.spread}`);
        }
    }, 30000);
});

describe('Training loop closes', () => {
    it('iter 0 discovers replicators, later iters improve rate', async () => {
        const history = await runTrainingLoop({
            iterations: 3,
            batchSize: 32, // larger batch for better coverage
            passes: 60,
            seed: 42,
        });

        console.log('\n=== Training Loop ===');
        for (const h of history) {
            const rate = (h.replicationRate * 100).toFixed(0);
            const working = Object.entries(h.weights.jointWeights)
                .filter(([_, w]) => w > 0)
                .map(([key, w]) => {
                    const [inc, branch] = key.split(':').map(Number);
                    return `${INC_NAMES[inc]}+${BRANCH_NAMES[branch]}=${w.toFixed(2)}`;
                });
            console.log(`  Iter ${h.iter}: ${h.nReplicators}/${h.nTotal} (${rate}%) | ${working.join(', ')}`);
        }

        // Iter 0 should find some replicators (32 uniform samples, ~37.5% base rate)
        expect(history[0].nTotal).toBe(32);
        expect(history[0].nReplicators).toBeGreaterThan(0);

        // Iter 2 should have higher rate than iter 0 (learned weights)
        const rate0 = history[0].replicationRate;
        const rate2 = history[2].replicationRate;
        console.log(`\n  Rate improvement: ${(rate0 * 100).toFixed(0)}% → ${(rate2 * 100).toFixed(0)}%`);
        expect(rate2).toBeGreaterThanOrEqual(rate0);
    }, 60000);
});

describe('Weighted sampling only picks working combos', () => {
    it('all samples use replicating (inc,branch) pairs', async () => {
        const results = await fullSweep({ passes: 80, seed: 42 });
        const weights = estimateWeights(results);

        const rng = new PRNG(999);
        const candidates = sampleWithWeights(weights, 100, rng);
        expect(candidates.length).toBe(100);

        // Verify all samples use combos that replicated in the sweep
        const workingKeys = new Set(
            Object.entries(weights.jointWeights)
                .filter(([_, w]) => w > 0)
                .map(([key]) => key)
        );

        for (const c of candidates) {
            const key = `${c[5]}:${c[6]}`;
            expect(workingKeys.has(key)).toBe(true);
        }
    }, 30000);
});
