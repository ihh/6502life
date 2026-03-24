#!/usr/bin/env node

// Re-run key ALife experiments after lastMoveTime[0] bug fix
// Date: 2026-03-23

import { readFileSync, writeFileSync } from 'fs';
import { createBoard, zeroAllCells, writeCellBytes, readCellMemory } from '../engine/board.js';
import { assemble } from '../engine/assembler.js';

// Suppress console.error crash messages from Sfotty
const origConsoleError = console.error;
function suppressCrashMessages() {
    console.error = (...args) => {
        const msg = args[0];
        if (typeof msg === 'string' && (msg.includes('crash') || msg.includes('Crash') || msg.includes('CRASH') || msg.includes('opcode'))) return;
        origConsoleError(...args);
    };
}
suppressCrashMessages();

// ── Helpers ──────────────────────────────────────────────────────────────

function loadPresetSource(name) {
    return readFileSync(new URL(`../presets/${name}.asm`, import.meta.url), 'utf-8');
}

async function assemblePreset(name) {
    return assemble(loadPresetSource(name));
}

function seedCell(controller, i, j, bytes, opts = {}) {
    const { N = undefined, pages = [0] } = opts;
    for (const page of pages) {
        writeCellBytes(controller, i, j, page * 0x100, bytes);
    }
    if (N !== undefined) {
        for (const page of pages) {
            writeCellBytes(controller, i, j, page * 0x100 + 0x42, new Uint8Array([N]));
        }
    }
}

function seedAllCells(controller, bytes, size, opts = {}) {
    for (let i = 0; i < size; i++)
        for (let j = 0; j < size; j++)
            seedCell(controller, i, j, bytes, opts);
}

function runInterrupts(controller, count) {
    for (let k = 0; k < count; k++) {
        controller.runToNextInterrupt();
    }
}

function isFuncAlive(controller, i, j) {
    const mem = readCellMemory(controller, i, j);
    return mem[0] === 0x00 && mem[1] >= 0xF5 && mem[1] <= 0xF8;
}

function countAlive(controller, size) {
    let count = 0;
    for (let i = 0; i < size; i++)
        for (let j = 0; j < size; j++)
            if (isFuncAlive(controller, i, j)) count++;
    return count;
}

function byteMatchFraction(cellMem, ref, rangeEnd) {
    let match = 0;
    for (let b = 0; b < rangeEnd; b++) {
        if (cellMem[b] === ref[b]) match++;
    }
    return match / rangeEnd;
}

function countHighFidelity(controller, size, refBytes, threshold = 0.8) {
    const rangeEnd = Math.min(refBytes.length, 0x43);
    let count = 0;
    for (let i = 0; i < size; i++)
        for (let j = 0; j < size; j++) {
            const mem = readCellMemory(controller, i, j);
            if (byteMatchFraction(mem, refBytes, rangeEnd) >= threshold) count++;
        }
    return count;
}

function readN(controller, i, j) {
    const mem = readCellMemory(controller, i, j);
    return mem[0x42];
}

function meanN(controller, size) {
    let sum = 0;
    for (let i = 0; i < size; i++)
        for (let j = 0; j < size; j++)
            sum += readN(controller, i, j);
    return sum / (size * size);
}

function nDistribution(controller, size) {
    const counts = {};
    for (let i = 0; i < size; i++)
        for (let j = 0; j < size; j++) {
            const n = readN(controller, i, j);
            counts[n] = (counts[n] || 0) + 1;
        }
    return counts;
}

function cellFingerprint(controller, i, j) {
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
            fps.add(cellFingerprint(controller, i, j));
    return fps.size;
}

function topNValues(dist, maxEntries = 5) {
    return Object.entries(dist)
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxEntries)
        .map(([n, c]) => `${n}:${c}`)
        .join(', ');
}

function formatLabel(cp) {
    if (cp === 0) return '0';
    if (cp >= 1_000_000) return `${(cp / 1_000_000).toFixed(1)}M`;
    return `${cp / 1000}k`;
}

// Count cells matching specific species patterns
function countSpecies(controller, size, tripBytes, nanoBytes) {
    let tripCount = 0, nanoCount = 0, otherCount = 0;
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            const mem = readCellMemory(controller, i, j);
            let tripMatch = 0;
            for (let b = 0; b < Math.min(8, tripBytes.length); b++)
                if (mem[b] === tripBytes[b]) tripMatch++;
            let nanoMatch = 0;
            for (let b = 0; b < nanoBytes.length; b++)
                if (mem[b] === nanoBytes[b]) nanoMatch++;
            if (tripMatch >= 6) tripCount++;
            else if (nanoMatch >= 6) nanoCount++;
            else otherCount++;
        }
    }
    return { tripCount, nanoCount, otherCount };
}

// Count cells that have been written to (proxy for "spread")
function countWrittenCells(controller, size) {
    let count = 0;
    const B = controller.memory.B;
    for (let i = 0; i < size; i++)
        for (let j = 0; j < size; j++) {
            const idx = i * B + j;
            if (controller.lastWriteTime[idx] > 0) count++;
        }
    return count;
}

// ── Output buffer ────────────────────────────────────────────────────────

const output = [];
function log(s = '') { output.push(s); origConsoleError(s); }

// ── Experiment 1: nano-2x viability sweep ────────────────────────────────

async function experiment1() {
    log('## Experiment 1: nano-2x viability sweep');
    log('');
    log('### Setup');
    log('- Board: 8x8, seed 42');
    log('- Organism: nano-2x at (0,0)');
    log('- Epsilon values: 0, 1/131072, 1/32768, 1/8192');
    log('- Duration: 5M interrupts each');
    log('- Metric: alive count (cells with BRK $F5-$F8 at byte 0)');
    log('');

    const epsilons = [0, 1/131072, 1/32768, 1/8192];
    const epsilonLabels = ['0', '1/131072', '1/32768', '1/8192'];
    const checkpoints = [500_000, 1_000_000, 2_000_000, 5_000_000];
    const nanoBytes = await assemblePreset('nano-2x');

    log('### Results');
    log('');
    log('| Epsilon | 500k | 1M | 2M | 5M |');
    log('|---------|------|-----|-----|-----|');

    for (let e = 0; e < epsilons.length; e++) {
        const eps = epsilons[e];
        const label = epsilonLabels[e];
        const size = 8;
        const { controller } = createBoard(size, 42, { pBitNoise: eps });
        zeroAllCells(controller);
        seedCell(controller, 0, 0, nanoBytes, { pages: [0] });

        const results = [];
        let totalDone = 0;
        for (const cp of checkpoints) {
            const toRun = cp - totalDone;
            if (toRun > 0) runInterrupts(controller, toRun);
            totalDone = cp;
            results.push(countAlive(controller, size));
        }
        log(`| ${label} | ${results.join(' | ')} |`);
    }
    log('');
}

// ── Experiment 2: Triplicator evolvable at eps=1/131072 ──────────────────

async function experiment2() {
    log('## Experiment 2: Triplicator evolvable at eps=1/131072 (10M interrupts)');
    log('');
    log('### Setup');
    log('- Board: 8x8, seed 42');
    log('- Organism: triplicator-evolvable with N=10');
    log('- Code loaded to pages 0, 2, and 3; N poked at $42, $242, $342');
    log('- Noise: pBitNoise = 1/131072');
    log('- Full-board seeding (all 64 cells)');
    log('- Duration: 10M interrupts');
    log('');

    const size = 8;
    const eps = 1 / 131072;
    const { controller } = createBoard(size, 42, { pBitNoise: eps });
    const bytes = await assemblePreset('triplicator-evolvable');

    const fullRef = new Uint8Array(0x43);
    fullRef.set(bytes);
    fullRef[0x42] = 10;

    seedAllCells(controller, bytes, size, { N: 10, pages: [0, 2, 3] });

    log('### Results');
    log('');
    log('| Interrupts | Alive | 80% fidelity | Mean N | Unique FPs | Top N values |');
    log('|-----------|-------|-------------|--------|-----------|-------------|');

    const checkpoints = [0, 1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000,
                         6_000_000, 7_000_000, 8_000_000, 9_000_000, 10_000_000];

    let totalDone = 0;
    for (const cp of checkpoints) {
        const toRun = cp - totalDone;
        if (toRun > 0) {
            const chunkSize = 100_000;
            let remaining = toRun;
            while (remaining > 0) {
                const chunk = Math.min(chunkSize, remaining);
                runInterrupts(controller, chunk);
                remaining -= chunk;
            }
        }
        totalDone = cp;

        const alive = countAlive(controller, size);
        const fidelity = countHighFidelity(controller, size, fullRef);
        const mn = meanN(controller, size).toFixed(1);
        const fps = countUniqueFingerprints(controller, size);
        const dist = nDistribution(controller, size);
        const topN = topNValues(dist);

        log(`| ${formatLabel(cp)} | ${alive} | ${fidelity} | ${mn} | ${fps} | ${topN} |`);
    }
    log('');
}

// ── Experiment 3: Competition nano-2x vs triplicator ─────────────────────

async function experiment3() {
    log('## Experiment 3: Competition — nano-2x vs triplicator at eps=1/131072');
    log('');
    log('### Setup');
    log('- Board: 8x8, seed 42');
    log('- nano-2x at (0,0)');
    log('- triplicator-evolvable at (4,4) with N=10, loaded to pages 0, 2, 3');
    log('- Noise: pBitNoise = 1/131072');
    log('- Duration: 5M interrupts');
    log('');

    const size = 8;
    const eps = 1 / 131072;
    const { controller } = createBoard(size, 42, { pBitNoise: eps });
    zeroAllCells(controller);

    const tripBytes = await assemblePreset('triplicator-evolvable');
    const nanoBytes = await assemblePreset('nano-2x');

    seedCell(controller, 0, 0, nanoBytes, { pages: [0] });
    seedCell(controller, 4, 4, tripBytes, { N: 10, pages: [0, 2, 3] });

    const tripRef = new Uint8Array(0x43);
    tripRef.set(tripBytes);
    tripRef[0x42] = 10;

    log('### Results');
    log('');
    log('| Interrupts | Triplicator | nano-2x | Other | Trip 80% | Unique FPs |');
    log('|-----------|------------|---------|-------|---------|-----------|');

    const checkpoints = [0, 100_000, 500_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000];

    let totalDone = 0;
    for (const cp of checkpoints) {
        const toRun = cp - totalDone;
        if (toRun > 0) runInterrupts(controller, toRun);
        totalDone = cp;

        const { tripCount, nanoCount, otherCount } = countSpecies(controller, size, tripBytes, nanoBytes);
        const fidelity = countHighFidelity(controller, size, tripRef);
        const fps = countUniqueFingerprints(controller, size);

        log(`| ${formatLabel(cp)} | ${tripCount} | ${nanoCount} | ${otherCount} | ${fidelity} | ${fps} |`);
    }
    log('');
}

// ── Experiment 4: Movement vs no-movement ────────────────────────────────

async function experiment4() {
    log('## Experiment 4: Movement vs no-movement');
    log('');
    log('### Setup');
    log('- Board: 8x8, seed 42');
    log('- Organism: nano-2x at (0,0)');
    log('- Epsilon: 0 (no noise)');
    log('- Duration: 100k interrupts');
    log('- Comparison: implementsMove=true vs implementsMove=false');
    log('');

    const nanoBytes = await assemblePreset('nano-2x');
    const size = 8;

    log('### Results');
    log('');
    log('| Interrupts | Alive (move=true) | Written (move=true) | Alive (move=false) | Written (move=false) |');
    log('|-----------|------------------|--------------------|--------------------|---------------------|');

    const checkpoints = [0, 1_000, 5_000, 10_000, 25_000, 50_000, 100_000];

    // Run with movement
    const { controller: ctrlMove } = createBoard(size, 42, { pBitNoise: 0, implementsMove: true });
    zeroAllCells(ctrlMove);
    seedCell(ctrlMove, 0, 0, nanoBytes, { pages: [0] });

    // Run without movement
    const { controller: ctrlNoMove } = createBoard(size, 42, { pBitNoise: 0, implementsMove: false });
    zeroAllCells(ctrlNoMove);
    seedCell(ctrlNoMove, 0, 0, nanoBytes, { pages: [0] });

    let totalDoneMove = 0;
    let totalDoneNoMove = 0;
    for (const cp of checkpoints) {
        const toRunMove = cp - totalDoneMove;
        if (toRunMove > 0) runInterrupts(ctrlMove, toRunMove);
        totalDoneMove = cp;

        const toRunNoMove = cp - totalDoneNoMove;
        if (toRunNoMove > 0) runInterrupts(ctrlNoMove, toRunNoMove);
        totalDoneNoMove = cp;

        const aliveMove = countAlive(ctrlMove, size);
        const writtenMove = countWrittenCells(ctrlMove, size);
        const aliveNoMove = countAlive(ctrlNoMove, size);
        const writtenNoMove = countWrittenCells(ctrlNoMove, size);

        log(`| ${formatLabel(cp)} | ${aliveMove} | ${writtenMove} | ${aliveNoMove} | ${writtenNoMove} |`);
    }
    log('');
}

// ── Main ─────────────────────────────────────────────────────────────────

log('# ALife Experiments Re-run (post lastMoveTime[0] bug fix)');
log('');
log('Date: 2026-03-23');
log('');
log('**Context:** Previous experiments were run with a bug where `lastMoveTime[0]`');
log('(cell 0,0) was permanently marked as recently moved, biasing all results');
log('involving cell (0,0). This re-run uses the corrected codebase.');
log('');

origConsoleError('Starting Experiment 1: nano-2x viability sweep (4 x 5M interrupts)...');
await experiment1();

origConsoleError('Starting Experiment 2: Triplicator evolvable (10M interrupts)...');
await experiment2();

origConsoleError('Starting Experiment 3: Competition nano-2x vs triplicator (5M interrupts)...');
await experiment3();

origConsoleError('Starting Experiment 4: Movement vs no-movement (100k interrupts)...');
await experiment4();

// Write output
const outPath = new URL('../doc/experiments-rerun.md', import.meta.url);
writeFileSync(outPath, output.join('\n') + '\n');
origConsoleError(`Results written to doc/experiments-rerun.md`);
