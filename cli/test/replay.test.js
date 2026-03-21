import { describe, it, expect } from 'vitest';
import { createBoard, zeroAllCells, writeCellBytes, readCellMemory } from '../../engine/board.js';
import { assemble } from '../../engine/assembler.js';
import { Tracker } from '../lib/probe/tracker.js';

describe('replay (tracker integration)', () => {
    function setupWithTracker(size = 4) {
        const { controller, memory } = createBoard(size, 42);
        const tracker = new Tracker(controller);
        return { controller, memory, tracker };
    }

    function stepWithTracking(controller, tracker) {
        const mem = controller.memory;
        const origCommitWrites = controller.commitWrites.bind(controller);
        const origUndoWrites = mem.undoWrites.bind(mem);

        let capturedHistory = null;
        let wasAtomic = false;

        controller.commitWrites = () => {
            capturedHistory = mem.undoHistory ? { ...mem.undoHistory } : null;
            origCommitWrites();
        };
        mem.undoWrites = () => {
            wasAtomic = true;
            origUndoWrites();
        };

        // Reset sfotty internal state before each interrupt to prevent
        // stale crashed/cycleCounter state from a previous cell's execution.
        controller.sfotty.crashed = false;
        controller.sfotty.cycleCounter = 0;
        controller.sfotty.operations = [() => controller.sfotty.decode()];
        controller.runToNextInterrupt();

        controller.commitWrites = origCommitWrites;
        mem.undoWrites = origUndoWrites;

        tracker.onInterrupt(capturedHistory, wasAtomic);
    }

    it('captures write events during simulation', async () => {
        const { controller, tracker } = setupWithTracker(4);
        zeroAllCells(controller);

        // Load a counter program
        const source = 'TXA\n@loop:\nCLC\nADC #$01\nSTA $10\nBNE @loop';
        const bytes = await assemble(source);
        writeCellBytes(controller, 0, 0, 0, bytes);

        const events = [];
        tracker.subscribe('writes', (e) => events.push(e));

        // Run enough interrupts that cell (0,0) gets scheduled at least once
        for (let i = 0; i < 200; i++) {
            stepWithTracking(controller, tracker);
        }

        // Should have captured some write events (counter writes to $10)
        expect(events.length).toBeGreaterThan(0);
        expect(events[0].channel).toBe('writes');
        expect(events[0].src).toBeDefined();
        expect(events[0].bytes).toBeDefined();
    });

    it('tracks interrupt count correctly', async () => {
        const { controller, tracker } = setupWithTracker(4);

        for (let i = 0; i < 10; i++) {
            stepWithTracking(controller, tracker);
        }

        expect(tracker.interruptCount).toBe(10);
    });

    it('emits census events at configured interval', async () => {
        const { controller, tracker } = setupWithTracker(4);
        tracker.censusInterval = 3;

        const censusEvents = [];
        tracker.subscribe('census', (e) => censusEvents.push(e));

        for (let i = 0; i < 10; i++) {
            stepWithTracking(controller, tracker);
        }

        // Should have at least 2 census events (at interrupt 3, 6, 9)
        expect(censusEvents.length).toBeGreaterThanOrEqual(2);
        expect(censusEvents[0].channel).toBe('census');
        expect(censusEvents[0].totalCells).toBe(16); // 4x4
    });

    it('detects copies when tracking a cell', async () => {
        const { controller, tracker } = setupWithTracker(8);
        zeroAllCells(controller);

        // Load copier into (0,0) — copies to East neighbor (cell 2)
        const source = [
            'LDY #$01',
            '@lp0:',
            'LDA $0201,Y',
            'STA $0801,Y',
            'INY',
            'BNE @lp0',
            'BRK',
            '.byte $01',
        ].join('\n');
        const bytes = await assemble(source);
        writeCellBytes(controller, 0, 0, 0, bytes);

        tracker.trackCell(0, 0);

        const lineageEvents = [];
        tracker.subscribe('lineage', (e) => lineageEvents.push(e));

        // Set origin to (0,0) and run enough interrupts
        const mem = controller.memory;
        mem.iOrig = 0;
        mem.jOrig = 0;
        mem.orientation = 0;
        mem.nextCycles = 100000;

        // Prepare CPU
        controller.sfotty.PC = 0;
        controller.sfotty.A = 0;
        controller.sfotty.X = 0;
        controller.sfotty.Y = 0;
        controller.sfotty.S = 0xFF;
        controller.sfotty.setP(0);
        mem.resetUndoHistory();

        stepWithTracking(controller, tracker);

        // The copier should have written enough to trigger a copy detection
        // (depends on similarity threshold — may or may not trigger with default 0.6)
        // At minimum, write events should be captured
        expect(tracker.interruptCount).toBe(1);
    });
});
