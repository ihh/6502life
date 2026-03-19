#!/usr/bin/env node

import { readFileSync } from 'fs';
import { parseArgs, getFlag, getIntFlag, getCellFlag } from '../lib/args.js';
import { createBoard, writeCellBytes } from '../../engine/board.js';
import { assemble } from '../../engine/assembler.js';
import { TerminalApp } from '../lib/terminal/app.js';
import { getPreset } from '../lib/terminal/presets.js';

const { flags } = parseArgs();

const seed = getIntFlag(flags, 'seed', 42);
const size = getIntFlag(flags, 'size', 8);
const stateFile = getFlag(flags, 'state');
const asmFile = getFlag(flags, 'asm');
const loadFile = getFlag(flags, 'load');
const presetName = getFlag(flags, 'preset');
const [cellI, cellJ] = getCellFlag(flags, 'cell', 0, 0);
const randomize = 'randomize' in flags;

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
    const text = content.toString('utf-8').trim();
    let data;
    if (/^[0-9a-fA-F]+$/.test(text)) {
        data = new Uint8Array(text.length / 2);
        for (let i = 0; i < text.length; i += 2) {
            data[i / 2] = parseInt(text.substring(i, i + 2), 16);
        }
    } else {
        data = new Uint8Array(content);
    }
    writeCellBytes(controller, cellI, cellJ, 0, data);
}

// Assemble and load source file
if (asmFile) {
    const source = readFileSync(asmFile, 'utf-8');
    const bytes = await assemble(source);
    writeCellBytes(controller, cellI, cellJ, 0, bytes);
}

// Load preset
if (presetName) {
    const p = getPreset(presetName);
    if (!p) {
        console.error(`Unknown preset: ${presetName}`);
        process.exit(1);
    }
    const bytes = await assemble(p.source);
    writeCellBytes(controller, cellI, cellJ, 0, bytes);
}

const app = new TerminalApp(controller, visualizer);
app.disasmPane.setCell(cellI, cellJ);
app.minimapPane.setHighlight(cellI, cellJ);
await app.start();
