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
            // 20 NOPs + BRK. Exact cycle count depends on Sfotty internals.
            expect(result.cpuCycles).toBeGreaterThan(20);
            expect(result.cpuCycles).toBeLessThan(100);
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

    describe('noiseParams', () => {
        it('uses default noise params', () => {
            const ctrl = new BoardController();
            expect(ctrl.noiseParams.pBitNoise).toBeCloseTo(1 / 2048);
        });

        it('accepts custom noise params', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0.5 });
            expect(ctrl.noiseParams.pBitNoise).toBe(0.5);
        });

        it('serializes and deserializes noise params', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0.1 });
            const saved = ctrl.state;
            const ctrl2 = new BoardController();
            ctrl2.state = saved;
            expect(ctrl2.noiseParams.pBitNoise).toBe(0.1);
        });
    });

    describe('pBrkFailure', () => {
        it('defaults to 0', () => {
            const ctrl = new BoardController();
            expect(ctrl.noiseParams.pBrkFailure).toBe(0);
        });

        it('pBrkFailure=1 prevents all BRK copies', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0, pBrkFailure: 1 });
            const mem = ctrl.memory;
            mem.orientation = 0;
            mem.iOrig = 0;
            mem.jOrig = 0;
            mem.nextCycles = 100000;

            // Write a known byte at origin cell byte 0x200
            const srcByteIdx = mem.ijbToByteIndex(0, 0, 0x200);
            mem.setByteWithoutUndo(srcByteIdx, 0x42);

            // Write BRK $F5 (copy to cell 1) at origin byte 0
            const byteIdx = mem.ijbToByteIndex(0, 0, 0);
            mem.setByteWithoutUndo(byteIdx, 0x00);     // BRK
            mem.setByteWithoutUndo(byteIdx + 1, 245);   // operand 245 = copy to cell 1

            ctrl.sfotty.PC = 0;
            ctrl.sfotty.setP(0);
            ctrl.sfotty.S = 0xFF;
            mem.resetUndoHistory();

            // Clear dest cell byte 0x200 to verify it stays 0
            const destByteIdx = mem.ijbToByteIndex(0, 1, 0x200);
            mem.setByteWithoutUndo(destByteIdx, 0x00);

            ctrl.runToNextInterrupt();

            // Copy should have failed — dest should still be 0
            expect(mem.getByte(destByteIdx)).toBe(0x00);
        });

        it('pBrkFailure=0 allows BRK copies normally', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0, pBrkFailure: 0 });
            const mem = ctrl.memory;
            mem.orientation = 0;
            mem.iOrig = 0;
            mem.jOrig = 0;
            mem.nextCycles = 100000;

            const srcByteIdx = mem.ijbToByteIndex(0, 0, 0x200);
            mem.setByteWithoutUndo(srcByteIdx, 0x42);

            const byteIdx = mem.ijbToByteIndex(0, 0, 0);
            mem.setByteWithoutUndo(byteIdx, 0x00);     // BRK
            mem.setByteWithoutUndo(byteIdx + 1, 245);   // copy to cell 1

            ctrl.sfotty.PC = 0;
            ctrl.sfotty.setP(0);
            ctrl.sfotty.S = 0xFF;
            mem.resetUndoHistory();

            ctrl.runToNextInterrupt();

            const destByteIdx = mem.ijbToByteIndex(0, 1, 0x200);
            expect(mem.getByte(destByteIdx)).toBe(0x42);
        });

        it('serializes and deserializes pBrkFailure', () => {
            const ctrl = new BoardController(undefined, { pBrkFailure: 0.25 });
            const saved = ctrl.state;
            const ctrl2 = new BoardController();
            ctrl2.state = saved;
            expect(ctrl2.noiseParams.pBrkFailure).toBe(0.25);
        });
    });

    describe('copyCellWithNoise', () => {
        it('copies origin to destination with zero noise', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0 });
            const mem = ctrl.memory;
            mem.orientation = 0;
            mem.iOrig = 0;
            mem.jOrig = 0;
            mem.resetUndoHistory();

            // Write known pattern to origin cell (cell 0)
            for (let b = 0; b < mem.M; b++) {
                mem.write(b, b & 0xFF);
            }

            // Cell 1 starts at address 0x400 in the memory map
            ctrl.copyCellWithNoise(1);

            // Verify destination matches source
            for (let b = 0; b < mem.M; b++) {
                expect(mem.read(0x400 + b)).toBe(b & 0xFF);
            }
        });

        it('pBitNoise=1 makes copy very noisy (differs from source)', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 1 });
            const mem = ctrl.memory;
            mem.orientation = 0;
            mem.iOrig = 0;
            mem.jOrig = 0;
            mem.resetUndoHistory();

            // Write all zeros to origin
            for (let b = 0; b < mem.M; b++) mem.write(b, 0x00);

            ctrl.copyCellWithNoise(1);

            // With pBitNoise=1, every bit is random — expect some non-zero bytes
            let nonZero = 0;
            for (let b = 0; b < mem.M; b++) {
                if (mem.read(0x400 + b) !== 0) nonZero++;
            }
            expect(nonZero).toBeGreaterThan(100);
        });

        it('BRK operand 245 triggers noisy copy to cell 1', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0 });
            const mem = ctrl.memory;
            mem.orientation = 0;
            mem.iOrig = 0;
            mem.jOrig = 0;
            mem.nextCycles = 100000;

            // Write a known byte at origin cell (0,0) byte 0x200
            const srcByteIdx = mem.ijbToByteIndex(0, 0, 0x200);
            mem.setByteWithoutUndo(srcByteIdx, 0x42);

            // Write BRK with operand 245 at origin byte 0
            const byteIdx = mem.ijbToByteIndex(0, 0, 0);
            mem.setByteWithoutUndo(byteIdx, 0x00);     // BRK
            mem.setByteWithoutUndo(byteIdx + 1, 245);   // operand 245 = copy to cell 1

            ctrl.sfotty.PC = 0;
            ctrl.sfotty.setP(0);
            ctrl.sfotty.S = 0xFF;
            mem.resetUndoHistory();

            ctrl.runToNextInterrupt();

            // Cell 1 = North = (0,+1) with orientation 0, origin (0,0)
            // Read from storage directly since memory map has been resampled
            const destByteIdx = mem.ijbToByteIndex(0, 1, 0x200);
            expect(mem.getByte(destByteIdx)).toBe(0x42);
        });

        it('BRK operand 253+ is reserved (no-op)', () => {
            const ctrl = new BoardController();
            const mem = ctrl.memory;
            mem.orientation = 0;
            mem.iOrig = 0;
            mem.jOrig = 0;
            mem.nextCycles = 100000;

            const byteIdx = mem.ijbToByteIndex(0, 0, 0);
            mem.setByteWithoutUndo(byteIdx, 0x00);     // BRK
            mem.setByteWithoutUndo(byteIdx + 1, 253);   // reserved

            ctrl.sfotty.PC = 0;
            ctrl.sfotty.setP(0);
            mem.resetUndoHistory();

            const result = ctrl.runToNextInterrupt();
            expect(result.cpuCycles).toBe(7);
        });
    });

    describe('B flag and fork detection', () => {
        it('sets B flag (bit 4 of P) after BRK', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0 });
            const mem = ctrl.memory;
            mem.iOrig = 0;
            mem.jOrig = 0;
            mem.orientation = 0;
            mem.nextCycles = 100000; // long timer so BRK fires first

            // Write BRK $00 (noop) at origin byte 0
            const srcBase = mem.neighborCellStorageBase(0);
            mem.storage[srcBase] = 0x00; // BRK
            mem.storage[srcBase + 1] = 0x00; // operand 0 (noop)

            // Clear P register (including B flag) before scheduling
            mem.storage[srcBase + 0xFB] = 0x00; // P = 0

            ctrl.readRegisters();
            ctrl.runToNextInterrupt();

            // After BRK, B flag should be set in the saved P at $FB
            const savedP = mem.storage[srcBase + 0xFB];
            expect(savedP & 0x10).toBe(0x10); // B flag set
        });

        it('clears B flag after timer interrupt', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0 });
            const mem = ctrl.memory;
            mem.iOrig = 0;
            mem.jOrig = 0;
            mem.orientation = 0;
            mem.resetUndoHistory();

            // Write a short NOP sled that will be interrupted by timer
            const srcBase = mem.neighborCellStorageBase(0);
            for (let i = 0; i < 16; i++) mem.storage[srcBase + i] = 0xEA; // NOPs
            // Set PC to 0
            mem.storage[srcBase + 0xF9] = 0x00;
            mem.storage[srcBase + 0xFA] = 0x00;
            // Set B flag in saved P before scheduling
            mem.storage[srcBase + 0xFB] = 0x10; // P = B set
            // Ensure I flag is clear so interrupt commits
            ctrl.sfotty.I = false;

            // Set short timer
            mem.nextCycles = 3;

            ctrl.readRegisters();
            ctrl.runToNextInterrupt();

            // After timer interrupt, B flag should be clear
            // Re-read from the same cell (sampleNextMove may have changed iOrig)
            const savedP = mem.storage[srcBase + 0xFB];
            expect(savedP & 0x10).toBe(0x00); // B flag clear
        });

        it('BRK copy child inherits B=clear, parent gets B=set', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0 });
            const mem = ctrl.memory;
            mem.iOrig = 0;
            mem.jOrig = 0;
            mem.orientation = 0;
            mem.nextCycles = 100000;

            // Program: clear B in $FB, then BRK $F5 (copy to cell 1)
            // LDA #$00 / STA $FB / BRK / .byte $F5
            const srcBase = mem.neighborCellStorageBase(0);
            mem.storage[srcBase + 0] = 0xA9; // LDA #$00
            mem.storage[srcBase + 1] = 0x00; // ... wait, $00 is BRK!

            // Use: LDA $FB / AND #$EF / STA $FB / BRK / .byte $F5
            mem.storage[srcBase + 0] = 0xA5; // LDA $FB
            mem.storage[srcBase + 1] = 0xFB;
            mem.storage[srcBase + 2] = 0x29; // AND #$EF (clear bit 4)
            mem.storage[srcBase + 3] = 0xEF;
            mem.storage[srcBase + 4] = 0x85; // STA $FB
            mem.storage[srcBase + 5] = 0xFB;
            mem.storage[srcBase + 6] = 0x00; // BRK
            mem.storage[srcBase + 7] = 0xF5; // operand: copy to cell 1

            // Set initial P with B set (from a previous BRK)
            mem.storage[srcBase + 0xFB] = 0x10;
            // Set PC to $0000
            mem.storage[srcBase + 0xF9] = 0x00;
            mem.storage[srcBase + 0xFA] = 0x00;

            mem.resetUndoHistory();
            ctrl.readRegisters();
            ctrl.runToNextInterrupt();

            // Parent: $FB should have B set (controller sets it after BRK)
            const parentP = mem.storage[srcBase + 0xFB];
            expect(parentP & 0x10).toBe(0x10);

            // Child (cell 1): $FB should have B clear (copied before B was set)
            const dstBase = mem.neighborCellStorageBase(1);
            const childP = mem.storage[dstBase + 0xFB];
            expect(childP & 0x10).toBe(0x00);
        });
    });

    describe('swapCells / swapPages', () => {
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

    describe('boardParams defaults', () => {
        it('has all 7 default params with correct values', () => {
            const ctrl = new BoardController();
            expect(ctrl.boardParams.pBitNoise).toBeCloseTo(1 / 2048);
            expect(ctrl.boardParams.pBrkFailure).toBe(0);
            expect(ctrl.boardParams.magnetosensing).toBe(false);
            expect(ctrl.boardParams.implementsMove).toBe(true);
            expect(ctrl.boardParams.implementsCopy).toBe(true);
            expect(ctrl.boardParams.implementsSync).toBe(false);
            expect(ctrl.boardParams.implementsAsync).toBe(false);
        });
    });

    describe('boardParams serialization', () => {
        it('save/restore preserves all params', () => {
            const ctrl = new BoardController(undefined, {
                pBitNoise: 0.123,
                pBrkFailure: 0.456,
                magnetosensing: true,
                implementsMove: false,
                implementsCopy: false,
                implementsSync: true,
                implementsAsync: true,
            });
            const saved = ctrl.state;
            const ctrl2 = new BoardController();
            ctrl2.state = saved;
            expect(ctrl2.boardParams.pBitNoise).toBeCloseTo(0.123);
            expect(ctrl2.boardParams.pBrkFailure).toBeCloseTo(0.456);
            expect(ctrl2.boardParams.magnetosensing).toBe(true);
            expect(ctrl2.boardParams.implementsMove).toBe(false);
            expect(ctrl2.boardParams.implementsCopy).toBe(false);
            expect(ctrl2.boardParams.implementsSync).toBe(true);
            expect(ctrl2.boardParams.implementsAsync).toBe(true);
        });
    });

    describe('magnetosensing', () => {
        it('$FA is 0 after scheduling when magnetosensing is disabled', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0, magnetosensing: false });
            const mem = ctrl.memory;
            mem.iOrig = 0; mem.jOrig = 0; mem.orientation = 0;
            mem.nextCycles = 100000;

            // Write BRK 0 to trigger an interrupt and scheduling
            const base = mem.neighborCellStorageBase(0);
            mem.storage[base] = 0x00;  // BRK
            mem.storage[base + 1] = 0x00;  // operand 0
            mem.resetUndoHistory();
            ctrl.sfotty.PC = 0;
            ctrl.sfotty.crashed = false;
            ctrl.sfotty.cycleCounter = 0;
            ctrl.sfotty.operations = [() => ctrl.sfotty.decode()];
            ctrl.runToNextInterrupt();

            // After scheduling, check $FA in the newly scheduled cell
            const newBase = mem.neighborCellStorageBase(0);
            expect(mem.storage[newBase + 0xFA]).toBe(0);
        });

        it('$FA contains orientation << 2 after scheduling when magnetosensing is enabled', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0, magnetosensing: true });
            const mem = ctrl.memory;
            mem.iOrig = 0; mem.jOrig = 0; mem.orientation = 0;
            mem.nextCycles = 100000;

            const base = mem.neighborCellStorageBase(0);
            mem.storage[base] = 0x00;  // BRK
            mem.storage[base + 1] = 0x00;  // operand 0
            mem.resetUndoHistory();
            ctrl.sfotty.PC = 0;
            ctrl.sfotty.crashed = false;
            ctrl.sfotty.cycleCounter = 0;
            ctrl.sfotty.operations = [() => ctrl.sfotty.decode()];
            ctrl.runToNextInterrupt();

            // After scheduling, $FA should be orientation << 2
            const newBase = mem.neighborCellStorageBase(0);
            const orientation = mem.orientation;
            expect(mem.storage[newBase + 0xFA]).toBe(orientation << 2);
        });
    });

    describe('implementsMove=false', () => {
        it('BRK swap operand (1-244) yields without swapping', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0, implementsMove: false });
            const mem = ctrl.memory;
            mem.iOrig = 0; mem.jOrig = 0; mem.orientation = 0;
            mem.nextCycles = 100000;

            // Write known data to cell 0 and cell 1
            const base0 = mem.neighborCellStorageBase(0);
            const base1 = mem.neighborCellStorageBase(1);
            mem.storage[base0 + 0x200] = 0xAA;
            mem.storage[base1 + 0x200] = 0xBB;

            // BRK with operand 1 (swap src=0, dest=1)
            mem.storage[base0] = 0x00;  // BRK
            mem.storage[base0 + 1] = 1;  // operand 1
            mem.resetUndoHistory();
            ctrl.sfotty.PC = 0;
            ctrl.sfotty.crashed = false;
            ctrl.sfotty.cycleCounter = 0;
            ctrl.sfotty.operations = [() => ctrl.sfotty.decode()];
            ctrl.runToNextInterrupt();

            // Cells should NOT have been swapped
            expect(mem.storage[base0 + 0x200]).toBe(0xAA);
            expect(mem.storage[base1 + 0x200]).toBe(0xBB);
        });
    });

    describe('implementsCopy=false', () => {
        it('BRK copy operand (245-252) yields without copying', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0, implementsCopy: false });
            const mem = ctrl.memory;
            mem.iOrig = 0; mem.jOrig = 0; mem.orientation = 0;
            mem.nextCycles = 100000;

            // Write known data to origin cell
            const base0 = mem.neighborCellStorageBase(0);
            mem.storage[base0 + 0x200] = 0x42;

            // Clear dest cell
            const base1 = mem.neighborCellStorageBase(1);
            mem.storage[base1 + 0x200] = 0x00;

            // BRK with operand 245 (copy to cell 1)
            mem.storage[base0] = 0x00;  // BRK
            mem.storage[base0 + 1] = 245;  // operand 245
            mem.resetUndoHistory();
            ctrl.sfotty.PC = 0;
            ctrl.sfotty.crashed = false;
            ctrl.sfotty.cycleCounter = 0;
            ctrl.sfotty.operations = [() => ctrl.sfotty.decode()];
            ctrl.runToNextInterrupt();

            // Copy should NOT have happened
            expect(mem.storage[base1 + 0x200]).toBe(0x00);
        });
    });

    describe('BRK 253 (sync interrupt request)', () => {
        it('sets nextRequestedInterrupt to next multiple of period when implementsSync=true', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0, implementsSync: true });
            const mem = ctrl.memory;
            mem.iOrig = 0; mem.jOrig = 0; mem.orientation = 0;
            mem.nextCycles = 100000;

            const base = mem.neighborCellStorageBase(0);
            mem.storage[base] = 0x00;  // BRK
            mem.storage[base + 1] = 253;  // sync
            // Period = 0x0100 = 256, set via X (low) and Y (high)
            ctrl.sfotty.X = 0x00;  // low byte
            ctrl.sfotty.Y = 0x01;  // high byte
            mem.resetUndoHistory();
            ctrl.sfotty.PC = 0;
            ctrl.sfotty.crashed = false;
            ctrl.sfotty.cycleCounter = 0;
            ctrl.sfotty.operations = [() => ctrl.sfotty.decode()];

            // totalCycles is 0 before running, BRK adds 7 cycles
            ctrl.runToNextInterrupt();

            // After BRK, totalCycles = 7. Period = 256.
            // nextTime = (floor(7/256) + 1) * 256 = 256
            const cellIdx = mem.ijToCellIndex(0, 0);
            expect(ctrl.nextRequestedInterrupt[cellIdx]).toBe(256);
        });

        it('just yields when implementsSync=false', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0, implementsSync: false });
            const mem = ctrl.memory;
            mem.iOrig = 0; mem.jOrig = 0; mem.orientation = 0;
            mem.nextCycles = 100000;

            const base = mem.neighborCellStorageBase(0);
            mem.storage[base] = 0x00;  // BRK
            mem.storage[base + 1] = 253;  // sync
            ctrl.sfotty.X = 0x00;
            ctrl.sfotty.Y = 0x01;
            mem.resetUndoHistory();
            ctrl.sfotty.PC = 0;
            ctrl.sfotty.crashed = false;
            ctrl.sfotty.cycleCounter = 0;
            ctrl.sfotty.operations = [() => ctrl.sfotty.decode()];
            ctrl.runToNextInterrupt();

            // No pending interrupt should be set
            const cellIdx = mem.ijToCellIndex(0, 0);
            expect(ctrl.nextRequestedInterrupt[cellIdx]).toBe(Infinity);
        });
    });

    describe('BRK 254 (async interrupt request)', () => {
        it('sets nextRequestedInterrupt to totalCycles + delay when implementsAsync=true', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0, implementsAsync: true });
            const mem = ctrl.memory;
            mem.iOrig = 0; mem.jOrig = 0; mem.orientation = 0;
            mem.nextCycles = 100000;

            const base = mem.neighborCellStorageBase(0);
            mem.storage[base] = 0x00;  // BRK
            mem.storage[base + 1] = 254;  // async
            // Delay = 0x0200 = 512
            ctrl.sfotty.X = 0x00;  // low byte
            ctrl.sfotty.Y = 0x02;  // high byte
            mem.resetUndoHistory();
            ctrl.sfotty.PC = 0;
            ctrl.sfotty.crashed = false;
            ctrl.sfotty.cycleCounter = 0;
            ctrl.sfotty.operations = [() => ctrl.sfotty.decode()];
            ctrl.runToNextInterrupt();

            // totalCycles after BRK = 7, delay = 512
            // nextRequestedInterrupt = 7 + 512 = 519
            const cellIdx = mem.ijToCellIndex(0, 0);
            expect(ctrl.nextRequestedInterrupt[cellIdx]).toBe(7 + 512);
        });
    });

    describe('pending interrupt scheduling', () => {
        it('cell with nextRequestedInterrupt <= totalCycles is selected by scheduler', () => {
            const ctrl = new BoardController(undefined, { pBitNoise: 0, implementsSync: true });
            const mem = ctrl.memory;
            mem.iOrig = 0; mem.jOrig = 0; mem.orientation = 0;

            // Set totalCycles high enough that a pending interrupt at time 100 is due
            ctrl.totalCycles = 200;
            const targetI = 2;
            const targetJ = 3;
            const cellIdx = mem.ijToCellIndex(targetI, targetJ);
            ctrl.nextRequestedInterrupt[cellIdx] = 100;  // already past due

            // Run a BRK 0 to trigger scheduling
            const base = mem.neighborCellStorageBase(0);
            mem.storage[base] = 0x00;  // BRK
            mem.storage[base + 1] = 0x00;  // operand 0
            mem.nextCycles = 100000;
            mem.resetUndoHistory();
            ctrl.sfotty.PC = 0;
            ctrl.sfotty.crashed = false;
            ctrl.sfotty.cycleCounter = 0;
            ctrl.sfotty.operations = [() => ctrl.sfotty.decode()];
            ctrl.runToNextInterrupt();

            // The scheduler should have selected the cell with the pending interrupt
            expect(mem.iOrig).toBe(targetI);
            expect(mem.jOrig).toBe(targetJ);
            // And cleared the pending interrupt
            expect(ctrl.nextRequestedInterrupt[cellIdx]).toBe(Infinity);
        });
    });

    describe('nextRequestedInterrupt serialization', () => {
        it('save/restore preserves pending interrupts', () => {
            const ctrl = new BoardController(undefined, { implementsSync: true });
            const mem = ctrl.memory;
            const cellIdx = mem.ijToCellIndex(1, 2);
            ctrl.nextRequestedInterrupt[cellIdx] = 12345;

            const saved = ctrl.state;
            const ctrl2 = new BoardController();
            ctrl2.state = saved;
            expect(ctrl2.nextRequestedInterrupt[cellIdx]).toBe(12345);
        });
    });
});
