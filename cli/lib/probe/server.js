// Socket server for the probe protocol
// JSON-lines over Unix domain socket (or TCP)
// Embeds into the TerminalApp, exposing commands and event streams

import { createServer } from 'net';
import { unlinkSync, existsSync } from 'fs';
import { Tracker } from './tracker.js';
import { hashHex } from './fingerprint.js';
import { readCellRegisters, readCellMemory } from '../../../engine/board.js';

export class ProbeServer {
    constructor(app) {
        this.app = app;
        this.controller = app.controller;
        this.tracker = new Tracker(app.controller);
        this.clients = new Set();
        this.server = null;
        this.socketPath = null;
    }

    listen(socketPath) {
        this.socketPath = socketPath;

        // Clean up stale socket
        if (!socketPath.includes(':') && existsSync(socketPath)) {
            try { unlinkSync(socketPath); } catch {}
        }

        const opts = {};
        if (socketPath.startsWith('tcp:')) {
            const port = parseInt(socketPath.slice(4));
            this.server = createServer(conn => this.onConnection(conn));
            this.server.listen(port, '127.0.0.1');
        } else {
            this.server = createServer(conn => this.onConnection(conn));
            this.server.listen(socketPath);
        }

        this.server.on('error', (err) => {
            this.app.commandPane?.print?.(`Probe server error: ${err.message}`);
        });
    }

    close() {
        for (const client of this.clients) {
            client.socket.destroy();
        }
        this.clients.clear();
        if (this.server) {
            this.server.close();
            if (this.socketPath && !this.socketPath.includes(':')) {
                try { unlinkSync(this.socketPath); } catch {}
            }
        }
    }

    onConnection(socket) {
        const client = {
            socket,
            buffer: '',
            subscriptions: [], // unsubscribe functions
        };
        this.clients.add(client);

        socket.on('data', (data) => {
            client.buffer += data.toString();
            let nl;
            while ((nl = client.buffer.indexOf('\n')) >= 0) {
                const line = client.buffer.slice(0, nl).trim();
                client.buffer = client.buffer.slice(nl + 1);
                if (line) this.handleMessage(client, line);
            }
        });

        socket.on('close', () => {
            for (const unsub of client.subscriptions) unsub();
            this.clients.delete(client);
        });

        socket.on('error', () => {
            for (const unsub of client.subscriptions) unsub();
            this.clients.delete(client);
        });

        this.send(client, { type: 'hello', version: 1 });
    }

    send(client, msg) {
        try {
            client.socket.write(JSON.stringify(msg) + '\n');
        } catch {}
    }

    handleMessage(client, line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            this.send(client, { type: 'error', error: 'Invalid JSON' });
            return;
        }

        const id = msg.id;
        const reply = (data) => this.send(client, { ...data, id });

        try {
            this.dispatch(client, msg, reply);
        } catch (err) {
            reply({ type: 'error', error: err.message });
        }
    }

    dispatch(client, msg, reply) {
        switch (msg.type) {
            // --- Simulation control ---
            case 'step': {
                const n = msg.n || 1;
                for (let i = 0; i < n; i++) {
                    this.stepWithTracking();
                }
                reply({ type: 'ok', interrupts: this.app.totalInterrupts });
                break;
            }

            case 'run':
                this.app.running = true;
                reply({ type: 'ok' });
                break;

            case 'pause':
                this.app.running = false;
                reply({ type: 'ok' });
                break;

            case 'status':
                reply({
                    type: 'status',
                    running: this.app.running,
                    interrupts: this.app.totalInterrupts,
                    speed: this.app.speed,
                    totalCycles: this.controller.totalCycles,
                    boardSize: this.controller.memory.B,
                });
                break;

            // --- Cell inspection ---
            case 'regs': {
                const [i, j] = parseCell(msg.cell) || [this.app.disasmPane.cellI, this.app.disasmPane.cellJ];
                const regs = readCellRegisters(this.controller, i, j);
                reply({ type: 'regs', cell: [i, j], ...regs });
                break;
            }

            case 'peek': {
                const addr = msg.addr;
                const n = msg.n || 1;
                const bytes = [];
                for (let k = 0; k < n; k++) {
                    bytes.push(this.controller.memory.read((addr + k) & 0xFFFF));
                }
                reply({ type: 'peek', addr, bytes });
                break;
            }

            case 'poke': {
                this.controller.memory.write(msg.addr, msg.val & 0xFF);
                reply({ type: 'ok' });
                break;
            }

            case 'dump': {
                const [i, j] = parseCell(msg.cell);
                const bytes = readCellMemory(this.controller, i, j);
                reply({
                    type: 'dump',
                    cell: [i, j],
                    data: Buffer.from(bytes).toString('base64'),
                });
                break;
            }

            case 'cell': {
                const [i, j] = parseCell(msg.cell);
                this.app.memoryPane.setCenter(i, j);
                this.app.disasmPane.setCell(i, j);
                this.app.minimapPane.setHighlight(i, j);
                this.app.needsRender = true;
                reply({ type: 'ok', cell: [i, j] });
                break;
            }

            // --- Fingerprinting ---
            case 'fingerprint': {
                const [i, j] = parseCell(msg.cell);
                const range = msg.range || undefined;
                const fp = this.tracker.fingerprintCell(i, j, range);
                reply({
                    type: 'fingerprint',
                    cell: [i, j],
                    hash: hashHex(fp.hash),
                    minhash: Array.from(fp.minhash),
                });
                break;
            }

            case 'scan': {
                const range = msg.range || undefined;
                const table = this.tracker.scanBoard(range);
                if (msg.match) {
                    // Return cells matching a specific hash
                    const matches = table.get(msg.match) || [];
                    reply({ type: 'scan', match: msg.match, matches, count: matches.length });
                } else {
                    // Return frequency table
                    const freqs = {};
                    for (const [hash, cells] of table) {
                        freqs[hash] = cells.length;
                    }
                    reply({ type: 'scan', table: freqs, uniqueFingerprints: table.size });
                }
                break;
            }

            case 'diff': {
                const [i1, j1] = parseCell(msg.cellA);
                const [i2, j2] = parseCell(msg.cellB);
                const range = msg.range || undefined;
                const result = this.tracker.diffCells(i1, j1, i2, j2, range);
                reply({ type: 'diff', ...result });
                break;
            }

            // --- Tagging ---
            case 'tag': {
                const [i, j] = parseCell(msg.cell);
                this.tracker.addTag(i, j, msg.tag);
                reply({ type: 'ok', tags: this.tracker.getTags(i, j) });
                break;
            }

            case 'untag': {
                const [i, j] = parseCell(msg.cell);
                this.tracker.removeTag(i, j, msg.tag);
                reply({ type: 'ok', tags: this.tracker.getTags(i, j) });
                break;
            }

            case 'tags': {
                if (msg.cell) {
                    const [i, j] = parseCell(msg.cell);
                    reply({ type: 'tags', cell: [i, j], tags: this.tracker.getTags(i, j) });
                } else if (msg.tag) {
                    const cells = this.tracker.findByTag(msg.tag);
                    reply({ type: 'tags', tag: msg.tag, cells, count: cells.length });
                } else {
                    // All tags summary
                    const all = {};
                    for (const [idx, tags] of this.tracker.tags) {
                        const B = this.controller.memory.B;
                        const cell = [Math.floor(idx / B), idx % B];
                        for (const t of tags) {
                            if (!all[t]) all[t] = [];
                            all[t].push(cell);
                        }
                    }
                    reply({ type: 'tags', all });
                }
                break;
            }

            // --- Lineage tracking ---
            case 'track': {
                const [i, j] = parseCell(msg.cell);
                this.tracker.trackCell(i, j);
                if (msg.tag) this.tracker.addTag(i, j, msg.tag);
                reply({ type: 'ok', tracking: true, cell: [i, j] });
                break;
            }

            case 'untrack': {
                const [i, j] = parseCell(msg.cell);
                this.tracker.untrackCell(i, j);
                reply({ type: 'ok', tracking: false, cell: [i, j] });
                break;
            }

            // --- Watchpoints ---
            case 'watch': {
                const [i, j] = parseCell(msg.cell);
                const offset = msg.offset || 0;
                const length = msg.length || 896;
                const id = this.tracker.addWatch(i, j, offset, length);
                reply({ type: 'ok', watchId: id });
                break;
            }

            case 'unwatch': {
                this.tracker.removeWatch(msg.id);
                reply({ type: 'ok' });
                break;
            }

            // --- Subscriptions ---
            case 'subscribe': {
                const channel = msg.channel;
                const unsub = this.tracker.subscribe(channel, (event) => {
                    this.send(client, { type: 'event', ...event });
                });
                client.subscriptions.push(unsub);
                reply({ type: 'subscribed', channel });
                break;
            }

            // --- Census ---
            case 'census': {
                if (msg.interval !== undefined) {
                    this.tracker.censusInterval = msg.interval;
                    this.tracker.lastCensusInterrupt = this.tracker.interruptCount;
                    reply({ type: 'ok', censusInterval: msg.interval });
                } else {
                    const result = this.tracker.computeCensus();
                    reply({ type: 'census', ...result });
                }
                break;
            }

            // --- Breakpoints ---
            case 'break': {
                const bp = msg;
                let id;
                if (bp.on === 'write') {
                    const [i, j] = parseCell(bp.cell);
                    id = this.tracker.addBreakpoint('write', { cell: [i, j] });
                } else if (bp.on === 'census') {
                    id = this.tracker.addBreakpoint('census', {
                        minCopies: bp.minCopies,
                        minUnique: bp.minUnique,
                    });
                } else if (bp.on === 'interrupt') {
                    id = this.tracker.addBreakpoint('interrupt', { count: bp.count });
                } else {
                    reply({ type: 'error', error: 'Unknown breakpoint type. Use: write, census, interrupt' });
                    break;
                }
                reply({ type: 'ok', breakpointId: id });
                break;
            }

            case 'delbreak': {
                this.tracker.removeBreakpoint(msg.id);
                reply({ type: 'ok' });
                break;
            }

            case 'breaks': {
                reply({
                    type: 'breaks',
                    breakpoints: this.tracker.breakpoints.map(bp => ({
                        id: bp.id, type: bp.type, condition: bp.condition,
                    })),
                });
                break;
            }

            // --- Config ---
            case 'config': {
                if (msg.similarityThreshold !== undefined) {
                    this.tracker.similarityThreshold = msg.similarityThreshold;
                }
                if (msg.fpRange !== undefined) {
                    this.tracker.fpRange = msg.fpRange;
                }
                reply({
                    type: 'config',
                    similarityThreshold: this.tracker.similarityThreshold,
                    fpRange: this.tracker.fpRange,
                });
                break;
            }

            default:
                reply({ type: 'error', error: `Unknown command: ${msg.type}` });
        }
    }

    // Step simulation with tracking hooks
    stepWithTracking() {
        // Capture undo history before it's cleared
        const mem = this.controller.memory;
        const origCommitWrites = this.controller.commitWrites.bind(this.controller);
        const origUndoWrites = mem.undoWrites.bind(mem);

        let capturedHistory = null;
        let wasAtomic = false;

        // Temporarily patch to capture write history
        this.controller.commitWrites = () => {
            capturedHistory = mem.undoHistory ? { ...mem.undoHistory } : null;
            origCommitWrites();
        };

        const origResetUndo = mem.resetUndoHistory.bind(mem);
        let undoInvoked = false;
        const patchedUndo = () => {
            wasAtomic = true;
            origUndoWrites();
        };
        mem.undoWrites = patchedUndo;

        this.controller.runToNextInterrupt();
        this.app.totalInterrupts++;

        // Restore
        this.controller.commitWrites = origCommitWrites;
        mem.undoWrites = origUndoWrites;

        // Notify tracker
        this.tracker.onInterrupt(capturedHistory, wasAtomic);

        // Check if a breakpoint was hit — pause simulation
        if (this.tracker.breakpointHit) {
            this.app.running = false;
            this.tracker.breakpointHit = null;
        }
    }

    // Called from the app's tick loop when running
    // Patches the step to include tracking
    wrapTick() {
        const origStep = this.app.step.bind(this.app);
        this.app.step = () => {
            this.stepWithTracking();
            this.app.needsRender = true;
        };

        // Also patch the tick loop's inline stepping
        const origTick = this.app.tick.bind(this.app);
        this.app.tick = () => {
            if (this.app.quit) return;

            if (this.app.running) {
                for (let i = 0; i < this.app.speed; i++) {
                    this.stepWithTracking();
                }
                this.app.needsRender = true;
            }

            const now = Date.now();
            if (this.app.needsRender && (now - this.app.lastRender >= this.app.minRenderInterval)) {
                this.app.render();
                this.app.lastRender = now;
                this.app.needsRender = false;
            }

            setImmediate(() => this.app.tick());
        };
    }
}

function parseCell(cell) {
    if (!cell) return null;
    if (Array.isArray(cell)) return cell;
    if (typeof cell === 'string') {
        const parts = cell.split(',').map(Number);
        return parts.length === 2 ? parts : null;
    }
    return null;
}
