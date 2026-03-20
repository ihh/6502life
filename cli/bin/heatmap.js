#!/usr/bin/env node

// heatmap.js — Terminal-rendered activity heatmap using Unicode block characters
// Shows write/move activity or byte entropy as a colored grid in the terminal
//
// Usage:
//   node cli/bin/heatmap.js --state state.json [--metric writes|moves|entropy]
//   node cli/bin/heatmap.js --state state.json --metric entropy
//   node cli/bin/heatmap.js --state state.json --metric writes --width 80

import { readFileSync } from 'fs';
import { parseArgs, getFlag, getIntFlag } from '../lib/args.js';
import { createBoard, readCellMemory, getActivityStats } from '../../engine/board.js';
import { fgRGB, bgRGB, reset, bold, dim } from '../lib/ansi.js';

const { flags } = parseArgs();

const stateFile = getFlag(flags, 'state');
const metric = getFlag(flags, 'metric') || 'writes';
const maxWidth = getIntFlag(flags, 'width', process.stdout.columns || 80);
const jsonOutput = 'json' in flags;

if (!stateFile) {
    console.error('Usage: heatmap.js --state <file> [--metric writes|moves|entropy] [--width N] [--json]');
    process.exit(1);
}

// Load state
const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
const boardSize = Math.sqrt(state.memory.storage.length / 1024) | 0;
const { controller } = createBoard(boardSize, 1);
controller.state = state;

// Compute metric values for each cell
const B = boardSize;
const values = new Float64Array(B * B);

if (metric === 'writes' || metric === 'moves') {
    const now = controller.totalCycles || 1;
    for (let idx = 0; idx < B * B; idx++) {
        const t = metric === 'writes'
            ? controller.lastWriteTime[idx]
            : controller.lastMoveTime[idx];
        values[idx] = t > 0 ? t / now : 0;
    }
} else if (metric === 'entropy') {
    // Shannon entropy of each cell's code region (bytes 0-255)
    for (let i = 0; i < B; i++) {
        for (let j = 0; j < B; j++) {
            const mem = readCellMemory(controller, i, j);
            values[i * B + j] = shannonEntropy(mem, 0, 256);
        }
    }
} else {
    console.error(`Unknown metric: ${metric}. Use writes, moves, or entropy.`);
    process.exit(1);
}

if (jsonOutput) {
    const grid = [];
    for (let i = 0; i < B; i++) {
        const row = [];
        for (let j = 0; j < B; j++) {
            row.push(Math.round(values[i * B + j] * 10000) / 10000);
        }
        grid.push(row);
    }
    console.log(JSON.stringify({ metric, boardSize: B, grid }, null, 2));
    process.exit(0);
}

// Render heatmap
// Use half-block characters: upper half = row N, lower half = row N+1
// Each character represents 2 rows × 1 column
const cellsPerChar = Math.max(1, Math.ceil(B / (maxWidth - 4)));
const gridW = Math.ceil(B / cellsPerChar);
const gridH = Math.ceil(B / (cellsPerChar * 2)); // half-blocks = 2 rows per char

// Find value range for normalization
let vmin = Infinity, vmax = -Infinity;
for (let k = 0; k < values.length; k++) {
    if (values[k] < vmin) vmin = values[k];
    if (values[k] > vmax) vmax = values[k];
}
const vrange = vmax - vmin || 1;

console.log(`${bold}Heatmap${reset}: ${metric}, ${B}×${B} board, ${controller.totalCycles} total cycles\n`);

for (let gr = 0; gr < gridH; gr++) {
    let line = '';
    for (let gc = 0; gc < gridW; gc++) {
        // Average values in this block
        const topVal = blockAvg(gr * 2, gc, cellsPerChar);
        const botVal = blockAvg(gr * 2 + 1, gc, cellsPerChar);

        const [tr, tg, tb] = heatColor(topVal);
        const [br, bg, bb] = heatColor(botVal);

        // Upper half block: ▀ (U+2580) — fg = top color, bg = bottom color
        line += fgRGB(tr, tg, tb) + bgRGB(br, bg, bb) + '▀';
    }
    line += reset;
    console.log(line);
}

// Legend
console.log();
let legend = '  ';
const legendW = Math.min(40, gridW);
for (let k = 0; k < legendW; k++) {
    const t = k / (legendW - 1);
    const [r, g, b] = heatColor(t);
    legend += fgRGB(r, g, b) + '█';
}
legend += reset;
console.log(`${legend}  ${dim}${vmin.toFixed(3)}${reset} → ${dim}${vmax.toFixed(3)}${reset}`);

// --- Helpers ---

function blockAvg(blockRow, blockCol, cpc) {
    let sum = 0, count = 0;
    for (let di = 0; di < cpc; di++) {
        for (let dj = 0; dj < cpc; dj++) {
            const i = blockRow * cpc + di;
            const j = blockCol * cpc + dj;
            if (i < B && j < B) {
                sum += (values[i * B + j] - vmin) / vrange;
                count++;
            }
        }
    }
    return count > 0 ? sum / count : 0;
}

function heatColor(t) {
    // Black → Blue → Cyan → Green → Yellow → Red → White
    t = Math.max(0, Math.min(1, t));
    if (t < 0.2) return lerp3([0,0,0], [0,0,200], t / 0.2);
    if (t < 0.4) return lerp3([0,0,200], [0,200,200], (t - 0.2) / 0.2);
    if (t < 0.6) return lerp3([0,200,200], [0,200,0], (t - 0.4) / 0.2);
    if (t < 0.8) return lerp3([0,200,0], [255,200,0], (t - 0.6) / 0.2);
    return lerp3([255,200,0], [255,60,60], (t - 0.8) / 0.2);
}

function lerp3(a, b, t) {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
    ];
}

function shannonEntropy(data, offset, length) {
    const counts = new Uint32Array(256);
    for (let i = 0; i < length; i++) {
        counts[data[offset + i]]++;
    }
    let entropy = 0;
    for (let i = 0; i < 256; i++) {
        if (counts[i] === 0) continue;
        const p = counts[i] / length;
        entropy -= p * Math.log2(p);
    }
    return entropy / 8; // normalize to 0..1
}
