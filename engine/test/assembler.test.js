import { describe, it, expect } from 'vitest';
import { assemble, assembleTo, hexToBytes } from '../assembler.js';
import { BoardMemory } from '../../board/memory.js';

describe('assembler', () => {
    describe('hexToBytes', () => {
        it('converts hex string to bytes', () => {
            expect(hexToBytes('ea')).toEqual(new Uint8Array([0xEA]));
        });

        it('converts multi-byte hex', () => {
            expect(hexToBytes('a942')).toEqual(new Uint8Array([0xA9, 0x42]));
        });
    });

    describe('assemble', () => {
        it('assembles NOP', async () => {
            const bytes = await assemble('NOP');
            expect(bytes).toEqual(new Uint8Array([0xEA]));
        });

        it('assembles LDA #$42', async () => {
            const bytes = await assemble('LDA #$42');
            expect(bytes).toEqual(new Uint8Array([0xA9, 0x42]));
        });

        it('assembles .byte directive', async () => {
            const bytes = await assemble('.byte $42');
            expect(bytes).toEqual(new Uint8Array([0x42]));
        });

        it('assembles local labels with colon', async () => {
            const source = `@loop:\n  NOP\n  JMP @loop`;
            const bytes = await assemble(source);
            // NOP = EA, JMP $0000 = 4C 00 00
            expect(bytes).toEqual(new Uint8Array([0xEA, 0x4C, 0x00, 0x00]));
        });

        it('assembles BNE with label reference', async () => {
            const source = `@loop:\n  DEX\n  BNE @loop`;
            const bytes = await assemble(source);
            // DEX = CA, BNE -2 (back to offset 0) = D0 FC
            expect(bytes).toEqual(new Uint8Array([0xCA, 0xD0, 0xFD]));
        });

        it('throws on syntax errors', async () => {
            await expect(assemble('INVALID')).rejects.toThrow();
        });
    });

    describe('assembleTo', () => {
        it('writes bytes at correct cell offset', async () => {
            const mem = new BoardMemory(42, 8);
            const len = await assembleTo('NOP', mem, 0, 0, 0);
            expect(len).toBe(1);
            const idx = mem.ijbToByteIndex(0, 0, 0);
            expect(mem.getByte(idx)).toBe(0xEA);
        });

        it('writes at specified start byte', async () => {
            const mem = new BoardMemory(42, 8);
            const len = await assembleTo('LDA #$42', mem, 1, 2, 0x200);
            expect(len).toBe(2);
            const base = mem.ijbToByteIndex(1, 2, 0x200);
            expect(mem.getByte(base)).toBe(0xA9);
            expect(mem.getByte(base + 1)).toBe(0x42);
        });
    });
});
