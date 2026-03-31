import { describe, it, expect } from 'vitest';
import { transducerToDFA, buildPipeline, sampleCandidates } from '../pipeline.js';
import { buildCopyTransducer, PASS, FAIL } from '../transducer.js';
import { effectiveBits, totalAccepting } from '../forward.js';
import { prepareSampler, sampleSequence } from '../sampler.js';
import { PRNG } from '../../webgpu/prng.js';

// Canonical 8-byte replicator
const REP = [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8];

describe('transducerToDFA', () => {
    it('converts a simple transducer to DFA', () => {
        const t = buildCopyTransducer({
            states: ['s0', 's1'], accept: 's1',
            rules: [
                { from: 's0', to: 's1', match: '*', verdict: FAIL },
                { from: 's0', to: 's1', match: 0xAA, verdict: PASS },
            ],
        });
        const dfa = transducerToDFA(t, { acceptStates: [1] });
        expect(dfa.accepts([0xAA])).toBe(true);
        expect(dfa.accepts([0xBB])).toBe(false); // FAIL → dead
    });

    it('FAIL transitions are dead in the DFA', () => {
        const t = buildCopyTransducer({
            states: ['s0', 's1', 's2'], accept: 's2',
            rules: [
                { from: 's0', to: 's1', match: '*', verdict: FAIL },
                { from: 's0', to: 's1', match: 0xAA, verdict: PASS },
                { from: 's1', to: 's2', match: '*' },
            ],
        });
        const dfa = transducerToDFA(t, { acceptStates: [2] });
        // AA then anything → accepted
        expect(dfa.accepts([0xAA, 0x00])).toBe(true);
        // BB (FAIL) → dead, no recovery
        expect(dfa.accepts([0xBB, 0x00])).toBe(false);
    });
});

describe('buildPipeline', () => {
    const { dfa } = buildPipeline();

    it('produces a DFA with opcode×offset states', () => {
        expect(dfa.numStates).toBe(13 * 50); // 650
    });

    it('canonical replicator is accepted at length 8', () => {
        expect(dfa.accepts(REP)).toBe(true);
    });

    it('wrong offset is rejected', () => {
        const bad = [...REP];
        bad[7] = 0x00;
        expect(dfa.accepts(bad)).toBe(false);
    });

    it('wrong page is rejected', () => {
        const bad = [...REP];
        bad[4] = 0x05;
        expect(dfa.accepts(bad)).toBe(false);
    });
});

describe('Forward on pipeline DFA', () => {
    const { dfa } = buildPipeline();

    it('B_eff at length 8 is in expected range', () => {
        const beff = effectiveBits(dfa, 8);
        // Core constraints: ~8 + 8 + 8 + 7 + ~5 + 8 = ~44 bits
        // (LDA=8, STA=8, page=8, INX=7, branch≈5, offset=8, free=0+0)
        expect(beff).toBeGreaterThan(30);
        expect(beff).toBeLessThan(55);
    });

    it('accepted count at length 8 > 0', () => {
        const count = totalAccepting(dfa, 8);
        expect(count).toBeGreaterThan(0n);
    });

    it('B_eff at length 7 is Infinity (too short)', () => {
        // Can't fit the full pattern in 7 bytes
        const count = totalAccepting(dfa, 7);
        // Might be 0 (too short) or small
        // The opcode reviewer has slide states, so some 7-byte paths might work
        // But they won't reach seen-offset (accept), so should be 0
        expect(count).toBe(0n);
    });

    it('B_eff decreases with longer sequences (NOP slides)', () => {
        const beff8 = effectiveBits(dfa, 8);
        const beff9 = effectiveBits(dfa, 9);
        // Longer sequences allow NOP slides → more valid sequences
        expect(beff9).toBeLessThan(beff8);
    });
});

describe('sampleCandidates', () => {
    const { dfa } = buildPipeline();
    const rng = new PRNG(123);

    it('samples valid candidates at length 8', () => {
        const { samples, attempts } = sampleCandidates(dfa, 8, 10, rng);
        expect(samples.length).toBe(10);
        // Each sample should pass opcode+offset checks
        for (const seq of samples) {
            expect(dfa.accepts([...seq])).toBe(true);
            // And addr-match (byte 1 = byte 3)
            expect(seq[1]).toBe(seq[3]);
        }
    });

    it('samples without addr-match filter', () => {
        const rng2 = new PRNG(456);
        const { samples, attempts } = sampleCandidates(dfa, 8, 100, rng2, {
            requireAddrMatch: false,
        });
        expect(samples.length).toBe(100);
        // Some may have byte 1 ≠ byte 3
        const mismatches = samples.filter(s => s[1] !== s[3]).length;
        // Most should mismatch (255/256 chance each)
        expect(mismatches).toBeGreaterThan(80);
    });

    it('rejection rate for addr-match is ~255/256', () => {
        const rng3 = new PRNG(789);
        const { samples, attempts, rejectRate } = sampleCandidates(dfa, 8, 50, rng3);
        expect(samples.length).toBe(50);
        // ~99.6% rejection rate
        expect(rejectRate).toBeGreaterThan(0.95);
    });

    it('all samples have correct structure', () => {
        const rng4 = new PRNG(101);
        const { samples } = sampleCandidates(dfa, 8, 20, rng4);
        for (const seq of samples) {
            expect(seq[0]).toBe(0xB5); // LDA zp,X
            expect(seq[2]).toBe(0x9D); // STA abs,X
            expect(seq[1]).toBe(seq[3]); // addr match
            expect(seq[4]).toBe(0x04); // page
            expect([0xE8, 0xCA]).toContain(seq[5]); // INX/DEX
            // Branch opcode
            expect([0x90, 0xB0, 0xD0, 0x10, 0x30, 0x50, 0x70, 0x00]).toContain(seq[6]);
        }
    });
});
