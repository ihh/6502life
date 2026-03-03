import { describe, it, expect } from 'vitest';
import { BoardController } from '../controller.js';
import { BoardMemory } from '../memory.js';

describe('BoardController', () => {
    describe('construction', () => {
        it('creates with default memory', () => {
            const ctrl = new BoardController();
            expect(ctrl.memory).toBeInstanceOf(BoardMemory);
            expect(ctrl.totalCycles).toBe(0);
            expect(ctrl.sfotty).toBeDefined();
        });

        it('creates with provided memory', () => {
            const mem = new BoardMemory(99);
            const ctrl = new BoardController(mem);
            expect(ctrl.memory).toBe(mem);
        });

        it('initializes tracking arrays', () => {
            const ctrl = new BoardController();
            const B = ctrl.memory.B;
            expect(ctrl.lastMoveTime.length).toBe(B * B);
            expect(ctrl.lastWriteTime.length).toBe(B * B);
            expect(ctrl.lastWriteTimeForByte.length).toBe(B * B);
        });
    });

    describe('randomize', () => {
        it('fills storage with non-zero data', () => {
            const ctrl = new BoardController();
            // Write a known pattern to a small region, then randomize with a custom RNG
            // that fills everything with 0x12345678
            ctrl.randomize(() => 0x12345678);
            expect(ctrl.memory.getByte(0)).toBe(0x12);
            expect(ctrl.memory.getByte(1)).toBe(0x34);
            expect(ctrl.memory.getByte(2)).toBe(0x56);
            expect(ctrl.memory.getByte(3)).toBe(0x78);
        });

        it('accepts custom RNG', () => {
            const ctrl = new BoardController();
            let callCount = 0;
            ctrl.randomize(() => { callCount++; return 0x12345678; });
            expect(callCount).toBeGreaterThan(0);
        });
    });

    describe('runToNextInterrupt', () => {
        it('returns reasonable cycle counts', () => {
            const ctrl = new BoardController();
            // Just run one interrupt cycle with whatever random state
            const result = ctrl.runToNextInterrupt();
            expect(result).toHaveProperty('cpuCycles');
            expect(result).toHaveProperty('schedulerCycles');
            expect(result.cpuCycles).toBeGreaterThan(0);
            expect(result.schedulerCycles).toBeGreaterThan(0);
        });
    });

    describe('NOP sled', () => {
        it('PC advances through NOPs', () => {
            const ctrl = new BoardController();
            const mem = ctrl.memory;
            mem.orientation = 0;
            mem.iOrig = 0;
            mem.jOrig = 0;
            mem.nextCycles = 100000;

            // Write NOPs at the origin cell starting at byte 0
            for (let i = 0; i < 20; i++) {
                const byteIdx = mem.ijbToByteIndex(0, 0, i);
                mem.setByteWithoutUndo(byteIdx, 0xEA); // NOP
            }
            // Write BRK at byte 20 to stop execution
            const brkIdx = mem.ijbToByteIndex(0, 0, 20);
            mem.setByteWithoutUndo(brkIdx, 0x00); // BRK
            mem.setByteWithoutUndo(brkIdx + 1, 0x00); // BRK operand 0

            ctrl.sfotty.PC = 0;
            ctrl.sfotty.A = 0;
            ctrl.sfotty.X = 0;
            ctrl.sfotty.Y = 0;
            ctrl.sfotty.S = 0xFF;
            ctrl.sfotty.setP(0);
            mem.resetUndoHistory();

            const result = ctrl.runToNextInterrupt();
            // 20 NOPs (2 cycles each) + BRK (7 cycles) = 47 cycles
            expect(result.cpuCycles).toBe(20 * 2 + 7);
        });
    });

    describe('BRK handling', () => {
        it('BRK with operand 0 is a no-op swap', () => {
            const ctrl = new BoardController();
            const mem = ctrl.memory;
            mem.orientation = 0;
            mem.iOrig = 0;
            mem.jOrig = 0;
            mem.nextCycles = 100000;

            const byteIdx = mem.ijbToByteIndex(0, 0, 0);
            mem.setByteWithoutUndo(byteIdx, 0x00); // BRK
            mem.setByteWithoutUndo(byteIdx + 1, 0x00); // operand 0

            ctrl.sfotty.PC = 0;
            ctrl.sfotty.setP(0);
            mem.resetUndoHistory();

            const result = ctrl.runToNextInterrupt();
            expect(result.cpuCycles).toBe(7);
        });
    });

    describe('I flag (atomic mode)', () => {
        it('when I is set and timer interrupt fires, writes are reverted', () => {
            const ctrl = new BoardController();
            const mem = ctrl.memory;
            mem.orientation = 0;
            mem.iOrig = 0;
            mem.jOrig = 0;
            // Set nextCycles long enough for the code to execute fully,
            // but short enough that the timer fires during the NOP sled after
            mem.nextCycles = 20;

            // Target byte is in a location that won't be overwritten by code/NOPs
            const targetByte = 0xA0;
            const byteIdx = mem.ijbToByteIndex(0, 0, targetByte);
            mem.setByteWithoutUndo(byteIdx, 0xAA);

            // SEI (0x78, 2 cycles) sets I flag
            // LDA #$BB (0xA9 0xBB, 2 cycles)
            // STA $A0 (0x85 0xA0, 3 cycles)  — total 7 cycles, well under nextCycles=20
            // Then NOPs until timer fires
            const code = [0x78, 0xA9, 0xBB, 0x85, targetByte];
            for (let i = 0; i < code.length; i++) {
                mem.setByteWithoutUndo(mem.ijbToByteIndex(0, 0, i), code[i]);
            }
            for (let i = code.length; i < 30; i++) {
                mem.setByteWithoutUndo(mem.ijbToByteIndex(0, 0, i), 0xEA);
            }

            ctrl.sfotty.PC = 0;
            ctrl.sfotty.setP(0);
            ctrl.sfotty.S = 0xFF;
            mem.resetUndoHistory();

            ctrl.runToNextInterrupt();

            // I was set when timer fired, so writes are reverted
            expect(mem.getByte(byteIdx)).toBe(0xAA);
        });

        it('when I is clear, writes persist (commitWrites behavior)', () => {
            const ctrl = new BoardController();
            const mem = ctrl.memory;
            mem.orientation = 0;
            mem.iOrig = 0;
            mem.jOrig = 0;

            const targetByte = 0xA0;
            const byteIdx = mem.ijbToByteIndex(0, 0, targetByte);
            mem.setByteWithoutUndo(byteIdx, 0xAA);
            mem.resetUndoHistory();

            // Simulate what happens during execution: write through the memory API
            mem.write(targetByte, 0xBB);
            expect(mem.getByte(byteIdx)).toBe(0xBB);

            // Verify undo history was recorded
            expect(Object.keys(mem.undoHistory).length).toBeGreaterThan(0);

            // commitWrites preserves the data (unlike undoWrites which reverts)
            ctrl.commitWrites();
            expect(mem.getByte(byteIdx)).toBe(0xBB);
        });
    });

    describe('writeRegisters / readRegisters', () => {
        it('round-trips CPU state through memory', () => {
            const ctrl = new BoardController();
            const mem = ctrl.memory;
            mem.orientation = 0;
            mem.iOrig = 0;
            mem.jOrig = 0;

            ctrl.sfotty.PC = 0x1234;
            ctrl.sfotty.A = 0x42;
            ctrl.sfotty.X = 0x43;
            ctrl.sfotty.Y = 0x44;
            ctrl.sfotty.S = 0xFE;
            ctrl.sfotty.P = 0x30;

            mem.resetUndoHistory();
            ctrl.writeRegisters();

            ctrl.sfotty.PC = 0;
            ctrl.sfotty.A = 0;
            ctrl.sfotty.X = 0;
            ctrl.sfotty.Y = 0;
            ctrl.sfotty.S = 0;
            ctrl.sfotty.P = 0;

            ctrl.readRegisters();
            expect(ctrl.sfotty.PC).toBe(0x1234);
            expect(ctrl.sfotty.A).toBe(0x42);
            expect(ctrl.sfotty.X).toBe(0x43);
            expect(ctrl.sfotty.Y).toBe(0x44);
            expect(ctrl.sfotty.S).toBe(0xFE);
            expect(ctrl.sfotty.P).toBe(0x30);
        });
    });

    describe('swapCells / swapPages', () => {
        it('swapPages swaps 256-byte blocks', () => {
            const ctrl = new BoardController();
            const mem = ctrl.memory;
            mem.orientation = 0;
            mem.iOrig = 0;
            mem.jOrig = 0;
            mem.resetUndoHistory();

            for (let b = 0; b < 256; b++) {
                mem.write(b, 0xAA);
                mem.write(0x400 + b, 0xBB);
            }

            ctrl.swapPages(0, 4);

            expect(mem.read(0x0010)).toBe(0xBB);
            expect(mem.read(0x0410)).toBe(0xAA);
        });

        it('swapCells swaps all 4 pages of two cells', () => {
            const ctrl = new BoardController();
            const mem = ctrl.memory;
            mem.orientation = 0;
            mem.iOrig = 0;
            mem.jOrig = 0;
            mem.resetUndoHistory();

            mem.write(0x200, 0x11);
            mem.write(0x400 + 0x200, 0x22);

            ctrl.swapCells(0, 1);

            expect(mem.read(0x200)).toBe(0x22);
            expect(mem.read(0x400 + 0x200)).toBe(0x11);
        });
    });
});
