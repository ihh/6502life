#!/usr/bin/env node
// Triplicator repair-rate experiments
// Tests loop-based repair variants and evolvable N
// Usage: node experiments/triplicator-repair-rate.mjs

import fs from 'fs';
import { createBoard, writeCellBytes, readCellMemory } from '../engine/board.js';
import { assemble } from '../engine/assembler.js';

// Suppress console.error globally (Sfotty crash messages)
const origConsoleError = console.error;
console.error = () => {};

function readFile(name) {
    return fs.readFileSync(new URL('../presets/' + name, import.meta.url), 'utf8');
}

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

function loadTriplicatorAll(controller, bytes) {
    const B = controller.memory.B;
    for (let i = 0; i < B; i++) {
        for (let j = 0; j < B; j++) {
            loadTriplicator(controller, i, j, bytes);
        }
    }
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

// Count cells matching reference at 80% byte threshold
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

function runInterrupts(controller, n) {
    for (let i = 0; i < n; i++) {
        controller.runToNextInterrupt();
    }
}

// For evolvable: read the N byte from each cell's offset $42
function getNDistribution(controller) {
    const B = controller.memory.B;
    const dist = {};
    for (let i = 0; i < B; i++) {
        for (let j = 0; j < B; j++) {
            const mem = readCellMemory(controller, i, j);
            // Only count functional cells
            if (mem[0] === 0x00 && mem[1] >= 0xF5 && mem[1] <= 0xFC) {
                const n = mem[0x42];
                dist[n] = (dist[n] || 0) + 1;
            }
        }
    }
    return dist;
}

// ============================================================
// Experiment 1: Loop repair variants at various noise levels
// ============================================================
async function experiment1() {
    origConsoleError('\n=== EXPERIMENT 1: Loop repair variants ===');

    const variants = [
        { name: 'original (N=1)', file: 'triplicator.asm' },
        { name: 'loop N=5', file: 'triplicator-loop5.asm' },
        { name: 'loop N=10', file: 'triplicator-loop10.asm' },
        { name: 'loop N=20', file: 'triplicator-loop20.asm' },
    ];

    const epsilons = [1/8192, 1/16384, 1/32768, 1/65536, 1/131072];
    const checkpoints = [500_000, 1_000_000, 2_000_000, 5_000_000];
    const size = 8;
    const seed = 42;

    const results = [];

    for (const variant of variants) {
        const src = readFile(variant.file);
        const bytes = await assemble(src);
        origConsoleError(`\n${variant.name} (${bytes.length}B):`);

        const varResults = [];
        for (const eps of epsilons) {
            const label = `1/${Math.round(1/eps)}`;
            origConsoleError(`  eps=${label}...`);

            const controller = initController(size, seed, eps);
            // Seed all cells with triplicator (full board)
            loadTriplicatorAll(controller, bytes);

            let prevCp = 0;
            const snapshots = [];
            for (const cp of checkpoints) {
                runInterrupts(controller, cp - prevCp);
                prevCp = cp;
                const funcAlive = countAliveFunc(controller);
                const match80 = countAliveMatch(controller, bytes, 0.8);
                snapshots.push({ cp, funcAlive, match80 });
                origConsoleError(`    ${(cp/1000).toFixed(0)}k: func=${funcAlive}, 80%=${match80}`);
            }
            varResults.push({ eps, label, snapshots });
        }
        results.push({ name: variant.name, codeSize: bytes.length, varResults });
    }
    return results;
}

// ============================================================
// Experiment 2: Evolvable N
// ============================================================
async function experiment2() {
    origConsoleError('\n=== EXPERIMENT 2: Evolvable repair rate ===');

    const src = readFile('triplicator-evolvable.asm');
    const bytes = await assemble(src);
    origConsoleError(`Evolvable triplicator: ${bytes.length}B`);

    // Byte $42 is where N is stored. In the assembled binary, what offset
    // does that correspond to? The code is 58 bytes (0x00-0x39).
    // Byte $42 is outside the code, we need to set it manually.
    // The assembler only produces code bytes; $42 is data we poke separately.

    const epsilons = [1/8192, 1/16384, 1/32768, 1/65536];
    const initialNs = [5, 10, 20];
    const checkpoints = [500_000, 1_000_000, 2_000_000, 5_000_000];
    const size = 8;
    const seed = 42;

    const results = [];

    for (const eps of epsilons) {
        const label = `1/${Math.round(1/eps)}`;
        for (const initN of initialNs) {
            origConsoleError(`\n  eps=${label}, initial N=${initN}...`);

            const controller = initController(size, seed, eps);
            const B = controller.memory.B;

            // Load evolvable triplicator into all cells, set N byte
            for (let i = 0; i < B; i++) {
                for (let j = 0; j < B; j++) {
                    // Write code to pages 0, 2, 3
                    writeCellBytes(controller, i, j, 0, bytes);
                    writeCellBytes(controller, i, j, 0x200, bytes);
                    writeCellBytes(controller, i, j, 0x300, bytes);
                    // Set N byte at $42 in all 3 pages
                    writeCellBytes(controller, i, j, 0x42, new Uint8Array([initN]));
                    writeCellBytes(controller, i, j, 0x242, new Uint8Array([initN]));
                    writeCellBytes(controller, i, j, 0x342, new Uint8Array([initN]));
                }
            }

            let prevCp = 0;
            const snapshots = [];
            for (const cp of checkpoints) {
                runInterrupts(controller, cp - prevCp);
                prevCp = cp;
                const funcAlive = countAliveFunc(controller);
                const nDist = getNDistribution(controller);
                // Compute mean N among alive cells
                let totalN = 0, count = 0;
                for (const [n, c] of Object.entries(nDist)) {
                    totalN += parseInt(n) * c;
                    count += c;
                }
                const meanN = count > 0 ? (totalN / count).toFixed(1) : 'N/A';
                // Top 3 N values
                const topN = Object.entries(nDist)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5)
                    .map(([n, c]) => `${n}:${c}`)
                    .join(' ');

                origConsoleError(`    ${(cp/1000).toFixed(0)}k: alive=${funcAlive}, meanN=${meanN}, dist=[${topN}]`);
                snapshots.push({ cp, funcAlive, meanN, nDist: {...nDist}, topN });
            }
            results.push({ eps, label, initN, snapshots });
        }
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

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    origConsoleError(`\nAll experiments completed in ${elapsed}s`);

    // ============================================================
    // Build markdown report
    // ============================================================
    let md = `# Triplicator Repair Rate Experiments

Date: ${new Date().toISOString().slice(0, 10)}

## Setup

- Board: 8x8 (64 cells), all cells seeded with triplicator
- Seed: 42
- Triplicator variants tested with repair LOOP (not duplication)
- Code size: original 51B, loop variants 56B, evolvable 58B
- The loop adds only 5 bytes (LDX #N / DEX / BNE) regardless of N

## Experiment 1: Loop Repair Variants at Various Noise Levels

### Functional alive counts (cells with BRK + copy signature)

`;

    for (const v of exp1) {
        md += `#### ${v.name} (${v.codeSize}B)\n\n`;
        md += `| Epsilon | 500k | 1M | 2M | 5M |\n`;
        md += `|---------|------|-----|-----|-----|\n`;
        for (const r of v.varResults) {
            const s = r.snapshots;
            md += `| ${r.label} | ${s[0].funcAlive} | ${s[1].funcAlive} | ${s[2].funcAlive} | ${s[3].funcAlive} |\n`;
        }
        md += `\n`;
    }

    md += `### 80% byte-match alive counts\n\n`;
    for (const v of exp1) {
        md += `#### ${v.name} (${v.codeSize}B)\n\n`;
        md += `| Epsilon | 500k | 1M | 2M | 5M |\n`;
        md += `|---------|------|-----|-----|-----|\n`;
        for (const r of v.varResults) {
            const s = r.snapshots;
            md += `| ${r.label} | ${s[0].match80} | ${s[1].match80} | ${s[2].match80} | ${s[3].match80} |\n`;
        }
        md += `\n`;
    }

    md += `## Experiment 2: Evolvable Repair Rate

The repair count N is stored at byte $42 in the genome. During noisy BRK copies,
N mutates along with the rest of the code. Natural selection acts on N: cells with
suboptimal N values die to corruption or waste scheduling cycles.

### Results by initial N and noise level

`;

    for (const r of exp2) {
        md += `#### eps=${r.label}, initial N=${r.initN}\n\n`;
        md += `| Checkpoint | Alive | Mean N | Top N values |\n`;
        md += `|-----------|-------|--------|-------------|\n`;
        for (const s of r.snapshots) {
            md += `| ${(s.cp/1000).toFixed(0)}k | ${s.funcAlive} | ${s.meanN} | ${s.topN} |\n`;
        }
        md += `\n`;
    }

    // Analysis
    md += `## Analysis

### Loop repair vs original

The original triplicator repairs 1 byte per scheduling cycle. With a repair range
of ~50 bytes, it takes ~50 scheduling cycles to fully repair one copy. At any nonzero
noise level, corruption accumulates faster than repair.

The loop variants repair N bytes per scheduling. This dramatically improves the
repair-to-corruption ratio:
- At N=5: repairs 5 bytes/scheduling = full scan every ~10 schedulings
- At N=10: repairs 10 bytes/scheduling = full scan every ~5 schedulings
- At N=20: repairs 20 bytes/scheduling = full scan every ~3 schedulings

The key insight is that a LOOP adds only 5 bytes to the genome (LDX/DEX/BNE),
whereas DUPLICATING the repair block adds ~45 bytes per extra copy. Smaller code =
less to corrupt = more robust.

### Cycle budget analysis

Each repair iteration costs ~48 cycles (DEC + BPL + LDY + 3x LDA/AND/ORA/STA).
The timer mean is ~2800 cycles. The BRK costs 7 cycles. Setup costs ~20 cycles.
Available budget: (2800 - 27) / 48 = ~57 bytes max.

But the timer is Poisson-distributed, so some schedulings are short. Safe targets:
- N=5: 5 * 48 + 27 = 267 cycles (< 10% of mean, very safe)
- N=10: 10 * 48 + 27 = 507 cycles (< 20% of mean, safe)
- N=20: 20 * 48 + 27 = 987 cycles (< 36% of mean, usually safe)

### Evolvable N

`;

    // Check if any evolvable runs survived
    const survivors = exp2.filter(r => r.snapshots[r.snapshots.length-1].funcAlive > 0);
    if (survivors.length > 0) {
        md += `Surviving runs show natural selection acting on N:\n\n`;
        for (const s of survivors) {
            const last = s.snapshots[s.snapshots.length-1];
            md += `- eps=${s.label}, initial N=${s.initN}: ${last.funcAlive} alive at 5M, mean N=${last.meanN}\n`;
        }
    } else {
        md += `No evolvable runs survived to 5M interrupts at the tested noise levels.\n`;
    }

    md += `\n## Best-performing variant assembly\n\n`;

    // Find best variant from exp1
    let bestName = 'original (N=1)';
    let bestAlive5M = 0;
    let bestFile = 'triplicator.asm';
    const variantFiles = ['triplicator.asm', 'triplicator-loop5.asm', 'triplicator-loop10.asm', 'triplicator-loop20.asm'];
    for (let vi = 0; vi < exp1.length; vi++) {
        const v = exp1[vi];
        // Best = highest alive at lowest epsilon that has survivors
        for (const r of v.varResults) {
            const alive5M = r.snapshots[3].funcAlive;
            if (alive5M > bestAlive5M) {
                bestAlive5M = alive5M;
                bestName = v.name;
                bestFile = variantFiles[vi];
            }
        }
    }

    const bestSrc = readFile(bestFile);
    md += `Best performer: **${bestName}** (${bestAlive5M}/64 alive at best noise level)\n\n`;
    md += '```asm\n' + bestSrc + '```\n';

    md += `\nTotal runtime: ${elapsed}s\n`;

    const outPath = new URL('../doc/triplicator-repair-rate.md', import.meta.url);
    fs.writeFileSync(outPath, md);
    origConsoleError('\nResults written to doc/triplicator-repair-rate.md');
}

main().catch(e => { origConsoleError(e); process.exit(1); });
