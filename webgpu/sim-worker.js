/**
 * Web Worker for CPU-mode bare sim.
 */

import { BareSimCPU } from './bare-sim-cpu.js';

let sim = null;
let running = false;
let passesPerTick = 1;
let passQueue = 0;
let noiseRate = 0;

const MEAN_CYC = 4096;
function applyCosmicRays() {
    if (noiseRate <= 0 || !sim) return;
    const rng = sim.rng;
    const totalBytes = sim.B * sim.B * sim.M;
    const totalBits = totalBytes * 8;
    // noiseRate is per-bit per-cycle per-cell; convert to per-pass
    const lambda = noiseRate * MEAN_CYC * totalBits;
    let nFlips;
    if (lambda < 30) {
        let L = Math.exp(-lambda), k = 0, p = 1;
        do { k++; p *= rng.real(); } while (p > L);
        nFlips = k - 1;
    } else {
        const u1 = rng.real() || 1e-10, u2 = rng.real();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        nFlips = Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
    }
    for (let i = 0; i < nFlips; i++) {
        sim.storage[rng.below(totalBytes)] ^= (1 << rng.below(8));
    }
}

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

        // Apply cosmic rays after passes
        if (n > 0) applyCosmicRays();

        // Send census
        const c = await sim.census();
        postMessage({ type: 'census', data: c, totalQuanta: sim.totalQuanta });

        // Send trace if one was captured
        if (sim._lastTrace) {
            postMessage({ type: 'trace', data: sim._lastTrace });
            sim._lastTrace = null;
        }

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
            passQueue = 0;
            break;
        case 'noise':
            noiseRate = msg.rate || 0;
            break;
        case 'traceCell':
            if (sim) sim._traceCell = msg.i >= 0 ? [msg.i, msg.j] : null;
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
