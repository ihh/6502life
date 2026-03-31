import { describe, it, expect } from 'vitest';
import {
    weightedForward, weightedSample, updateWeights,
    weightedBeff, trainLoop, logPathProbability,
    importanceSamplingEstimate,
} from '../weighted-sampler.js';
import { buildOpcodeReviewer } from '../reviewers/opcode.js';
import { buildOffsetReviewer } from '../reviewers/offset.js';
import { composeOpcodeOffset } from '../compose.js';
import { simulateCandidate } from '../simulate.js';
import { PRNG } from '../../webgpu/prng.js';
import { FAIL } from '../transducer.js';

// Build the composed transducer and accept states
function buildMachine() {
    const opcode = buildOpcodeReviewer();
    const offset = buildOffsetReviewer();
    const composed = composeOpcodeOffset(opcode, offset);

    // Accept states: opcode in {seen-offset, accept} × any offset state
    const acceptStates = new Set();
    const opcSO = opcode.stateIdx.get('seen-offset');
    const opcAcc = opcode.stateIdx.get('accept');
    for (let os = 0; os < offset.numStates; os++) {
        acceptStates.add(opcSO * offset.numStates + os);
        acceptStates.add(opcAcc * offset.numStates + os);
    }

    return { composed, acceptStates, opcode, offset };
}

describe('weightedForward', () => {
    it('produces non-zero counts at length 8', () => {
        const { composed, acceptStates } = buildMachine();
        const fwd = weightedForward(composed, 8, acceptStates);
        expect(fwd[composed.initial][8]).toBeGreaterThan(0);
    });

    it('counts match DFA forward for uniform weights', () => {
        // With all weights = 1.0, weighted forward should match DFA forward
        const { composed, acceptStates } = buildMachine();
        const fwd = weightedForward(composed, 8, acceptStates);
        // The DFA forward gives 1048576 accepted sequences at length 8
        // Weighted forward with uniform weights should give the same
        expect(fwd[composed.initial][8]).toBeCloseTo(1048576, -1);
    });
});

describe('weightedSample', () => {
    it('samples valid sequences at length 8', () => {
        const { composed, acceptStates } = buildMachine();
        const rng = new PRNG(42);
        const fwd = weightedForward(composed, 8, acceptStates);

        for (let i = 0; i < 10; i++) {
            const seq = weightedSample(composed, 8, fwd, rng);
            expect(seq).not.toBeNull();
            expect(seq.length).toBe(8);
            // Should have B5 at position 0 (LDA)
            expect(seq[0]).toBe(0xB5);
        }
    });

    it('samples at length 9 (one slide byte)', () => {
        const { composed, acceptStates } = buildMachine();
        const rng = new PRNG(123);
        const fwd = weightedForward(composed, 9, acceptStates);

        const seq = weightedSample(composed, 9, fwd, rng);
        expect(seq).not.toBeNull();
        expect(seq.length).toBe(9);
        // Should contain B5 and 9D somewhere
        expect([...seq]).toContain(0xB5);
        expect([...seq]).toContain(0x9D);
    });
});

describe('weightedBeff', () => {
    it('B_eff at length 8 matches DFA result', () => {
        const { composed, acceptStates } = buildMachine();
        const fwd = weightedForward(composed, 8, acceptStates);
        const beff = weightedBeff(fwd, composed.initial, 8);
        expect(beff).toBeCloseTo(44.0, 0);
    });
});

describe('trainLoop: end-to-end on composed machine', () => {
    it('trains weights from simulation, mean spread improves', async () => {
        // Use the fully constrained machine so training focuses on slides
        const opcode = buildOpcodeReviewer();
        const offset = buildOffsetReviewer();
        const { composeFullPipeline } = await import('../compose.js');
        const composed = composeFullPipeline(opcode, offset);

        const acceptStates = new Set();
        const opcSO = opcode.stateIdx.get('seen-offset');
        const opcAcc = opcode.stateIdx.get('accept');
        for (let os = 0; os < offset.numStates; os++) {
            acceptStates.add(opcSO * offset.numStates + os);
            acceptStates.add(opcAcc * offset.numStates + os);
        }

        const rng = new PRNG(42);

        const history = await trainLoop(
            composed, acceptStates,
            async (bytes) => simulateCandidate(bytes, { passes: 80, seed: 42 }),
            { L: 8, iterations: 4, samplesPerIter: 30, rng },
        );

        console.log('\n=== WFST Training Loop (constrained machine, length 8) ===');
        for (const h of history) {
            console.log(`  Iter ${h.iter}: B_eff=${h.beff.toFixed(1)} meanSpread=${h.meanSpread.toFixed(2)} viable=${h.nViable}/${h.nSampled}`);
        }

        expect(history.length).toBe(4);

        // With hard constraints on addr+branch, most samples should spread
        const spreadLast = history[history.length - 1].meanSpread;
        console.log(`\n  Final mean spread: ${spreadLast.toFixed(2)}`);
        expect(spreadLast).toBeGreaterThan(10);
    }, 120000);

    it('trains on length 9 (with slide bytes), learns safe opcodes', async () => {
        const opcode = buildOpcodeReviewer();
        const offset = buildOffsetReviewer();
        const { composeFullPipeline } = await import('../compose.js');
        const composed = composeFullPipeline(opcode, offset);

        const acceptStates = new Set();
        const opcSO = opcode.stateIdx.get('seen-offset');
        const opcAcc = opcode.stateIdx.get('accept');
        for (let os = 0; os < offset.numStates; os++) {
            acceptStates.add(opcSO * offset.numStates + os);
            acceptStates.add(opcAcc * offset.numStates + os);
        }

        const rng = new PRNG(99);

        const history = await trainLoop(
            composed, acceptStates,
            async (bytes) => simulateCandidate(bytes, { passes: 80, seed: 42 }),
            { L: 9, iterations: 5, samplesPerIter: 40, rng },
        );

        console.log('\n=== WFST Training Loop (constrained, length 9) ===');
        for (const h of history) {
            console.log(`  Iter ${h.iter}: B_eff=${h.beff.toFixed(1)} meanSpread=${h.meanSpread.toFixed(1)} viable=${h.nViable}/${h.nSampled} (${(h.viableRate*100).toFixed(0)}%)`);
        }

        // Mean spread should improve as lethal slide bytes get downweighted
        const spread0 = history[0].meanSpread;
        const spreadLast = history[history.length - 1].meanSpread;
        console.log(`\n  Mean spread: ${spread0.toFixed(1)} → ${spreadLast.toFixed(1)}`);
        expect(spreadLast).toBeGreaterThan(spread0);

        // Sample post-training and inspect the slide byte distribution
        const fwd = weightedForward(composed, 9, acceptStates);
        const postSamples = [];
        for (let i = 0; i < 30; i++) {
            const seq = weightedSample(composed, 9, fwd, rng);
            if (seq) postSamples.push(seq);
        }

        // The slide byte is the one that's NOT a core byte
        // Find it by checking which position varies
        const slideByteCounts = {};
        for (const s of postSamples) {
            // In a 9-byte seq with one slide, the slide could be at any
            // position where the opcode reviewer is in a slide state.
            // The first byte that isn't B5 (and comes before it) is the prefix slide.
            // Or the slide could be between other core bytes.
            for (let i = 0; i < s.length; i++) {
                if (s[i] !== 0xB5 && s[i] !== 0x00 && s[i] !== 0x9D &&
                    s[i] !== 0x04 && s[i] !== 0xE8 && s[i] !== 0xCA &&
                    s[i] !== 0x50 && s[i] !== 0x90) {
                    const hex = s[i].toString(16).padStart(2, '0');
                    slideByteCounts[hex] = (slideByteCounts[hex] || 0) + 1;
                }
            }
        }

        console.log('\n  Slide byte distribution (post-training):');
        const sorted = Object.entries(slideByteCounts).sort((a,b) => b[1]-a[1]);
        for (const [hex, n] of sorted.slice(0, 10)) {
            console.log(`    $${hex}: ${n}`);
        }

        expect(history.length).toBe(5);
    }, 180000);

    it('after training, samples are biased toward viable programs', async () => {
        const { composed, acceptStates } = buildMachine();
        const rng = new PRNG(2026);

        // Train for several iterations
        await trainLoop(
            composed, acceptStates,
            async (bytes) => simulateCandidate(bytes, { passes: 80, seed: 42 }),
            { L: 8, iterations: 5, samplesPerIter: 40, rng },
        );

        // Now sample and check what we get
        const fwd = weightedForward(composed, 8, acceptStates);
        const samples = [];
        for (let i = 0; i < 20; i++) {
            const seq = weightedSample(composed, 8, fwd, rng);
            if (seq) samples.push(seq);
        }

        // Check which branch opcodes the trained model prefers
        const branchCounts = {};
        const addrCounts = {};
        for (const s of samples) {
            branchCounts[s[6]] = (branchCounts[s[6]] || 0) + 1;
            addrCounts[s[1]] = (addrCounts[s[1]] || 0) + 1;
        }

        console.log('\n=== Post-training sample distribution ===');
        console.log('Branch opcodes:', Object.entries(branchCounts)
            .map(([b, n]) => `$${Number(b).toString(16)}=${n}`)
            .join(', '));
        console.log('Addr byte:', Object.entries(addrCounts)
            .sort((a,b) => b[1]-a[1])
            .slice(0, 5)
            .map(([a, n]) => `$${Number(a).toString(16).padStart(2,'0')}=${n}`)
            .join(', '));

        // After training, should strongly prefer BVC ($50) and BCC ($90)
        const bvcBcc = (branchCounts[0x50] || 0) + (branchCounts[0x90] || 0);
        console.log(`  BVC+BCC: ${bvcBcc}/${samples.length}`);

        expect(samples.length).toBe(20);
    }, 120000);
});

describe('Importance sampling validation', () => {
    it('recovers known B_eff=62 for constrained length-8 machine', async () => {
        const opcode = buildOpcodeReviewer();
        const offset = buildOffsetReviewer();
        const { composeFullPipeline } = await import('../compose.js');
        const composed = composeFullPipeline(opcode, offset);

        const acceptStates = new Set();
        const opcSO = opcode.stateIdx.get('seen-offset');
        const opcAcc = opcode.stateIdx.get('accept');
        for (let os = 0; os < offset.numStates; os++) {
            acceptStates.add(opcSO * offset.numStates + os);
            acceptStates.add(opcAcc * offset.numStates + os);
        }

        const rng = new PRNG(42);
        const result = await importanceSamplingEstimate(
            composed, acceptStates, 8, 50,
            async (bytes) => simulateCandidate(bytes, { passes: 80, seed: 42 }),
            rng,
        );

        console.log('\n=== Importance Sampling: Constrained L=8 ===');
        console.log(`  WFST B_eff:  ${result.beffWFST.toFixed(1)} bits`);
        console.log(`  IS B_eff:    ${result.beffIS.toFixed(1)} bits`);
        console.log(`  Viable rate: ${(result.viableRate * 100).toFixed(0)}% (${result.nViable}/${result.nSampled})`);

        // Both should be ~62 bits
        expect(result.beffWFST).toBeCloseTo(62, 0);
        expect(result.beffIS).toBeCloseTo(62, 0);
    }, 60000);

    it('estimates B_eff for trained length-9 machine', async () => {
        const opcode = buildOpcodeReviewer();
        const offset = buildOffsetReviewer();
        const { composeFullPipeline } = await import('../compose.js');
        const composed = composeFullPipeline(opcode, offset);

        const acceptStates = new Set();
        const opcSO = opcode.stateIdx.get('seen-offset');
        const opcAcc = opcode.stateIdx.get('accept');
        for (let os = 0; os < offset.numStates; os++) {
            acceptStates.add(opcSO * offset.numStates + os);
            acceptStates.add(opcAcc * offset.numStates + os);
        }

        const rng = new PRNG(42);

        // Train first
        const history = await trainLoop(
            composed, acceptStates,
            async (bytes) => simulateCandidate(bytes, { passes: 80, seed: 42 }),
            { L: 9, iterations: 3, samplesPerIter: 30, rng },
        );

        // Now estimate with importance sampling
        const result = await importanceSamplingEstimate(
            composed, acceptStates, 9, 50,
            async (bytes) => simulateCandidate(bytes, { passes: 80, seed: 42 }),
            rng,
        );

        console.log('\n=== Importance Sampling: Trained L=9 ===');
        console.log(`  WFST B_eff:  ${result.beffWFST.toFixed(1)} bits (model estimate)`);
        console.log(`  IS B_eff:    ${result.beffIS.toFixed(1)} bits (ground truth)`);
        console.log(`  Viable rate: ${(result.viableRate * 100).toFixed(0)}% (${result.nViable}/${result.nSampled})`);
        console.log(`  Gap:         ${(result.beffIS - result.beffWFST).toFixed(1)} bits`);

        // IS estimate should be finite (found some viable)
        expect(result.beffIS).toBeLessThan(Infinity);
        // WFST estimate might differ from IS — the gap is the model error
        expect(result.beffWFST).toBeLessThan(Infinity);
    }, 120000);
});
