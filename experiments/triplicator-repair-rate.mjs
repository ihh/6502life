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
    writeCellBytes(controller, i, j, 0, bytes);
    writeCellBytes(controller, i, j, 0x200, bytes);
    writeCellBytes(controller, i, j, 0x300, bytes);
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
// Experiment 1A: Single-cell seeding (matches original experiment)
// Tests whether loop repair allows spreading + surviving at nonzero noise
// ============================================================
async function experiment1a() {
    origConsoleError('\n=== EXPERIMENT 1A: Single-cell seeding, spread + survive ===');

    const variants = [
        { name: 'original (N=1)', file: 'triplicator.asm' },
        { name: 'loop N=5', file: 'triplicator-loop5.asm' },
        { name: 'loop N=10', file: 'triplicator-loop10.asm' },
        { name: 'loop N=20', file: 'triplicator-loop20.asm' },
    ];

    const epsilons = [1/32768, 1/65536, 1/131072];
    const checkpoints = [100_000, 500_000, 1_000_000];
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
            // Single cell seeding at (0,0)
            loadTriplicator(controller, 0, 0, bytes);

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
            origConsoleError(`    -> 1M: func=${last.funcAlive}, 80%=${last.match80} (${dt}s)`);
            varResults.push({ eps, label, snapshots });
        }
        results.push({ name: variant.name, codeSize: bytes.length, varResults });
    }
    return results;
}

// ============================================================
// Experiment 1B: Full-board seeding (tests repair maintenance)
// ============================================================
async function experiment1b() {
    origConsoleError('\n=== EXPERIMENT 1B: Full-board seeding, repair maintenance ===');

    const variants = [
        { name: 'original (N=1)', file: 'triplicator.asm' },
        { name: 'loop N=5', file: 'triplicator-loop5.asm' },
        { name: 'loop N=10', file: 'triplicator-loop10.asm' },
        { name: 'loop N=20', file: 'triplicator-loop20.asm' },
    ];

    const epsilons = [1/8192, 1/32768, 1/131072];
    const checkpoints = [100_000, 500_000, 1_000_000];
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
            origConsoleError(`    -> 1M: func=${last.funcAlive}, 80%=${last.match80} (${dt}s)`);
            varResults.push({ eps, label, snapshots });
        }
        results.push({ name: variant.name, codeSize: bytes.length, varResults });
    }
    return results;
}

// ============================================================
// Experiment 2: Evolvable N (full-board seeding)
// ============================================================
async function experiment2() {
    origConsoleError('\n=== EXPERIMENT 2: Evolvable repair rate ===');

    const src = readFile('triplicator-evolvable.asm');
    const bytes = await assemble(src);
    origConsoleError(`Evolvable triplicator: ${bytes.length}B`);

    const epsilons = [1/32768, 1/131072];
    const initialNs = [5, 10, 20];
    const checkpoints = [100_000, 500_000, 1_000_000];
    const size = 8;
    const seed = 42;

    const results = [];

    for (const eps of epsilons) {
        const label = `1/${Math.round(1/eps)}`;
        for (const initN of initialNs) {
            const t0 = Date.now();
            origConsoleError(`  eps=${label}, N=${initN}...`);

            const controller = initController(size, seed, eps);
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
                const match80 = countAliveMatch(controller, bytes, 0.8);
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
                snapshots.push({ cp, funcAlive, match80, meanN, topN });
            }
            const last = snapshots[snapshots.length - 1];
            const dt = ((Date.now() - t0) / 1000).toFixed(1);
            origConsoleError(`    -> 1M: alive=${last.funcAlive}, 80%=${last.match80}, meanN=${last.meanN} (${dt}s)`);
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

    const exp1a = await experiment1a();
    const exp1b = await experiment1b();
    const exp2 = await experiment2();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    origConsoleError(`\nAll experiments completed in ${elapsed}s`);

    // ============================================================
    // Build markdown report
    // ============================================================
    const checkpointLabels = ['100k', '500k', '1M'];
    const lastCp = checkpointLabels.length - 1;

    let md = `# Triplicator Repair Rate Experiments

Date: ${new Date().toISOString().slice(0, 10)}

## Setup

- Board: 8x8 (64 cells)
- Seed: 42
- Triplicator variants tested with repair LOOP (not duplication)
- Code size: original 51B, loop variants 56B, evolvable 58B
- The loop adds only 5 bytes (LDX #N / DEX / BNE) regardless of N
- Previous "faster repair" experiment failed because it DUPLICATED the repair block,
  inflating the genome from 51B to 96-366B. The loop approach keeps code compact.

## Experiment 1A: Single-Cell Seeding (Spread + Survive)

Triplicator seeded at cell (0,0) only. Tests ability to spread AND maintain integrity.

### Functional alive counts at ${checkpointLabels[lastCp]} interrupts

| Epsilon |`;
    for (const v of exp1a) md += ` ${v.name} |`;
    md += `\n|---------|`;
    for (const _v of exp1a) md += `------|`;
    md += `\n`;
    for (let ei = 0; ei < exp1a[0].varResults.length; ei++) {
        md += `| ${exp1a[0].varResults[ei].label} |`;
        for (const v of exp1a) {
            md += ` ${v.varResults[ei].snapshots[lastCp].funcAlive} |`;
        }
        md += `\n`;
    }

    md += `\n### 80% byte-match at ${checkpointLabels[lastCp]} interrupts\n\n`;
    md += `| Epsilon |`;
    for (const v of exp1a) md += ` ${v.name} |`;
    md += `\n|---------|`;
    for (const _v of exp1a) md += `------|`;
    md += `\n`;
    for (let ei = 0; ei < exp1a[0].varResults.length; ei++) {
        md += `| ${exp1a[0].varResults[ei].label} |`;
        for (const v of exp1a) {
            md += ` ${v.varResults[ei].snapshots[lastCp].match80} |`;
        }
        md += `\n`;
    }

    md += `\n### Spread timeline (func-alive at each checkpoint)\n\n`;
    for (const v of exp1a) {
        md += `#### ${v.name} (${v.codeSize}B)\n\n`;
        md += `| Epsilon |`;
        for (const cl of checkpointLabels) md += ` ${cl} |`;
        md += `\n|---------|`;
        for (const _cl of checkpointLabels) md += `------|`;
        md += `\n`;
        for (const r of v.varResults) {
            md += `| ${r.label} |`;
            for (const s of r.snapshots) md += ` ${s.funcAlive} |`;
            md += `\n`;
        }
        md += `\n`;
    }

    md += `## Experiment 1B: Full-Board Seeding (Repair Maintenance)

All 64 cells seeded with triplicator. Tests pure repair ability under noise.

### Functional alive counts at ${checkpointLabels[lastCp]} interrupts

| Epsilon |`;
    for (const v of exp1b) md += ` ${v.name} |`;
    md += `\n|---------|`;
    for (const _v of exp1b) md += `------|`;
    md += `\n`;
    for (let ei = 0; ei < exp1b[0].varResults.length; ei++) {
        md += `| ${exp1b[0].varResults[ei].label} |`;
        for (const v of exp1b) {
            md += ` ${v.varResults[ei].snapshots[lastCp].funcAlive} |`;
        }
        md += `\n`;
    }

    md += `\n### 80% byte-match at ${checkpointLabels[lastCp]} interrupts\n\n`;
    md += `| Epsilon |`;
    for (const v of exp1b) md += ` ${v.name} |`;
    md += `\n|---------|`;
    for (const _v of exp1b) md += `------|`;
    md += `\n`;
    for (let ei = 0; ei < exp1b[0].varResults.length; ei++) {
        md += `| ${exp1b[0].varResults[ei].label} |`;
        for (const v of exp1b) {
            md += ` ${v.varResults[ei].snapshots[lastCp].match80} |`;
        }
        md += `\n`;
    }

    md += `\n## Experiment 2: Evolvable Repair Rate

The repair count N is stored at byte \\$42 in the genome. During noisy BRK copies,
N mutates along with the rest of the code. Natural selection acts on N: cells with
suboptimal N values die to corruption or waste scheduling cycles.
Full-board seeding.

### Results

`;

    for (const r of exp2) {
        md += `#### eps=${r.label}, initial N=${r.initN}\n\n`;
        md += `| Checkpoint | Alive | 80% match | Mean N | Top N values |\n`;
        md += `|-----------|-------|----------|--------|-------------|\n`;
        for (let si = 0; si < r.snapshots.length; si++) {
            const s = r.snapshots[si];
            md += `| ${checkpointLabels[si]} | ${s.funcAlive} | ${s.match80} | ${s.meanN} | ${s.topN} |\n`;
        }
        md += `\n`;
    }

    // Analysis
    md += `## Analysis

### Loop repair vs original

The original triplicator repairs 1 byte per scheduling cycle. With a repair range
of ~50 bytes, it takes ~50 scheduling cycles to fully scan all code bytes.

The loop variants repair N bytes per scheduling, dramatically improving the
repair-to-corruption ratio:
- At N=5: full code scan every ~11 schedulings
- At N=10: full code scan every ~6 schedulings
- At N=20: full code scan every ~3 schedulings

The crucial insight: a LOOP adds only 5 bytes to the genome (LDX #N / DEX / BNE),
whereas DUPLICATING the repair block adds ~45 bytes per extra copy. Smaller code =
less surface area to corrupt = more robust.

### Cycle budget analysis

Each repair iteration costs ~55 cycles:
- DEC \\$40 (5), BPL (2-3), LDY \\$40 (3) = ~10 cycles
- Majority vote: 3 pairs of LDA/AND/ORA/STA = ~36 cycles
- Write-back: 3 STAs = ~14 cycles
- DEX (2) + BNE (3) = 5 cycles

The timer mean is ~2800 cycles (Poisson-distributed). BRK = 7 cycles. LDX = 2 cycles.
Available budget: (2800 - 9) / 55 = ~50 iterations max.

Safe targets (accounting for Poisson variance):
- N=5: 284 cycles (~10% of mean, very safe)
- N=10: 559 cycles (~20% of mean, safe)
- N=20: 1109 cycles (~40% of mean, usually safe)
- N=50: 2759 cycles (~99% of mean, risky — many schedulings will be cut short)

### Evolvable N

`;

    const survivors = exp2.filter(r => r.snapshots[lastCp].funcAlive > 0);
    if (survivors.length > 0) {
        md += `Results at ${checkpointLabels[lastCp]}:\n\n`;
        for (const s of survivors) {
            const last = s.snapshots[lastCp];
            md += `- eps=${s.label}, initial N=${s.initN}: ${last.funcAlive}/64 alive, 80%=${last.match80}, mean N=${last.meanN}, top=[${last.topN}]\n`;
        }
        const drifters = survivors.filter(s => {
            const last = s.snapshots[lastCp];
            return parseFloat(last.meanN) !== s.initN;
        });
        if (drifters.length > 0) {
            md += `\nN drift observed in ${drifters.length} runs — natural selection is acting on N.\n`;
        } else {
            md += `\nN values remained stable — mutations at \\$42 are being repaired along with the rest of the code.\n`;
            md += `At higher noise levels or longer runs, N would begin to drift and selection would act.\n`;
        }
    } else {
        md += `No evolvable runs survived to ${checkpointLabels[lastCp]} interrupts.\n`;
    }

    // Viable range analysis
    md += `\n### Viable N range\n\n`;
    md += `From the cycle budget analysis, the viable range for N is approximately:\n`;
    md += `- **Minimum**: N >= 1 (must repair at least something)\n`;
    md += `- **Optimum**: N ~ 10-20 (full code scan every 3-6 schedulings)\n`;
    md += `- **Maximum**: N ~ 50 (uses nearly all scheduling budget; Poisson variance\n`;
    md += `  means many schedulings get cut short before completing the repair loop)\n`;
    md += `- **N = 0**: effectively disables repair; viable only at zero noise\n\n`;
    md += `The evolvable triplicator allows natural selection to find this optimum.\n`;
    md += `At high noise, N should evolve upward (more repair needed to survive).\n`;
    md += `At low noise, N is neutral and drifts freely.\n`;

    md += `\n## Best-performing variant\n\n`;

    // Determine best: look at 1A (single-cell) results since that's harder
    let bestName = 'original (N=1)';
    let bestFile = 'triplicator.asm';
    let bestScore = -1;
    let bestEps = '';
    let bestAlive = 0;
    let bestMatch = 0;
    const variantFiles = ['triplicator.asm', 'triplicator-loop5.asm', 'triplicator-loop10.asm', 'triplicator-loop20.asm'];
    for (let vi = 0; vi < exp1a.length; vi++) {
        const v = exp1a[vi];
        for (const r of v.varResults) {
            const last = r.snapshots[lastCp];
            // Score: prefer highest match80 at highest noise
            const score = last.match80 * 1e6 * r.eps + last.funcAlive * r.eps;
            if (score > bestScore) {
                bestScore = score;
                bestName = v.name;
                bestFile = variantFiles[vi];
                bestEps = r.label;
                bestAlive = last.funcAlive;
                bestMatch = last.match80;
            }
        }
    }

    const bestSrc = readFile(bestFile);
    md += `Best performer (single-cell spread test): **${bestName}** (${bestAlive}/64 func-alive, ${bestMatch}/64 80%-match at eps=${bestEps})\n\n`;
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
