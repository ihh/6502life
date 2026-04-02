#!/usr/bin/env node --input-type=module
/**
 * Measure per-opcode lethality by exhaustive simulation.
 *
 * For each of the 256 possible insert bytes (and for multi-byte opcodes,
 * sampled operand values), insert it into each of the 6 core variants
 * at each of the 5 insert positions, with each of the 8 branch types,
 * simulate, and check for spread.
 *
 * Output: survival probability per opcode, marginalized over
 * variant × branch × position × operand.
 */

import { BareSimCPU } from '../webgpu/bare-sim-cpu.js';
import { OPCODE_LENGTHS } from './loop-detector.js';

// ── Core variants ────────────────────────────────────────────────────

// Each variant is defined by its core bytes (without branch+offset)
// and 5 insert slots (before each core byte group + after last)
const VARIANTS = [
    { name: 'DEX', family: 'X',
      core: [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xCA] },
    { name: 'INX', family: 'X',
      core: [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8] },
    { name: 'DEY', family: 'Y',
      core: [0xB7, 0x00, 0x99, 0x00, 0x04, 0x88] },
    { name: 'INY', family: 'Y',
      core: [0xB7, 0x00, 0x99, 0x00, 0x04, 0xC8] },
    { name: 'INX3FF', family: 'X',
      core: [0xB5, 0x00, 0xE8, 0x9D, 0xFF, 0x03] },
    { name: 'INY3FF', family: 'Y',
      core: [0xB7, 0x00, 0xC8, 0x99, 0xFF, 0x03] },
];

const BRANCHES = [0x10, 0x30, 0x50, 0x70, 0x90, 0xB0, 0xD0, 0xF0];
const BRANCH_NAMES = {
    0x10: 'BPL', 0x30: 'BMI', 0x50: 'BVC', 0x70: 'BVS',
    0x90: 'BCC', 0xB0: 'BCS', 0xD0: 'BNE', 0xF0: 'BEQ',
};

// Insert positions: between which core bytes
// For core = [A, B, C, D, E, F]:
// Pos 0: before A  (prefix)
// Pos 1: after B (between LDA addr and STA)
// Pos 2: after E (between STA page and INC)
// Pos 3: after F (between INC and branch)
// Pos 4: (after branch = before A in loop, same as pos 0)
// So effectively 4 distinct positions (0-3), plus we test pos 0 as both prefix and suffix
const INSERT_POSITIONS = [0, 1, 2, 3]; // before core[0], after core[1], after core[4], after core[5]

function buildProgram(variant, branch, insertPos, insertBytes) {
    const core = [...variant.core];
    const prog = [];

    // Position 0: before core
    if (insertPos === 0) prog.push(...insertBytes);
    prog.push(core[0], core[1]); // LDA/LAX + addr

    // Position 1: between LDA addr and STA
    if (insertPos === 1) prog.push(...insertBytes);
    prog.push(core[2], core[3], core[4]); // STA + addr

    // Position 2: between STA and INC
    if (insertPos === 2) prog.push(...insertBytes);
    prog.push(core[5]); // INC/DEC

    // Position 3: between INC and branch
    if (insertPos === 3) prog.push(...insertBytes);

    // Branch + offset (offset loops back to start)
    const branchPos = prog.length;
    prog.push(branch);
    const offset = (0 - branchPos - 2 + 256) & 0xFF;
    prog.push(offset);

    return new Uint8Array(prog);
}

async function testProgram(prog) {
    const sim = await BareSimCPU.create(4, { seed: 42, hasRegisterSave: true });
    sim.storage.fill(0x02); // JAM

    // Inject program
    sim.writeCell(0, 0, 0, Array.from(prog));
    sim.writeCell(0, 0, 0xF9, [0x00, 0x00]); // PC=0
    sim.writeCell(0, 0, 0xFB, [0x30]);         // P=0x30 (C=0, V=0)
    sim.writeCell(0, 0, 0xFD, [0x00]);         // X=0
    sim.writeCell(0, 0, 0xFE, [0x00]);         // Y=0
    sim.writeCell(0, 0, 0xFF, [0xFF]);         // S=0xFF

    // Run
    for (let r = 0; r < 30; r++) {
        await sim.runPass();
        await sim.runPass();
    }

    // Check: did the program spread to non-neighbors?
    const neighbors = new Set();
    for (let di = -1; di <= 1; di++)
        for (let dj = -1; dj <= 1; dj++)
            neighbors.add(((0 + di + 4) % 4) * 4 + ((0 + dj + 4) % 4));

    let spread = 0;
    for (let ci = 0; ci < 16; ci++) {
        if (neighbors.has(ci)) continue;
        const base = ci * 1024;
        let nonJam = 0;
        for (let j = 0; j < 256; j++)
            if (sim.storage[base + j] !== 0x02) nonJam++;
        if (nonJam > 5) spread++;
    }

    return spread > 0;
}

// ── First: verify bare cores work ────────────────────────────────────

console.error('Verifying bare cores...');
let coresOk = 0;
for (const variant of VARIANTS) {
    for (const branch of BRANCHES) {
        const prog = buildProgram(variant, branch, 0, []);
        const viable = await testProgram(prog);
        if (viable) coresOk++;
    }
}
console.error(`  ${coresOk}/${VARIANTS.length * BRANCHES.length} bare cores viable`);

// ── Main: test each opcode as insert ─────────────────────────────────

// For speed: sample operands rather than testing all 256
const OPERAND_SAMPLES = [0x00, 0x03, 0x10, 0x40, 0x7F, 0x80, 0xC0, 0xFF];

const results = new Array(256);
let totalTests = 0;

console.error('Testing insert opcodes...');

for (let op = 0; op < 256; op++) {
    const instrLen = OPCODE_LENGTHS[op];
    if (instrLen === 0) {
        // JAM - instant death
        results[op] = { op, survival: 0, total: 0, survived: 0, name: 'JAM' };
        continue;
    }

    let survived = 0;
    let total = 0;

    // Build insert byte sequences for this opcode
    const insertSequences = [];
    if (instrLen === 1) {
        insertSequences.push([op]);
    } else if (instrLen === 2) {
        for (const operand of OPERAND_SAMPLES) {
            insertSequences.push([op, operand]);
        }
    } else if (instrLen === 3) {
        // Sample a few operand pairs
        for (const op1 of [0x00, 0x40, 0x80, 0xFF]) {
            for (const op2 of [0x00, 0x04, 0x80, 0xFF]) {
                insertSequences.push([op, op1, op2]);
            }
        }
    }

    for (const insertBytes of insertSequences) {
        for (const variant of VARIANTS) {
            for (const branch of BRANCHES) {
                for (const pos of INSERT_POSITIONS) {
                    const prog = buildProgram(variant, branch, pos, insertBytes);
                    const viable = await testProgram(prog);
                    if (viable) survived++;
                    total++;
                }
            }
        }
    }

    const survival = total > 0 ? survived / total : 0;
    results[op] = { op, survival, total, survived };
    totalTests += total;

    if (op % 16 === 15) {
        console.error(`  Tested 0x00-0x${op.toString(16).padStart(2, '0')} (${totalTests} tests so far)`);
    }
}

// ── Output results ───────────────────────────────────────────────────

console.log('op,hex,survival,survived,total');
for (let op = 0; op < 256; op++) {
    const r = results[op];
    console.log(`${op},${op.toString(16).padStart(2, '0')},${r.survival.toFixed(4)},${r.survived},${r.total}`);
}

// Summary
console.error('\n=== SUMMARY ===');
console.error(`Total tests: ${totalTests}`);

// Group by survival ranges
const ranges = [
    [1.0, 1.0, 'Safe (100%)'],
    [0.75, 0.99, 'Mostly safe (75-99%)'],
    [0.5, 0.74, 'Risky (50-74%)'],
    [0.25, 0.49, 'Dangerous (25-49%)'],
    [0.01, 0.24, 'Very dangerous (1-24%)'],
    [0.0, 0.0, 'Fatal (0%)'],
];

for (const [lo, hi, label] of ranges) {
    const ops = results.filter(r => r && r.survival >= lo && r.survival <= hi);
    if (ops.length > 0) {
        const hexList = ops.map(r => r.op.toString(16).padStart(2, '0')).join(' ');
        console.error(`${label}: ${ops.length} opcodes`);
        console.error(`  ${hexList}`);
    }
}

// Print E0-F8 range specifically
console.error('\n=== OFFSET RANGE E0-F8 ===');
for (let op = 0xE0; op <= 0xF8; op++) {
    const r = results[op];
    const loopLen = 256 - op;
    const bar = '█'.repeat(Math.round(r.survival * 20));
    const space = '░'.repeat(20 - Math.round(r.survival * 20));
    console.error(`  ${op.toString(16).toUpperCase()} L=${loopLen.toString().padStart(2)}: ${bar}${space} ${(r.survival * 100).toFixed(1)}% (${r.survived}/${r.total})`);
}
