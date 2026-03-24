#!/usr/bin/env node

// Cross-board evolution experiments using EdgeSession social mining infrastructure
// Tests organism migration, divergent evolution, asymmetric noise, and competition

import { writeFileSync } from 'fs';
import { Board6502Engine } from '../coin/engines/board6502.js';
import { EdgeSession } from '../coin/social.js';
import { readCellMemory } from '../engine/board.js';
import { minhash, minhashSimilarity } from '../cli/lib/probe/fingerprint.js';

// Suppress console.error
const origError = console.error;
console.error = () => {};

// ── Helpers ──────────────────────────────────────────────────────────────

function isFuncAlive(controller, i, j) {
    const mem = readCellMemory(controller, i, j);
    return mem[0] === 0x00 && mem[1] >= 0xF5 && mem[1] <= 0xFC;
}

function countAlive(controller, size) {
    let count = 0;
    for (let i = 0; i < size; i++)
        for (let j = 0; j < size; j++)
            if (isFuncAlive(controller, i, j)) count++;
    return count;
}

function cellFingerprint64(controller, i, j) {
    const mem = readCellMemory(controller, i, j);
    let hash = 0;
    for (let b = 0; b < 64; b++) {
        hash = ((hash << 5) - hash + mem[b]) | 0;
    }
    return hash;
}

function countUniqueFingerprints(controller, size) {
    const fps = new Set();
    for (let i = 0; i < size; i++)
        for (let j = 0; j < size; j++)
            fps.add(cellFingerprint64(controller, i, j));
    return fps.size;
}

// Get MinHash fingerprint for a cell (code region: bytes 0-896)
function getCellMinhash(controller, i, j) {
    const mem = readCellMemory(controller, i, j);
    return minhash(mem, 0, 896);
}

// Average pairwise MinHash similarity across all cells on a board
function avgBoardSimilarity(controller, size) {
    const sigs = [];
    for (let i = 0; i < size; i++)
        for (let j = 0; j < size; j++)
            sigs.push(getCellMinhash(controller, i, j));
    let totalSim = 0, pairs = 0;
    for (let a = 0; a < sigs.length; a++) {
        for (let b = a + 1; b < sigs.length; b++) {
            totalSim += minhashSimilarity(sigs[a], sigs[b]);
            pairs++;
        }
    }
    return pairs > 0 ? totalSim / pairs : 0;
}

// Cross-board average MinHash similarity (cells on A vs cells on B)
function crossBoardSimilarity(ctrlA, ctrlB, size) {
    const sigsA = [], sigsB = [];
    for (let i = 0; i < size; i++)
        for (let j = 0; j < size; j++) {
            sigsA.push(getCellMinhash(ctrlA, i, j));
            sigsB.push(getCellMinhash(ctrlB, i, j));
        }
    let totalSim = 0, pairs = 0;
    for (const sa of sigsA) {
        for (const sb of sigsB) {
            totalSim += minhashSimilarity(sa, sb);
            pairs++;
        }
    }
    return pairs > 0 ? totalSim / pairs : 0;
}

// Check if nano-2x pattern exists at a cell (first 8 bytes match)
function isNano2x(controller, i, j, refBytes) {
    const mem = readCellMemory(controller, i, j);
    let match = 0;
    for (let b = 0; b < refBytes.length; b++) {
        if (mem[b] === refBytes[b]) match++;
    }
    return match >= 6;
}

function countNano2x(controller, size, refBytes) {
    let count = 0;
    for (let i = 0; i < size; i++)
        for (let j = 0; j < size; j++)
            if (isNano2x(controller, i, j, refBytes)) count++;
    return count;
}

// Check for red or blue organisms by code pattern match
// Red: A9 01 8D A0 03 00 F5 ... Blue: A9 AA 8D A0 03 00 F5 ...
// Both share the same structure; only byte 1 (LDA immediate) differs.
function countByColor(controller, size, redRef, blueRef) {
    let red = 0, blue = 0, other = 0;
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            const mem = readCellMemory(controller, i, j);
            // Check common structure: A9 xx 8D A0 03 00 F5
            const isRedLike = mem[0] === 0xA9 && mem[2] === 0x8D && mem[5] === 0x00 && mem[6] >= 0xF5 && mem[6] <= 0xFC;
            if (isRedLike) {
                if (mem[1] === redRef[1]) red++;
                else if (mem[1] === blueRef[1]) blue++;
                else other++; // mutant with different hue value
            } else {
                other++;
            }
        }
    }
    return { red, blue, other };
}

function makeEngine(size, seed, eps, presets) {
    const engine = new Board6502Engine();
    const config = { size, seed };
    if (eps != null) config.pBitNoise = eps;
    if (presets) config.presets = presets;
    engine.init(config);
    return engine;
}

function fmtTicks(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
    return String(n);
}

// ── Output ───────────────────────────────────────────────────────────────

const output = [];
function log(s = '') { output.push(s); }

// ── Experiment 1: Organism migration across boards ──────────────────────

async function experiment1() {
    log('## Experiment 1: Organism Migration Across Boards');
    log('');
    log('### Setup');
    log('- Two 8x8 boards, both at eps=0 (no noise)');
    log('- Board A: nano-2x at (0,0). Board B: empty (zeroed).');
    log('- Share south(A)->north(B) edge every 100 ticks for 200k ticks');
    log('- Tracking: when nano-2x first appears on Board B, colonization rate');
    log('');

    const size = 8;
    const engineA = makeEngine(size, 42, 0, [{ name: 'nano-2x', cell: [0, 0] }]);
    const engineB = makeEngine(size, 99, 0, []);
    await engineA.ready();
    await engineB.ready();

    // Zero board B explicitly
    const { zeroAllCells } = await import('../engine/board.js');
    zeroAllCells(engineB.controller);

    // Get nano-2x reference bytes
    const nanoRef = readCellMemory(engineA.controller, 0, 0).slice(0, 8);

    const session = new EdgeSession(engineA, engineB, {
        edgeA: 'south',
        edgeB: 'south',
        shareInterval: 100,
    });

    log('### Results');
    log('');
    log('| Ticks | A alive | A nano-2x | B alive | B nano-2x | Shares |');
    log('|-------|---------|-----------|---------|-----------|--------|');

    const checkpoints = [0, 1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 150_000, 200_000];
    let totalDone = 0;
    let firstAppearB = null;

    for (const cp of checkpoints) {
        const toRun = cp - totalDone;
        if (toRun > 0) session.step(toRun);
        totalDone = cp;

        const aliveA = countAlive(engineA.controller, size);
        const aliveB = countAlive(engineB.controller, size);
        const nanoA = countNano2x(engineA.controller, size, nanoRef);
        const nanoB = countNano2x(engineB.controller, size, nanoRef);

        if (nanoB > 0 && firstAppearB === null) firstAppearB = cp;

        const shares = session.framesAtoB.length;
        log(`| ${fmtTicks(cp)} | ${aliveA} | ${nanoA} | ${aliveB} | ${nanoB} | ${shares} |`);
    }
    log('');
    log(`**First nano-2x appearance on Board B:** ${firstAppearB !== null ? fmtTicks(firstAppearB) + ' ticks' : 'never'}`);
    log('');
}

// ── Experiment 2: Divergent evolution ────────────────────────────────────

async function experiment2() {
    log('## Experiment 2: Divergent Evolution');
    log('');
    log('### Setup');
    log('- Two 8x8 boards, both seeded with nano-2x at (0,0), eps=1/131072');
    log('- Share edge every 500 ticks for 1M ticks (connected phase)');
    log('- Then run each independently for another 1M ticks (isolated phase)');
    log('- Compare populations using MinHash fingerprinting');
    log('');

    const size = 8;
    const eps = 1 / 131072;
    const engineA = makeEngine(size, 42, eps, [{ name: 'nano-2x', cell: [0, 0] }]);
    const engineB = makeEngine(size, 99, eps, [{ name: 'nano-2x', cell: [0, 0] }]);
    await engineA.ready();
    await engineB.ready();

    const nanoRef = readCellMemory(engineA.controller, 0, 0).slice(0, 8);

    const session = new EdgeSession(engineA, engineB, {
        edgeA: 'east',
        edgeB: 'west',
        shareInterval: 500,
    });

    log('### Connected Phase (1M ticks, sharing every 500)');
    log('');
    log('| Ticks | A alive | B alive | A unique | B unique | Cross-sim | A-self-sim | B-self-sim |');
    log('|-------|---------|---------|----------|----------|-----------|------------|------------|');

    const connCheckpoints = [0, 100_000, 250_000, 500_000, 750_000, 1_000_000];
    let totalDone = 0;

    for (const cp of connCheckpoints) {
        const toRun = cp - totalDone;
        if (toRun > 0) session.step(toRun);
        totalDone = cp;

        const aliveA = countAlive(engineA.controller, size);
        const aliveB = countAlive(engineB.controller, size);
        const uniqueA = countUniqueFingerprints(engineA.controller, size);
        const uniqueB = countUniqueFingerprints(engineB.controller, size);
        const crossSim = crossBoardSimilarity(engineA.controller, engineB.controller, size).toFixed(3);
        const selfSimA = avgBoardSimilarity(engineA.controller, size).toFixed(3);
        const selfSimB = avgBoardSimilarity(engineB.controller, size).toFixed(3);

        log(`| ${fmtTicks(cp)} | ${aliveA} | ${aliveB} | ${uniqueA} | ${uniqueB} | ${crossSim} | ${selfSimA} | ${selfSimB} |`);
    }
    log('');

    log('### Isolated Phase (1M additional ticks, no sharing)');
    log('');
    log('| Ticks | A alive | B alive | A unique | B unique | Cross-sim | A-self-sim | B-self-sim |');
    log('|-------|---------|---------|----------|----------|-----------|------------|------------|');

    const isoCheckpoints = [0, 250_000, 500_000, 750_000, 1_000_000];
    let isoDone = 0;

    for (const cp of isoCheckpoints) {
        const toRun = cp - isoDone;
        if (toRun > 0) {
            engineA.step(toRun);
            engineB.step(toRun);
        }
        isoDone = cp;

        const aliveA = countAlive(engineA.controller, size);
        const aliveB = countAlive(engineB.controller, size);
        const uniqueA = countUniqueFingerprints(engineA.controller, size);
        const uniqueB = countUniqueFingerprints(engineB.controller, size);
        const crossSim = crossBoardSimilarity(engineA.controller, engineB.controller, size).toFixed(3);
        const selfSimA = avgBoardSimilarity(engineA.controller, size).toFixed(3);
        const selfSimB = avgBoardSimilarity(engineB.controller, size).toFixed(3);

        log(`| +${fmtTicks(cp)} | ${aliveA} | ${aliveB} | ${uniqueA} | ${uniqueB} | ${crossSim} | ${selfSimA} | ${selfSimB} |`);
    }
    log('');
}

// ── Experiment 3: Asymmetric noise ──────────────────────────────────────

async function experiment3() {
    log('## Experiment 3: Asymmetric Noise');
    log('');
    log('### Setup');
    log('- Board A: eps=0 (clean), Board B: eps=1/8192 (noisy)');
    log('- Both seeded with nano-2x at (0,0)');
    log('- Share east(A)->west(B) edge every 100 ticks for 500k ticks');
    log('- Questions: Do clean organisms survive on the noisy board?');
    log('  Do mutants from the noisy board invade the clean board?');
    log('');

    const size = 8;
    const engineA = makeEngine(size, 42, 0, [{ name: 'nano-2x', cell: [0, 0] }]);
    const engineB = makeEngine(size, 99, 1 / 8192, [{ name: 'nano-2x', cell: [0, 0] }]);
    await engineA.ready();
    await engineB.ready();

    const nanoRef = readCellMemory(engineA.controller, 0, 0).slice(0, 8);

    const session = new EdgeSession(engineA, engineB, {
        edgeA: 'east',
        edgeB: 'west',
        shareInterval: 100,
    });

    log('### Results');
    log('');
    log('| Ticks | A alive | A nano-2x | A unique | B alive | B nano-2x | B unique | Cross-sim |');
    log('|-------|---------|-----------|----------|---------|-----------|----------|-----------|');

    const checkpoints = [0, 10_000, 50_000, 100_000, 200_000, 300_000, 500_000];
    let totalDone = 0;

    for (const cp of checkpoints) {
        const toRun = cp - totalDone;
        if (toRun > 0) session.step(toRun);
        totalDone = cp;

        const aliveA = countAlive(engineA.controller, size);
        const aliveB = countAlive(engineB.controller, size);
        const nanoA = countNano2x(engineA.controller, size, nanoRef);
        const nanoB = countNano2x(engineB.controller, size, nanoRef);
        const uniqueA = countUniqueFingerprints(engineA.controller, size);
        const uniqueB = countUniqueFingerprints(engineB.controller, size);
        const crossSim = crossBoardSimilarity(engineA.controller, engineB.controller, size).toFixed(3);

        log(`| ${fmtTicks(cp)} | ${aliveA} | ${nanoA} | ${uniqueA} | ${aliveB} | ${nanoB} | ${uniqueB} | ${crossSim} |`);
    }
    log('');

    // Post-isolation analysis
    log('### Post-isolation (100k more ticks, no sharing)');
    log('');
    engineA.step(100_000);
    engineB.step(100_000);

    const aliveA = countAlive(engineA.controller, size);
    const aliveB = countAlive(engineB.controller, size);
    const nanoA = countNano2x(engineA.controller, size, nanoRef);
    const nanoB = countNano2x(engineB.controller, size, nanoRef);
    const crossSim = crossBoardSimilarity(engineA.controller, engineB.controller, size).toFixed(3);

    log(`- Board A (clean): ${aliveA} alive, ${nanoA} nano-2x`);
    log(`- Board B (noisy): ${aliveB} alive, ${nanoB} nano-2x`);
    log(`- Cross-board similarity: ${crossSim}`);
    log('');
}

// ── Experiment 4: Red vs Blue across boards ─────────────────────────────

async function experiment4() {
    log('## Experiment 4: Red vs Blue Across Boards');
    log('');
    log('### Setup');
    log('- Board A: red organism at (0,0). Board B: blue organism at (0,0).');
    log('- Both boards 8x8, eps=0');
    log('- Share east(A)->west(B) edge every 100 ticks for 500k ticks');
    log('- Red writes hue=0x01 to $3A0, Blue writes hue=0xAA to $3A0');
    log('');

    const size = 8;
    const engineA = makeEngine(size, 42, 0, [{ name: 'red', cell: [0, 0] }]);
    const engineB = makeEngine(size, 99, 0, [{ name: 'blue', cell: [0, 0] }]);
    await engineA.ready();
    await engineB.ready();

    // Get reference bytes for red and blue organisms
    const redRef = readCellMemory(engineA.controller, 0, 0).slice(0, 11);
    const blueRef = readCellMemory(engineB.controller, 0, 0).slice(0, 11);

    const session = new EdgeSession(engineA, engineB, {
        edgeA: 'east',
        edgeB: 'west',
        shareInterval: 100,
    });

    log('### Results');
    log('');
    log('| Ticks | A-red | A-blue | A-other | B-red | B-blue | B-other |');
    log('|-------|-------|--------|---------|-------|--------|---------|');

    const checkpoints = [0, 5_000, 10_000, 25_000, 50_000, 100_000, 200_000, 300_000, 500_000];
    let totalDone = 0;

    for (const cp of checkpoints) {
        const toRun = cp - totalDone;
        if (toRun > 0) session.step(toRun);
        totalDone = cp;

        const colA = countByColor(engineA.controller, size, redRef, blueRef);
        const colB = countByColor(engineB.controller, size, redRef, blueRef);

        log(`| ${fmtTicks(cp)} | ${colA.red} | ${colA.blue} | ${colA.other} | ${colB.red} | ${colB.blue} | ${colB.other} |`);
    }
    log('');

    const colA = countByColor(engineA.controller, size, redRef, blueRef);
    const colB = countByColor(engineB.controller, size, redRef, blueRef);
    const totalRed = colA.red + colB.red;
    const totalBlue = colA.blue + colB.blue;
    if (totalRed > totalBlue) {
        log(`**Winner: Red** (${totalRed} cells vs ${totalBlue} blue)`);
    } else if (totalBlue > totalRed) {
        log(`**Winner: Blue** (${totalBlue} cells vs ${totalRed} red)`);
    } else {
        log(`**Draw** (${totalRed} red vs ${totalBlue} blue)`);
    }
    log('');
}

// ── Main ─────────────────────────────────────────────────────────────────

log('# Cross-Board Evolution Experiments');
log('');
log('Using EdgeSession social mining infrastructure for edge sharing.');
log('');
log('Date: 2026-03-23');
log('');

origError('Starting Experiment 1: Organism migration (200k ticks)...');
await experiment1();

origError('Starting Experiment 2: Divergent evolution (2M ticks)...');
await experiment2();

origError('Starting Experiment 3: Asymmetric noise (500k ticks)...');
await experiment3();

origError('Starting Experiment 4: Red vs Blue (500k ticks)...');
await experiment4();

writeFileSync(new URL('../doc/cross-board-experiments.md', import.meta.url), output.join('\n') + '\n');
origError('Results written to doc/cross-board-experiments.md');
