#!/usr/bin/env node
// Triplicator noise threshold experiments
// Usage: node experiments/triplicator-threshold.mjs

import fs from 'fs';
import { createBoard, writeCellBytes, readCellMemory } from '../engine/board.js';
import { assemble } from '../engine/assembler.js';

// Suppress console.error globally (Sfotty crash messages)
const origConsoleError = console.error;
console.error = () => {};

const TRIPLICATOR_SRC = fs.readFileSync(new URL('../presets/triplicator.asm', import.meta.url), 'utf8');
const NANO2X_SRC = fs.readFileSync(new URL('../presets/nano-2x.asm', import.meta.url), 'utf8');

function initController(size, seed, pBitNoise) {
    const { controller } = createBoard(size, seed, { pBitNoise });
    controller.sfotty.crashed = false;
    controller.sfotty.cycleCounter = 0;
    controller.sfotty.operations = [() => controller.sfotty.decode()];
    return controller;
}

function loadTriplicator(controller, i, j, bytes) {
    writeCellBytes(controller, i, j, 0, bytes);       // page 0
    writeCellBytes(controller, i, j, 0x200, bytes);    // page 2
    writeCellBytes(controller, i, j, 0x300, bytes);    // page 3
}

// Count cells starting with BRK + copy operand (functional replicator signature)
function countAliveFunc(controller) {
    const B = controller.memory.B;
    let alive = 0;
    for (let i = 0; i < B; i++) {
        for (let j = 0; j < B; j++) {
            const mem = readCellMemory(controller, i, j);
            if (mem[0] === 0x00 && mem[1] >= 0xF5 && mem[1] <= 0xFC) alive++;
        }
    }
    return alive;
}

// Count cells matching reference at given similarity threshold
function countAliveMatch(controller, refBytes, threshold) {
    const B = controller.memory.B;
    let alive = 0;
    for (let i = 0; i < B; i++) {
        for (let j = 0; j < B; j++) {
            const mem = readCellMemory(controller, i, j);
            let matches = 0;
            for (let k = 0; k < refBytes.length; k++) {
                if (mem[k] === refBytes[k]) matches++;
            }
            if (matches >= refBytes.length * threshold) alive++;
        }
    }
    return alive;
}

// Average Hamming distance (bits) from reference, among functionally alive cells
function avgHammingFromRef(controller, refBytes) {
    const B = controller.memory.B;
    let totalDist = 0, count = 0;
    for (let i = 0; i < B; i++) {
        for (let j = 0; j < B; j++) {
            const mem = readCellMemory(controller, i, j);
            if (mem[0] !== 0x00 || mem[1] < 0xF5 || mem[1] > 0xFC) continue;
            let dist = 0;
            for (let k = 0; k < refBytes.length; k++) {
                let xor = mem[k] ^ refBytes[k];
                while (xor) { dist++; xor &= xor - 1; }
            }
            totalDist += dist;
            count++;
        }
    }
    return count > 0 ? (totalDist / count).toFixed(1) : 'N/A';
}

function runInterrupts(controller, n) {
    for (let i = 0; i < n; i++) {
        controller.runToNextInterrupt();
    }
}

// ============================================================
// Experiment 1: Binary search on epsilon
// ============================================================
async function experiment1() {
    console.log('\n=== EXPERIMENT 1: Noise threshold search ===');
    const triBytes = await assemble(TRIPLICATOR_SRC);
    const epsilons = [1/8192, 1/16384, 1/32768, 1/65536, 1/131072];
    const checkpoints = [100_000, 500_000, 1_000_000, 2_000_000, 5_000_000];
    const size = 8;
    const seed = 42;

    const results = [];

    for (const eps of epsilons) {
        const label = `1/${Math.round(1/eps)}`;
        console.log(`\nEpsilon = ${label}`);
        const controller = initController(size, seed, eps);
        loadTriplicator(controller, 0, 0, triBytes);

        let prevCheckpoint = 0;
        const snapshots = [];
        for (const cp of checkpoints) {
            runInterrupts(controller, cp - prevCheckpoint);
            prevCheckpoint = cp;
            const funcAlive = countAliveFunc(controller);
            const match80 = countAliveMatch(controller, triBytes, 0.8);
            const match60 = countAliveMatch(controller, triBytes, 0.6);
            const hamming = avgHammingFromRef(controller, triBytes);
            console.log(`  ${(cp/1000).toFixed(0)}k: func=${funcAlive}, 80%=${match80}, 60%=${match60}, avgHD=${hamming}`);
            snapshots.push({ cp, funcAlive, match80, match60, hamming });
        }
        results.push({ eps, label, snapshots });
    }
    return results;
}

// ============================================================
// Experiment 2: Faster repair
// ============================================================
function makeMultiRepairSource(repairCount) {
    // We need to assemble first to get code size, then set repair range.
    // Use a two-pass approach: first assemble with placeholder range,
    // then adjust. For simplicity, use a fixed large range.
    // The repair range needs to be (codeSize - 1) to cover all bytes.
    // But we don't know codeSize until assembly. Use a callback approach.

    const repairBlock = (n, rangeHex) => `DEC $40
BPL @noWrap${n}
LDA #$${rangeHex}
STA $40
@noWrap${n}:
LDY $40
LDA $0200,Y
AND $0300,Y
STA $41
LDA $00,Y
AND $0200,Y
ORA $41
STA $41
LDA $00,Y
AND $0300,Y
ORA $41
STA $00,Y
STA $0200,Y
STA $0300,Y`;

    // First pass: assemble with range $30 to get approximate size
    let blocks = '';
    for (let n = 0; n < repairCount; n++) {
        blocks += repairBlock(n, '30') + '\n';
    }
    const firstPassSrc = `@top:\nBRK\n.byte $F5\n${blocks}BNE @top\nBEQ @top`;

    return { getSource: (rangeHex) => {
        let blocks = '';
        for (let n = 0; n < repairCount; n++) {
            blocks += repairBlock(n, rangeHex) + '\n';
        }
        return `@top:\nBRK\n.byte $F5\n${blocks}BNE @top\nBEQ @top`;
    }, firstPassSrc };
}

async function experiment2() {
    console.log('\n=== EXPERIMENT 2: Faster repair at epsilon=1/8192 ===');
    const eps = 1/8192;
    const repairCounts = [1, 2, 4, 8];
    const checkpoints = [100_000, 500_000, 1_000_000, 2_000_000, 5_000_000];
    const size = 8;
    const seed = 42;

    const results = [];

    for (const rc of repairCounts) {
        console.log(`\nRepair ${rc} bytes/scheduling at eps=1/8192`);
        const { getSource, firstPassSrc } = makeMultiRepairSource(rc);

        // First pass to get size
        let firstBytes;
        try {
            firstBytes = await assemble(firstPassSrc);
        } catch(e) {
            console.log(`  Assembly failed: ${e.message}`);
            continue;
        }

        // Check if code fits in page 0 (max 0xEF = 239 bytes, registers at 0xF0+)
        if (firstBytes.length > 0xEF) {
            console.log(`  Code too large (${firstBytes.length}B > 239B), skipping`);
            results.push({ repairCount: rc, codeSize: firstBytes.length, skipped: true, snapshots: [] });
            continue;
        }

        // Set repair range to cover full code
        const range = firstBytes.length - 1;
        const rangeHex = range.toString(16).padStart(2, '0');
        const src = getSource(rangeHex);

        let triBytes;
        try {
            triBytes = await assemble(src);
        } catch(e) {
            console.log(`  Assembly failed on second pass: ${e.message}`);
            continue;
        }
        console.log(`  Code size: ${triBytes.length}B, repair range: $01-$${rangeHex}`);

        const controller = initController(size, seed, eps);
        loadTriplicator(controller, 0, 0, triBytes);

        let prevCheckpoint = 0;
        const snapshots = [];
        for (const cp of checkpoints) {
            runInterrupts(controller, cp - prevCheckpoint);
            prevCheckpoint = cp;
            const funcAlive = countAliveFunc(controller);
            const match60 = countAliveMatch(controller, triBytes, 0.6);
            const hamming = avgHammingFromRef(controller, triBytes);
            console.log(`  ${(cp/1000).toFixed(0)}k: func=${funcAlive}, 60%=${match60}, avgHD=${hamming}`);
            snapshots.push({ cp, funcAlive, match60, hamming });
        }
        results.push({ repairCount: rc, codeSize: triBytes.length, skipped: false, snapshots });
    }
    return results;
}

// ============================================================
// Experiment 3: Competition
// ============================================================
async function experiment3() {
    console.log('\n=== EXPERIMENT 3: Competition at epsilon=1/32768 ===');
    const triBytes = await assemble(TRIPLICATOR_SRC);
    const nanoBytes = await assemble(NANO2X_SRC);

    const eps = 1/32768;
    const size = 8;
    const seed = 42;
    const checkpoints = [100_000, 500_000, 1_000_000, 2_000_000, 5_000_000];

    const controller = initController(size, seed, eps);
    loadTriplicator(controller, 0, 0, triBytes);
    writeCellBytes(controller, 4, 4, 0, nanoBytes);

    let prevCheckpoint = 0;
    const results = [];

    for (const cp of checkpoints) {
        runInterrupts(controller, cp - prevCheckpoint);
        prevCheckpoint = cp;

        const B = controller.memory.B;
        // Triplicator: functional = starts with BRK + copy and has repair structure
        let triFuncAlive = 0;
        let nanoFunc = 0;
        let otherBrk = 0;

        for (let i = 0; i < B; i++) {
            for (let j = 0; j < B; j++) {
                const m = readCellMemory(controller, i, j);
                // Check triplicator signature: BRK F5 + has DEC $40 (0xC6 0x40) nearby
                const hasBrkCopy = m[0] === 0x00 && m[1] >= 0xF5 && m[1] <= 0xFC;
                const hasRepair = hasBrkCopy && (m[2] === 0xC6 && m[3] === 0x40); // DEC $40
                const hasNano = m[0] === 0x00 && m[1] === 0xF5 && m[2] === 0x00 && m[3] === 0xF6;
                if (hasNano) nanoFunc++;
                else if (hasRepair) triFuncAlive++;
                else if (hasBrkCopy) otherBrk++;
            }
        }
        const triMatch60 = countAliveMatch(controller, triBytes, 0.6);
        const nanoMatch60 = countAliveMatch(controller, nanoBytes, 0.6);
        console.log(`  ${(cp/1000).toFixed(0)}k: tri=${triFuncAlive}, nano=${nanoFunc}, other_brk=${otherBrk}, tri60%=${triMatch60}, nano60%=${nanoMatch60}`);
        results.push({ checkpoint: cp, triFuncAlive, nanoFunc, otherBrk, triMatch60, nanoMatch60 });
    }
    return results;
}

// ============================================================
// Main
// ============================================================
async function main() {
    const startTime = Date.now();

    const exp1 = await experiment1();
    const exp2 = await experiment2();
    const exp3 = await experiment3();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nAll experiments completed in ${elapsed}s`);

    // Build markdown report
    let md = `# Triplicator Noise Threshold Experiments

Date: ${new Date().toISOString().slice(0, 10)}

## Setup

- Board: 8x8 (64 cells)
- Seed: 42
- Triplicator: 51 bytes, 3 copies at pages 0, 2, 3; majority-vote repairs 1 byte/scheduling
- Noise model: each bit independently flipped with probability epsilon during BRK copy
- Metrics:
  - **func**: cells starting with BRK + copy operand (0x00, 0xF5..FC) — functional replicator signature
  - **60%/80%**: cells with >=60%/80% byte-level match to original reference
  - **avgHD**: mean Hamming distance (bits) from reference among func-alive cells

## Experiment 1: Noise Threshold Search

Triplicator seeded at (0,0), run for 5M interrupts at each noise level.

| Epsilon | 100k func | 500k func | 1M func | 2M func | 5M func | 100k avgHD | 500k avgHD | 5M avgHD |
|---------|-----------|-----------|---------|---------|---------|------------|------------|----------|
`;
    for (const r of exp1) {
        const s = r.snapshots;
        md += `| ${r.label}`;
        for (const snap of s) md += ` | ${snap.funcAlive}`;
        md += ` | ${s[0].hamming} | ${s[1].hamming} | ${s[s.length-1].hamming}`;
        md += ` |\n`;
    }

    md += `
### Detailed 80% match counts

| Epsilon | 100k | 500k | 1M | 2M | 5M |
|---------|------|------|-----|-----|-----|
`;
    for (const r of exp1) {
        md += `| ${r.label}`;
        for (const snap of r.snapshots) md += ` | ${snap.match80}`;
        md += ` |\n`;
    }

    md += `
## Experiment 2: Faster Repair at Epsilon=1/8192

Repair block duplicated N times; repair range adjusted to cover full code.

| Repair/sched | Code size | 100k func | 500k func | 1M func | 2M func | 5M func | 5M avgHD |
|-------------|-----------|-----------|-----------|---------|---------|---------|----------|
`;
    for (const r of exp2) {
        if (r.skipped) {
            md += `| ${r.repairCount} | ${r.codeSize}B | (skipped — code too large for page 0) ||||| |\n`;
            continue;
        }
        const s = r.snapshots;
        md += `| ${r.repairCount} | ${r.codeSize}B`;
        for (const snap of s) md += ` | ${snap.funcAlive}`;
        md += ` | ${s[s.length-1].hamming}`;
        md += ` |\n`;
    }

    md += `
## Experiment 3: Competition (Triplicator vs Nano-2x at Epsilon=1/32768)

Triplicator at (0,0), nano-2x at (4,4), both on same 8x8 board.
"tri" = cells with BRK+copy+DEC$40 signature. "nano" = cells with BRK F5 BRK F6 pattern.

| Checkpoint | Tri (sig) | Nano (sig) | Other BRK | Tri (60%) | Nano (60%) |
|-----------|-----------|------------|-----------|-----------|------------|
`;
    for (const r of exp3) {
        md += `| ${(r.checkpoint/1000).toFixed(0)}k | ${r.triFuncAlive} | ${r.nanoFunc} | ${r.otherBrk} | ${r.triMatch60} | ${r.nanoMatch60} |\n`;
    }

    // Analysis
    md += `\n## Analysis\n\n`;

    // Threshold from exp 1
    const alive5M = exp1.map(r => ({
        label: r.label,
        eps: r.eps,
        func: r.snapshots[r.snapshots.length-1].funcAlive,
        func1M: r.snapshots[2].funcAlive,
    }));

    md += `### Noise tolerance\n\n`;
    for (const a of alive5M) {
        const status = a.func >= 60 ? 'SURVIVES (full board)' :
                       a.func > 0 ? `PARTIAL (${a.func}/64)` : 'DEAD';
        md += `- epsilon=${a.label}: ${status} at 5M\n`;
    }

    const threshold = alive5M.find(a => a.func > 0 && alive5M.find(b => b.eps > a.eps && b.func === 0));
    if (threshold) {
        const justAbove = alive5M.filter(a => a.eps > threshold.eps && a.func === 0)
                                  .reduce((a, b) => a.eps < b.eps ? a : b);
        md += `\n**Critical threshold**: between epsilon=${threshold.label} (survives) and epsilon=${justAbove.label} (dies).\n`;
    }

    // Repair analysis
    md += `\n### Faster repair\n\n`;
    for (const r of exp2) {
        if (r.skipped) {
            md += `- ${r.repairCount} bytes/sched: skipped (${r.codeSize}B exceeds page 0 limit)\n`;
        } else {
            const last = r.snapshots[r.snapshots.length-1];
            md += `- ${r.repairCount} bytes/sched (${r.codeSize}B): ${last.funcAlive}/64 alive at 5M, avgHD=${last.hamming}\n`;
        }
    }

    // Competition analysis
    md += `\n### Competition\n\n`;
    const lastComp = exp3[exp3.length - 1];
    md += `At 5M interrupts with epsilon=1/32768: triplicator holds ${lastComp.triFuncAlive} cells, `;
    md += `nano-2x holds ${lastComp.nanoFunc} cells, ${lastComp.otherBrk} cells have mutant BRK-copy programs.\n`;

    md += `\nTotal runtime: ${elapsed}s\n`;

    const outPath = new URL('../doc/triplicator-experiments.md', import.meta.url);
    fs.writeFileSync(outPath, md);
    console.log('\nResults written to doc/triplicator-experiments.md');
}

main().catch(e => { origConsoleError(e); process.exit(1); });
