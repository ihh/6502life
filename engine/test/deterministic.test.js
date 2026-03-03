import { describe, it, expect } from 'vitest';
import { createBoard, zeroAllCells, readCellRegisters, readCellMemory, writeCellBytes } from '../board.js';
import { assemble, assembleTo } from '../assembler.js';

// IMPORTANT: The controller checks the opcode at PC on every cycle.
// During multi-cycle instructions, PC may temporarily point to operand bytes.
// If an operand byte is 0x00, the controller treats it as BRK.
// All test code must avoid 0x00 bytes in the instruction stream.
// This also means JMP to addresses $00xx won't work (high byte is 0x00).
// Use BNE (branch) instead of JMP for loops, and avoid LDA #$00.

describe('deterministic simulation', () => {
    it('counter: increments accumulator and stores to memory', async () => {
        const { controller } = createBoard(8, 42);
        zeroAllCells(controller);

        // TXA avoids the 0x00 operand that LDA #$00 would have.
        // BNE avoids the 0x00 high-byte that JMP $00xx would have.
        const source = [
            'TXA',           // A = X (0), 1 byte, no operand
            '@loop:',
            'CLC',           // clear carry
            'ADC #$01',      // A += 1
            'STA $10',       // store to ZP $10
            'BNE @loop',     // loop (A > 0 after ADC, so always branches)
        ].join('\n');

        await assembleTo(source, controller.memory, 0, 0, 0);

        const mem = controller.memory;
        mem.iOrig = 0;
        mem.jOrig = 0;
        mem.orientation = 0;
        mem.nextCycles = 10000;

        controller.sfotty.PC = 0;
        controller.sfotty.A = 0;
        controller.sfotty.X = 0;
        controller.sfotty.Y = 0;
        controller.sfotty.S = 0xFF;
        controller.sfotty.setP(0);
        mem.resetUndoHistory();

        controller.runToNextInterrupt();

        // Byte at $10 in cell (0,0) should have been incremented
        const idx = mem.ijbToByteIndex(0, 0, 0x10);
        expect(mem.getByte(idx)).toBeGreaterThan(0);
    });

    it('copier: copies data from cell (0,0) to neighbor', async () => {
        const { controller } = createBoard(8, 42);
        zeroAllCells(controller);

        const mem = controller.memory;

        // Write known pattern into cell (0,0) bytes $201-$2FF
        // (page 2, starting at byte 1 to avoid zero in address low byte)
        for (let x = 0; x < 255; x++) {
            const b = 0x201 + x;
            const idx = mem.ijbToByteIndex(0, 0, b);
            mem.setByteWithoutUndo(idx, (x + 0x42) & 0xFF);
        }

        // Copier: reads from $0201,X and writes to $0801,X
        // Cell 2 in spiral order = East neighbor at orientation 0 = physical cell (1,0)
        // $0201,X → cell 0 byte $201+X
        // $0801,X → cell 2 byte $01+X
        // All bytes in instruction stream are non-zero.
        const source = [
            '@loop:',
            'LDA $0201,X',   // BD 01 02 — no zeros
            'STA $0801,X',   // 9D 01 08 — no zeros
            'INX',           // E8
            'BNE @loop',     // D0 F7
        ].join('\n');

        await assembleTo(source, mem, 0, 0, 0);

        // Set up known origin/orientation
        mem.iOrig = 0;
        mem.jOrig = 0;
        mem.orientation = 0;
        mem.nextCycles = 100000; // long enough for copier to finish

        controller.sfotty.PC = 0;
        controller.sfotty.A = 0;
        controller.sfotty.X = 0;
        controller.sfotty.Y = 0;
        controller.sfotty.S = 0xFF;
        controller.sfotty.setP(0);
        mem.resetUndoHistory();

        controller.runToNextInterrupt();

        // Cell 2 in spiral order at orientation 0 is [1,0] relative to origin
        // Physical cell: (iOrig+1, jOrig+0) = (1, 0)
        const destI = 1, destJ = 0;

        // Verify some of the copied data appeared at cell (1,0) bytes $01-$FF
        let matchCount = 0;
        for (let x = 0; x < 255; x++) {
            const destIdx = mem.ijbToByteIndex(destI, destJ, 0x01 + x);
            if (mem.getByte(destIdx) === ((x + 0x42) & 0xFF)) matchCount++;
        }
        expect(matchCount).toBeGreaterThan(0);
    });

    it('determinism: same seed produces identical results', async () => {
        // Assemble once, then create two identical boards
        const source = 'TXA\n@loop:\nCLC\nADC #$01\nSTA $10\nBNE @loop';
        const code = await assemble(source);

        function runScenario() {
            const { controller } = createBoard(8, 42);
            zeroAllCells(controller);
            writeCellBytes(controller, 0, 0, 0, code);

            // Sfotty constructor leaves registers uninitialized (non-deterministic).
            // Explicitly set CPU state and clear resetPending for reproducibility.
            controller.sfotty.PC = 0;
            controller.sfotty.A = 0;
            controller.sfotty.X = 0;
            controller.sfotty.Y = 0;
            controller.sfotty.S = 0xFF;
            controller.sfotty.setP(0);
            controller.sfotty.resetPending = false;
            controller.memory.resetUndoHistory();

            for (let i = 0; i < 10; i++) {
                controller.runToNextInterrupt();
            }

            return Array.from(controller.memory.storage);
        }

        const snap1 = runScenario();
        const snap2 = runScenario();

        expect(snap1).toEqual(snap2);
    });

    it('NOP sled: PC advances through NOPs', async () => {
        const { controller } = createBoard(8, 42);
        zeroAllCells(controller);

        const mem = controller.memory;

        // Fill cell (0,0) with NOPs
        for (let b = 0; b < 240; b++) {
            const idx = mem.ijbToByteIndex(0, 0, b);
            mem.setByteWithoutUndo(idx, 0xEA); // NOP
        }

        mem.iOrig = 0;
        mem.jOrig = 0;
        mem.orientation = 0;
        mem.nextCycles = 50;

        controller.sfotty.PC = 0;
        controller.sfotty.A = 0;
        controller.sfotty.X = 0;
        controller.sfotty.Y = 0;
        controller.sfotty.S = 0xFF;
        controller.sfotty.setP(0);
        mem.resetUndoHistory();

        controller.runToNextInterrupt();

        // After running, the saved PC should have advanced
        const regs = readCellRegisters(controller, 0, 0);
        expect(regs.PC).toBeGreaterThan(0);
    });
});
