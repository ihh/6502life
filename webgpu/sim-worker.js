/**
 * Web Worker for CPU-mode bare sim.
 * Runs the 6502 interpreter off the main thread.
 */

import { BareSimCPU } from './bare-sim-cpu.js';

let sim = null;
let running = false;
let passesPerTick = 1;  // passes per ~16ms tick (fractional ok)
let passQueue = 0;

async function init(B) {
    sim = await BareSimCPU.create(B);
    postMessage({ type: 'ready' });
}

async function runLoop() {
    while (running) {
        passQueue += passesPerTick;
        const n = Math.floor(passQueue);
        passQueue -= n;

        for (let i = 0; i < n; i++) {
            await sim.runPass();
            await sim.runPass();
        }

        // Send census
        const c = await sim.census();
        postMessage({ type: 'census', data: c, totalQuanta: sim.totalQuanta });

        // Pace at ~60 ticks/sec
        await new Promise(r => setTimeout(r, 16));
    }
}

onmessage = async (e) => {
    const msg = e.data;
    switch (msg.type) {
        case 'init':
            await init(msg.B);
            break;
        case 'writeCell':
            if (sim) sim.writeCell(msg.i, msg.j, msg.offset, msg.data);
            break;
        case 'start':
            passesPerTick = msg.speed || 1;
            passQueue = 0;
            running = true;
            runLoop();
            break;
        case 'stop':
            running = false;
            break;
        case 'speed':
            passesPerTick = msg.speed || 1;
            passQueue = 0;  // reset accumulator to avoid burst
            break;
        case 'census':
            if (sim) {
                const c = await sim.census();
                postMessage({ type: 'census', data: c, totalQuanta: sim.totalQuanta });
            }
            break;
        case 'getCellView':
            if (sim && sim.getCellView) {
                const v = sim.getCellView(msg.i, msg.j);
                postMessage({
                    type: 'cellView', i: msg.i, j: msg.j,
                    data: v.data, writes: v.writes, fetches: v.fetches,
                });
            }
            break;
    }
};
