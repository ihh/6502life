import { describe, it, expect } from 'vitest';
import { buildCopyTransducer, composeCopyTransducers, andGate,
         PASS, FAIL } from '../transducer.js';

describe('CopyTransducer basics', () => {
    it('echo transducer passes all bytes through', () => {
        const t = buildCopyTransducer({
            states: ['s0'],
            accept: 's0',
            rules: [], // passthrough = true by default
        });
        const result = t.run([0x00, 0xFF, 0x42]);
        expect(result.accepted).toBe(true);
        expect(result.verdicts.length).toBe(0);
        expect(result.passed).toBe(true);
        expect(result.weight).toBe(1);
    });

    it('emits PASS verdict at specific position', () => {
        const t = buildCopyTransducer({
            states: ['s0', 's1'],
            accept: 's1',
            rules: [
                { from: 's0', to: 's1', match: 0xB5, verdict: PASS,
                  tag: 'core', label: 'LDA zp,X found' },
            ],
        });
        const result = t.run([0xB5]);
        expect(result.accepted).toBe(true);
        expect(result.verdicts.length).toBe(1);
        expect(result.verdicts[0].verdict).toBe(PASS);
        expect(result.verdicts[0].tag).toBe('core');
        expect(result.passed).toBe(true);
    });

    it('emits FAIL verdict for wrong byte', () => {
        // Wildcard first (default), then B5 overrides
        const t = buildCopyTransducer({
            states: ['s0', 's1'],
            accept: 's1',
            rules: [
                { from: 's0', to: 's1', match: '*', verdict: FAIL },
                { from: 's0', to: 's1', match: 0xB5, verdict: PASS },
            ],
        });
        expect(t.run([0xB5]).passed).toBe(true);
        expect(t.run([0xB4]).passed).toBe(false);
    });

    it('priority: later rules override wildcard', () => {
        const t = buildCopyTransducer({
            states: ['s0', 's1'],
            accept: 's1',
            rules: [
                { from: 's0', to: 's1', match: '*', verdict: FAIL, label: 'wrong' },
                { from: 's0', to: 's1', match: 0xB5, verdict: PASS, label: 'correct' },
            ],
        });
        expect(t.run([0xB5]).passed).toBe(true);
        expect(t.run([0xB4]).passed).toBe(false);
        expect(t.run([0xB4]).verdicts[0].label).toBe('wrong');
        expect(t.run([0xB5]).verdicts[0].label).toBe('correct');
    });

    it('weighted verdict: FAIL with probability', () => {
        const t = buildCopyTransducer({
            states: ['s0', 's1'],
            accept: 's1',
            rules: [
                { from: 's0', to: 's1', match: '*', verdict: FAIL, weight: 0.05 },
                { from: 's0', to: 's1', match: 0xEA, verdict: PASS, weight: 0.95 },
            ],
            passthrough: false,
        });
        const safe = t.run([0xEA]);
        expect(safe.weight).toBe(0.95);
        expect(safe.passed).toBe(true);

        const risky = t.run([0x85]);
        expect(risky.weight).toBe(0.05);
        expect(risky.passed).toBe(false);
    });

    it('multi-state: checks two positions', () => {
        // Check byte 0 = B5, byte 1 = anything, byte 2 = 9D
        // Wildcards first, then specific bytes override
        const t = buildCopyTransducer({
            states: ['pos0', 'pos1', 'pos2', 'done'],
            accept: 'done',
            rules: [
                { from: 'pos0', to: 'pos1', match: '*', verdict: FAIL, tag: 'lda' },
                { from: 'pos0', to: 'pos1', match: 0xB5, verdict: PASS, tag: 'lda' },
                { from: 'pos1', to: 'pos2', match: '*' },
                { from: 'pos2', to: 'done', match: '*', verdict: FAIL, tag: 'sta' },
                { from: 'pos2', to: 'done', match: 0x9D, verdict: PASS, tag: 'sta' },
            ],
            passthrough: false,
        });

        const good = t.run([0xB5, 0x42, 0x9D]);
        expect(good.accepted).toBe(true);
        expect(good.passed).toBe(true);
        expect(good.verdicts.length).toBe(2);
        expect(good.verdicts.every(v => v.verdict === PASS)).toBe(true);

        const bad0 = t.run([0xB4, 0x42, 0x9D]);
        expect(bad0.verdicts[0].verdict).toBe(FAIL);
        expect(bad0.verdicts[0].tag).toBe('lda');

        const bad2 = t.run([0xB5, 0x42, 0x9C]);
        expect(bad2.verdicts[1].verdict).toBe(FAIL);
        expect(bad2.verdicts[1].tag).toBe('sta');
    });

    it('passes() convenience method', () => {
        const t = buildCopyTransducer({
            states: ['s0', 's1'],
            accept: 's1',
            rules: [
                { from: 's0', to: 's1', match: '*', verdict: FAIL },
                { from: 's0', to: 's1', match: 0xAA, verdict: PASS },
            ],
        });
        expect(t.passes([0xAA])).toBe(true);
        expect(t.passes([0xBB])).toBe(false);
    });
});

describe('CopyTransducer composition', () => {
    it('compose two echo transducers → echo', () => {
        const a = buildCopyTransducer({ states: ['s0'], rules: [] });
        const b = buildCopyTransducer({ states: ['s0'], rules: [] });
        const c = composeCopyTransducers(a, b);
        expect(c.run([0x00, 0xFF]).accepted).toBe(true);
        expect(c.run([0x00, 0xFF]).verdicts.length).toBe(0);
    });

    it('compose checker A with checker B: both verdicts appear', () => {
        // A checks byte 0 = B5
        const a = buildCopyTransducer({
            states: ['check', 'rest'],
            accept: 'rest',
            rules: [
                { from: 'check', to: 'rest', match: '*', verdict: FAIL, tag: 'A' },
                { from: 'check', to: 'rest', match: 0xB5, verdict: PASS, tag: 'A' },
            ],
        });
        // B checks byte 1 = 9D
        const b = buildCopyTransducer({
            states: ['skip', 'check', 'rest'],
            accept: 'rest',
            rules: [
                { from: 'skip', to: 'check', match: '*' },
                { from: 'check', to: 'rest', match: '*', verdict: FAIL, tag: 'B' },
                { from: 'check', to: 'rest', match: 0x9D, verdict: PASS, tag: 'B' },
            ],
        });

        const c = composeCopyTransducers(a, b);

        // Both pass
        const good = c.run([0xB5, 0x9D]);
        expect(good.verdicts.length).toBe(2);
        expect(good.passed).toBe(true);

        // A fails, B passes
        const badA = c.run([0xB4, 0x9D]);
        expect(badA.passed).toBe(false);
        expect(badA.verdicts.some(v => v.verdict === FAIL)).toBe(true);

        // A passes, B fails
        const badB = c.run([0xB5, 0x9C]);
        expect(badB.passed).toBe(false);

        // Both fail
        const both = c.run([0x00, 0x00]);
        expect(both.passed).toBe(false);
    });

    it('compose preserves weights', () => {
        const a = buildCopyTransducer({
            states: ['s0', 's1'],
            accept: 's1',
            rules: [{ from: 's0', to: 's1', match: '*', verdict: PASS, weight: 0.8 }],
        });
        const b = buildCopyTransducer({
            states: ['s0', 's1'],
            accept: 's1',
            rules: [{ from: 's0', to: 's1', match: '*', verdict: PASS, weight: 0.9 }],
        });
        const c = composeCopyTransducers(a, b);
        const result = c.run([0x42]);
        expect(result.weight).toBeCloseTo(0.72, 5); // 0.8 × 0.9
    });

    it('AND gate on composed result', () => {
        const a = buildCopyTransducer({
            states: ['s0', 's1'],
            accept: 's1',
            rules: [
                { from: 's0', to: 's1', match: '*', verdict: FAIL },
                { from: 's0', to: 's1', match: 0xAA, verdict: PASS },
            ],
        });
        const b = buildCopyTransducer({
            states: ['s0', 's1'],
            accept: 's1',
            rules: [
                { from: 's0', to: 's1', match: '*', verdict: PASS },
            ],
        });
        const c = composeCopyTransducers(a, b);

        expect(andGate(c.run([0xAA]))).toBe(true);
        expect(andGate(c.run([0xBB]))).toBe(false);
    });
});

describe('CopyTransducer: NOP slide with verdicts', () => {
    it('NOP slide before core opcode', () => {
        const NOPS = [0xEA, 0x18, 0x38]; // NOP, CLC, SEC
        const t = buildCopyTransducer({
            states: ['slide', 'done'],
            accept: 'done',
            rules: [
                // Wildcard first (default: FAIL)
                { from: 'slide', to: 'done', match: '*', verdict: FAIL, tag: 'bad' },
                // NOPs override: stay in slide, emit PASS
                { from: 'slide', to: 'slide', match: NOPS, verdict: PASS, tag: 'nop' },
                // Core opcode override: advance to done, emit PASS
                { from: 'slide', to: 'done', match: 0xB5, verdict: PASS, tag: 'core' },
            ],
            passthrough: false,
        });

        // NOP NOP B5 → all PASS
        const good = t.run([0xEA, 0x18, 0xB5]);
        expect(good.passed).toBe(true);
        expect(good.verdicts.length).toBe(3);
        expect(good.verdicts[0].tag).toBe('nop');
        expect(good.verdicts[2].tag).toBe('core');

        // NOP XX → NOP is PASS, XX is FAIL
        const bad = t.run([0xEA, 0x42]);
        expect(bad.passed).toBe(false);
        expect(bad.verdicts[0].verdict).toBe(PASS);
        expect(bad.verdicts[1].verdict).toBe(FAIL);
    });
});
