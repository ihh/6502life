import { describe, it, expect } from 'vitest';
import { PASS, FAIL } from '../transducer.js';
import { buildOpcodeReviewer } from '../reviewers/opcode.js';
import { buildOffsetReviewer } from '../reviewers/offset.js';
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

describe('Offset reviewer', () => {
    it('correct offset for 8-byte replicator', () => {
        const r = buildOffsetReviewer();
        // REP is 8 bytes. Branch at byte 6, offset at byte 7.
        // Target = 0. PC at branch = 6, so offset = -(6+2) = -8 = $F8.
        // At position 7: correct offset = (255-7) & 0xFF = 248 = $F8.
        const result = r.run(REP);
        // Verdict at position 7 should be PASS (byte $F8 at pos 7)
        const v7 = result.verdicts.find(v => v.position === 7);
        expect(v7).toBeDefined();
        expect(v7.verdict).toBe(PASS);
    });

    it('wrong offset fails', () => {
        const r = buildOffsetReviewer();
        const bad = [...REP];
        bad[7] = 0xF7; // wrong offset
        const result = r.run(bad);
        const v7 = result.verdicts.find(v => v.position === 7);
        expect(v7.verdict).toBe(FAIL);
    });

    it('correct offset for 9-byte sequence (1 NOP)', () => {
        const r = buildOffsetReviewer();
        // EA B5 00 9D 00 04 E8 90 F7
        // Branch at byte 7, offset at byte 8.
        // Correct offset at pos 8: (255-8) & 0xFF = 247 = $F7.
        const seq = [0xEA, 0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF7];
        const result = r.run(seq);
        const v8 = result.verdicts.find(v => v.position === 8);
        expect(v8.verdict).toBe(PASS);
    });

    it('emits a verdict at every position', () => {
        const r = buildOffsetReviewer();
        const result = r.run(REP);
        // Should have 8 verdicts (one per byte)
        expect(result.verdicts.length).toBe(8);
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
