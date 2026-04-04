import { describe, it, expect } from 'vitest';
import { blake3Cell, blake3Board, buildSoupLookup, applyBias, generateBiasedCell } from '../blake3.js';

describe('blake3Cell', () => {
    it('produces deterministic output', () => {
        const a = blake3Cell(42, 0);
        const b = blake3Cell(42, 0);
        expect(a).toEqual(b);
    });

    it('produces 32 bytes by default', () => {
        const out = blake3Cell(1, 0);
        expect(out.length).toBe(32);
    });

    it('produces requested number of bytes', () => {
        const out = blake3Cell(1, 0, 64);
        expect(out.length).toBe(64);
    });

    it('different seeds produce different output', () => {
        const a = blake3Cell(1, 0);
        const b = blake3Cell(2, 0);
        expect(a).not.toEqual(b);
    });

    it('different cell indices produce different output', () => {
        const a = blake3Cell(1, 0);
        const b = blake3Cell(1, 1);
        expect(a).not.toEqual(b);
    });
});

describe('blake3Board', () => {
    it('produces correct total bytes', () => {
        const board = blake3Board(42, 4);
        expect(board.length).toBe(4 * 4 * 1024);
    });

    it('produces correct total bytes for size 8', () => {
        const board = blake3Board(42, 8);
        expect(board.length).toBe(8 * 8 * 1024);
    });

    it('is deterministic', () => {
        const a = blake3Board(42, 2);
        const b = blake3Board(42, 2);
        expect(a).toEqual(b);
    });
});

describe('buildSoupLookup', () => {
    it('produces 65536-entry table', () => {
        const lut = buildSoupLookup();
        expect(lut.length).toBe(65536);
        expect(lut).toBeInstanceOf(Uint8Array);
    });

    it('is deterministic', () => {
        const a = buildSoupLookup();
        const b = buildSoupLookup();
        expect(a).toEqual(b);
    });

    it('contains biased opcodes', () => {
        const lut = buildSoupLookup();
        // 0x00 has weight 400 — should appear many times in the table
        let count00 = 0;
        for (let i = 0; i < 65536; i++) {
            if (lut[i] === 0x00) count00++;
        }
        // With weight 400 out of ~3000+ total, should be >5% of entries
        expect(count00).toBeGreaterThan(3000);
    });
});

describe('applyBias', () => {
    it('transforms bytes using lookup table', () => {
        const lut = buildSoupLookup();
        const raw = new Uint8Array([0, 128, 255]);
        const biased = applyBias(raw, lut);
        expect(biased.length).toBe(3);
        // byte 0 maps to idx 0*257=0, byte 255 maps to idx min(255*257,65535)=65535
        expect(biased[0]).toBe(lut[0]);
        expect(biased[2]).toBe(lut[65535]);
    });

    it('is deterministic', () => {
        const lut = buildSoupLookup();
        const raw = new Uint8Array([10, 20, 30, 40, 50]);
        const a = applyBias(raw, lut);
        const b = applyBias(raw, lut);
        expect(a).toEqual(b);
    });
});

describe('generateBiasedCell', () => {
    it('produces 32 bytes', () => {
        const lut = buildSoupLookup();
        const cell = generateBiasedCell(42, 0, lut);
        expect(cell.length).toBe(32);
    });

    it('is deterministic', () => {
        const lut = buildSoupLookup();
        const a = generateBiasedCell(42, 7, lut);
        const b = generateBiasedCell(42, 7, lut);
        expect(a).toEqual(b);
    });

    it('matches mined_organisms.json: seed 417314, cell (28,6) on 64x64 board', () => {
        // From mined_organisms.json: preset tt-x-dex-bcc-417314
        // seed=417314, cell=[28,6], program starts with B5 00 9D 00 04 CA 90 F8
        // cell_index = 28*64 + 6 = 1798
        const seed = 417314;
        const cellIndex = 28 * 64 + 6;
        const lut = buildSoupLookup();
        const cell = generateBiasedCell(seed, cellIndex, lut);
        const expected = [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xCA, 0x90, 0xF8];
        const actual = Array.from(cell.subarray(0, 8));
        expect(actual).toEqual(expected);
    });
});
