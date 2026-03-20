#!/usr/bin/env node

// inject.js — Patch cells in a saved board state
// Load state, write assembly or raw bytes into cells, save back
//
// Usage:
//   node cli/bin/inject.js --state board.json --asm copier.asm --cell 0,0 --save board.json
//   node cli/bin/inject.js --state board.json --preset spreader --cell 4,4 --save board.json
//   node cli/bin/inject.js --state board.json --cell 3,3 --poke F0=40 --save board.json
//   node cli/bin/inject.js --state board.json --cell 0,0 --zero --save board.json
//   node cli/bin/inject.js --size 16 --randomize --asm a.asm --cell 0,0 --save board.json

import { readFileSync, writeFileSync } from 'fs';
import { parseArgs, getFlag, getIntFlag, getCellFlag } from '../lib/args.js';
import { createBoard, zeroAllCells, writeCellBytes, zeroCellMemory } from '../../engine/board.js';
import { assemble, assembleMulti, applyImage } from '../../engine/assembler.js';
import { getPreset } from '../lib/terminal/presets.js';

const { flags } = parseArgs();

const stateFile = getFlag(flags, 'state');
const saveFile = getFlag(flags, 'save');
const size = getIntFlag(flags, 'size', 8);
const seed = getIntFlag(flags, 'seed', 42);
const randomize = 'randomize' in flags;
const quiet = 'quiet' in flags;

if (!saveFile) {
    console.error('Usage: inject.js [--state <file>] [--size N] [options] --save <file>');
    console.error('  --asm <file>       Assemble and load into --cell');
    console.error('  --preset <name>    Load a preset program into --cell');
    console.error('  --hex <string>     Load hex bytes into --cell');
    console.error('  --poke OFF=VAL     Write byte at offset (hex) into --cell');
    console.error('  --zero             Zero the cell before loading');
    console.error('  --cell I,J         Target cell (default 0,0)');
    console.error('  --randomize        Fill board with random data first');
    process.exit(1);
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
}

if (randomize) {
    controller.randomize();
    if (!quiet) console.error(`Board randomized`);
}

// Process injection commands from argv (supports multiple --asm/--cell pairs)
// Walk through argv to handle sequential --cell + --asm/--preset/--poke/--zero combos
const argv = process.argv.slice(2);
let currentCell = [0, 0];
let actions = 0;

for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--cell' && argv[i + 1]) {
        const parts = argv[i + 1].split(',').map(Number);
        if (parts.length === 2) currentCell = parts;
        i++;
        continue;
    }

    if (arg === '--zero') {
        const [ci, cj] = currentCell;
        zeroCellMemory(controller, ci, cj);
        if (!quiet) console.error(`Zeroed cell (${ci},${cj})`);
        actions++;
        continue;
    }

    if (arg === '--asm' && argv[i + 1]) {
        const source = readFileSync(argv[i + 1], 'utf-8');
        const hasDirectives = /^\s*\.(cell|celladdr|addr)\s/im.test(source);
        const [ci, cj] = currentCell;
        if (hasDirectives) {
            const image = await assembleMulti(source);
            applyImage(image, controller.memory, ci, cj);
            const totalBytes = image.segments.reduce((sum, s) => sum + s.bytes.length, 0);
            if (!quiet) console.error(`Assembled ${totalBytes} bytes in ${image.segments.length} segment(s) from ${argv[i + 1]} (origin cell ${ci},${cj})`);
        } else {
            const bytes = await assemble(source);
            writeCellBytes(controller, ci, cj, 0, bytes);
            writeCellBytes(controller, ci, cj, 0x200, bytes);
            if (!quiet) console.error(`Assembled ${bytes.length} bytes into cell (${ci},${cj}) from ${argv[i + 1]}`);
        }
        actions++;
        i++;
        continue;
    }

    if (arg === '--preset' && argv[i + 1]) {
        const preset = getPreset(argv[i + 1]);
        if (!preset) {
            console.error(`Unknown preset: ${argv[i + 1]}`);
            process.exit(1);
        }
        const bytes = await assemble(preset.source);
        const [ci, cj] = currentCell;
        writeCellBytes(controller, ci, cj, 0, bytes);
        writeCellBytes(controller, ci, cj, 0x200, bytes);
        if (!quiet) console.error(`Loaded preset "${preset.name}" (${bytes.length} bytes) into cell (${ci},${cj})`);
        actions++;
        i++;
        continue;
    }

    if (arg === '--hex' && argv[i + 1]) {
        const hexStr = argv[i + 1].replace(/\s+/g, '');
        const data = new Uint8Array(hexStr.length / 2);
        for (let k = 0; k < hexStr.length; k += 2) {
            data[k / 2] = parseInt(hexStr.substring(k, k + 2), 16);
        }
        const [ci, cj] = currentCell;
        writeCellBytes(controller, ci, cj, 0, data);
        if (!quiet) console.error(`Wrote ${data.length} hex bytes into cell (${ci},${cj})`);
        actions++;
        i++;
        continue;
    }

    if (arg === '--poke' && argv[i + 1]) {
        const [offStr, valStr] = argv[i + 1].split('=');
        const off = parseInt(offStr, 16);
        const val = parseInt(valStr, 16);
        const [ci, cj] = currentCell;
        writeCellBytes(controller, ci, cj, off, new Uint8Array([val]));
        if (!quiet) console.error(`Poked $${off.toString(16).toUpperCase()}=$${val.toString(16).toUpperCase()} in cell (${ci},${cj})`);
        actions++;
        i++;
        continue;
    }
}

// Save
writeFileSync(saveFile, JSON.stringify(controller.state));
if (!quiet) console.error(`State saved to ${saveFile} (${actions} action${actions !== 1 ? 's' : ''})`);
