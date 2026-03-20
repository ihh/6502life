import { describe, it, expect } from 'vitest';
import { initDisassembler, disassembleRangeSync, disassembleAtSync, formatInstruction } from '../lib/terminal/disassembler.js';

describe('disassembler (standalone)', () => {
    // Ensure opcode table is loaded before tests
    it('initializes opcode table', async () => {
        await initDisassembler();
    });

    it('disassembles NOP', () => {
        const readFn = (addr) => [0xEA][addr] || 0;
        const instr = disassembleAtSync(readFn, 0);
        expect(instr.mnemonic).toBe('NOP');
        expect(instr.size).toBe(1);
        expect(instr.nextAddr).toBe(1);
    });

    it('disassembles LDA immediate', () => {
        const bytes = [0xA9, 0x42]; // LDA #$42
        const readFn = (addr) => bytes[addr] || 0;
        const instr = disassembleAtSync(readFn, 0);
        expect(instr.mnemonic).toBe('LDA');
        expect(instr.operand).toBe('#$42');
        expect(instr.size).toBe(2);
    });

    it('disassembles STA absolute', () => {
        const bytes = [0x8D, 0x10, 0x04]; // STA $0410
        const readFn = (addr) => bytes[addr] || 0;
        const instr = disassembleAtSync(readFn, 0);
        expect(instr.mnemonic).toBe('STA');
        expect(instr.operand).toBe('$0410');
        expect(instr.size).toBe(3);
    });

    it('disassembles a range of instructions', () => {
        // LDA #$01; STA $10; NOP
        const bytes = [0xA9, 0x01, 0x85, 0x10, 0xEA];
        const readFn = (addr) => bytes[addr] || 0;
        const instrs = disassembleRangeSync(readFn, 0, 3);
        expect(instrs.length).toBe(3);
        expect(instrs[0].mnemonic).toBe('LDA');
        expect(instrs[1].mnemonic).toBe('STA');
        expect(instrs[2].mnemonic).toBe('NOP');
    });

    it('handles illegal opcodes gracefully', () => {
        const bytes = [0x02]; // illegal
        const readFn = (addr) => bytes[addr] || 0;
        const instr = disassembleAtSync(readFn, 0);
        expect(instr.mnemonic).toBe('???');
        expect(instr.size).toBe(1);
    });

    it('formats instructions correctly', () => {
        const bytes = [0xA9, 0x42]; // LDA #$42
        const readFn = (addr) => bytes[addr] || 0;
        const instr = disassembleAtSync(readFn, 0);
        const formatted = formatInstruction(instr);
        expect(formatted).toContain('LDA');
        expect(formatted).toContain('#$42');
        expect(formatted).toContain('$0000');
    });

    it('disassembles branch instructions with relative addressing', () => {
        // BNE -3 (branch back 3 bytes from PC+2)
        const bytes = [0xD0, 0xFD]; // BNE $FFFF (wraps to $FFFF at addr 0)
        const readFn = (addr) => bytes[addr] || 0;
        const instr = disassembleAtSync(readFn, 0);
        expect(instr.mnemonic).toBe('BNE');
        expect(instr.size).toBe(2);
        // target = 0 + 2 + (-3) = -1 = $FFFF
        expect(instr.operand).toBe('$FFFF');
    });
});
