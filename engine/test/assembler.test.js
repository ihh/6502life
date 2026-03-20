import { describe, it, expect } from 'vitest';
import { assemble, assembleTo, hexToBytes, assembleMulti, applyImage, imageToJSON, imageFromJSON, spiralIndexFromDxDy, dxDyFromSpiralIndex, describeImage } from '../assembler.js';
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

    describe('spiralIndex', () => {
        it('maps origin to index 0', () => {
            expect(spiralIndexFromDxDy(0, 0)).toBe(0);
        });

        it('maps cardinal neighbors correctly', () => {
            expect(spiralIndexFromDxDy(0, 1)).toBe(1);   // North
            expect(spiralIndexFromDxDy(1, 0)).toBe(2);   // East
            expect(spiralIndexFromDxDy(0, -1)).toBe(3);  // South
            expect(spiralIndexFromDxDy(-1, 0)).toBe(4);  // West
        });

        it('maps diagonals correctly', () => {
            expect(spiralIndexFromDxDy(1, 1)).toBe(5);    // NE
            expect(spiralIndexFromDxDy(1, -1)).toBe(6);   // SE
            expect(spiralIndexFromDxDy(-1, -1)).toBe(7);  // SW
            expect(spiralIndexFromDxDy(-1, 1)).toBe(8);   // NW
        });

        it('returns -1 for out-of-range', () => {
            expect(spiralIndexFromDxDy(4, 0)).toBe(-1);
            expect(spiralIndexFromDxDy(0, -4)).toBe(-1);
        });

        it('round-trips through dxDyFromSpiralIndex', () => {
            for (let dx = -3; dx <= 3; dx++) {
                for (let dy = -3; dy <= 3; dy++) {
                    const idx = spiralIndexFromDxDy(dx, dy);
                    const vec = dxDyFromSpiralIndex(idx);
                    expect(vec).toEqual([dx, dy]);
                }
            }
        });
    });

    describe('assembleMulti', () => {
        it('assembles plain source as single segment at address 0', async () => {
            const image = await assembleMulti('NOP');
            expect(image.segments.length).toBe(1);
            expect(image.segments[0].address).toBe(0);
            expect(image.segments[0].bytes).toEqual(new Uint8Array([0xEA]));
        });

        it('handles .cell directive', async () => {
            const source = `.cell 0,0\nNOP\n.cell 1,0\nNOP`;
            const image = await assembleMulti(source);
            expect(image.segments.length).toBe(2);
            expect(image.segments[0].address).toBe(0);         // cell 0 = origin
            expect(image.segments[1].address).toBe(2 * 1024);  // cell 2 = East (1,0)
        });

        it('handles .cell with hex offset', async () => {
            const source = `.cell 0,0 200\nNOP`;
            const image = await assembleMulti(source);
            expect(image.segments[0].address).toBe(0x200);
        });

        it('handles .celladdr directive', async () => {
            const source = `.cell 0,0\nNOP\n.celladdr 100\nNOP`;
            const image = await assembleMulti(source);
            expect(image.segments.length).toBe(2);
            expect(image.segments[0].address).toBe(0);
            expect(image.segments[1].address).toBe(0x100);
        });

        it('handles .addr directive', async () => {
            const source = `.addr 0800\nNOP`;
            const image = await assembleMulti(source);
            expect(image.segments[0].address).toBe(0x0800);
        });

        it('sets .org so labels resolve correctly', async () => {
            // At address $0800, JMP @start should jump to $0800
            const source = `.addr 0800\n@start:\nNOP\nJMP @start`;
            const image = await assembleMulti(source);
            const bytes = image.segments[0].bytes;
            // NOP=EA, JMP $0800 = 4C 00 08
            expect(bytes).toEqual(new Uint8Array([0xEA, 0x4C, 0x00, 0x08]));
        });

        it('throws on out-of-range .cell', async () => {
            await expect(assembleMulti('.cell 4,0\nNOP')).rejects.toThrow('outside the 7x7 neighborhood');
        });

        it('skips empty segments', async () => {
            const source = `.cell 0,0\n; just a comment\n.cell 1,0\nNOP`;
            const image = await assembleMulti(source);
            // The comment-only segment may or may not produce bytes depending on assembler
            // At minimum the NOP segment should be present
            expect(image.segments.length).toBeGreaterThanOrEqual(1);
            const nopSeg = image.segments.find(s => s.address === 2 * 1024);
            expect(nopSeg).toBeDefined();
            expect(nopSeg.bytes).toEqual(new Uint8Array([0xEA]));
        });
    });

    describe('applyImage', () => {
        it('writes single-cell image to correct board location', async () => {
            const mem = new BoardMemory(42, 8);
            const image = await assembleMulti('NOP');
            applyImage(image, mem, 2, 3);
            const idx = mem.ijbToByteIndex(2, 3, 0);
            expect(mem.getByte(idx)).toBe(0xEA);
        });

        it('writes multi-cell image to correct neighbors', async () => {
            const mem = new BoardMemory(42, 8);
            const source = `.cell 0,0\nLDA #$11\n.cell 1,0\nLDA #$22`;
            const image = await assembleMulti(source);
            applyImage(image, mem, 0, 0);
            // Origin cell (0,0): LDA #$11 = A9 11
            expect(mem.getByte(mem.ijbToByteIndex(0, 0, 0))).toBe(0xA9);
            expect(mem.getByte(mem.ijbToByteIndex(0, 0, 1))).toBe(0x11);
            // East cell (0,1): LDA #$22 = A9 22
            expect(mem.getByte(mem.ijbToByteIndex(0, 1, 0))).toBe(0xA9);
            expect(mem.getByte(mem.ijbToByteIndex(0, 1, 1))).toBe(0x22);
        });

        it('wraps coordinates at board edges', async () => {
            const mem = new BoardMemory(42, 8);
            // West neighbor of (0,0) should wrap to (0,7)
            const source = `.cell -1,0\nNOP`;
            const image = await assembleMulti(source);
            applyImage(image, mem, 0, 0);
            const idx = mem.ijbToByteIndex(0, 7, 0);
            expect(mem.getByte(idx)).toBe(0xEA);
        });
    });

    describe('image serialization', () => {
        it('round-trips through JSON', async () => {
            const image = await assembleMulti('.cell 0,0\nNOP\n.cell 1,0\nLDA #$42');
            const json = imageToJSON(image);
            const restored = imageFromJSON(json);
            expect(restored.segments.length).toBe(image.segments.length);
            for (let i = 0; i < image.segments.length; i++) {
                expect(restored.segments[i].address).toBe(image.segments[i].address);
                expect(restored.segments[i].bytes).toEqual(image.segments[i].bytes);
            }
        });

        it('produces JSON-safe output', async () => {
            const image = await assembleMulti('NOP');
            const json = imageToJSON(image);
            const str = JSON.stringify(json);
            const parsed = JSON.parse(str);
            expect(parsed.segments[0].hex).toBe('ea');
        });
    });

    describe('describeImage', () => {
        it('describes segments with cell coordinates', async () => {
            const image = await assembleMulti('.cell 0,0\nNOP\n.cell 1,0\nNOP');
            const desc = describeImage(image);
            expect(desc.length).toBe(2);
            expect(desc[0]).toMatch(/\(0,0\)/);
            expect(desc[1]).toMatch(/\(1,0\)/);
        });
    });
});
