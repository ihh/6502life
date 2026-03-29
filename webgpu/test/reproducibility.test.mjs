/**
 * Reproducibility tests: board histories must be 100% deterministic
 * from seed, with or without cosmic ray noise, on CPU.
 *
 * GPU reproducibility is verified separately (same PRNG, same pairs,
 * but GPU float nondeterminism could theoretically differ — the CPU
 * test is the ground truth).
 */

import { describe, it, expect } from 'vitest';
import { BareSimCPU } from '../bare-sim-cpu.js';
import { PRNG } from '../prng.js';

const B = 8;  // small board for fast tests
const PASSES = 20;
const M = 1024;
const TOTAL_BYTES = B * B * M;
const TOTAL_BITS = TOTAL_BYTES * 8;

function plantReplicator(sim) {
    sim.writeCell(0, 0, 0, [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]);
    sim.writeCell(0, 0, 0xF9, [0x00, 0x00]);
    sim.writeCell(0, 0, 0xFF, [0xFF]);
}

function sampleFlipCount(rng, p) {
    if (p <= 0) return 0;
    const lambda = p * TOTAL_BITS;
    if (lambda < 30) {
        let L = Math.exp(-lambda), k = 0, pr = 1;
        do { k++; pr *= rng.real(); } while (pr > L);
        return k - 1;
    }
    const u1 = rng.real() || 1e-10, u2 = rng.real();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
}

function applyCosmicRays(sim, noiseRate) {
    if (noiseRate <= 0) return;
    const rng = sim.rng;
    const nFlips = sampleFlipCount(rng, noiseRate);
    for (let i = 0; i < nFlips; i++) {
        const byteIdx = rng.below(TOTAL_BYTES);
        const bitIdx = rng.below(8);
        sim.storage[byteIdx] ^= (1 << bitIdx);
    }
}

async function runSim(seed, { passes = PASSES, noiseRate = 0 } = {}) {
    const sim = await BareSimCPU.create(B, { seed });
    plantReplicator(sim);
    for (let i = 0; i < passes; i++) {
        await sim.runPass();
        await sim.runPass();
        if (noiseRate > 0) applyCosmicRays(sim, noiseRate);
    }
    return {
        hash: sim.getStateHash(),
        totalQuanta: sim.totalQuanta,
        rngState: sim.rng.state,
        storageSample: Array.from(sim.storage.slice(0, 64)),
    };
}

describe('CPU reproducibility', () => {
    it('same seed produces identical state (no noise)', async () => {
        const r1 = await runSim(42);
        const r2 = await runSim(42);
        expect(r1.hash).toBe(r2.hash);
        expect(r1.totalQuanta).toBe(r2.totalQuanta);
        expect(r1.rngState).toBe(r2.rngState);
        expect(r1.storageSample).toEqual(r2.storageSample);
    });

    it('different seed produces different state', async () => {
        const r1 = await runSim(42);
        const r2 = await runSim(99999);
        expect(r1.hash).not.toBe(r2.hash);
    });

    it('same seed produces identical state (with cosmic rays)', async () => {
        const noise = 1e-6;  // ~0.5 flips per pass on 8x8 board
        const r1 = await runSim(42, { noiseRate: noise });
        const r2 = await runSim(42, { noiseRate: noise });
        expect(r1.hash).toBe(r2.hash);
        expect(r1.totalQuanta).toBe(r2.totalQuanta);
        expect(r1.rngState).toBe(r2.rngState);
        expect(r1.storageSample).toEqual(r2.storageSample);
    });

    it('same seed, different noise rate produces different state', async () => {
        const r1 = await runSim(42, { noiseRate: 0 });
        const r2 = await runSim(42, { noiseRate: 1e-5 });
        expect(r1.hash).not.toBe(r2.hash);
    });

    it('cosmic rays actually modify storage', async () => {
        const r_clean = await runSim(42, { noiseRate: 0 });
        const r_noisy = await runSim(42, { noiseRate: 1e-4, passes: 50 });
        // With high noise and many passes, storage must differ
        expect(r_clean.hash).not.toBe(r_noisy.hash);
    });

    it('cosmic rays consume PRNG state deterministically', async () => {
        // Run with noise, check that PRNG state diverges from no-noise
        const r1 = await runSim(42, { noiseRate: 0 });
        const r2 = await runSim(42, { noiseRate: 1e-5 });
        // PRNG states should differ because noise consumed extra PRNG calls
        expect(r1.rngState).not.toBe(r2.rngState);
    });

    it('longer runs remain reproducible', async () => {
        const r1 = await runSim(7, { passes: 100, noiseRate: 1e-6 });
        const r2 = await runSim(7, { passes: 100, noiseRate: 1e-6 });
        expect(r1.hash).toBe(r2.hash);
        expect(r1.rngState).toBe(r2.rngState);
    });
});

describe('PRNG determinism', () => {
    it('PRNG produces same sequence from same seed', () => {
        const a = new PRNG(12345);
        const b = new PRNG(12345);
        for (let i = 0; i < 1000; i++) {
            expect(a.int()).toBe(b.int());
        }
    });

    it('PRNG state serialization round-trips', () => {
        const a = new PRNG(42);
        for (let i = 0; i < 100; i++) a.int();
        const saved = a.state;
        const b = new PRNG(0);
        b.state = saved;
        for (let i = 0; i < 100; i++) {
            expect(a.int()).toBe(b.int());
        }
    });
});
