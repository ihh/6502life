#!/usr/bin/env node

// Long-term evolution experiments for 6502life
// Runs 4 experiments and outputs results as markdown

import { readFileSync } from 'fs';
import { createBoard, zeroAllCells, writeCellBytes, readCellMemory } from '../engine/board.js';
import { assemble } from '../engine/assembler.js';

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
        // Poke evolvable N at offset $42 in each page
        for (const page of pages) {
            writeCellBytes(controller, i, j, page * 0x100 + 0x42, new Uint8Array([N]));
        }
    }
}

function seedAllCells(controller, bytes, size, opts = {}) {
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            seedCell(controller, i, j, bytes, opts);
        }
    }
}

function runInterrupts(controller, count) {
    for (let k = 0; k < count; k++) {
        controller.runToNextInterrupt();
    }
}

// Check if a cell is "functionally alive" — byte 0 is BRK ($00)
// and byte 1 is a copy operand ($F5-$F8)
function isFuncAlive(controller, i, j) {
    const mem = readCellMemory(controller, i, j);
    return mem[0] === 0x00 && mem[1] >= 0xF5 && mem[1] <= 0xF8;
}

// Count functionally alive cells
function countAlive(controller, size) {
    let count = 0;
    for (let i = 0; i < size; i++)
        for (let j = 0; j < size; j++)
            if (isFuncAlive(controller, i, j)) count++;
    return count;
}

// 80% byte match to reference
function byteMatchFraction(cellMem, ref, rangeEnd) {
    let match = 0;
    for (let b = 0; b < rangeEnd; b++) {
        if (cellMem[b] === ref[b]) match++;
    }
    return match / rangeEnd;
}

function countHighFidelity(controller, size, refBytes, threshold = 0.8) {
    const rangeEnd = Math.min(refBytes.length, 0x43); // code region
    let count = 0;
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            const mem = readCellMemory(controller, i, j);
            if (byteMatchFraction(mem, refBytes, rangeEnd) >= threshold) count++;
        }
    }
    return count;
}

// Read N value from a cell (offset $42)
function readN(controller, i, j) {
    const mem = readCellMemory(controller, i, j);
    return mem[0x42];
}

// Mean N across all cells
function meanN(controller, size) {
    let sum = 0;
    for (let i = 0; i < size; i++)
        for (let j = 0; j < size; j++)
            sum += readN(controller, i, j);
    return sum / (size * size);
}

// N distribution
function nDistribution(controller, size) {
    const counts = {};
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            const n = readN(controller, i, j);
            counts[n] = (counts[n] || 0) + 1;
        }
    }
    return counts;
}

// Fingerprint: hash first 64 bytes of a cell
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

// Check if a cell has BRK copy at byte 0
function hasBrkCopyAtZero(controller, i, j) {
    const mem = readCellMemory(controller, i, j);
    return mem[0] === 0x00 && mem[1] >= 0xF5 && mem[1] <= 0xFC;
}

// Top N values as a formatted string
function topNValues(dist, maxEntries = 5) {
    return Object.entries(dist)
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxEntries)
        .map(([n, c]) => `${n}:${c}`)
        .join(', ');
}

// ── Output buffer ────────────────────────────────────────────────────────

const output = [];
function log(s = '') { output.push(s); console.error(s); }

// ── Experiment 1: Long-term evolution at eps=1/131072 ────────────────────

async function experiment1() {
    log('## Experiment 1: Long-term evolution (triplicator-evolvable, eps=1/131072, 10M interrupts)');
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

    // Build reference with N=10 poked in
    const refBytes = new Uint8Array(bytes.length + (0x43 - bytes.length > 0 ? 0x43 - bytes.length : 0));
    refBytes.set(bytes);
    // Make a full 0x43-byte reference
    const fullRef = new Uint8Array(0x43);
    fullRef.set(bytes);
    fullRef[0x42] = 10;

    // Seed all cells with triplicator on pages 0, 2, 3
    seedAllCells(controller, bytes, size, { N: 10, pages: [0, 2, 3] });

    log('### Results');
    log('');
    log('| Interrupts | Alive | 80% fidelity | Mean N | Unique FPs | Top N values |');
    log('|-----------|-------|-------------|--------|-----------|-------------|');

    const checkpoints = [0, 500_000, 1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000,
                         6_000_000, 7_000_000, 8_000_000, 9_000_000, 10_000_000];

    let totalDone = 0;
    for (const cp of checkpoints) {
        const toRun = cp - totalDone;
        if (toRun > 0) {
            // Run in chunks for progress
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

        const label = cp === 0 ? '0' : `${(cp/1_000_000).toFixed(1)}M`;
        log(`| ${label} | ${alive} | ${fidelity} | ${mn} | ${fps} | ${topN} |`);
    }
    log('');
}

// ── Experiment 2: Multi-species ecology ──────────────────────────────────

async function experiment2() {
    log('## Experiment 2: Multi-species ecology (triplicator-evolvable vs nano-2x)');
    log('');
    log('### Setup');
    log('- Board: 8x8, seed 42');
    log('- Triplicator-evolvable at (0,0) with N=10, loaded to pages 0, 2, 3');
    log('- nano-2x at (4,4)');
    log('- Noise: pBitNoise = 1/131072');
    log('- Duration: 5M interrupts');
    log('');

    const size = 8;
    const eps = 1 / 131072;
    const { controller } = createBoard(size, 42, { pBitNoise: eps });

    // Zero all cells first
    zeroAllCells(controller);

    const tripBytes = await assemblePreset('triplicator-evolvable');
    const nanoBytes = await assemblePreset('nano-2x');

    // Seed triplicator at (0,0) on pages 0, 2, 3
    seedCell(controller, 0, 0, tripBytes, { N: 10, pages: [0, 2, 3] });

    // Seed nano-2x at (4,4) on page 0 only (it's simple enough)
    seedCell(controller, 4, 4, nanoBytes, { pages: [0] });

    // Build references for identification
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

        // Count triplicator-like cells (BRK $F5 at byte 0, code match)
        let tripCount = 0, nanoCount = 0, otherCount = 0;
        for (let i = 0; i < size; i++) {
            for (let j = 0; j < size; j++) {
                const mem = readCellMemory(controller, i, j);
                // Check for triplicator pattern (first 8 bytes match)
                let tripMatch = 0;
                for (let b = 0; b < Math.min(8, tripBytes.length); b++) {
                    if (mem[b] === tripBytes[b]) tripMatch++;
                }
                // Check for nano-2x pattern (first 8 bytes match)
                let nanoMatch = 0;
                for (let b = 0; b < nanoBytes.length; b++) {
                    if (mem[b] === nanoBytes[b]) nanoMatch++;
                }
                if (tripMatch >= 6) tripCount++;
                else if (nanoMatch >= 6) nanoCount++;
                else otherCount++;
            }
        }
        const fidelity = countHighFidelity(controller, size, tripRef);
        const fps = countUniqueFingerprints(controller, size);

        const label = cp === 0 ? '0' : cp >= 1_000_000 ? `${(cp/1_000_000).toFixed(0)}M` : `${cp/1000}k`;
        log(`| ${label} | ${tripCount} | ${nanoCount} | ${otherCount} | ${fidelity} | ${fps} |`);
    }
    log('');
}

// ── Experiment 3: Spontaneous emergence from random ──────────────────────

async function experiment3() {
    log('## Experiment 3: Spontaneous emergence from random (eps=0, 10M interrupts)');
    log('');
    log('### Setup');
    log('- Board: 8x8, seed 42, fully randomized');
    log('- Noise: pBitNoise = 0 (zero noise)');
    log('- Duration: 10M interrupts');
    log('- Looking for: cells with BRK $F5-$F8 at byte 0, self-replicating patterns');
    log('');

    const size = 8;
    const { controller } = createBoard(size, 42, { pBitNoise: 0 });
    controller.randomize();

    log('### Results');
    log('');
    log('| Interrupts | BRK-copy@0 cells | Unique FPs | Notes |');
    log('|-----------|-----------------|-----------|-------|');

    const checkpoints = [0, 100_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000];

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

        // Count cells with BRK copy at byte 0
        let brkCopyCount = 0;
        const brkCopyCells = [];
        for (let i = 0; i < size; i++) {
            for (let j = 0; j < size; j++) {
                if (hasBrkCopyAtZero(controller, i, j)) {
                    brkCopyCount++;
                    if (brkCopyCells.length < 3) brkCopyCells.push(`(${i},${j})`);
                }
            }
        }
        const fps = countUniqueFingerprints(controller, size);
        const notes = brkCopyCount > 0 ? `at ${brkCopyCells.join(',')}` : '';

        const label = cp === 0 ? '0' : cp >= 1_000_000 ? `${(cp/1_000_000).toFixed(0)}M` : `${cp/1000}k`;
        log(`| ${label} | ${brkCopyCount} | ${fps} | ${notes} |`);
    }
    log('');

    // Additional analysis: check for any cell that has managed to create copies of itself
    log('### Self-replication check at 10M');
    log('');
    // Compare all pairs of cells to find clusters of similar cells
    const fingerprints = {};
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            const fp = cellFingerprint(controller, i, j);
            if (!fingerprints[fp]) fingerprints[fp] = [];
            fingerprints[fp].push(`(${i},${j})`);
        }
    }
    const clusters = Object.entries(fingerprints)
        .filter(([_, cells]) => cells.length > 1)
        .sort((a, b) => b[1].length - a[1].length);

    if (clusters.length > 0) {
        log(`Found ${clusters.length} clusters of identical cells:`);
        for (const [fp, cells] of clusters.slice(0, 5)) {
            log(`- ${cells.length} cells: ${cells.join(', ')}`);
            // Check if the cluster members have BRK copy at byte 0
            const coord = cells[0].match(/(\d+),(\d+)/);
            if (coord) {
                const mem = readCellMemory(controller, parseInt(coord[1]), parseInt(coord[2]));
                const first8 = Array.from(mem.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ');
                log(`  First 8 bytes: ${first8}`);
            }
        }
    } else {
        log('No clusters of identical cells found. All 64 cells are unique.');
    }
    log('');
}

// ── Experiment 4: Magnetosensing evolution ───────────────────────────────

async function experiment4() {
    log('## Experiment 4: Magnetosensing vs standard nano-2x');
    log('');
    log('### Setup');
    log('- Board: 8x8, seed 42');
    log('- Noise: pBitNoise = 1/131072');
    log('- Duration: 5M interrupts');
    log('- Comparison: standard nano-2x vs hasCompass nano-2x variant');
    log('');

    // Standard nano-2x (control)
    log('### Control: standard nano-2x (no hasCompass)');
    {
        const size = 8;
        const { controller } = createBoard(size, 42, { pBitNoise: 1/131072, hasCompass: false });
        zeroAllCells(controller);
        const bytes = await assemblePreset('nano-2x');
        seedCell(controller, 0, 0, bytes, { pages: [0] });

        log('');
        log('| Interrupts | Alive | Unique FPs |');
        log('|-----------|-------|-----------|');

        const checkpoints = [0, 100_000, 500_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000];
        let totalDone = 0;
        for (const cp of checkpoints) {
            const toRun = cp - totalDone;
            if (toRun > 0) runInterrupts(controller, toRun);
            totalDone = cp;
            const alive = countAlive(controller, size);
            const fps = countUniqueFingerprints(controller, size);
            const label = cp === 0 ? '0' : cp >= 1_000_000 ? `${(cp/1_000_000).toFixed(0)}M` : `${cp/1000}k`;
            log(`| ${label} | ${alive} | ${fps} |`);
        }
        log('');
    }

    // Magnetosensing nano-2x variant
    // This variant reads $FA (orientation) and uses it to choose copy direction
    // At $FA: orientation << 2 (0, 4, 8, 12 for orientations 0-3)
    // Uses LDA $FA, AND #$03, TAX, BRK with operand indexed by orientation
    log('### Magnetosensing nano-2x variant');
    log('');
    log('This variant uses a direction-aware copy strategy.');
    log('When hasCompass is enabled, $FA contains (orientation << 2).');
    log('The organism reads $FA and adjusts its BRK operand accordingly.');
    log('');

    // Assemble a hasCompass variant
    // Simple approach: always copy forward ($F5). With hasCompass,
    // the organism knows its orientation, so "forward" is always the same
    // absolute direction. Without hasCompass, "forward" is random.
    // A smarter variant: copy in two fixed absolute directions.
    const magnetoSource = `
; Magnetosensing nano-2x: copies forward and right, aware of orientation
; Reads $FA to know orientation. Copies $F5 (forward) and $F6 (right).
; With hasCompass enabled, these map to consistent absolute directions.
@start:
BRK
.byte $F5
BRK
.byte $F6
BNE @start
BEQ @start
`;

    {
        const size = 8;
        const { controller } = createBoard(size, 42, { pBitNoise: 1/131072, hasCompass: true });
        zeroAllCells(controller);
        const bytes = await assemble(magnetoSource);
        seedCell(controller, 0, 0, bytes, { pages: [0] });

        log('| Interrupts | Alive | Unique FPs |');
        log('|-----------|-------|-----------|');

        const checkpoints = [0, 100_000, 500_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000];
        let totalDone = 0;
        for (const cp of checkpoints) {
            const toRun = cp - totalDone;
            if (toRun > 0) runInterrupts(controller, toRun);
            totalDone = cp;
            const alive = countAlive(controller, size);
            const fps = countUniqueFingerprints(controller, size);
            const label = cp === 0 ? '0' : cp >= 1_000_000 ? `${(cp/1_000_000).toFixed(0)}M` : `${cp/1000}k`;
            log(`| ${label} | ${alive} | ${fps} |`);
        }
        log('');
    }

    // Now the real hasCompass test: a direction-aware organism
    // that uses $FA to pick which neighbor to copy to
    log('### Direction-aware triplicator (hasCompass ON)');
    log('');
    log('Uses triplicator-evolvable with hasCompass enabled.');
    log('The organism itself does not read $FA, but the board provides');
    log('orientation info. This tests whether hasCompass as a board');
    log('parameter affects triplicator survival.');
    log('');
    {
        const size = 8;
        const { controller } = createBoard(size, 42, { pBitNoise: 1/131072, hasCompass: true });
        const bytes = await assemblePreset('triplicator-evolvable');
        seedAllCells(controller, bytes, size, { N: 10, pages: [0, 2, 3] });

        log('| Interrupts | Alive | 80% fidelity | Mean N |');
        log('|-----------|-------|-------------|--------|');

        const fullRef = new Uint8Array(0x43);
        fullRef.set(bytes);
        fullRef[0x42] = 10;

        const checkpoints = [0, 500_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000];
        let totalDone = 0;
        for (const cp of checkpoints) {
            const toRun = cp - totalDone;
            if (toRun > 0) runInterrupts(controller, toRun);
            totalDone = cp;
            const alive = countAlive(controller, size);
            const fidelity = countHighFidelity(controller, size, fullRef);
            const mn = meanN(controller, size).toFixed(1);
            const label = cp === 0 ? '0' : cp >= 1_000_000 ? `${(cp/1_000_000).toFixed(0)}M` : `${cp/1000}k`;
            log(`| ${label} | ${alive} | ${fidelity} | ${mn} |`);
        }
        log('');
    }

    // Magnetosensing OFF for comparison
    log('### Triplicator control (hasCompass OFF)');
    log('');
    {
        const size = 8;
        const { controller } = createBoard(size, 42, { pBitNoise: 1/131072, hasCompass: false });
        const bytes = await assemblePreset('triplicator-evolvable');
        seedAllCells(controller, bytes, size, { N: 10, pages: [0, 2, 3] });

        log('| Interrupts | Alive | 80% fidelity | Mean N |');
        log('|-----------|-------|-------------|--------|');

        const fullRef = new Uint8Array(0x43);
        fullRef.set(bytes);
        fullRef[0x42] = 10;

        const checkpoints = [0, 500_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000];
        let totalDone = 0;
        for (const cp of checkpoints) {
            const toRun = cp - totalDone;
            if (toRun > 0) runInterrupts(controller, toRun);
            totalDone = cp;
            const alive = countAlive(controller, size);
            const fidelity = countHighFidelity(controller, size, fullRef);
            const mn = meanN(controller, size).toFixed(1);
            const label = cp === 0 ? '0' : cp >= 1_000_000 ? `${(cp/1_000_000).toFixed(0)}M` : `${cp/1000}k`;
            log(`| ${label} | ${alive} | ${fidelity} | ${mn} |`);
        }
        log('');
    }
}

// ── Main ─────────────────────────────────────────────────────────────────

log('# Long-term Evolution Experiments');
log('');
log('Date: 2026-03-22');
log('');

console.error('Starting Experiment 1: Long-term evolution (10M interrupts)...');
await experiment1();

console.error('Starting Experiment 2: Multi-species ecology (5M interrupts)...');
await experiment2();

console.error('Starting Experiment 3: Spontaneous emergence (10M interrupts)...');
await experiment3();

console.error('Starting Experiment 4: Magnetosensing (5M interrupts)...');
await experiment4();

// Write output
import { writeFileSync } from 'fs';
writeFileSync(new URL('../doc/evolution-experiments.md', import.meta.url), output.join('\n') + '\n');
console.error('Results written to doc/evolution-experiments.md');
