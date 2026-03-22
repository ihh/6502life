#!/usr/bin/env node

// disasm.js — Standalone 6502 disassembler
// Disassembles from saved state files, hex strings, or diffs two cells
//
// Usage:
//   node cli/bin/disasm.js --state state.json --cell 0,0 [--lines N] [--offset ADDR]
//   node cli/bin/disasm.js --hex "A9 01 8D 10 00"
//   node cli/bin/disasm.js --state state.json --cell 0,0 --cell 1,0 --diff
//   node cli/bin/disasm.js --state state.json --cell 0,0 --json

import { readFileSync } from 'fs';
import { parseArgs, getFlag, getIntFlag } from '../lib/args.js';
import { createBoard, readCellMemory, readCellRegisters } from '../../engine/board.js';
import { initDisassembler, disassembleRangeSync, formatInstruction } from '../lib/terminal/disassembler.js';
import { hexByte, hexWord } from '../../engine/format.js';

const { flags, positional } = parseArgs();

if ('help' in flags) {
    console.log(`disasm.js — 6502 disassembler

Usage:
  node cli/bin/disasm.js --state <file> --cell I,J [options]
  node cli/bin/disasm.js --hex "A9 01 8D 10 00"
  echo "A9 01" | node cli/bin/disasm.js

Options:
  --state FILE       Board state file
  --cell I,J         Cell to disassemble (repeatable for --diff)
  --hex STRING       Disassemble hex byte string
  --lines N          Number of instructions to show (default: 32)
  --offset ADDR      Start address in hex (default: PC for state, 0 for hex)
  --diff             Diff disassembly of two cells
  --json             Output as JSON
  --help             Show this help message`);
    process.exit(0);
}

const stateFile = getFlag(flags, 'state');
const hexInput = getFlag(flags, 'hex');
const lines = getIntFlag(flags, 'lines', 32);
const offset = flags.offset !== undefined ? parseInt(flags.offset, 16) || 0 : undefined;
const jsonOutput = 'json' in flags;
const diffMode = 'diff' in flags;

// Collect all --cell flags (may appear multiple times)
const cells = [];
for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--cell') {
        const val = process.argv[i + 1];
        if (val) {
            const parts = val.split(',').map(Number);
            if (parts.length === 2) cells.push(parts);
        }
    }
}
if (cells.length === 0) cells.push([0, 0]);

await initDisassembler();

if (hexInput) {
    // Disassemble from hex string
    const bytes = hexInput.trim().split(/\s+/).map(s => parseInt(s, 16));
    const data = new Uint8Array(bytes);
    const readFn = (addr) => addr < data.length ? data[addr] : 0;
    const instrs = disassembleRangeSync(readFn, offset || 0, lines);
    output(instrs);
} else if (stateFile) {
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    const size = Math.sqrt(state.memory.storage.length / 1024) | 0;
    const { controller } = createBoard(size, 1);
    controller.state = state;

    if (diffMode && cells.length >= 2) {
        // Diff disassembly of two cells
        const [i1, j1] = cells[0];
        const [i2, j2] = cells[1];
        const mem1 = readCellMemory(controller, i1, j1);
        const mem2 = readCellMemory(controller, i2, j2);
        const startAddr = offset !== undefined ? offset : 0;

        const instrs1 = disassembleRangeSync((a) => a < mem1.length ? mem1[a] : 0, startAddr, lines);
        const instrs2 = disassembleRangeSync((a) => a < mem2.length ? mem2[a] : 0, startAddr, lines);

        if (jsonOutput) {
            console.log(JSON.stringify({ cell1: [i1, j1], cell2: [i2, j2], disasm1: instrs1, disasm2: instrs2 }, null, 2));
        } else {
            console.log(`Diff: cell (${i1},${j1}) vs (${i2},${j2})\n`);
            const maxLines = Math.max(instrs1.length, instrs2.length);
            for (let n = 0; n < maxLines; n++) {
                const line1 = n < instrs1.length ? formatInstruction(instrs1[n]) : '';
                const line2 = n < instrs2.length ? formatInstruction(instrs2[n]) : '';
                const match = line1 === line2;
                const marker = match ? '  ' : '!=';
                console.log(`${marker} ${line1.padEnd(30)} | ${line2}`);
            }
        }
    } else {
        // Disassemble a single cell
        const [ci, cj] = cells[0];
        const mem = readCellMemory(controller, ci, cj);
        const regs = readCellRegisters(controller, ci, cj);
        const startAddr = offset !== undefined ? offset : regs.PC;

        const readFn = (addr) => addr < mem.length ? mem[addr] : 0;
        const instrs = disassembleRangeSync(readFn, startAddr, lines);

        if (jsonOutput) {
            console.log(JSON.stringify({
                cell: [ci, cj],
                pc: regs.PC,
                registers: regs,
                disassembly: instrs,
            }, null, 2));
        } else {
            console.log(`Cell (${ci},${cj})  PC=$${hexWord(regs.PC)}  A=$${hexByte(regs.A)} X=$${hexByte(regs.X)} Y=$${hexByte(regs.Y)}\n`);
            output(instrs, regs.PC);
        }
    }
} else {
    // Read from stdin
    const input = readFileSync('/dev/stdin', 'utf-8').trim();
    const bytes = input.split(/\s+/).map(s => parseInt(s, 16));
    const data = new Uint8Array(bytes);
    const readFn = (addr) => addr < data.length ? data[addr] : 0;
    const instrs = disassembleRangeSync(readFn, offset || 0, Math.min(lines, data.length));
    output(instrs);
}

function output(instrs, pc) {
    if (jsonOutput) {
        console.log(JSON.stringify(instrs, null, 2));
    } else {
        for (const instr of instrs) {
            const marker = (pc !== undefined && instr.addr === pc) ? '>' : ' ';
            console.log(`${marker} ${formatInstruction(instr)}`);
        }
    }
}
