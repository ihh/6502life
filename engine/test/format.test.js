import { describe, it, expect } from 'vitest';
import { hexByte, hexWord, flagsString } from '../format.js';

describe('format', () => {
    describe('hexByte', () => {
        it('formats zero', () => {
            expect(hexByte(0)).toBe('00');
        });

        it('formats single digit', () => {
            expect(hexByte(0x0A)).toBe('0A');
        });

        it('formats two digits', () => {
            expect(hexByte(0xFF)).toBe('FF');
        });

        it('formats 0x42', () => {
            expect(hexByte(0x42)).toBe('42');
        });
    });

    describe('hexWord', () => {
        it('formats zero', () => {
            expect(hexWord(0)).toBe('0000');
        });

        it('formats small value', () => {
            expect(hexWord(0x00FF)).toBe('00FF');
        });

        it('formats full word', () => {
            expect(hexWord(0x1234)).toBe('1234');
        });

        it('formats max word', () => {
            expect(hexWord(0xFFFF)).toBe('FFFF');
        });
    });

    describe('flagsString', () => {
        it('formats all flags clear', () => {
            // NV-BDIZC, bit 5 is always '-'
            expect(flagsString(0x00)).toBe('--------');
        });

        it('formats all flags set', () => {
            expect(flagsString(0xFF)).toBe('NV-BDIZC');
        });

        it('formats N flag', () => {
            expect(flagsString(0x80)).toBe('N-------');
        });

        it('formats Z flag', () => {
            expect(flagsString(0x02)).toBe('------Z-');
        });

        it('formats C flag', () => {
            expect(flagsString(0x01)).toBe('-------C');
        });

        it('formats I flag', () => {
            expect(flagsString(0x04)).toBe('-----I--');
        });

        it('formats typical P value (0x30)', () => {
            // 0x30 = 0b00110000 = bit5 (unused, always -) + B
            expect(flagsString(0x30)).toBe('---B----');
        });

        it('formats NV flags (0xC0)', () => {
            expect(flagsString(0xC0)).toBe('NV------');
        });
    });
});
