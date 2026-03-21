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

function loadTriplicatorAll(controller, bytes, extraBytes) {
    const B = controller.memory.B;
    for (let i = 0; i < B; i++) {
        for (let j = 0; j < B; j++) {
            loadTriplicator(controller, i, j, bytes);
            if (extraBytes) {
                for (const [offset, data] of extraBytes) {
                    writeCellBytes(controller, i, j, offset, data);
                }
            }
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

// Count cells matching reference at given byte threshold
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

// Read N byte from each functional cell
function getNDistribution(controller) {
    const B = controller.memory.B;
    const dist = {};
    for (let i = 0; i < B; i++) {
        for (let j = 0; j < B; j++) {
            const mem = readCellMemory(controller, i, j);
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
            const t0 = Date.now();
            origConsoleError(`  eps=${label}...`);

            const controller = initController(size, seed, eps);
            loadTriplicatorAll(controller, bytes);

            let prevCp = 0;
            const snapshots = [];
            for (const cp of checkpoints) {
                runInterrupts(controller, cp - prevCp);
                prevCp = cp;
                const funcAlive = countAliveFunc(controller);
                const match80 = countAliveMatch(controller, bytes, 0.8);
                snapshots.push({ cp, funcAlive, match80 });
            }
            const last = snapshots[snapshots.length - 1];
            const dt = ((Date.now() - t0) / 1000).toFixed(1);
            origConsoleError(`    -> 5M: func=${last.funcAlive}, 80%=${last.match80} (${dt}s)`);
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

    const epsilons = [1/16384, 1/32768, 1/65536, 1/131072];
    const initialNs = [5, 10, 20];
    const checkpoints = [500_000, 1_000_000, 2_000_000, 5_000_000];
    const size = 8;
    const seed = 42;

    const results = [];

    for (const eps of epsilons) {
        const label = `1/${Math.round(1/eps)}`;
        for (const initN of initialNs) {
            const t0 = Date.now();
            origConsoleError(`  eps=${label}, N=${initN}...`);

            const controller = initController(size, seed, eps);

            // Extra bytes: N at $42 in all 3 pages
            const nByte = new Uint8Array([initN]);
            loadTriplicatorAll(controller, bytes, [
                [0x42, nByte], [0x242, nByte], [0x342, nByte],
            ]);

            let prevCp = 0;
            const snapshots = [];
            for (const cp of checkpoints) {
                runInterrupts(controller, cp - prevCp);
                prevCp = cp;
                const funcAlive = countAliveFunc(controller);
                const nDist = getNDistribution(controller);
                let totalN = 0, count = 0;
                for (const [n, c] of Object.entries(nDist)) {
                    totalN += parseInt(n) * c;
                    count += c;
                }
                const meanN = count > 0 ? (totalN / count).toFixed(1) : 'N/A';
                const topN = Object.entries(nDist)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5)
                    .map(([n, c]) => `${n}:${c}`)
                    .join(' ');
                snapshots.push({ cp, funcAlive, meanN, topN });
            }
            const last = snapshots[snapshots.length - 1];
            const dt = ((Date.now() - t0) / 1000).toFixed(1);
            origConsoleError(`    -> 5M: alive=${last.funcAlive}, meanN=${last.meanN} (${dt}s)`);
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
- Previous "faster repair" experiment failed because it DUPLICATED the repair block,
  inflating the genome from 51B to 96-366B. The loop approach keeps code compact.

## Experiment 1: Loop Repair Variants at Various Noise Levels

### Functional alive counts (cells with BRK + copy signature)

`;

    // Combined table: all variants side by side for each checkpoint
    for (const cpIdx of [0, 1, 2, 3]) {
        const cpLabel = ['500k', '1M', '2M', '5M'][cpIdx];
        md += `#### At ${cpLabel} interrupts\n\n`;
        md += `| Epsilon |`;
        for (const v of exp1) md += ` ${v.name} |`;
        md += `\n|---------|`;
        for (const _v of exp1) md += `------|`;
        md += `\n`;
        for (let ei = 0; ei < exp1[0].varResults.length; ei++) {
            md += `| ${exp1[0].varResults[ei].label} |`;
            for (const v of exp1) {
                md += ` ${v.varResults[ei].snapshots[cpIdx].funcAlive} |`;
            }
            md += `\n`;
        }
        md += `\n`;
    }

    md += `### 80% byte-match alive counts at 5M interrupts\n\n`;
    md += `| Epsilon |`;
    for (const v of exp1) md += ` ${v.name} |`;
    md += `\n|---------|`;
    for (const _v of exp1) md += `------|`;
    md += `\n`;
    for (let ei = 0; ei < exp1[0].varResults.length; ei++) {
        md += `| ${exp1[0].varResults[ei].label} |`;
        for (const v of exp1) {
            md += ` ${v.varResults[ei].snapshots[3].match80} |`;
        }
        md += `\n`;
    }

    md += `\n## Experiment 2: Evolvable Repair Rate

The repair count N is stored at byte \\$42 in the genome. During noisy BRK copies,
N mutates along with the rest of the code. Natural selection acts on N: cells with
suboptimal N values die to corruption or waste scheduling cycles.

### Results

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
of ~50 bytes, it takes ~50 scheduling cycles to fully scan all code. At any nonzero
noise level, corruption accumulates faster than repair can fix it.

The loop variants repair N bytes per scheduling, dramatically improving the
repair-to-corruption ratio:
- At N=5: full code scan every ~11 schedulings
- At N=10: full code scan every ~6 schedulings
- At N=20: full code scan every ~3 schedulings

The crucial insight: a LOOP adds only 5 bytes to the genome (LDX #N / DEX / BNE),
whereas DUPLICATING the repair block adds ~45 bytes per extra copy. Smaller code =
less surface area to corrupt = more robust.

### Cycle budget analysis

Each repair iteration costs ~48 cycles:
- DEC \\$40 (5), BPL (2-3), LDY \\$40 (3)
- LDA abs,Y (4), AND abs,Y (4), STA zp (3) = 11 cycles (majority pair 1)
- LDA zp,Y (4), AND abs,Y (4), ORA zp (3), STA zp (3) = 14 cycles (majority pair 2)
- LDA zp,Y (4), AND abs,Y (4), ORA zp (3) = 11 cycles (majority pair 3)
- STA zp,Y (4), STA abs,Y (5), STA abs,Y (5) = 14 cycles (write back)
- DEX (2), BNE (3) = 5 cycles
- Total: ~55 cycles per iteration

The timer mean is ~2800 cycles. BRK = 7 cycles. LDX = 2 cycles.
Available budget: (2800 - 9) / 55 = ~50 iterations max.

Safe targets (accounting for Poisson variance):
- N=5: 5 * 55 + 9 = 284 cycles (~10% of mean, very safe)
- N=10: 10 * 55 + 9 = 559 cycles (~20% of mean, safe)
- N=20: 20 * 55 + 9 = 1109 cycles (~40% of mean, usually safe)

### Evolvable N

`;

    const survivors = exp2.filter(r => r.snapshots[r.snapshots.length-1].funcAlive > 0);
    if (survivors.length > 0) {
        md += `Surviving runs show natural selection acting on N:\n\n`;
        for (const s of survivors) {
            const last = s.snapshots[s.snapshots.length-1];
            md += `- eps=${s.label}, initial N=${s.initN}: ${last.funcAlive}/64 alive at 5M, mean N=${last.meanN}, top=[${last.topN}]\n`;
        }
        md += `\n`;
        // Find convergent N value if possible
        const nValues = survivors.map(s => parseFloat(s.snapshots[s.snapshots.length-1].meanN)).filter(n => !isNaN(n));
        if (nValues.length > 0) {
            const avgN = (nValues.reduce((a,b) => a+b, 0) / nValues.length).toFixed(1);
            md += `Mean N across surviving runs: ${avgN}\n\n`;
            md += `This suggests natural selection converges toward N ~ ${Math.round(parseFloat(avgN))} as the optimal repair rate.\n`;
        }
    } else {
        md += `No evolvable runs survived to 5M interrupts at the tested noise levels.\n`;
        md += `This indicates the evolvable variant may need the repair range adjusted to cover byte \\$42,\n`;
        md += `or the noise levels tested are too high for the 58-byte genome to sustain.\n`;
    }

    md += `\n## Best-performing variant\n\n`;

    // Find best variant: highest 80%-match at lowest epsilon
    let bestName = 'original (N=1)';
    let bestScore = 0;
    let bestFile = 'triplicator.asm';
    let bestEps = '';
    const variantFiles = ['triplicator.asm', 'triplicator-loop5.asm', 'triplicator-loop10.asm', 'triplicator-loop20.asm'];
    for (let vi = 0; vi < exp1.length; vi++) {
        const v = exp1[vi];
        for (const r of v.varResults) {
            // Score: alive at 5M, weighted by epsilon (higher eps = harder = worth more)
            const alive5M = r.snapshots[3].match80;
            const score = alive5M * r.eps * 1e6;  // normalize
            if (score > bestScore || (score === bestScore && r.snapshots[3].funcAlive > 0)) {
                bestScore = score;
                bestName = v.name;
                bestFile = variantFiles[vi];
                bestEps = r.label;
            }
        }
        // Also check funcAlive if no 80% matches anywhere
        if (bestScore === 0) {
            for (const r of v.varResults) {
                const alive5M = r.snapshots[3].funcAlive;
                if (alive5M > 0) {
                    bestName = v.name;
                    bestFile = variantFiles[vi];
                    bestEps = r.label;
                    bestScore = -1; // sentinel
                }
            }
        }
    }

    const bestSrc = readFile(bestFile);
    md += `Best performer: **${bestName}** at eps=${bestEps}\n\n`;
    md += '```asm\n' + bestSrc + '```\n';

    md += `\n## Evolvable variant assembly\n\n`;
    const evolSrc = readFile('triplicator-evolvable.asm');
    md += '```asm\n' + evolSrc + '```\n';
    md += `\nN is stored at byte \\$42. To use, poke the initial N value at offsets \\$42, \\$242, \\$342.\n`;

    md += `\nTotal runtime: ${elapsed}s\n`;

    const outPath = new URL('../doc/triplicator-repair-rate.md', import.meta.url);
    fs.writeFileSync(outPath, md);
    origConsoleError('\nResults written to doc/triplicator-repair-rate.md');
}

main().catch(e => { origConsoleError(e); process.exit(1); });
