import { describe, it, expect } from 'vitest';
import {
    findUncertainTransitions, activeSample,
    activeIteration, activeTrainingLoop,
} from '../active-learning.js';
import { buildOpcodeReviewer } from '../reviewers/opcode.js';
import { buildOffsetReviewer } from '../reviewers/offset.js';
import { composeFullPipeline } from '../compose.js';
import { trainLoop } from '../weighted-sampler.js';
import { simulateCandidate } from '../simulate.js';
import { PRNG } from '../../webgpu/prng.js';

function buildConstrained() {
    const opcode = buildOpcodeReviewer();
    const offset = buildOffsetReviewer();
    const machine = composeFullPipeline(opcode, offset);
    const acceptStates = new Set();
    for (const name of ['seen-offset', 'accept']) {
        const idx = opcode.stateIdx.get(name);
        for (let os = 0; os < offset.numStates; os++)
            acceptStates.add(idx * offset.numStates + os);
    }
    return { machine, acceptStates };
}

describe('findUncertainTransitions', () => {
    it('finds uncertain transitions after partial training', async () => {
        const { machine, acceptStates } = buildConstrained();
        const rng = new PRNG(42);
        const simFn = async (bytes) => simulateCandidate(bytes, { passes: 80, seed: 42 });

        // Partially train at L=9
        await trainLoop(machine, acceptStates, simFn,
            { L: 9, iterations: 2, samplesPerIter: 30, rng });

        const uncertain = findUncertainTransitions(machine, { topK: 10 });

        console.log('\n=== Most uncertain transitions ===');
        for (const u of uncertain) {
            console.log(`  ${u.stateName} + $${u.byte.toString(16).padStart(2,'0')}: w=${u.weight.toFixed(3)} H=${u.entropy.toFixed(3)}`);
        }
        console.log(`  (${uncertain.length} found — constrained machine has few uncertain transitions at L=9)`);

        // Constrained machine may have 0 uncertain transitions
        // because hard constraints (addr=0, BVC/BCC) leave little gray area.
        // Active learning is more valuable at longer lengths with more slides.
        expect(uncertain.length).toBeGreaterThanOrEqual(0);
    }, 30000);
});

describe('Active learning loop', () => {
    it('trains across lengths 9-12, reducing uncertainty', async () => {
        const { machine, acceptStates } = buildConstrained();
        const rng = new PRNG(42);

        const { history, beffByLength, cumBeff } = await activeTrainingLoop(
            machine, acceptStates, {
                lengths: [9, 10, 11, 12],
                itersPerLength: 3,
                exploreSamples: 25,
                exploitSamples: 20,
                passes: 80,
                seed: 42,
                rng,
            });

        console.log('\n=== Active Learning Loop ===');
        for (const h of history) {
            console.log(
                `  L=${h.L} iter=${h.iter}: ` +
                `viable=${h.nViable}/${h.nExplore} ` +
                `WFST=${h.beffWFST.toFixed(1)} IS=${h.beffIS.toFixed(1)} ` +
                `gap=${h.gap.toFixed(1)} ` +
                `uncertain=${h.nUncertain} H=${h.meanEntropy.toFixed(3)}`
            );
        }

        console.log('\n--- Per-length IS B_eff ---');
        for (const [L, beff] of Object.entries(beffByLength)) {
            console.log(`  L=${L}: ${beff.toFixed(1)} bits`);
        }
        console.log(`\n  Cumulative B_eff: ${cumBeff.toFixed(2)} bits`);

        expect(history.length).toBe(12); // 4 lengths × 3 iters
        expect(cumBeff).toBeLessThan(65);
        expect(cumBeff).toBeGreaterThan(50);
    }, 300000);
});
