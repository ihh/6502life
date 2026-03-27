#!/usr/bin/env node
/**
 * Test that stop/start doesn't affect determinism.
 * Run 100 passes straight vs run 50, stop, run 50 more.
 */

import { BareSimCPU } from './bare-sim-cpu.js';

const B = 8;
const SEED = 42;

function plantReplicator(sim) {
    sim.writeCell(0, 0, 0, [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]);
    sim.writeCell(0, 0, 0xF9, [0x00, 0x00]);
    sim.writeCell(0, 0, 0xFF, [0xFF]);
}

// Run 1: 100 passes straight
const sim1 = await BareSimCPU.create(B, { seed: SEED });
plantReplicator(sim1);
for (let i = 0; i < 100; i++) { await sim1.runPass(); await sim1.runPass(); }
const h1 = sim1.getStateHash();

// Run 2: 50 passes, "stop" (do nothing), 50 more passes
const sim2 = await BareSimCPU.create(B, { seed: SEED });
plantReplicator(sim2);
for (let i = 0; i < 50; i++) { await sim2.runPass(); await sim2.runPass(); }
// "stop" — just a pause, no state change
for (let i = 0; i < 50; i++) { await sim2.runPass(); await sim2.runPass(); }
const h2 = sim2.getStateHash();

// Run 3: 10+20+30+40 passes with "stops" between
const sim3 = await BareSimCPU.create(B, { seed: SEED });
plantReplicator(sim3);
for (let i = 0; i < 10; i++) { await sim3.runPass(); await sim3.runPass(); }
for (let i = 0; i < 20; i++) { await sim3.runPass(); await sim3.runPass(); }
for (let i = 0; i < 30; i++) { await sim3.runPass(); await sim3.runPass(); }
for (let i = 0; i < 40; i++) { await sim3.runPass(); await sim3.runPass(); }
const h3 = sim3.getStateHash();

console.log('100 straight:    hash=' + h1 + ' quanta=' + sim1.totalQuanta);
console.log('50+50:           hash=' + h2 + ' quanta=' + sim2.totalQuanta);
console.log('10+20+30+40:     hash=' + h3 + ' quanta=' + sim3.totalQuanta);
console.log('');
console.log('All match: ' + (h1 === h2 && h2 === h3));
console.log(h1 === h2 && h2 === h3 ? 'PASS' : 'FAIL');
process.exit(h1 === h2 && h2 === h3 ? 0 : 1);
