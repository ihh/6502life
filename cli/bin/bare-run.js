#!/usr/bin/env node
/**
 * bare-run: run the bare-sim (pair-based, no noise) from the CLI.
 *
 * Usage:
 *   node cli/bin/bare-run.js --preset bare-rep --cell 0,0 --passes 100
 *   node cli/bin/bare-run.js --asm program.asm --cell 0,0 --passes 200
 *   node cli/bin/bare-run.js --hex "B5 00 9D 00 04 E8 90 F8" --cell 0,0
 *   node cli/bin/bare-run.js --size 16 --randomize --passes 500
 *   node cli/bin/bare-run.js --seed 42 --preset bare-rep --cell 0,0 --json
 */

import { BareSimCPU } from '../../webgpu/bare-sim-cpu.js';
import { getPreset } from '../lib/terminal/presets.js';
import { assemble } from '../../engine/assembler.js';
import { readFileSync } from 'fs';

// --- Parse args ---
const args = process.argv.slice(2);
function flag(name) { return args.includes('--' + name); }
function opt(name, def) {
    const i = args.indexOf('--' + name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const size = Number(opt('size', 8));
const seed = Number(opt('seed', 42));
const passes = Number(opt('passes', 100));
const cellArg = opt('cell', null);
const presetName = opt('preset', null);
const asmFile = opt('asm', null);
const hexStr = opt('hex', null);
const randomize = flag('randomize');
const json = flag('json');
const census = flag('census');

// --- Build sim ---
const sim = new BareSimCPU(size, 1024, { seed });

// Randomize if requested
if (randomize) {
    for (let i = 0; i < sim.storage.length; i++) {
        sim.storage[i] = (Math.random() * 256) | 0;
    }
}

// --- Load program ---
let programBytes = null;
let programSource = null;

if (hexStr) {
    programBytes = new Uint8Array(hexStr.trim().split(/\s+/).map(h => parseInt(h, 16)));
    programSource = 'hex';
} else if (presetName) {
    const preset = getPreset(presetName);
    if (!preset) { console.error(`Unknown preset: ${presetName}`); process.exit(1); }
    programBytes = await assemble(preset.source);
    programSource = `preset:${presetName}`;
} else if (asmFile) {
    const source = readFileSync(asmFile, 'utf-8');
    programBytes = await assemble(source);
    programSource = `asm:${asmFile}`;
}

if (programBytes && cellArg) {
    const [ci, cj] = cellArg.split(',').map(Number);
    sim.writeCell(ci, cj, 0, programBytes);
    // Init registers: PC=0, S=$FF, P=$30
    sim.writeCell(ci, cj, 0xF9, [0x00, 0x00]); // PCHI, PCLO
    sim.writeCell(ci, cj, 0xFB, [0x30]);        // P
    sim.writeCell(ci, cj, 0xFF, [0xFF]);         // S
    if (!json) {
        const hex = [...programBytes].map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.error(`Loaded ${programBytes.length}B into cell (${ci},${cj}): ${hex}`);
    }
}

// --- Run ---
for (let p = 0; p < passes; p++) {
    await sim.runPass();
}

// --- Report ---
const M = 1024;
const B = size;

if (census || !json) {
    const c = await sim.census();
    if (json) {
        console.log(JSON.stringify(c, null, 2));
    } else {
        console.log(`\nBoard: ${B}x${B}, seed=${seed}, ${passes} passes`);
        console.log(`Functional: ${c.functional}/${c.total}`);
        console.log(`Variants: ${c.loopVariants}`);
        if (c.topLoops.length > 0) {
            console.log('Top loops:');
            for (const [sig, count] of c.topLoops) {
                console.log(`  ${sig}: ${count} cells`);
            }
        }
    }
}

// If a cell was specified, show its state
if (cellArg && !json) {
    const [ci, cj] = cellArg.split(',').map(Number);
    const base = (ci * B + cj) * M;
    const bytes = sim.storage.slice(base, base + 32);
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ');
    const regs = {
        PCHI: sim.storage[base + 0xF9],
        PCLO: sim.storage[base + 0xFA],
        P: sim.storage[base + 0xFB],
        A: sim.storage[base + 0xFC],
        X: sim.storage[base + 0xFD],
        Y: sim.storage[base + 0xFE],
        S: sim.storage[base + 0xFF],
    };
    console.log(`\nCell (${ci},${cj}):`);
    console.log(`  ${hex.slice(0, 47)}...`);
    console.log(`  PC=$${((regs.PCHI << 8) | regs.PCLO).toString(16).padStart(4, '0')} A=$${regs.A.toString(16).padStart(2, '0')} X=$${regs.X.toString(16).padStart(2, '0')} Y=$${regs.Y.toString(16).padStart(2, '0')} S=$${regs.S.toString(16).padStart(2, '0')} P=$${regs.P.toString(16).padStart(2, '0')}`);
}

// Spread check: count cells matching the program
if (programBytes && !json) {
    let spread = 0;
    const L = programBytes.length;
    for (let ci = 0; ci < B; ci++) {
        for (let cj = 0; cj < B; cj++) {
            const base = (ci * B + cj) * M;
            let match = true;
            for (let k = 0; k < L; k++) {
                if (sim.storage[base + k] !== programBytes[k]) { match = false; break; }
            }
            if (match) spread++;
        }
    }
    console.log(`\nSpread: ${spread}/${B * B} cells contain the program`);
}

if (json && !census) {
    // Full JSON output
    const result = { size, seed, passes };
    if (programBytes) {
        let spread = 0;
        const L = programBytes.length;
        for (let ci = 0; ci < B; ci++) {
            for (let cj = 0; cj < B; cj++) {
                const base = (ci * B + cj) * M;
                let match = true;
                for (let k = 0; k < L; k++) {
                    if (sim.storage[base + k] !== programBytes[k]) { match = false; break; }
                }
                if (match) spread++;
            }
        }
        result.spread = spread;
        result.viable = spread > (B * B) / 2;
        result.program = [...programBytes].map(b => b.toString(16).padStart(2, '0')).join(' ');
    }
    const c = await sim.census();
    result.functional = c.functional;
    result.loopVariants = c.loopVariants;
    console.log(JSON.stringify(result, null, 2));
}
