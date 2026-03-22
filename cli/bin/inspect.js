#!/usr/bin/env node

import { readFileSync } from 'fs';
import { parseArgs, getFlag, getCellFlag } from '../lib/args.js';
import { createBoard, readCellRegisters, readCellMemory, getRecentlyActiveCells } from '../../engine/board.js';
import { formatRegisters, formatHexDump, formatActivity } from '../lib/output.js';

const { flags } = parseArgs();

if ('help' in flags) {
    console.log(`inspect.js — Inspect cell state in a saved board

Usage:
  node cli/bin/inspect.js --state <file> [options]

Options:
  --state FILE       Board state file to inspect (required)
  --cell I,J         Cell to inspect (default: 0,0)
  --registers        Show CPU registers
  --memory           Show full memory hex dump
  --activity         Show recently active cells
  --all              Show registers, memory, and activity
  --json             Output as JSON
  --help             Show this help message`);
    process.exit(0);
}

const stateFile = getFlag(flags, 'state');
const [cellI, cellJ] = getCellFlag(flags, 'cell', 0, 0);
const showRegisters = 'registers' in flags;
const showMemory = 'memory' in flags;
const showActivity = 'activity' in flags;
const showAll = 'all' in flags;
const jsonOutput = 'json' in flags;

if (!stateFile) {
    console.error('Usage: inspect.js --state <file> [--cell i,j] [--registers] [--memory] [--activity] [--all] [--json]');
    process.exit(1);
}

// Load state
const state = JSON.parse(readFileSync(stateFile, 'utf-8'));

// Reconstruct board from state
const size = Math.sqrt(state.memory.storage.length / 1024) | 0;
const { controller } = createBoard(size, 1);
controller.state = state;

const regs = readCellRegisters(controller, cellI, cellJ);
const mem = readCellMemory(controller, cellI, cellJ);
const activity = getRecentlyActiveCells(controller, 20);

if (jsonOutput) {
    const result = {};
    if (showRegisters || showAll) result.registers = regs;
    if (showMemory || showAll) result.memory = Array.from(mem);
    if (showActivity || showAll) result.activity = activity;
    if (!showRegisters && !showMemory && !showActivity && !showAll) {
        result.registers = regs;
    }
    console.log(JSON.stringify(result, null, 2));
} else {
    console.log(`Cell (${cellI},${cellJ})`);
    if (showRegisters || showAll || (!showMemory && !showActivity)) {
        console.log(formatRegisters(regs));
        console.log();
    }
    if (showMemory || showAll) {
        console.log(formatHexDump(mem, 0));
        console.log();
    }
    if (showActivity || showAll) {
        console.log(formatActivity(activity, controller.totalCycles));
    }
}
