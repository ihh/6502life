#!/usr/bin/env node
/**
 * bare-tui: Interactive TUI for the bare-sim (pair-based, no noise).
 *
 * Same grid view as tui.js but uses BareSimCPU. Supports the bare-rep
 * family of replicators and --hex for arbitrary byte sequences.
 *
 * Usage:
 *   node cli/bin/bare-tui.js --preset bare-rep --cell 0,0
 *   node cli/bin/bare-tui.js --hex "B5 00 9D 00 04 E8 50 F8" --cell 0,0
 *   node cli/bin/bare-tui.js --size 16 --randomize
 *   node cli/bin/bare-tui.js --preset bare-rep --cell 0,0 --soup
 *
 * Controls: arrows=move, space=step, r=run, p=pause, 1-9=speed, q=quit
 */

import { readFileSync } from 'fs';
import { BareSimCPU } from '../../webgpu/bare-sim-cpu.js';
import { getPreset } from '../lib/terminal/presets.js';
import { assemble } from '../../engine/assembler.js';
import { hexByte, hexWord } from '../../engine/format.js';
import {
    fgRGB, bgRGB, reset, bold, dim,
    moveTo, clear, hideCursor, showCursor,
    altScreen, mainScreen, clearLine,
} from '../lib/ansi.js';

const HALF_BLOCK = '\u2580';

// --- Parse args ---
const args = process.argv.slice(2);
function flag(name) { return args.includes('--' + name); }
function opt(name, def) {
    const i = args.indexOf('--' + name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const size = Number(opt('size', 8));
const seed = Number(opt('seed', 42));
const cellArg = opt('cell', null);
const presetName = opt('preset', null);
const asmFile = opt('asm', null);
const hexStr = opt('hex', null);
const randomize = flag('randomize');
const soup = flag('soup');

// --- Init sim ---
const sim = new BareSimCPU(size, 1024, { seed });

if (randomize || soup) {
    // Fill with random bytes
    const crypto = await import('node:crypto');
    const rng = crypto.createHash ? null : null; // use Math.random for simplicity
    for (let i = 0; i < sim.storage.length; i++) {
        sim.storage[i] = (Math.random() * 256) | 0;
    }
}

// --- Load program ---
let programBytes = null;

if (hexStr) {
    programBytes = new Uint8Array(hexStr.trim().split(/\s+/).map(h => parseInt(h, 16)));
} else if (presetName) {
    const preset = getPreset(presetName);
    if (!preset) { console.error(`Unknown preset: ${presetName}`); process.exit(1); }
    programBytes = await assemble(preset.source);
} else if (asmFile) {
    const source = readFileSync(asmFile, 'utf-8');
    programBytes = await assemble(source);
}

if (programBytes && cellArg) {
    const [ci, cj] = cellArg.split(',').map(Number);
    sim.writeCell(ci, cj, 0, programBytes);
    sim.writeCell(ci, cj, 0xF9, [0x00, 0x00]);
    sim.writeCell(ci, cj, 0xFB, [0x30]);
    sim.writeCell(ci, cj, 0xFF, [0xFF]);
}

// --- TUI state ---
const B = size;
const M = 1024;
let cursorI = cellArg ? Number(cellArg.split(',')[0]) : 0;
let cursorJ = cellArg ? Number(cellArg.split(',')[1]) : 0;
let running = false;
let speed = 1;
let totalPasses = 0;
let quit = false;
let lastRender = 0;

// --- Color: activity-based HSV ---
function cellColor(ci, cj) {
    const base = (ci * B + cj) * M;
    const writeAct = sim.lastWrite[base]; // just check byte 0
    const fetchAct = sim.lastFetch[base];
    const act = Math.min(1, (writeAct + fetchAct) / 50);

    // Check if it looks like a replicator (B5 xx 9D)
    const b0 = sim.storage[base];
    const b2 = sim.storage[base + 2];

    if (b0 === 0xB5 && b2 === 0x9D) {
        // Replicator: green, brightness from activity
        const v = 40 + Math.floor(act * 215);
        return [0, v, 0];
    }

    if (act > 0.01) {
        // Active: yellow-orange
        const v = Math.floor(act * 255);
        return [v, Math.floor(v * 0.6), 0];
    }

    // Inactive: dark based on content
    const h = sim.storage[base] * 137 & 0xFF;
    return [Math.floor(h * 0.1), Math.floor(h * 0.05), Math.floor(h * 0.15)];
}

function render() {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    const inspectorWidth = 34;
    const boardWidth = Math.min(cols - inspectorWidth - 3, B);
    const boardHeight = Math.min((rows - 3) * 2, B);
    const boardTermRows = Math.ceil(boardHeight / 2);

    let out = moveTo(1, 1);

    // Board
    for (let tr = 0; tr < boardTermRows; tr++) {
        out += moveTo(1 + tr, 1);
        for (let x = 0; x < boardWidth; x++) {
            const topI = tr * 2;
            const botI = tr * 2 + 1;
            const j = x;

            const [tr1, tg1, tb1] = topI < B ? cellColor(topI, j) : [0, 0, 0];
            const [br1, bg1, bb1] = botI < B ? cellColor(botI, j) : [0, 0, 0];

            // Cursor highlight
            const isTop = topI === cursorI && j === cursorJ;
            const isBot = botI === cursorI && j === cursorJ;

            if (isTop || isBot) {
                out += fgRGB(255, 255, 255) + bgRGB(80, 80, 80) + (isTop ? HALF_BLOCK : '\u2584') + reset;
            } else {
                out += fgRGB(tr1, tg1, tb1) + bgRGB(br1, bg1, bb1) + HALF_BLOCK + reset;
            }
        }
    }

    // Inspector
    const panelCol = boardWidth + 3;
    const base = (cursorI * B + cursorJ) * M;
    const pc = (sim.storage[base + 0xF9] << 8) | sim.storage[base + 0xFA];
    const a = sim.storage[base + 0xFC];
    const x = sim.storage[base + 0xFD];
    const y = sim.storage[base + 0xFE];
    const s = sim.storage[base + 0xFF];
    const p = sim.storage[base + 0xFB];

    out += moveTo(1, panelCol) + bold + `Cell (${cursorI},${cursorJ})` + reset;
    out += moveTo(2, panelCol) + `A=${hexByte(a)} X=${hexByte(x)} Y=${hexByte(y)} S=${hexByte(s)}`;
    out += moveTo(3, panelCol) + `PC=${hexWord(pc)} P=${hexByte(p)}`;

    // Hex dump
    const hexRows = Math.min(8, rows - 6);
    for (let r = 0; r < hexRows; r++) {
        const offset = r * 8;
        const hex = [];
        for (let k = 0; k < 8; k++) {
            hex.push(hexByte(sim.storage[base + offset + k]));
        }
        out += moveTo(5 + r, panelCol) + dim + hexWord(offset) + reset + ' ' + hex.join(' ');
    }

    // Census
    let functional = 0;
    if (programBytes) {
        const L = programBytes.length;
        for (let ci = 0; ci < B; ci++) {
            for (let cj = 0; cj < B; cj++) {
                const cb = (ci * B + cj) * M;
                let match = true;
                for (let k = 0; k < L; k++) {
                    if (sim.storage[cb + k] !== programBytes[k]) { match = false; break; }
                }
                if (match) functional++;
            }
        }
    }

    // Status bar
    const statusRow = rows;
    const status = running ? fgRGB(0, 255, 0) + 'RUNNING' + reset : dim + 'PAUSED' + reset;
    out += moveTo(statusRow, 1) + clearLine;
    out += `[spc]step [r]un [p]ause [q]uit  ${status}  Spd:${speed}  Pass:${totalPasses}`;
    if (programBytes) out += `  Spread:${functional}/${B * B}`;

    process.stdout.write(out);
}

function step() {
    sim.runPass();
    totalPasses++;
}

function tick() {
    if (quit) return;
    if (running) {
        for (let i = 0; i < speed; i++) {
            step();
        }
        const now = Date.now();
        if (now - lastRender >= 100) {
            render();
            lastRender = now;
        }
    }
    setImmediate(tick);
}

// --- Input ---
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf-8');
process.stdout.write(altScreen + hideCursor + clear());

process.stdin.on('data', (key) => {
    switch (key) {
        case 'q': case '\x03':
            quit = true;
            process.stdout.write(showCursor + mainScreen);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.exit(0);
            break;
        case ' ':
            step();
            render();
            break;
        case 'r': running = true; break;
        case 'p': running = false; render(); break;
        case '\x1b[A': cursorI = (cursorI - 1 + B) % B; if (!running) render(); break;
        case '\x1b[B': cursorI = (cursorI + 1) % B; if (!running) render(); break;
        case '\x1b[C': cursorJ = (cursorJ + 1) % B; if (!running) render(); break;
        case '\x1b[D': cursorJ = (cursorJ - 1 + B) % B; if (!running) render(); break;
        default:
            if (key >= '1' && key <= '9') {
                speed = Math.pow(2, parseInt(key) - 1);
                if (!running) render();
            }
            break;
    }
});

render();
tick();
