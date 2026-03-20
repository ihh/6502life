import { describe, it, expect } from 'vitest';
import { createBoard, zeroAllCells, writeCellBytes } from '../../engine/board.js';
import { Tracker } from '../lib/probe/tracker.js';

describe('breakpoints', () => {
    function setup(size = 4) {
        const { controller, memory } = createBoard(size, 42);
        const tracker = new Tracker(controller);
        return { controller, memory, tracker };
    }

    it('adds and removes breakpoints', () => {
        const { tracker } = setup();
        const id = tracker.addBreakpoint('write', { cell: [1, 1] });
        expect(id).toBeGreaterThan(0);
        expect(tracker.breakpoints.length).toBe(1);
        tracker.removeBreakpoint(id);
        expect(tracker.breakpoints.length).toBe(0);
    });

    it('increments breakpoint IDs', () => {
        const { tracker } = setup();
        const id1 = tracker.addBreakpoint('write', { cell: [0, 0] });
        const id2 = tracker.addBreakpoint('write', { cell: [1, 1] });
        expect(id2).toBe(id1 + 1);
    });

    it('checkBreakpoints detects write to target cell', () => {
        const { memory, tracker } = setup();
        tracker.addBreakpoint('write', { cell: [1, 1] });

        // Simulate writesByCell Map
        const cellIdx = memory.ijToCellIndex(1, 1);
        const writesByCell = new Map();
        writesByCell.set(cellIdx, [{ i: 1, j: 1, offset: 0, oldVal: 0, newVal: 0xEA }]);

        const hit = tracker.checkBreakpoints(writesByCell);
        expect(hit).not.toBeNull();
        expect(hit.type).toBe('write');
    });

    it('checkBreakpoints returns null when no match', () => {
        const { memory, tracker } = setup();
        tracker.addBreakpoint('write', { cell: [2, 2] });

        // Write to a different cell
        const cellIdx = memory.ijToCellIndex(0, 0);
        const writesByCell = new Map();
        writesByCell.set(cellIdx, [{ i: 0, j: 0, offset: 0, oldVal: 0, newVal: 0xEA }]);

        const hit = tracker.checkBreakpoints(writesByCell);
        expect(hit).toBeNull();
    });

    it('checkBreakpoints detects interrupt count', () => {
        const { tracker } = setup();
        tracker.addBreakpoint('interrupt', { count: 5 });
        tracker.interruptCount = 5;

        const hit = tracker.checkBreakpoints(new Map());
        expect(hit).not.toBeNull();
        expect(hit.type).toBe('interrupt');
    });

    it('interrupt breakpoint does not trigger before count', () => {
        const { tracker } = setup();
        tracker.addBreakpoint('interrupt', { count: 10 });
        tracker.interruptCount = 5;

        const hit = tracker.checkBreakpoints(new Map());
        expect(hit).toBeNull();
    });

    it('emits breakpoint event via onInterrupt', () => {
        const { controller, memory, tracker } = setup();
        zeroAllCells(controller);

        tracker.addBreakpoint('interrupt', { count: 1 });

        const events = [];
        tracker.subscribe('breakpoint', (e) => events.push(e));

        // Simulate an interrupt
        tracker.onInterrupt(null, false);

        expect(events.length).toBe(1);
        expect(events[0].channel).toBe('breakpoint');
        expect(events[0].id).toBeGreaterThan(0);
    });

    it('handles multiple breakpoints and returns first match', () => {
        const { memory, tracker } = setup();
        tracker.addBreakpoint('write', { cell: [1, 1] });
        tracker.addBreakpoint('write', { cell: [2, 2] });

        const cellIdx = memory.ijToCellIndex(1, 1);
        const writesByCell = new Map();
        writesByCell.set(cellIdx, [{ i: 1, j: 1, offset: 0, oldVal: 0, newVal: 0xEA }]);

        const hit = tracker.checkBreakpoints(writesByCell);
        expect(hit).not.toBeNull();
        expect(hit.type).toBe('write');
    });
});
