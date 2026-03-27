#!/usr/bin/env node
/**
 * Reproducibility test: run the same seed twice, verify identical state.
 * This is the foundation for Merkle tree board histories.
 *
 * If this test passes, then:
 * - The initial state is deterministic from the seed
 * - The scheduling is deterministic from the PRNG
 * - The 6502 execution is deterministic
 * - The final state is reproducible
 * - A Merkle tree over checkpoints is verifiable by replay
 */

import { BareSimCPU } from './bare-sim-cpu.js';

const B = 16;
const QUANTA = 10000;  // ~20 passes

async function runSim(seed) {
    const sim = await BareSimCPU.create(B, { seed });
    // Plant BCC replicator at (0,0)
    sim.writeCell(0, 0, 0, [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]);
    sim.writeCell(0, 0, 0xF9, [0x00, 0x00]);
    sim.writeCell(0, 0, 0xFF, [0xFF]);

    // Run
    const passCount = Math.ceil(QUANTA / (B * B / 2));
    for (let i = 0; i < passCount; i++) {
        await sim.runPass();
        await sim.runPass();
    }

    return {
        hash: sim.getStateHash(),
        totalQuanta: sim.totalQuanta,
        rngState: sim.rng.state,
        sample: Array.from(sim.storage.slice(0, 32)),
    };
}

console.log('Reproducibility test: ' + B + 'x' + B + ' board, ' + QUANTA + '+ quanta\n');

// Run twice with same seed
const seed = 12345;
console.log('Run 1 (seed=' + seed + ')...');
const r1 = await runSim(seed);
console.log('  hash=' + r1.hash + ' quanta=' + r1.totalQuanta + ' rng=' + r1.rngState);

console.log('Run 2 (seed=' + seed + ')...');
const r2 = await runSim(seed);
console.log('  hash=' + r2.hash + ' quanta=' + r2.totalQuanta + ' rng=' + r2.rngState);

// Verify identical
const pass = r1.hash === r2.hash && r1.totalQuanta === r2.totalQuanta && r1.rngState === r2.rngState;
console.log('\nState hashes match: ' + (r1.hash === r2.hash));
console.log('Quanta match: ' + (r1.totalQuanta === r2.totalQuanta));
console.log('RNG state match: ' + (r1.rngState === r2.rngState));
console.log('First 32 bytes match: ' + (JSON.stringify(r1.sample) === JSON.stringify(r2.sample)));

// Run with different seed — should differ
console.log('\nRun 3 (seed=99999)...');
const r3 = await runSim(99999);
console.log('  hash=' + r3.hash);
console.log('Different seed produces different state: ' + (r1.hash !== r3.hash));

console.log('\n' + (pass ? 'PASS: Simulation is deterministic and reproducible.' : 'FAIL: Non-deterministic!'));
process.exit(pass ? 0 : 1);
