import { describe, it, expect } from 'vitest';
import { createBoard, zeroAllCells, readCellMemory, writeCellBytes, zeroCellMemory } from '../../engine/board.js';
import { assemble } from '../../engine/assembler.js';
import { getPreset, listPresets } from '../lib/terminal/presets.js';

describe('inject (cell patching)', () => {
    it('writes assembly into a cell', async () => {
        const { controller } = createBoard(4, 42);
        zeroAllCells(controller);

        const source = 'NOP\nNOP\nNOP';
        const bytes = await assemble(source);
        writeCellBytes(controller, 1, 2, 0, bytes);

        const mem = readCellMemory(controller, 1, 2);
        expect(mem[0]).toBe(0xEA); // NOP
        expect(mem[1]).toBe(0xEA);
        expect(mem[2]).toBe(0xEA);
    });

    it('loads a preset into a cell', async () => {
        const { controller } = createBoard(4, 42);
        zeroAllCells(controller);

        const preset = getPreset('counter');
        expect(preset).not.toBeNull();

        const bytes = await assemble(preset.source);
        writeCellBytes(controller, 0, 0, 0, bytes);

        const mem = readCellMemory(controller, 0, 0);
        // Counter starts with TXA (0x8A)
        expect(mem[0]).toBe(0x8A);
    });

    it('pokes individual bytes', () => {
        const { controller } = createBoard(4, 42);
        zeroAllCells(controller);

        writeCellBytes(controller, 2, 2, 0xF0, new Uint8Array([0x40]));
        const mem = readCellMemory(controller, 2, 2);
        expect(mem[0xF0]).toBe(0x40);
    });

    it('zeros a cell', () => {
        const { controller } = createBoard(4, 42);
        // Write some data first
        writeCellBytes(controller, 1, 1, 0, new Uint8Array(64).fill(0xAA));
        zeroCellMemory(controller, 1, 1);
        const mem = readCellMemory(controller, 1, 1);
        expect(mem[0]).toBe(0);
        expect(mem[63]).toBe(0);
    });

    it('handles multiple cells independently', async () => {
        const { controller } = createBoard(4, 42);
        zeroAllCells(controller);

        writeCellBytes(controller, 0, 0, 0, new Uint8Array([0xAA]));
        writeCellBytes(controller, 1, 1, 0, new Uint8Array([0xBB]));

        const mem1 = readCellMemory(controller, 0, 0);
        const mem2 = readCellMemory(controller, 1, 1);
        expect(mem1[0]).toBe(0xAA);
        expect(mem2[0]).toBe(0xBB);
    });

    it('lists all available presets', () => {
        const presets = listPresets();
        expect(presets.length).toBeGreaterThan(5);
        expect(presets.find(p => p.key === 'copier')).toBeDefined();
        expect(presets.find(p => p.key === 'spreader')).toBeDefined();
    });

    it('assembles all presets without errors', async () => {
        const presets = listPresets();
        for (const p of presets) {
            const preset = getPreset(p.key);
            const bytes = await assemble(preset.source);
            expect(bytes.length).toBeGreaterThan(0);
        }
    });
});
