#!/usr/bin/env node
/**
 * Rock-Paper-Scissors ecology experiments with red/green/blue BRK copier presets.
 * Outputs results as Markdown to stdout.
 */

import { createBoard, writeCellBytes } from '../engine/board.js';
import { assemble } from '../engine/assembler.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Suppress console.error globally
const origError = console.error;
console.error = () => {};

// Read preset source files
const redSrc = fs.readFileSync(path.join(__dirname, '../presets/red.asm'), 'utf-8');
const greenSrc = fs.readFileSync(path.join(__dirname, '../presets/green.asm'), 'utf-8');
const blueSrc = fs.readFileSync(path.join(__dirname, '../presets/blue.asm'), 'utf-8');

let redBytes, greenBytes, blueBytes;

// Hue constants
const HUE_RED = 1;
const HUE_GREEN = 85;   // 0x55
const HUE_BLUE = 170;   // 0xAA
const HUE_DEAD = 0;
const HUE_OFFSET = 0x3A0; // offset within cell for hue byte (green channel of bitmap)

function readHue(memory, i, j) {
    const base = memory.ijbToByteIndex(i, j, 0);
    return memory.storage[base + HUE_OFFSET];
}

function countHues(memory, size) {
    const counts = { red: 0, green: 0, blue: 0, dead: 0, other: 0 };
    const hueDistribution = new Map(); // for experiment 5
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            const hue = readHue(memory, i, j);
            hueDistribution.set(hue, (hueDistribution.get(hue) || 0) + 1);
            if (hue === HUE_RED) counts.red++;
            else if (hue === HUE_GREEN) counts.green++;
            else if (hue === HUE_BLUE) counts.blue++;
            else if (hue === HUE_DEAD) counts.dead++;
            else counts.other++;
        }
    }
    return { counts, hueDistribution };
}

function seedCell(controller, i, j, bytes) {
    writeCellBytes(controller, i, j, 0, bytes);
}

function runInterrupts(controller, n) {
    for (let k = 0; k < n; k++) {
        controller.runToNextInterrupt();
    }
}

function runExperimentWithTracking(size, seed, placements, boardParams, totalInterrupts, trackInterval, trackHueDistribution = false) {
    const { memory, controller } = createBoard(size, seed, boardParams);

    // Seed cells
    for (const { i, j, bytes } of placements) {
        seedCell(controller, i, j, bytes);
    }

    const snapshots = [];
    const interruptsPerChunk = trackInterval;
    const numChunks = Math.floor(totalInterrupts / interruptsPerChunk);

    // Initial snapshot
    const init = countHues(memory, size);
    snapshots.push({ interrupt: 0, ...init.counts, hueDistribution: trackHueDistribution ? init.hueDistribution : null });

    for (let chunk = 0; chunk < numChunks; chunk++) {
        runInterrupts(controller, interruptsPerChunk);
        const result = countHues(memory, size);
        snapshots.push({
            interrupt: (chunk + 1) * interruptsPerChunk,
            ...result.counts,
            hueDistribution: trackHueDistribution ? result.hueDistribution : null
        });
    }

    return snapshots;
}

function formatTable(snapshots) {
    let table = '| Interrupts | Red | Green | Blue | Dead | Other |\n';
    table += '|---:|---:|---:|---:|---:|---:|\n';
    for (const s of snapshots) {
        table += `| ${s.interrupt.toLocaleString()} | ${s.red} | ${s.green} | ${s.blue} | ${s.dead} | ${s.other} |\n`;
    }
    return table;
}

function summarize(snapshots) {
    const last = snapshots[snapshots.length - 1];
    const parts = [];
    if (last.red > 0) parts.push(`Red: ${last.red}`);
    if (last.green > 0) parts.push(`Green: ${last.green}`);
    if (last.blue > 0) parts.push(`Blue: ${last.blue}`);
    if (last.dead > 0) parts.push(`Dead: ${last.dead}`);
    if (last.other > 0) parts.push(`Other: ${last.other}`);

    const total = last.red + last.green + last.blue;
    if (total === 0) return 'All dead.';

    const dominant = [
        { name: 'Red', count: last.red },
        { name: 'Green', count: last.green },
        { name: 'Blue', count: last.blue },
    ].sort((a, b) => b.count - a.count);

    if (dominant[0].count > 0 && dominant[1].count === 0) {
        return `${dominant[0].name} dominates completely. ${parts.join(', ')}`;
    }

    // Check for cycling: did any species that was 0 at some point recover?
    const hadZero = { red: false, green: false, blue: false };
    const hadPositive = { red: false, green: false, blue: false };
    for (const s of snapshots) {
        if (s.red === 0 && hadPositive.red) hadZero.red = true;
        if (s.green === 0 && hadPositive.green) hadZero.green = true;
        if (s.blue === 0 && hadPositive.blue) hadZero.blue = true;
        if (s.red > 0) hadPositive.red = true;
        if (s.green > 0) hadPositive.green = true;
        if (s.blue > 0) hadPositive.blue = true;
    }

    const allCoexist = last.red > 0 && last.green > 0 && last.blue > 0;
    if (allCoexist) return `All three coexist. ${parts.join(', ')}`;

    return `Final: ${parts.join(', ')}`;
}

async function main() {
    // Assemble presets
    redBytes = await assemble(redSrc);
    greenBytes = await assemble(greenSrc);
    blueBytes = await assemble(blueSrc);

    const output = [];
    output.push('# Rock-Paper-Scissors Ecology Experiments');
    output.push('');
    output.push('Three BRK copier species (red hue=1, green hue=85, blue hue=170) compete on a board.');
    output.push('Each uses `BRK $F5` to noisy-copy itself to a neighbor.');
    output.push('');

    // ========== Experiment 1 ==========
    console.log('Running Experiment 1: 16x16 three-way competition...');
    output.push('## Experiment 1: Three-way competition on 16x16 board');
    output.push('');
    output.push('- Size: 16x16, Seed: 42, epsilon=1/131072');
    output.push('- Red at (0,0), Green at (8,0), Blue at (0,8)');
    output.push('- 2M interrupts, tracking every 100k');
    output.push('');

    const exp1 = runExperimentWithTracking(16, 42, [
        { i: 0, j: 0, bytes: redBytes },
        { i: 8, j: 0, bytes: greenBytes },
        { i: 0, j: 8, bytes: blueBytes },
    ], { pBitNoise: 1/131072 }, 2_000_000, 100_000);

    output.push(formatTable(exp1));
    output.push(`**Result:** ${summarize(exp1)}`);
    output.push('');

    // ========== Experiment 2 ==========
    console.log('Running Experiment 2: 32x32 three-way competition...');
    output.push('## Experiment 2: Three-way competition on 32x32 board');
    output.push('');
    output.push('- Size: 32x32, Seed: 42, epsilon=1/131072');
    output.push('- Red at (0,0), Green at (16,0), Blue at (0,16)');
    output.push('- 2M interrupts, tracking every 100k');
    output.push('');

    const exp2 = runExperimentWithTracking(32, 42, [
        { i: 0, j: 0, bytes: redBytes },
        { i: 16, j: 0, bytes: greenBytes },
        { i: 0, j: 16, bytes: blueBytes },
    ], { pBitNoise: 1/131072 }, 2_000_000, 100_000);

    output.push(formatTable(exp2));
    output.push(`**Result:** ${summarize(exp2)}`);
    output.push('');

    // ========== Experiment 3 ==========
    console.log('Running Experiment 3: 16x16 with movement disabled...');
    output.push('## Experiment 3: RPS with movement disabled');
    output.push('');
    output.push('- Size: 16x16, Seed: 42, epsilon=1/131072, implementsMove=false');
    output.push('- Red at (0,0), Green at (8,0), Blue at (0,8)');
    output.push('- 2M interrupts, tracking every 100k');
    output.push('');

    const exp3 = runExperimentWithTracking(16, 42, [
        { i: 0, j: 0, bytes: redBytes },
        { i: 8, j: 0, bytes: greenBytes },
        { i: 0, j: 8, bytes: blueBytes },
    ], { pBitNoise: 1/131072, implementsMove: false }, 2_000_000, 100_000);

    output.push(formatTable(exp3));
    output.push(`**Result:** ${summarize(exp3)}`);
    output.push('');

    // ========== Experiment 4 ==========
    output.push('## Experiment 4: RPS at different noise levels');
    output.push('');

    const noiseConfigs = [
        { label: 'epsilon=0', eps: 0 },
        { label: 'epsilon=1/131072', eps: 1/131072 },
        { label: 'epsilon=1/32768', eps: 1/32768 },
        { label: 'epsilon=1/8192', eps: 1/8192 },
    ];

    for (const { label, eps } of noiseConfigs) {
        console.log(`Running Experiment 4 (${label})...`);
        output.push(`### ${label}`);
        output.push('');
        output.push(`- Size: 16x16, Seed: 42, ${label}`);
        output.push('- Red at (0,0), Green at (8,0), Blue at (0,8)');
        output.push('- 2M interrupts, tracking every 100k');
        output.push('');

        const exp4 = runExperimentWithTracking(16, 42, [
            { i: 0, j: 0, bytes: redBytes },
            { i: 8, j: 0, bytes: greenBytes },
            { i: 0, j: 8, bytes: blueBytes },
        ], { pBitNoise: eps }, 2_000_000, 100_000);

        output.push(formatTable(exp4));
        output.push(`**Result:** ${summarize(exp4)}`);
        output.push('');
    }

    // ========== Experiment 5 ==========
    console.log('Running Experiment 5: Hue diversity tracking...');
    output.push('## Experiment 5: Hue diversity tracking');
    output.push('');
    output.push('- Size: 16x16, Seed: 42, epsilon=1/131072');
    output.push('- Red at (0,0), Green at (8,0), Blue at (0,8)');
    output.push('- 2M interrupts, tracking full hue distribution every 200k');
    output.push('');

    const exp5 = runExperimentWithTracking(16, 42, [
        { i: 0, j: 0, bytes: redBytes },
        { i: 8, j: 0, bytes: greenBytes },
        { i: 0, j: 8, bytes: blueBytes },
    ], { pBitNoise: 1/131072 }, 2_000_000, 200_000, true);

    // Show distribution at each checkpoint
    for (const s of exp5) {
        if (!s.hueDistribution) continue;
        output.push(`### At ${s.interrupt.toLocaleString()} interrupts`);
        output.push('');

        // Sort by count descending, show top entries
        const sorted = [...s.hueDistribution.entries()].sort((a, b) => b[1] - a[1]);
        const totalCells = sorted.reduce((sum, [, count]) => sum + count, 0);
        const uniqueHues = sorted.filter(([, count]) => count > 0).length;

        output.push(`Unique hue values: ${uniqueHues}`);
        output.push('');

        // Show all non-trivial hues
        let distTable = '| Hue | Count | % | Species |\n';
        distTable += '|---:|---:|---:|:---|\n';
        for (const [hue, count] of sorted) {
            if (count === 0) continue;
            const pct = (100 * count / totalCells).toFixed(1);
            let species = '';
            if (hue === HUE_RED) species = 'Red';
            else if (hue === HUE_GREEN) species = 'Green';
            else if (hue === HUE_BLUE) species = 'Blue';
            else if (hue === HUE_DEAD) species = 'Dead';
            else species = 'Mutant';
            distTable += `| ${hue} | ${count} | ${pct} | ${species} |\n`;
        }
        output.push(distTable);
    }

    // Summary of speciation
    const lastDist = exp5[exp5.length - 1].hueDistribution;
    const mutantHues = [...lastDist.entries()].filter(([hue,]) =>
        hue !== HUE_RED && hue !== HUE_GREEN && hue !== HUE_BLUE && hue !== HUE_DEAD
    );
    const totalMutants = mutantHues.reduce((sum, [, count]) => sum + count, 0);

    output.push('### Speciation Summary');
    output.push('');
    if (totalMutants > 0) {
        output.push(`**${totalMutants} cells have mutant hue values** (neither 0, 1, 85, nor 170).`);
        output.push('This represents visible speciation through copy noise.');
        output.push('');
        output.push('Mutant hue values at final snapshot:');
        output.push('');
        for (const [hue, count] of mutantHues.sort((a, b) => b[1] - a[1])) {
            output.push(`- Hue ${hue}: ${count} cells`);
        }
    } else {
        output.push('No mutant hue values detected. Copy noise did not produce visible speciation at this epsilon.');
    }
    output.push('');

    // Write output
    const markdown = output.join('\n');
    const outPath = path.join(__dirname, '../doc/rps-ecology-experiments.md');
    fs.writeFileSync(outPath, markdown);
    console.log(`Results written to ${outPath}`);
}

main().catch(e => {
    console.error = origError;
    console.error(e);
    process.exit(1);
});
