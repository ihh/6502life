#!/usr/bin/env node

import { readFileSync } from 'fs';
import { writeFileSync } from 'fs';
import { parseArgs, getFlag, getIntFlag, getCellFlag } from '../lib/args.js';
import { createBoard, zeroAllCells, readCellRegisters, readCellMemory, writeCellBytes, getRecentlyActiveCells } from '../../engine/board.js';
import { assemble } from '../../engine/assembler.js';
import { formatRegisters, formatHexDump, formatActivity, hexByte } from '../lib/output.js';

const { flags } = parseArgs();

const seed = getIntFlag(flags, 'seed', 42);
const size = getIntFlag(flags, 'size', 8);
const targetCycles = getIntFlag(flags, 'cycles', 1000);
const targetInterrupts = getIntFlag(flags, 'interrupts', undefined);
const loadFile = getFlag(flags, 'load');
const asmFile = getFlag(flags, 'asm');
const [cellI, cellJ] = getCellFlag(flags, 'cell', 0, 0);
const randomize = 'randomize' in flags;
const saveFile = getFlag(flags, 'save');
const stateFile = getFlag(flags, 'state');
const jsonOutput = 'json' in flags;
const quiet = 'quiet' in flags;

// Create board
const { controller, visualizer } = createBoard(size, seed);

// Load state if provided
if (stateFile) {
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    controller.state = state;
}

// Randomize if requested
if (randomize) {
    controller.randomize();
}

// Load binary/hex file
if (loadFile) {
    const content = readFileSync(loadFile);
    let data;
    const text = content.toString('utf-8').trim();
    if (/^[0-9a-fA-F]+$/.test(text)) {
        // Hex string
        data = new Uint8Array(text.length / 2);
        for (let i = 0; i < text.length; i += 2) {
            data[i / 2] = parseInt(text.substring(i, i + 2), 16);
        }
    } else {
        // Raw binary
        data = new Uint8Array(content);
    }
    writeCellBytes(controller, cellI, cellJ, 0, data);
}

// Assemble and load source
if (asmFile) {
    const source = readFileSync(asmFile, 'utf-8');
    const bytes = await assemble(source);
    writeCellBytes(controller, cellI, cellJ, 0, bytes);
    if (!quiet) {
        console.error(`Assembled ${bytes.length} bytes into cell (${cellI},${cellJ})`);
    }
}

// Run simulation
let totalSchedulerCycles = 0;
let totalInterrupts = 0;

const shouldStop = () => {
    if (targetInterrupts !== undefined) {
        return totalInterrupts >= targetInterrupts;
    }
    return totalSchedulerCycles >= targetCycles;
};

while (!shouldStop()) {
    const { cpuCycles, schedulerCycles } = controller.runToNextInterrupt();
    totalSchedulerCycles += schedulerCycles;
    totalInterrupts++;
}

// Output results
if (jsonOutput) {
    const regs = readCellRegisters(controller, cellI, cellJ);
    const mem = readCellMemory(controller, cellI, cellJ);
    const activity = getRecentlyActiveCells(controller, 10);
    console.log(JSON.stringify({
        cell: { i: cellI, j: cellJ },
        registers: regs,
        memory: Array.from(mem),
        totalSchedulerCycles,
        totalInterrupts,
        activity,
    }, null, 2));
} else if (!quiet) {
    const regs = readCellRegisters(controller, cellI, cellJ);
    const mem = readCellMemory(controller, cellI, cellJ);
    console.log(`\nBoard: ${size}x${size}, seed=${seed}`);
    console.log(`Ran ${totalInterrupts} interrupts, ${totalSchedulerCycles} scheduler cycles\n`);
    console.log(`Cell (${cellI},${cellJ}):`);
    console.log(formatRegisters(regs));
    console.log();
    console.log(formatHexDump(mem.slice(0, 64), 0));
    console.log();
    console.log(formatActivity(getRecentlyActiveCells(controller, 10), controller.totalCycles));
}

// Save state
if (saveFile) {
    writeFileSync(saveFile, JSON.stringify(controller.state));
    if (!quiet) {
        console.error(`State saved to ${saveFile}`);
    }
}
