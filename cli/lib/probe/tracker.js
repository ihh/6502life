// Tracker — monitors board events for write provenance, lineage, tags, and census
// Hooks into the controller's commit cycle to capture structured events

import { readCellMemory } from '../../../engine/board.js';
import { fingerprint, minhashSimilarity, hashHex } from './fingerprint.js';

export class Tracker {
    constructor(controller) {
        this.controller = controller;
        this.memory = controller.memory;

        // Event subscribers: channel -> Set of callback functions
        this.subscribers = new Map();

        // Tag tracking: cellIndex -> Set of tag strings
        this.tags = new Map();

        // Lineage tracking: set of cellIndex values being tracked
        this.trackedCells = new Set();

        // Similarity threshold for copy detection
        this.similarityThreshold = 0.6;

        // Fingerprint range (default: code region, excluding bitmap/name)
        this.fpRange = [0, 896];

        // Census interval tracking
        this.censusInterval = 0;
        this.lastCensusInterrupt = 0;
        this.interruptCount = 0;

        // Cache: cellIndex -> last known fingerprint
        this.fpCache = new Map();

        // Watchpoints: array of {cell:[i,j], offset, length, id}
        this.watchpoints = [];
        this.nextWatchId = 1;

        // Breakpoints: array of {type, condition, id}
        this.breakpoints = [];
        this.nextBreakpointId = 1;
        this.breakpointHit = null; // set to the breakpoint when triggered
    }

    // --- Subscription ---

    subscribe(channel, callback) {
        if (!this.subscribers.has(channel)) {
            this.subscribers.set(channel, new Set());
        }
        this.subscribers.get(channel).add(callback);
        return () => this.subscribers.get(channel)?.delete(callback);
    }

    emit(channel, event) {
        const subs = this.subscribers.get(channel);
        if (subs) {
            for (const cb of subs) cb(event);
        }
    }

    // --- Hook into controller cycle ---
    // Call this AFTER each runToNextInterrupt(), passing the undoHistory
    // before it gets cleared. We patch into the controller flow.

    onInterrupt(undoHistory, wasAtomic) {
        this.interruptCount++;

        if (wasAtomic) return; // writes were reverted, nothing to track

        // Collect writes by destination cell
        const writesByCell = new Map(); // cellIndex -> [{offset, oldVal, newVal}]
        const srcCell = this.memory.ijToCellIndex(this.memory.iOrig, this.memory.jOrig);

        if (undoHistory) {
            for (const addrStr of Object.keys(undoHistory)) {
                const byteIndex = parseInt(addrStr);
                const [i, j, b] = this.memory.ijbFromByteIndex(byteIndex);
                const cellIdx = this.memory.ijToCellIndex(i, j);
                const oldVal = undoHistory[addrStr];
                const newVal = this.memory.getByte(byteIndex);

                if (!writesByCell.has(cellIdx)) writesByCell.set(cellIdx, []);
                writesByCell.get(cellIdx).push({ i, j, offset: b, oldVal, newVal });
            }
        }

        // Emit write events
        if (this.subscribers.has('writes') && writesByCell.size > 0) {
            for (const [cellIdx, writes] of writesByCell) {
                const { i, j } = writes[0];
                this.emit('writes', {
                    channel: 'writes',
                    time: this.memory.totalCycles,
                    interrupt: this.interruptCount,
                    src: [this.memory.iOrig, this.memory.jOrig],
                    dst: [i, j],
                    bytes: writes.map(w => ({ offset: w.offset, old: w.oldVal, new: w.newVal })),
                });
            }
        }

        // Check watchpoints
        if (this.watchpoints.length > 0 && writesByCell.size > 0) {
            for (const wp of this.watchpoints) {
                const wpCellIdx = this.memory.ijToCellIndex(wp.cell[0], wp.cell[1]);
                const cellWrites = writesByCell.get(wpCellIdx);
                if (!cellWrites) continue;
                const inRange = cellWrites.filter(w =>
                    w.offset >= wp.offset && w.offset < wp.offset + wp.length
                );
                if (inRange.length > 0) {
                    this.emit('watch', {
                        channel: 'watch',
                        id: wp.id,
                        time: this.memory.totalCycles,
                        interrupt: this.interruptCount,
                        cell: wp.cell,
                        src: [this.memory.iOrig, this.memory.jOrig],
                        bytes: inRange.map(w => ({ offset: w.offset, old: w.oldVal, new: w.newVal })),
                    });
                }
            }
        }

        // Lineage: detect copy-to events
        if (this.trackedCells.size > 0 && writesByCell.size > 0) {
            for (const trackedIdx of this.trackedCells) {
                // Check if this tracked cell wrote to another cell's code region
                const B = this.memory.B;
                const trackedI = Math.floor(trackedIdx / B);
                const trackedJ = trackedIdx % B;

                // Is the tracked cell the one executing? (i.e. is it the origin?)
                if (trackedIdx !== srcCell) continue;

                const srcBytes = readCellMemory(this.controller, trackedI, trackedJ);
                const srcFp = fingerprint(srcBytes, this.fpRange);

                for (const [dstCellIdx, writes] of writesByCell) {
                    if (dstCellIdx === trackedIdx) continue;
                    // Were significant code-region bytes written?
                    const codeWrites = writes.filter(w =>
                        w.offset >= this.fpRange[0] && w.offset < this.fpRange[1]
                    );
                    if (codeWrites.length < 8) continue; // too few to be a copy

                    const dstI = writes[0].i;
                    const dstJ = writes[0].j;
                    const dstBytes = readCellMemory(this.controller, dstI, dstJ);
                    const dstFp = fingerprint(dstBytes, this.fpRange);
                    const sim = minhashSimilarity(srcFp.minhash, dstFp.minhash);

                    if (sim >= this.similarityThreshold) {
                        this.emit('lineage', {
                            channel: 'lineage',
                            time: this.memory.totalCycles,
                            interrupt: this.interruptCount,
                            event: 'copied_to',
                            src: [trackedI, trackedJ],
                            dst: [dstI, dstJ],
                            similarity: Math.round(sim * 1000) / 1000,
                            bytesWritten: codeWrites.length,
                        });

                        // Propagate tags
                        const srcTags = this.tags.get(trackedIdx);
                        if (srcTags && srcTags.size > 0) {
                            if (!this.tags.has(dstCellIdx)) this.tags.set(dstCellIdx, new Set());
                            for (const tag of srcTags) this.tags.get(dstCellIdx).add(tag);
                        }

                        // Auto-track the copy too
                        this.trackedCells.add(dstCellIdx);
                    }
                }
            }
        }

        // Census
        if (this.censusInterval > 0 &&
            this.interruptCount - this.lastCensusInterrupt >= this.censusInterval) {
            this.lastCensusInterrupt = this.interruptCount;
            const census = this.computeCensus();
            this.emit('census', census);
        }

        // Breakpoints
        if (this.breakpoints.length > 0) {
            const hit = this.checkBreakpoints(writesByCell);
            if (hit) {
                this.breakpointHit = hit;
                this.emit('breakpoint', {
                    channel: 'breakpoint',
                    id: hit.id,
                    type: hit.type,
                    interrupt: this.interruptCount,
                    time: this.memory.totalCycles,
                });
            }
        }
    }

    onMove(srcNeighIdx, dstNeighIdx) {
        // Convert neighborhood indices to board coordinates
        // srcNeighIdx is among first 5 cells (self + NESW), dstNeighIdx among all 49
        // We need the actual (i,j) — the controller does this in commitMove
        // For now emit a simplified event
        this.emit('moves', {
            channel: 'moves',
            time: this.memory.totalCycles,
            interrupt: this.interruptCount,
            src: srcNeighIdx,
            dst: dstNeighIdx,
            origin: [this.memory.iOrig, this.memory.jOrig],
        });

        // If tracked cells were moved, update tracking
        // (The controller swaps cell contents, so tracking should follow)
    }

    // --- Tagging ---

    addTag(i, j, tag) {
        const idx = this.memory.ijToCellIndex(i, j);
        if (!this.tags.has(idx)) this.tags.set(idx, new Set());
        this.tags.get(idx).add(tag);
    }

    removeTag(i, j, tag) {
        const idx = this.memory.ijToCellIndex(i, j);
        const tags = this.tags.get(idx);
        if (tags) tags.delete(tag);
    }

    getTags(i, j) {
        const idx = this.memory.ijToCellIndex(i, j);
        return Array.from(this.tags.get(idx) || []);
    }

    findByTag(tag) {
        const results = [];
        const B = this.memory.B;
        for (const [idx, tags] of this.tags) {
            if (tags.has(tag)) {
                results.push([Math.floor(idx / B), idx % B]);
            }
        }
        return results;
    }

    // --- Watchpoints ---

    addWatch(i, j, offset = 0, length = 896) {
        const id = this.nextWatchId++;
        this.watchpoints.push({ cell: [i, j], offset, length, id });
        return id;
    }

    removeWatch(id) {
        this.watchpoints = this.watchpoints.filter(w => w.id !== id);
    }

    // --- Breakpoints ---

    addBreakpoint(type, condition) {
        const id = this.nextBreakpointId++;
        this.breakpoints.push({ type, condition, id });
        return id;
    }

    removeBreakpoint(id) {
        this.breakpoints = this.breakpoints.filter(bp => bp.id !== id);
    }

    checkBreakpoints(writesByCell) {
        for (const bp of this.breakpoints) {
            if (bp.type === 'write') {
                // Break when a specific cell is written
                const targetIdx = this.memory.ijToCellIndex(bp.condition.cell[0], bp.condition.cell[1]);
                if (writesByCell.has(targetIdx)) {
                    return bp;
                }
            } else if (bp.type === 'census') {
                // Break on census condition (e.g., copies > N)
                // Only check periodically (every 100 interrupts) to avoid performance hit
                if (this.interruptCount % 100 === 0) {
                    const census = this.computeCensus();
                    const topValues = Object.values(census.top);
                    if (bp.condition.minCopies && topValues.some(v => v >= bp.condition.minCopies)) {
                        return bp;
                    }
                    if (bp.condition.minUnique && census.uniqueFingerprints >= bp.condition.minUnique) {
                        return bp;
                    }
                }
            } else if (bp.type === 'interrupt') {
                // Break at interrupt count
                if (this.interruptCount >= bp.condition.count) {
                    return bp;
                }
            }
        }
        return null;
    }

    // --- Fingerprinting ---

    fingerprintCell(i, j, range) {
        const bytes = readCellMemory(this.controller, i, j);
        return fingerprint(bytes, range || this.fpRange);
    }

    // Scan entire board, returning hash -> list of [i,j] pairs
    scanBoard(range) {
        const B = this.memory.B;
        const table = new Map(); // hash -> [[i,j], ...]
        for (let i = 0; i < B; i++) {
            for (let j = 0; j < B; j++) {
                const fp = this.fingerprintCell(i, j, range);
                const h = hashHex(fp.hash);
                if (!table.has(h)) table.set(h, []);
                table.get(h).push([i, j]);
            }
        }
        return table;
    }

    // Diff two cells byte-by-byte
    diffCells(i1, j1, i2, j2, range) {
        const r = range || this.fpRange;
        const a = readCellMemory(this.controller, i1, j1);
        const b = readCellMemory(this.controller, i2, j2);
        const changes = [];
        for (let off = r[0]; off < r[1]; off++) {
            if (a[off] !== b[off]) {
                changes.push({ offset: off, a: a[off], b: b[off] });
            }
        }
        // Also compute minhash similarity
        const fpA = fingerprint(a, r);
        const fpB = fingerprint(b, r);
        const sim = minhashSimilarity(fpA.minhash, fpB.minhash);
        return {
            cells: [[i1, j1], [i2, j2]],
            identical: changes.length === 0,
            similarity: Math.round(sim * 1000) / 1000,
            numChanges: changes.length,
            changes: changes.slice(0, 256), // cap to avoid huge output
        };
    }

    // --- Census ---

    computeCensus() {
        const B = this.memory.B;
        const table = this.scanBoard();
        const sorted = Array.from(table.entries())
            .map(([hash, cells]) => ({ hash, count: cells.length }))
            .sort((a, b) => b.count - a.count);

        // Active cells (recently written/moved)
        let active = 0;
        for (let idx = 0; idx < B * B; idx++) {
            if (this.controller.lastWriteTime[idx] > 0 ||
                this.controller.lastMoveTime[idx] > 0) {
                active++;
            }
        }

        // Top fingerprints (skip the most common one if it's likely "empty")
        const top = sorted.slice(0, 20).reduce((obj, e) => {
            obj[e.hash] = e.count;
            return obj;
        }, {});

        // Tag summary
        const tagCounts = {};
        for (const [, tags] of this.tags) {
            for (const tag of tags) {
                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            }
        }

        return {
            channel: 'census',
            time: this.memory.totalCycles,
            interrupt: this.interruptCount,
            totalCells: B * B,
            active,
            uniqueFingerprints: table.size,
            top,
            tags: tagCounts,
        };
    }

    // --- Track management ---

    trackCell(i, j) {
        const idx = this.memory.ijToCellIndex(i, j);
        this.trackedCells.add(idx);
    }

    untrackCell(i, j) {
        const idx = this.memory.ijToCellIndex(i, j);
        this.trackedCells.delete(idx);
    }
}
