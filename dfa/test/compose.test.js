import { describe, it, expect } from 'vitest';
import {
    composePipeline, composeCopyTransducers,
    composeOpcodeOffset, andGate,
} from '../compose.js';
import { buildCopyTransducer, PASS, FAIL } from '../transducer.js';
import { buildOpcodeReviewer } from '../reviewers/opcode.js';
import { buildOffsetReviewer, correctOffsetAt } from '../reviewers/offset.js';
import { buildAddrMatchReviewer } from '../reviewers/addr-match.js';

// Canonical 8-byte replicator: LDA zp,X $00 / STA abs,X $00 $04 / INX / BCC $F8
const REP = [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8];

describe('composePipeline', () => {
    it('single transducer is identity', () => {
        const t = buildCopyTransducer({ states: ['s0'], rules: [] });
        expect(composePipeline(t)).toBe(t);
    });

    it('two echo transducers → echo', () => {
        const a = buildCopyTransducer({ states: ['s0'], rules: [] });
        const b = buildCopyTransducer({ states: ['s0'], rules: [] });
        const c = composePipeline(a, b);
        const result = c.run([0x42, 0xFF]);
        expect(result.accepted).toBe(true);
        expect(result.verdicts.length).toBe(0);
    });

    it('throws on empty', () => {
        expect(() => composePipeline()).toThrow('at least one');
    });

    it('three-way composition merges per-position verdicts', () => {
        const a = buildCopyTransducer({
            states: ['s0', 's1'], accept: 's1',
            rules: [
                { from: 's0', to: 's1', match: '*', verdict: FAIL, tag: 'A' },
                { from: 's0', to: 's1', match: 0xAA, verdict: PASS, tag: 'A' },
            ],
        });
        const b = buildCopyTransducer({
            states: ['s0', 's1', 's2'], accept: 's2',
            rules: [
                { from: 's0', to: 's1', match: '*' },
                { from: 's1', to: 's2', match: '*', verdict: FAIL, tag: 'B' },
                { from: 's1', to: 's2', match: 0xBB, verdict: PASS, tag: 'B' },
            ],
        });
        const c = buildCopyTransducer({
            states: ['s0', 's1'], accept: 's1',
            rules: [
                { from: 's0', to: 's1', match: '*', verdict: FAIL, tag: 'C' },
                { from: 's0', to: 's1', match: 0xAA, verdict: PASS, tag: 'C' },
            ],
        });

        const pipeline = composePipeline(a, b, c);
        const good = pipeline.run([0xAA, 0xBB]);
        expect(good.accepted).toBe(true);
        expect(good.passed).toBe(true);
        // A+C merged at byte 0, B at byte 1 → 2 verdict entries
        expect(good.verdicts.length).toBe(2);

        expect(composePipeline(a, b, c).run([0xAA, 0xCC]).passed).toBe(false);
    });

    it('N-way state count is product', () => {
        const a = buildCopyTransducer({
            states: ['a0', 'a1'], accept: 'a1',
            rules: [{ from: 'a0', to: 'a1', match: '*' }],
        });
        const b = buildCopyTransducer({
            states: ['b0', 'b1', 'b2'], accept: 'b2',
            rules: [
                { from: 'b0', to: 'b1', match: '*' },
                { from: 'b1', to: 'b2', match: '*' },
            ],
        });
        expect(composePipeline(a, b).numStates).toBe(6);
    });
});

describe('correctOffsetAt', () => {
    it('position 7 → 0xF8', () => {
        expect(correctOffsetAt(7)).toBe(0xF8);
    });

    it('position 8 → 0xF7', () => {
        expect(correctOffsetAt(8)).toBe(0xF7);
    });

    it('position 0 → 0xFF', () => {
        expect(correctOffsetAt(0)).toBe(0xFF);
    });

    it('position 255 → 0x00', () => {
        expect(correctOffsetAt(255)).toBe(0x00);
    });
});

describe('Offset reviewer: silent counter', () => {
    const offset = buildOffsetReviewer();

    it('emits no verdicts', () => {
        const result = offset.run(REP);
        const withVerdict = result.verdicts.filter(v => v.verdict !== null);
        expect(withVerdict.length).toBe(0);
    });

    it('advances state per byte', () => {
        const result = offset.run(REP);
        expect(result.path.length).toBe(8);
        expect(result.path[0].state).toBe('pos1');
        expect(result.path[7].state).toBe('pos8');
    });
});

describe('composeOpcodeOffset', () => {
    const opcode = buildOpcodeReviewer();
    const offset = buildOffsetReviewer();
    const composed = composeOpcodeOffset(opcode, offset);

    it('canonical replicator: passes all checks', () => {
        const result = composed.run(REP);
        expect(result.passed).toBe(true);
        const offsetVerdict = result.verdicts.find(v => v.tag.includes('offset'));
        expect(offsetVerdict).toBeDefined();
        expect(offsetVerdict.verdict).toBe(PASS);
    });

    it('wrong offset byte: FAIL at offset position', () => {
        const bad = [...REP];
        bad[7] = 0xF7;
        const result = composed.run(bad);
        expect(result.passed).toBe(false);
        const offsetFail = result.verdicts.find(v =>
            v.verdict === FAIL && v.tag.includes('offset'));
        expect(offsetFail).toBeDefined();
        expect(offsetFail.position).toBe(7);
    });

    it('wrong opcode: no core-lda PASS', () => {
        const bad = [0xB4, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8];
        const result = composed.run(bad);
        expect(result.verdicts.find(v => v.tag.includes('core-lda'))).toBeUndefined();
    });

    it('DEX variant with correct offset', () => {
        const dex = [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xCA, 0x90, 0xF8];
        expect(composed.run(dex).passed).toBe(true);
    });

    it('BNE variant with correct offset', () => {
        const bne = [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0xD0, 0xF8];
        expect(composed.run(bne).passed).toBe(true);
    });

    it('9-byte sequence with NOP prefix: correct offset', () => {
        // EA B5 00 9D 00 04 E8 90 F7
        // Offset at pos 8: (255-8) = 0xF7
        const seq = [0xEA, 0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF7];
        expect(composed.run(seq).passed).toBe(true);
    });

    it('9-byte sequence with wrong offset: fails', () => {
        // F8 is correct for 8-byte, not 9-byte
        const seq = [0xEA, 0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8];
        expect(composed.run(seq).passed).toBe(false);
    });

    it('offset FAIL only at the offset position, not elsewhere', () => {
        const result = composed.run(REP);
        // No FAIL verdicts at all for the canonical replicator
        const fails = result.verdicts.filter(v => v.verdict === FAIL);
        expect(fails.length).toBe(0);
    });

    it('state count is product of component counts', () => {
        expect(composed.numStates).toBe(opcode.numStates * offset.numStates);
    });
});

describe('Opcode + AddrMatch: standard composition', () => {
    const opcode = buildOpcodeReviewer();
    const addr = buildAddrMatchReviewer();
    const composed = composeCopyTransducers(opcode, addr);

    it('canonical replicator: passes', () => {
        expect(composed.run(REP).passed).toBe(true);
    });

    it('address mismatch: FAIL', () => {
        const bad = [0xB5, 0x42, 0x9D, 0x43, 0x04, 0xE8, 0x90, 0xF8];
        expect(composed.run(bad).passed).toBe(false);
    });

    it('non-zero matching address: passes', () => {
        const seq = [0xB5, 0x80, 0x9D, 0x80, 0x04, 0xE8, 0x90, 0xF8];
        expect(composed.run(seq).passed).toBe(true);
    });

    it('all 256 matching addresses pass', () => {
        for (let v = 0; v < 256; v++) {
            const seq = [0xB5, v, 0x9D, v, 0x04, 0xE8, 0x90, 0xF8];
            expect(composed.run(seq).passed).toBe(true);
        }
    });
});

describe('Verdict positions match individual reviewers', () => {
    const opcode = buildOpcodeReviewer();
    const offset = buildOffsetReviewer();
    const composed = composeOpcodeOffset(opcode, offset);

    it('all PASS tags from opcode reviewer present in composed', () => {
        const opcRes = opcode.run(REP);
        const compRes = composed.run(REP);

        for (const v of opcRes.verdicts) {
            if (v.verdict !== PASS) continue;
            const match = compRes.verdicts.find(cv =>
                cv.position === v.position && cv.tag.includes(v.tag));
            expect(match).toBeDefined();
            expect(match.verdict).toBe(PASS);
        }
    });

    it('offset PASS at position 7 in composed', () => {
        const result = composed.run(REP);
        const v7 = result.verdicts.find(v =>
            v.position === 7 && v.tag.includes('offset'));
        expect(v7).toBeDefined();
        expect(v7.verdict).toBe(PASS);
    });
});

describe('Relaxed addr-match composition', () => {
    const opcode = buildOpcodeReviewer();
    const addr = buildAddrMatchReviewer({ relaxed: true, mismatchWeight: 0.01 });
    const composed = composeCopyTransducers(opcode, addr);

    it('mismatched address has lower weight than matched', () => {
        const match = [0xB5, 0x42, 0x9D, 0x42, 0x04, 0xE8, 0x90, 0xF8];
        const mismatch = [0xB5, 0x42, 0x9D, 0x43, 0x04, 0xE8, 0x90, 0xF8];
        const wMatch = composed.run(match).weight;
        const wMismatch = composed.run(mismatch).weight;
        expect(wMismatch).toBeLessThan(wMatch);
        expect(wMismatch / wMatch).toBeCloseTo(0.01, 3);
    });
});
