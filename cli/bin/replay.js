#!/usr/bin/env node

// replay.js — Deterministic replay with structured event logging
// Runs simulation from a saved state (or fresh board) and emits JSONL events
//
// Usage:
//   node cli/bin/replay.js --state snap.json --interrupts 5000 --log events.jsonl --save snap2.json
//   node cli/bin/replay.js --size 16 --asm copier.asm --cell 0,0 --interrupts 1000 --log events.jsonl
//   node cli/bin/replay.js --state snap.json --interrupts 100 --track 0,0 --log lineage.jsonl
//   node cli/bin/replay.js --state snap.json --interrupts 500 --census 100 --log census.jsonl

import { readFileSync, writeFileSync, createWriteStream } from 'fs';
import { parseArgs, getFlag, getIntFlag, getCellFlag } from '../lib/args.js';
import { createBoard, zeroAllCells, writeCellBytes, readCellMemory } from '../../engine/board.js';
import { assemble } from '../../engine/assembler.js';
import { Tracker } from '../lib/probe/tracker.js';

const { flags } = parseArgs();

const stateFile = getFlag(flags, 'state');
const saveFile = getFlag(flags, 'save');
const logFile = getFlag(flags, 'log');
const asmFile = getFlag(flags, 'asm');
const [cellI, cellJ] = getCellFlag(flags, 'cell', 0, 0);
const size = getIntFlag(flags, 'size', 8);
const seed = getIntFlag(flags, 'seed', 42);
const targetInterrupts = getIntFlag(flags, 'interrupts', 1000);
const censusInterval = getIntFlag(flags, 'census', 0);
const randomize = 'randomize' in flags;
const quiet = 'quiet' in flags;

// Collect --track flags
const trackCells = [];
for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--track') {
        const val = process.argv[i + 1];
        if (val) {
            const parts = val.split(',').map(Number);
            if (parts.length === 2) trackCells.push(parts);
        }
    }
}

// Create or load board
let controller;
if (stateFile) {
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    const bSize = Math.sqrt(state.memory.storage.length / 1024) | 0;
    ({ controller } = createBoard(bSize, 1));
    controller.state = state;
} else {
    ({ controller } = createBoard(size, seed));
    if (randomize) controller.randomize();
}

// Load assembly if provided
if (asmFile) {
    const source = readFileSync(asmFile, 'utf-8');
    const bytes = await assemble(source);
    writeCellBytes(controller, cellI, cellJ, 0, bytes);
    writeCellBytes(controller, cellI, cellJ, 0x200, bytes);
    if (!quiet) console.error(`Assembled ${bytes.length} bytes into cell (${cellI},${cellJ})`);
}

// Set up tracker
const tracker = new Tracker(controller);
if (censusInterval > 0) {
    tracker.censusInterval = censusInterval;
}
for (const [ti, tj] of trackCells) {
    tracker.trackCell(ti, tj);
}

// Set up log output
const logStream = logFile ? createWriteStream(logFile) : null;
const logStdout = !logFile; // if no --log, write events to stdout

function logEvent(event) {
    const line = JSON.stringify(event) + '\n';
    if (logStream) logStream.write(line);
    if (logStdout && !quiet) process.stdout.write(line);
}

// Subscribe to all channels
for (const channel of ['writes', 'moves', 'lineage', 'census', 'watch']) {
    tracker.subscribe(channel, logEvent);
}

// Run simulation with tracking
const origCommitWrites = controller.commitWrites.bind(controller);
const mem = controller.memory;
const origUndoWrites = mem.undoWrites.bind(mem);

for (let interrupt = 0; interrupt < targetInterrupts; interrupt++) {
    let capturedHistory = null;
    let wasAtomic = false;

    // Patch to capture write history
    controller.commitWrites = () => {
        capturedHistory = mem.undoHistory ? { ...mem.undoHistory } : null;
        origCommitWrites();
    };
    mem.undoWrites = () => {
        wasAtomic = true;
        origUndoWrites();
    };

    controller.runToNextInterrupt();

    // Restore
    controller.commitWrites = origCommitWrites;
    mem.undoWrites = origUndoWrites;

    // Notify tracker
    tracker.onInterrupt(capturedHistory, wasAtomic);

    // Progress
    if (!quiet && !logStdout && interrupt > 0 && interrupt % 1000 === 0) {
        console.error(`  ${interrupt}/${targetInterrupts} interrupts...`);
    }
}

// Save state
if (saveFile) {
    writeFileSync(saveFile, JSON.stringify(controller.state));
    if (!quiet) console.error(`State saved to ${saveFile}`);
}

if (logStream) {
    logStream.end();
    if (!quiet) console.error(`Events written to ${logFile}`);
}

if (!quiet && !logStdout) {
    console.error(`Replay complete: ${targetInterrupts} interrupts, ${controller.totalCycles} cycles`);
}
