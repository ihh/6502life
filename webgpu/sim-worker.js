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

let censusSkip = 0;
const FULL_CENSUS_INTERVAL = 16; // full census (functional count) every 16 ticks

// Reusable yield channel (avoid creating new MessageChannel every tick)
const _yieldCh = new MessageChannel();
function yieldToMessages() {
    return new Promise(r => { _yieldCh.port1.onmessage = r; _yieldCh.port2.postMessage(0); });
}

// --- Diagnostic counters ---
let _diagTicks = 0, _diagT0 = 0;
let _diagPassMs = 0, _diagCensusMs = 0, _diagYieldMs = 0, _diagPostMs = 0;
let _diagPasses = 0, _diagYieldCount = 0;

async function runLoop() {
    _diagT0 = performance.now();
    _diagTicks = 0;
    while (running) {
        const t1 = performance.now();

        passQueue += passesPerTick;
        const n = Math.floor(passQueue);
        passQueue -= n;

        for (let i = 0; i < n; i++) {
            sim.runPass();
            sim.runPass();
        }
        _diagPasses += n;

        // Apply cosmic rays after passes
        if (n > 0) applyCosmicRays();

        const t2 = performance.now();
        const _passElapsed = t2 - t1;
        _diagPassMs += _passElapsed;
        // Log individual passes that take >500ms (stall detection)
        if (_passElapsed > 500) {
            console.log(`[worker STALL] pass took ${_passElapsed.toFixed(0)}ms (${n} passes, tick ${_diagTicks})`);
        }

        // Lightweight quanta update every tick (no hashing)
        // quickCensus (grid chars) every 4 ticks, full census every 16
        censusSkip++;
        if (censusSkip >= FULL_CENSUS_INTERVAL) {
            censusSkip = 0;
            const c = sim.census();
            const t3a = performance.now();
            _diagCensusMs += t3a - t2;
            postMessage({ type: 'census', data: c, totalQuanta: sim.totalQuanta });
            _diagPostMs += performance.now() - t3a;
        } else if (censusSkip % 4 === 0) {
            const cellChars = sim.quickCensus();
            const t3a = performance.now();
            _diagCensusMs += t3a - t2;
            postMessage({ type: 'quickCensus', cellChars, totalQuanta: sim.totalQuanta });
            _diagPostMs += performance.now() - t3a;
        } else {
            postMessage({ type: 'quanta', totalQuanta: sim.totalQuanta });
            _diagPostMs += performance.now() - t2;
        }

        // Send trace if one was captured
        if (sim._lastTrace) {
            postMessage({ type: 'trace', data: sim._lastTrace });
            sim._lastTrace = null;
        }

        // Yield to allow message processing (speed/stop commands)
        const tY0 = performance.now();
        await yieldToMessages();
        _diagYieldMs += performance.now() - tY0;
        _diagYieldCount++;

        // Diagnostic: every 3 seconds, report timing breakdown
        _diagTicks++;
        const elapsed = performance.now() - _diagT0;
        if (elapsed > 3000) {
            console.log(`[worker diag] ${(elapsed/1000).toFixed(1)}s: ` +
                `ticks=${_diagTicks} passes=${_diagPasses} ` +
                `pass=${_diagPassMs.toFixed(0)}ms census=${_diagCensusMs.toFixed(0)}ms ` +
                `post=${_diagPostMs.toFixed(0)}ms yield=${_diagYieldMs.toFixed(0)}ms ` +
                `(${_diagYieldCount} yields, avg=${(_diagYieldMs/_diagYieldCount).toFixed(1)}ms)`);
            _diagT0 = performance.now();
            _diagTicks = 0; _diagPassMs = 0; _diagCensusMs = 0;
            _diagYieldMs = 0; _diagPostMs = 0; _diagPasses = 0; _diagYieldCount = 0;
        }
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
        case 'loadBoard':
            // Bulk load: msg.data is an ArrayBuffer of the entire board
            // (register init values already set by blake3soup)
            if (sim) {
                sim.storage.set(new Uint8Array(msg.data));
                console.log('[worker] loadBoard:', msg.data.byteLength, 'bytes');
            } else {
                console.warn('[worker] loadBoard: sim not initialized');
            }
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
            // Don't reset passQueue — just change the rate
            break;
        case 'noise':
            noiseRate = msg.rate || 0;
            break;
        case 'traceCell':
            if (sim) sim._traceCell = msg.i >= 0 ? [msg.i, msg.j] : null;
            break;
        case 'census':
            if (sim) {
                const c = sim.census();
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
