import { describe, it, expect } from 'vitest';
import { PASS, FAIL } from '../transducer.js';
import { buildOpcodeReviewer } from '../reviewers/opcode.js';
import { buildOffsetReviewer, correctOffsetAt } from '../reviewers/offset.js';
import { buildAddrMatchReviewer } from '../reviewers/addr-match.js';

// The canonical simple replicator: B5 00 9D 00 04 E8 90 F8
const REP = [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8];

describe('Opcode reviewer', () => {
    it('accepts canonical replicator', () => {
        const r = buildOpcodeReviewer();
        const result = r.run(REP);
        // Should have PASS verdicts for LDA, STA, page, INC, branch
        const passes = result.verdicts.filter(v => v.verdict === PASS);
        expect(passes.length).toBeGreaterThanOrEqual(4);
        expect(passes.some(v => v.tag === 'core-lda')).toBe(true);
        expect(passes.some(v => v.tag === 'core-sta')).toBe(true);
        expect(passes.some(v => v.tag === 'page')).toBe(true);
        expect(passes.some(v => v.tag === 'core-inc')).toBe(true);
    });

    it('accepts DEX variant', () => {
        const r = buildOpcodeReviewer();
        const variant = [...REP];
        variant[5] = 0xCA; // DEX instead of INX
        const result = r.run(variant);
        const incPass = result.verdicts.find(v => v.tag === 'core-inc');
        expect(incPass.verdict).toBe(PASS);
    });

    it('fails on wrong LDA opcode', () => {
        const r = buildOpcodeReviewer();
        const bad = [0xB4, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8];
        const result = r.run(bad);
        // B4 is not recognized as LDA, so the pattern doesn't match
        // The reviewer should not emit a PASS for core-lda
        const ldaPass = result.verdicts.find(v => v.tag === 'core-lda');
        expect(ldaPass).toBeUndefined();
    });

    it('fails on wrong destination page', () => {
        const r = buildOpcodeReviewer();
        const bad = [0xB5, 0x00, 0x9D, 0x00, 0x05, 0xE8, 0x90, 0xF8];
        const result = r.run(bad);
        const pageFail = result.verdicts.find(v => v.tag === 'page');
        expect(pageFail.verdict).toBe(FAIL);
    });

    it('accepts BCC, BCS, BNE branch variants', () => {
        const r = buildOpcodeReviewer();
        for (const branch of [0x90, 0xB0, 0xD0]) {
            const variant = [...REP];
            variant[6] = branch;
            const result = r.run(variant);
            const branchPass = result.verdicts.find(v =>
                v.tag === 'branch' || v.tag === 'brk-loop');
            expect(branchPass).toBeDefined();
            expect(branchPass.verdict).toBe(PASS);
        }
    });

    it('accepts BRK loop variant', () => {
        const r = buildOpcodeReviewer();
        const brk = [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x00, 0x00];
        const result = r.run(brk);
        const brkPass = result.verdicts.find(v => v.tag === 'brk-loop');
        expect(brkPass).toBeDefined();
        expect(brkPass.verdict).toBe(PASS);
    });
});

describe('Offset reviewer (silent counter)', () => {
    it('tracks position without emitting verdicts', () => {
        const r = buildOffsetReviewer();
        const result = r.run(REP);
        // Silent counter: no verdicts emitted
        expect(result.verdicts.length).toBe(0);
        // But state advances per byte
        expect(result.path[7].state).toBe('pos8');
    });

    it('correctOffsetAt matches known values', () => {
        // 8-byte rep: offset at pos 7 → (255-7) = 0xF8
        expect(correctOffsetAt(7)).toBe(0xF8);
        // 9-byte rep: offset at pos 8 → (255-8) = 0xF7
        expect(correctOffsetAt(8)).toBe(0xF7);
        // Edge: pos 0 → 0xFF
        expect(correctOffsetAt(0)).toBe(0xFF);
    });

    it('advances through all positions', () => {
        const r = buildOffsetReviewer();
        const result = r.run(REP);
        expect(result.path.length).toBe(8);
        for (let i = 0; i < 8; i++) {
            expect(result.path[i].state).toBe(`pos${i + 1}`);
        }
    });

    it('handles sequences up to MAX_LEN', () => {
        const r = buildOffsetReviewer();
        const long = new Array(48).fill(0xEA);
        const result = r.run(long);
        expect(result.path[47].state).toBe('pos48');
    });
});

describe('Address match reviewer', () => {
    it('passes when byte 1 = byte 3', () => {
        const r = buildAddrMatchReviewer();
        // Need 8 bytes: the reviewer reads pos 0-7
        // Byte 0 is consumed at pos0, byte 1 remembered,
        // byte 2 passed through, byte 3 checked
        const seq = [0xB5, 0x42, 0x9D, 0x42, 0x04, 0xE8, 0x90, 0xF8];
        const result = r.run(seq);
        const match = result.verdicts.find(v => v.tag === 'addr-match');
        expect(match).toBeDefined();
        expect(match.verdict).toBe(PASS);
    });

    it('fails when byte 1 ≠ byte 3', () => {
        const r = buildAddrMatchReviewer();
        const seq = [0xB5, 0x42, 0x9D, 0x43, 0x04, 0xE8, 0x90, 0xF8];
        const result = r.run(seq);
        const mismatch = result.verdicts.find(v => v.tag === 'addr-mismatch');
        expect(mismatch).toBeDefined();
        expect(mismatch.verdict).toBe(FAIL);
    });

    it('works for all 256 matching values', () => {
        const r = buildAddrMatchReviewer();
        for (let v = 0; v < 256; v++) {
            const seq = [0xB5, v, 0x9D, v, 0x04, 0xE8, 0x90, 0xF8];
            const result = r.run(seq);
            const pass = result.verdicts.find(vd => vd.tag === 'addr-match');
            expect(pass).toBeDefined();
            expect(pass.verdict).toBe(PASS);
        }
    });

    it('relaxed mode: mismatch has low weight', () => {
        const r = buildAddrMatchReviewer({ relaxed: true, mismatchWeight: 0.01 });
        const seq = [0xB5, 0x42, 0x9D, 0x43, 0x04, 0xE8, 0x90, 0xF8];
        const result = r.run(seq);
        expect(result.weight).toBeCloseTo(0.01, 5);
    });
});
