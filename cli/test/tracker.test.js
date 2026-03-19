import { describe, it, expect } from 'vitest';
import { createBoard, readCellMemory, writeCellBytes } from '../../engine/board.js';
import { Tracker } from '../lib/probe/tracker.js';

describe('Tracker', () => {
    function setup(size = 4) {
        const { controller, memory, visualizer } = createBoard(size, 42);
        const tracker = new Tracker(controller);
        return { controller, memory, tracker };
    }

    describe('fingerprinting', () => {
        it('fingerprints a cell', () => {
            const { tracker } = setup();
            const fp = tracker.fingerprintCell(0, 0);
            expect(typeof fp.hash).toBe('number');
            expect(fp.minhash).toBeInstanceOf(Uint32Array);
        });

        it('identical cells have same fingerprint', () => {
            const { controller, tracker } = setup();
            const data = new Uint8Array(64).fill(0xEA); // NOP sled
            writeCellBytes(controller, 0, 0, 0, data);
            writeCellBytes(controller, 1, 1, 0, data);
            const fp1 = tracker.fingerprintCell(0, 0);
            const fp2 = tracker.fingerprintCell(1, 1);
            expect(fp1.hash).toBe(fp2.hash);
        });

        it('different cells have different fingerprints', () => {
            const { controller, tracker } = setup();
            writeCellBytes(controller, 0, 0, 0, new Uint8Array([0xA9, 0x42]));
            writeCellBytes(controller, 1, 0, 0, new Uint8Array([0xA9, 0x99]));
            const fp1 = tracker.fingerprintCell(0, 0);
            const fp2 = tracker.fingerprintCell(1, 0);
            expect(fp1.hash).not.toBe(fp2.hash);
        });
    });

    describe('scanning', () => {
        it('scans board and returns fingerprint table', () => {
            const { tracker } = setup();
            const table = tracker.scanBoard();
            expect(table).toBeInstanceOf(Map);
            // 4x4 = 16 cells
            let total = 0;
            for (const cells of table.values()) total += cells.length;
            expect(total).toBe(16);
        });
    });

    describe('diffing', () => {
        it('identical cells show no changes', () => {
            const { controller, tracker } = setup();
            const data = new Uint8Array(64).fill(0xEA);
            writeCellBytes(controller, 0, 0, 0, data);
            writeCellBytes(controller, 1, 1, 0, data);
            const result = tracker.diffCells(0, 0, 1, 1);
            expect(result.identical).toBe(true);
            expect(result.similarity).toBe(1);
        });

        it('different cells show changes', () => {
            const { controller, tracker } = setup();
            writeCellBytes(controller, 0, 0, 0, new Uint8Array(64).fill(0xEA));
            writeCellBytes(controller, 1, 0, 0, new Uint8Array(64).fill(0x00));
            const result = tracker.diffCells(0, 0, 1, 0);
            expect(result.identical).toBe(false);
            expect(result.numChanges).toBeGreaterThan(0);
        });
    });

    describe('tagging', () => {
        it('adds and retrieves tags', () => {
            const { tracker } = setup();
            tracker.addTag(2, 3, 'origin');
            tracker.addTag(2, 3, 'copier');
            expect(tracker.getTags(2, 3)).toContain('origin');
            expect(tracker.getTags(2, 3)).toContain('copier');
        });

        it('removes tags', () => {
            const { tracker } = setup();
            tracker.addTag(1, 1, 'test');
            tracker.removeTag(1, 1, 'test');
            expect(tracker.getTags(1, 1)).toEqual([]);
        });

        it('finds cells by tag', () => {
            const { tracker } = setup();
            tracker.addTag(0, 0, 'family');
            tracker.addTag(2, 3, 'family');
            const cells = tracker.findByTag('family');
            expect(cells.length).toBe(2);
            expect(cells).toContainEqual([0, 0]);
            expect(cells).toContainEqual([2, 3]);
        });
    });

    describe('watchpoints', () => {
        it('adds and removes watchpoints', () => {
            const { tracker } = setup();
            const id = tracker.addWatch(1, 1, 0, 256);
            expect(id).toBeGreaterThan(0);
            expect(tracker.watchpoints.length).toBe(1);
            tracker.removeWatch(id);
            expect(tracker.watchpoints.length).toBe(0);
        });
    });

    describe('census', () => {
        it('computes board census', () => {
            const { tracker } = setup();
            const census = tracker.computeCensus();
            expect(census.totalCells).toBe(16);
            expect(typeof census.active).toBe('number');
            expect(typeof census.uniqueFingerprints).toBe('number');
            expect(typeof census.top).toBe('object');
        });
    });

    describe('cell tracking', () => {
        it('tracks and untracks cells', () => {
            const { tracker } = setup();
            tracker.trackCell(0, 0);
            expect(tracker.trackedCells.size).toBe(1);
            tracker.untrackCell(0, 0);
            expect(tracker.trackedCells.size).toBe(0);
        });
    });

    describe('event subscriptions', () => {
        it('subscribes and receives events', () => {
            const { tracker } = setup();
            const events = [];
            tracker.subscribe('writes', (e) => events.push(e));
            tracker.emit('writes', { test: true });
            expect(events.length).toBe(1);
            expect(events[0].test).toBe(true);
        });

        it('unsubscribes correctly', () => {
            const { tracker } = setup();
            const events = [];
            const unsub = tracker.subscribe('writes', (e) => events.push(e));
            unsub();
            tracker.emit('writes', { test: true });
            expect(events.length).toBe(0);
        });
    });
});
