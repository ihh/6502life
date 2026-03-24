#!/usr/bin/env node

import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { parseArgs, getFlag, getIntFlag, getCellFlag } from '../lib/args.js';
import { createBoard, writeCellBytes } from '../../engine/board.js';
import { assemble } from '../../engine/assembler.js';
import { TerminalApp } from '../lib/terminal/app.js';
import { getPreset } from '../lib/terminal/presets.js';
import { ProbeServer } from '../lib/probe/server.js';

const { flags } = parseArgs();

if ('help' in flags) {
    console.log(`terminal.js — Interactive four-pane terminal debugger

Usage:
  node cli/bin/terminal.js [options]

Options:
  --seed N           PRNG seed (default: 42)
  --size N           Board size NxN (default: 8)
  --state FILE       Load board state from file
  --asm FILE         Assemble source file and load into cell
  --load FILE        Load binary/hex file into cell
  --preset NAME      Load a preset program into cell
  --cell I,J         Target cell for --asm/--load/--preset (default: 0,0)
  --randomize        Fill board with random data
  --listen [PATH]    Start probe socket for external CLI tools
  --script FILE      Run debugger commands from file and exit
  --dump FILE        Write dump output to file (with --script)
  --epsilon N        Bit-noise probability
  --brk-failure N    BRK failure probability
  --help             Show this help message

Pane layout: memory map | disassembler | command prompt | board minimap
Controls: Tab=switch pane, type "help" in command pane for debugger commands
Presets: counter, nop, copier, overwriter, tumbler, spreader, painter, knight, crawler`);
    process.exit(0);
}

const seed = getIntFlag(flags, 'seed', 42);
const size = getIntFlag(flags, 'size', 8);
const stateFile = getFlag(flags, 'state');
const asmFile = getFlag(flags, 'asm');
const loadFile = getFlag(flags, 'load');
const presetName = getFlag(flags, 'preset');
const [cellI, cellJ] = getCellFlag(flags, 'cell', 0, 0);
const randomize = 'randomize' in flags;
const listenFlag = getFlag(flags, 'listen');
const scriptFile = getFlag(flags, 'script');
const dumpFile = getFlag(flags, 'dump');
const epsilon = getFlag(flags, 'epsilon');
const swapCycles = getFlag(flags, 'swap-cycles');

const noiseParams = (epsilon !== undefined || swapCycles !== undefined) ? {} : undefined;
if (epsilon !== undefined) noiseParams.pBitNoise = parseFloat(epsilon);
if (swapCycles !== undefined) noiseParams.nSwapCycles = parseInt(swapCycles);
const { controller, visualizer } = createBoard(size, seed, noiseParams);

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
    writeCellBytes(controller, cellI, cellJ, 0x200, bytes);
    writeCellBytes(controller, cellI, cellJ, 0x300, bytes);
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
    writeCellBytes(controller, cellI, cellJ, 0x200, bytes);
    writeCellBytes(controller, cellI, cellJ, 0x300, bytes);
}

const app = new TerminalApp(controller, visualizer);
app.memoryPane.setCenter(cellI, cellJ);
app.disasmPane.setCell(cellI, cellJ);
app.minimapPane.setHighlight(cellI, cellJ);

// Script mode: run commands from file, dump to stdout, exit
if (scriptFile) {
    const scriptContent = readFileSync(scriptFile, 'utf-8');
    const scriptLines = scriptContent.split('\n');
    await app.startScript(scriptLines);
    // If --dump is also specified, write dump to that file
    if (dumpFile) {
        const { writeFileSync } = await import('fs');
        const dumpText = app.executor.generateDump();
        writeFileSync(dumpFile, dumpText);
    }
    process.exit(0);
}

// Start probe socket server if --listen
if ('listen' in flags) {
    const socketPath = listenFlag || `${tmpdir()}/6502life-${process.pid}.sock`;
    const probeServer = new ProbeServer(app);
    app.probeServer = probeServer;
    probeServer.listen(socketPath);
    probeServer.wrapTick();
    process.on('exit', () => probeServer.close());
    process.on('SIGINT', () => { probeServer.close(); process.exit(0); });
    // Show socket path in command pane after start
    const origStart = app.start.bind(app);
    app.start = async function() {
        await origStart();
        app.commandPane.print(`Probe socket: ${socketPath}`);
    };
}

await app.start();
