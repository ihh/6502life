#!/usr/bin/env node

import { readFileSync } from 'fs';
import { parseArgs, getFlag, getIntFlag, getCellFlag } from '../lib/args.js';
import { createBoard, zeroAllCells, writeCellBytes } from '../../engine/board.js';
import { assemble } from '../../engine/assembler.js';
import { TuiApp } from '../lib/tui-app.js';

const { flags } = parseArgs();

const seed = getIntFlag(flags, 'seed', 42);
const size = getIntFlag(flags, 'size', 8);
const stateFile = getFlag(flags, 'state');
const asmFile = getFlag(flags, 'asm');
const loadFile = getFlag(flags, 'load');
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
    let data;
    const text = content.toString('utf-8').trim();
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

// Assemble and load source
if (asmFile) {
    const source = readFileSync(asmFile, 'utf-8');
    const bytes = await assemble(source);
    writeCellBytes(controller, cellI, cellJ, 0, bytes);
    console.error(`Assembled ${bytes.length} bytes into cell (${cellI},${cellJ})`);
}

const app = new TuiApp(controller, visualizer);
app.cursorI = cellI;
app.cursorJ = cellJ;
app.start();
