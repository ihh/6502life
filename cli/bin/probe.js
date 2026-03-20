#!/usr/bin/env node

// probe.js — CLI client for the 6502life debugger socket protocol
// Connects to a running terminal debugger and sends commands / streams events
//
// Usage:
//   node cli/bin/probe.js [--socket PATH] <command> [args...]
//
// Examples:
//   node cli/bin/probe.js status
//   node cli/bin/probe.js fingerprint 4,4
//   node cli/bin/probe.js scan
//   node cli/bin/probe.js scan --match a3f2c891
//   node cli/bin/probe.js diff 0,0 4,3
//   node cli/bin/probe.js track 0,0
//   node cli/bin/probe.js tag 0,0 origin
//   node cli/bin/probe.js tags --tag origin
//   node cli/bin/probe.js watch 3,5
//   node cli/bin/probe.js census
//   node cli/bin/probe.js census --interval 500
//   node cli/bin/probe.js subscribe writes
//   node cli/bin/probe.js step 100
//   node cli/bin/probe.js regs 4,4
//   node cli/bin/probe.js dump 4,4
//   node cli/bin/probe.js config --similarity 0.7 --range 0,512

import { connect } from 'net';
import { existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';

const args = process.argv.slice(2);

// Parse --socket flag
let socketPath = null;
let commandArgs = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--socket' || args[i] === '-s') {
        socketPath = args[++i];
    } else {
        commandArgs.push(args[i]);
    }
}

// Auto-detect socket if not specified
if (!socketPath) {
    const tmp = tmpdir();
    try {
        const files = readdirSync(tmp).filter(f => f.startsWith('6502life-') && f.endsWith('.sock'));
        if (files.length === 1) {
            socketPath = `${tmp}/${files[0]}`;
        } else if (files.length > 1) {
            console.error('Multiple debugger sockets found. Specify one with --socket:');
            for (const f of files) console.error(`  ${tmp}/${f}`);
            process.exit(1);
        } else {
            console.error('No debugger socket found. Start terminal.js with --listen first.');
            process.exit(1);
        }
    } catch {
        console.error('No debugger socket found. Start terminal.js with --listen first.');
        process.exit(1);
    }
}

const cmd = commandArgs[0];
if (!cmd) {
    printUsage();
    process.exit(0);
}

// Connect
const socket = socketPath.startsWith('tcp:')
    ? connect(parseInt(socketPath.slice(4)), '127.0.0.1')
    : connect(socketPath);

let buffer = '';
let msgId = 1;
let pendingCallbacks = new Map();
let streaming = false;
let gotHello = false;

socket.on('connect', () => {
    // Wait for hello, then send command
});

socket.on('data', (data) => {
    buffer += data.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
            const msg = JSON.parse(line);
            handleMessage(msg);
        } catch (err) {
            console.error('Invalid response:', line);
        }
    }
});

socket.on('error', (err) => {
    console.error(`Connection error: ${err.message}`);
    process.exit(1);
});

socket.on('close', () => {
    if (!streaming) process.exit(0);
});

function handleMessage(msg) {
    if (msg.type === 'hello') {
        gotHello = true;
        runCommand();
        return;
    }

    if (msg.type === 'event') {
        // Streaming event
        console.log(JSON.stringify(msg));
        return;
    }

    if (msg.id && pendingCallbacks.has(msg.id)) {
        const cb = pendingCallbacks.get(msg.id);
        pendingCallbacks.delete(msg.id);
        cb(msg);
        return;
    }

    // Unsolicited message
    console.log(JSON.stringify(msg));
}

function send(msg) {
    return new Promise((resolve) => {
        const id = msgId++;
        msg.id = id;
        pendingCallbacks.set(id, resolve);
        socket.write(JSON.stringify(msg) + '\n');
    });
}

async function runCommand() {
    try {
        switch (cmd) {
            case 'status': {
                const r = await send({ type: 'status' });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'step': {
                const n = parseInt(commandArgs[1]) || 1;
                const r = await send({ type: 'step', n });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'run': {
                const r = await send({ type: 'run' });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'pause': {
                const r = await send({ type: 'pause' });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'regs': {
                const cell = commandArgs[1] || undefined;
                const r = await send({ type: 'regs', cell });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'peek': {
                const addr = parseInt(commandArgs[1], 16);
                const n = parseInt(commandArgs[2]) || 1;
                const r = await send({ type: 'peek', addr, n });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'poke': {
                const addr = parseInt(commandArgs[1], 16);
                const val = parseInt(commandArgs[2], 16);
                const r = await send({ type: 'poke', addr, val });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'dump': {
                const cell = commandArgs[1];
                const r = await send({ type: 'dump', cell });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'cell': {
                const cell = commandArgs[1];
                const r = await send({ type: 'cell', cell });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'fingerprint': case 'fp': {
                const cell = commandArgs[1];
                const range = parseRange(commandArgs);
                const r = await send({ type: 'fingerprint', cell, range });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'scan': {
                const match = getFlagValue(commandArgs, '--match');
                const range = parseRange(commandArgs);
                const r = await send({ type: 'scan', match, range });
                if (r.table) {
                    // Sort by count descending for readability
                    const sorted = Object.entries(r.table)
                        .sort((a, b) => b[1] - a[1]);
                    console.log(JSON.stringify({
                        ...r,
                        table: Object.fromEntries(sorted),
                    }, null, 2));
                } else {
                    console.log(JSON.stringify(r, null, 2));
                }
                socket.end();
                break;
            }

            case 'diff': {
                const cellA = commandArgs[1];
                const cellB = commandArgs[2];
                const range = parseRange(commandArgs);
                const r = await send({ type: 'diff', cellA, cellB, range });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'tag': {
                const cell = commandArgs[1];
                const tag = commandArgs[2];
                if (!tag) { console.error('Usage: tag <i,j> <tag>'); process.exit(1); }
                const r = await send({ type: 'tag', cell, tag });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'untag': {
                const cell = commandArgs[1];
                const tag = commandArgs[2];
                const r = await send({ type: 'untag', cell, tag });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'tags': {
                const msg = { type: 'tags' };
                const tagFlag = getFlagValue(commandArgs, '--tag');
                if (tagFlag) msg.tag = tagFlag;
                else if (commandArgs[1]) msg.cell = commandArgs[1];
                const r = await send(msg);
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'track': {
                const cell = commandArgs[1];
                const tag = getFlagValue(commandArgs, '--tag');
                // Subscribe to lineage events
                await send({ type: 'subscribe', channel: 'lineage' });
                const r = await send({ type: 'track', cell, tag });
                console.log(JSON.stringify(r));
                streaming = true;
                // Events will stream to stdout
                break;
            }

            case 'untrack': {
                const cell = commandArgs[1];
                const r = await send({ type: 'untrack', cell });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'watch': {
                const cell = commandArgs[1];
                const offset = parseInt(getFlagValue(commandArgs, '--offset') || '0');
                const length = parseInt(getFlagValue(commandArgs, '--length') || '896');
                await send({ type: 'subscribe', channel: 'watch' });
                const r = await send({ type: 'watch', cell, offset, length });
                console.log(JSON.stringify(r));
                streaming = true;
                break;
            }

            case 'unwatch': {
                const id = parseInt(commandArgs[1]);
                const r = await send({ type: 'unwatch', id });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'subscribe': case 'sub': {
                const channel = commandArgs[1];
                if (!channel) { console.error('Usage: subscribe <channel>'); process.exit(1); }
                const r = await send({ type: 'subscribe', channel });
                console.log(JSON.stringify(r));
                streaming = true;
                break;
            }

            case 'census': {
                const interval = getFlagValue(commandArgs, '--interval');
                if (interval !== undefined) {
                    // Set up periodic census
                    await send({ type: 'subscribe', channel: 'census' });
                    const r = await send({ type: 'census', interval: parseInt(interval) });
                    console.log(JSON.stringify(r));
                    streaming = true;
                } else {
                    // One-shot census
                    const r = await send({ type: 'census' });
                    console.log(JSON.stringify(r, null, 2));
                    socket.end();
                }
                break;
            }

            case 'break': {
                const on = commandArgs[1];
                if (on === 'write') {
                    const cell = commandArgs[2];
                    if (!cell) { console.error('Usage: break write <i,j>'); process.exit(1); }
                    const r = await send({ type: 'break', on: 'write', cell });
                    // Subscribe to breakpoint events
                    await send({ type: 'subscribe', channel: 'breakpoint' });
                    console.log(JSON.stringify(r));
                    streaming = true;
                } else if (on === 'census') {
                    const expr = commandArgs[2];
                    if (!expr) { console.error('Usage: break census "copies>N" or "unique>N"'); process.exit(1); }
                    const msg = { type: 'break', on: 'census' };
                    if (expr.startsWith('copies>')) msg.minCopies = parseInt(expr.slice(7));
                    else if (expr.startsWith('unique>')) msg.minUnique = parseInt(expr.slice(7));
                    const r = await send(msg);
                    await send({ type: 'subscribe', channel: 'breakpoint' });
                    console.log(JSON.stringify(r));
                    streaming = true;
                } else if (on === 'interrupt') {
                    const count = parseInt(commandArgs[2]);
                    const r = await send({ type: 'break', on: 'interrupt', count });
                    await send({ type: 'subscribe', channel: 'breakpoint' });
                    console.log(JSON.stringify(r));
                    streaming = true;
                } else {
                    console.error('Usage: break <write|census|interrupt> <args>');
                    process.exit(1);
                }
                break;
            }

            case 'delbreak': {
                const id = parseInt(commandArgs[1]);
                const r = await send({ type: 'delbreak', id });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'breaks': {
                const r = await send({ type: 'breaks' });
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'config': {
                const msg = { type: 'config' };
                const sim = getFlagValue(commandArgs, '--similarity');
                const range = parseRange(commandArgs);
                if (sim !== undefined) msg.similarityThreshold = parseFloat(sim);
                if (range) msg.fpRange = range;
                const r = await send(msg);
                console.log(JSON.stringify(r, null, 2));
                socket.end();
                break;
            }

            case 'help':
                printUsage();
                socket.end();
                break;

            default:
                console.error(`Unknown command: ${cmd}. Try: probe.js help`);
                socket.end();
                break;
        }
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}

function getFlagValue(args, flag) {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function parseRange(args) {
    const rangeStr = getFlagValue(args, '--range');
    if (!rangeStr) return undefined;
    const parts = rangeStr.split(',').map(Number);
    return parts.length === 2 ? parts : undefined;
}

function printUsage() {
    console.log(`6502life probe — CLI client for the debugger socket

Usage: node cli/bin/probe.js [--socket PATH] <command> [args...]

Simulation:
  status                       Show board status
  step [N]                     Step N interrupts (default 1)
  run / pause                  Control simulation

Inspection:
  regs [I,J]                   Show cell registers
  peek ADDR [N]                Read N bytes at address (hex)
  poke ADDR VAL                Write byte (hex)
  dump I,J                     Dump full cell (base64)
  cell I,J                     Navigate TUI to cell

Fingerprinting:
  fingerprint I,J [--range S,E]   MinHash + content hash for cell
  scan [--match HASH] [--range S,E]  Scan board for fingerprints
  diff I1,J1 I2,J2 [--range S,E]    Byte-level diff + similarity

Tagging:
  tag I,J TAG                  Add tag to cell
  untag I,J TAG                Remove tag from cell
  tags [I,J | --tag TAG]       List tags (by cell, by tag, or all)

Tracking:
  track I,J [--tag TAG]        Track cell lineage (streams events)
  untrack I,J                  Stop tracking cell

Watchpoints:
  watch I,J [--offset N] [--length N]  Watch cell writes (streams)
  unwatch ID                   Remove watchpoint

Events:
  subscribe CHANNEL            Stream raw events (writes|moves|lineage|watch|census)
  census [--interval N]        One-shot or periodic board census

Breakpoints:
  break write I,J                Pause when cell is written
  break census "copies>N"        Pause when any fingerprint has N+ copies
  break interrupt N              Pause at interrupt count N
  delbreak ID                    Remove breakpoint
  breaks                         List active breakpoints

Config:
  config [--similarity N] [--range S,E]  Get/set tracker config

Socket auto-detected from /tmp/6502life-*.sock or specify with --socket.`);
}
