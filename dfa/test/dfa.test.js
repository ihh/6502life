import { describe, it, expect } from 'vitest';
import { DFA, buildDFA } from '../dfa.js';
import { PRNG } from '../../webgpu/prng.js';

// --- Phase 1: Gold-standard matcher tests ---

describe('DFA basics', () => {
    it('rejects on empty DFA (all transitions -1)', () => {
        const dfa = buildDFA(1, 0, [0], []); // no rules = all transitions -1
        // Empty input: start in state 0 (accepting) → accept
        expect(dfa.accepts([])).toBe(true);
        // Any byte: transitions to -1 → reject
        expect(dfa.accepts([0])).toBe(false);
        expect(dfa.accepts([0xFF])).toBe(false);
    });

    it('accept-all DFA', () => {
        const dfa = buildDFA(1, 0, [0], [{ from: 0, to: 0, on: '*' }]);
        expect(dfa.accepts([])).toBe(true);
        expect(dfa.accepts([0])).toBe(true);
        expect(dfa.accepts([1, 2, 3])).toBe(true);
        expect(dfa.accepts(new Uint8Array(1000))).toBe(true);
    });

    it('reject-all DFA (no accept states)', () => {
        const dfa = buildDFA(1, 0, [], [{ from: 0, to: 0, on: '*' }]);
        expect(dfa.accepts([])).toBe(false);
        expect(dfa.accepts([0])).toBe(false);
    });

    it('accept single specific byte', () => {
        // State 0 --$B5--> State 1 (accept)
        const dfa = buildDFA(2, 0, [1], [{ from: 0, to: 1, on: 0xB5 }]);
        expect(dfa.accepts([0xB5])).toBe(true);
        expect(dfa.accepts([0xB4])).toBe(false);
        expect(dfa.accepts([0xB5, 0x00])).toBe(false); // too long (state 1 has no transitions)
        expect(dfa.accepts([])).toBe(false); // too short
    });

    it('step returns correct states', () => {
        const dfa = buildDFA(3, 0, [2], [
            { from: 0, to: 1, on: 0xAA },
            { from: 1, to: 2, on: 0xBB },
        ]);
        expect(dfa.step(0, 0xAA)).toBe(1);
        expect(dfa.step(0, 0xAB)).toBe(-1);
        expect(dfa.step(1, 0xBB)).toBe(2);
        expect(dfa.step(2, 0x00)).toBe(-1);
        expect(dfa.step(-1, 0x00)).toBe(-1);
    });

    it('run returns final state', () => {
        const dfa = buildDFA(3, 0, [2], [
            { from: 0, to: 1, on: 0xAA },
            { from: 1, to: 2, on: 0xBB },
        ]);
        expect(dfa.run([0xAA, 0xBB])).toBe(2);
        expect(dfa.run([0xAA])).toBe(1);
        expect(dfa.run([])).toBe(0);
        expect(dfa.run([0xFF])).toBe(-1);
        expect(dfa.run([0xAA, 0xFF])).toBe(-1);
    });

    it('throws on unknown state in rule', () => {
        const dfa = new DFA();
        dfa.addState('s0');
        dfa.addRule({ from: 's0', to: 'NONEXISTENT', match: 0x00 });
        expect(() => dfa.compile()).toThrow();
    });
});

describe('DFA: toy replicator pattern', () => {
    // Recognizes: B5 XX 9D (any XX, exactly 3 bytes)
    function makeToyDFA() {
        return buildDFA(4, 0, [3], [
            { from: 0, to: 1, on: 0xB5 },         // byte 0 = B5
            { from: 1, to: 2, on: '*' },           // byte 1 = anything
            { from: 2, to: 3, on: 0x9D },          // byte 2 = 9D
        ]);
    }

    it('accepts B5 XX 9D for various XX', () => {
        const dfa = makeToyDFA();
        for (let xx = 0; xx < 256; xx++) {
            expect(dfa.accepts([0xB5, xx, 0x9D])).toBe(true);
        }
    });

    it('rejects wrong first byte', () => {
        const dfa = makeToyDFA();
        expect(dfa.accepts([0xB4, 0x00, 0x9D])).toBe(false);
        expect(dfa.accepts([0x00, 0x00, 0x9D])).toBe(false);
    });

    it('rejects wrong third byte', () => {
        const dfa = makeToyDFA();
        expect(dfa.accepts([0xB5, 0x00, 0x9C])).toBe(false);
        expect(dfa.accepts([0xB5, 0x00, 0x00])).toBe(false);
    });

    it('rejects wrong length', () => {
        const dfa = makeToyDFA();
        expect(dfa.accepts([0xB5, 0x00])).toBe(false);
        expect(dfa.accepts([0xB5, 0x00, 0x9D, 0x00])).toBe(false);
        expect(dfa.accepts([])).toBe(false);
    });
});

describe('DFA with self-loops (NOP slides)', () => {
    // Recognizes: (NOP)* B5 XX 9D where NOP = $EA, length 3+
    function makeSlidesDFA() {
        return buildDFA(4, 0, [3], [
            { from: 0, to: 0, on: 0xEA },         // NOP slide
            { from: 0, to: 1, on: 0xB5 },         // LDA
            { from: 1, to: 2, on: '*' },           // any addr
            { from: 2, to: 3, on: 0x9D },          // STA
        ]);
    }

    it('accepts without NOPs', () => {
        const dfa = makeSlidesDFA();
        expect(dfa.accepts([0xB5, 0x00, 0x9D])).toBe(true);
    });

    it('accepts with leading NOPs', () => {
        const dfa = makeSlidesDFA();
        expect(dfa.accepts([0xEA, 0xB5, 0x00, 0x9D])).toBe(true);
        expect(dfa.accepts([0xEA, 0xEA, 0xEA, 0xB5, 0xFF, 0x9D])).toBe(true);
    });

    it('rejects NOP-only', () => {
        const dfa = makeSlidesDFA();
        expect(dfa.accepts([0xEA, 0xEA, 0xEA])).toBe(false);
    });

    it('rejects NOP after B5', () => {
        const dfa = makeSlidesDFA();
        // B5 EA 9D — EA is consumed as the XX byte, 9D is accepted
        expect(dfa.accepts([0xB5, 0xEA, 0x9D])).toBe(true);
        // But B5 00 EA 9D — 4 bytes, EA at position 2 goes to -1 (not 9D)
        expect(dfa.accepts([0xB5, 0x00, 0xEA, 0x9D])).toBe(false);
    });
});

// --- Phase 2: Fuzz testing ---

describe('DFA fuzz testing', () => {
    // A more interesting DFA: recognizes byte sequences matching
    // (CLC|SEC|NOP)* B5 XX 9D XX 04 (INX|DEX)
    // where the two XX bytes can be anything (independently).
    // This is 6+ bytes, with a NOP slide at the start.
    function makeFuzzDFA() {
        const SLIDE = [0x18, 0x38, 0xEA]; // CLC, SEC, NOP
        return buildDFA(7, 0, [6], [
            // State 0: slide or B5
            { from: 0, to: 0, on: SLIDE },
            { from: 0, to: 1, on: 0xB5 },
            // State 1: any byte (addr1)
            { from: 1, to: 2, on: '*' },
            // State 2: 9D
            { from: 2, to: 3, on: 0x9D },
            // State 3: any byte (addr2)
            { from: 3, to: 4, on: '*' },
            // State 4: 04
            { from: 4, to: 5, on: 0x04 },
            // State 5: INX or DEX
            { from: 5, to: 6, on: [0xE8, 0xCA] },
        ]);
    }

    it('accepts known valid sequences', () => {
        const dfa = makeFuzzDFA();
        expect(dfa.accepts([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8])).toBe(true);
        expect(dfa.accepts([0xB5, 0xFF, 0x9D, 0xAA, 0x04, 0xCA])).toBe(true);
        expect(dfa.accepts([0xEA, 0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8])).toBe(true);
        expect(dfa.accepts([0x18, 0x38, 0xEA, 0xB5, 0x42, 0x9D, 0x42, 0x04, 0xCA])).toBe(true);
    });

    it('rejects known invalid sequences', () => {
        const dfa = makeFuzzDFA();
        expect(dfa.accepts([0xB5, 0x00, 0x9D, 0x00, 0x04])).toBe(false); // too short
        expect(dfa.accepts([0xB5, 0x00, 0x9D, 0x00, 0x05, 0xE8])).toBe(false); // wrong page
        expect(dfa.accepts([0xB4, 0x00, 0x9D, 0x00, 0x04, 0xE8])).toBe(false); // wrong opcode
        expect(dfa.accepts([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE9])).toBe(false); // wrong inc
    });

    it('fuzz: random sequences, acceptance rate consistent with structure', () => {
        const dfa = makeFuzzDFA();
        const rng = new PRNG(12345);
        const trials = 100000;
        let accepted = 0;
        const acceptedByLen = {};

        for (let t = 0; t < trials; t++) {
            const len = 6 + (rng.below(11)); // lengths 6-16
            const bytes = [];
            for (let i = 0; i < len; i++) bytes.push(rng.below(256));
            if (dfa.accepts(bytes)) {
                accepted++;
                acceptedByLen[len] = (acceptedByLen[len] || 0) + 1;
            }
        }

        // For length 6 (no slide): P = (1/256) * 1 * (1/256) * 1 * (1/256) * (2/256)
        //   = 2 / 256^4 ≈ 4.66e-10. Very low — expect ~0 in 100K trials.
        // For length 7 (1 slide byte): slide has 3/256 prob, then 6 core bytes.
        //   P = (3/256) * (2/256^4) ≈ 5.45e-12. Even lower.
        // Total acceptance rate should be extremely low.
        // With 100K trials, we expect 0-1 acceptances.
        expect(accepted).toBeLessThan(5);
    });

    it('fuzz: verify all accepted sequences pass structural checks', () => {
        const dfa = makeFuzzDFA();
        const rng = new PRNG(99999);

        // Generate sequences that we KNOW are accepted (by construction)
        // then verify accepts() agrees.
        for (let t = 0; t < 1000; t++) {
            const nSlide = rng.below(4); // 0-3 slide bytes
            const bytes = [];
            for (let i = 0; i < nSlide; i++) {
                bytes.push([0x18, 0x38, 0xEA][rng.below(3)]);
            }
            bytes.push(0xB5);
            bytes.push(rng.below(256)); // addr1
            bytes.push(0x9D);
            bytes.push(rng.below(256)); // addr2
            bytes.push(0x04);
            bytes.push(rng.below(2) === 0 ? 0xE8 : 0xCA);

            expect(dfa.accepts(bytes)).toBe(true);
        }
    });

    it('fuzz: truncated accepted sequences reach expected intermediate states', () => {
        const dfa = makeFuzzDFA();

        // A known accepted sequence
        const seq = [0xEA, 0xB5, 0x42, 0x9D, 0x42, 0x04, 0xE8];
        expect(dfa.accepts(seq)).toBe(true);

        // Truncation checks
        expect(dfa.run(seq.slice(0, 0))).toBe(0); // start
        expect(dfa.run(seq.slice(0, 1))).toBe(0); // after NOP: still in slide
        expect(dfa.run(seq.slice(0, 2))).toBe(1); // after B5: state 1
        expect(dfa.run(seq.slice(0, 3))).toBe(2); // after addr1: state 2
        expect(dfa.run(seq.slice(0, 4))).toBe(3); // after 9D: state 3
        expect(dfa.run(seq.slice(0, 5))).toBe(4); // after addr2: state 4
        expect(dfa.run(seq.slice(0, 6))).toBe(5); // after 04: state 5
        expect(dfa.run(seq.slice(0, 7))).toBe(6); // after INX: state 6 (accept)
    });
});

describe('DFA trace (path annotation)', () => {
    it('trace returns full path with rule metadata', () => {
        const dfa = new DFA();
        dfa.addState('init');
        dfa.addState('slide', { meta: { type: 'nop-slide' } });
        dfa.addState('seen-lda');
        dfa.addState('accept', { accept: true });
        dfa.addRules([
            { from: 'init', to: 'init', match: 0xEA, tag: 'nop', label: 'NOP slide' },
            { from: 'init', to: 'seen-lda', match: 0xB5, tag: 'core', label: 'LDA zp,X' },
            { from: 'seen-lda', to: 'accept', match: '*', tag: 'operand', label: 'address byte' },
        ]);
        dfa.compile();

        const result = dfa.trace([0xEA, 0xEA, 0xB5, 0x42]);
        expect(result.accepted).toBe(true);
        expect(result.path.length).toBe(5); // init + 4 steps
        expect(result.path[1].rule.tag).toBe('nop');
        expect(result.path[3].rule.tag).toBe('core');
        expect(result.path[3].rule.label).toBe('LDA zp,X');
        expect(result.path[4].rule.tag).toBe('operand');
        expect(result.path[4].byte).toBe(0x42);
    });

    it('trace reports failure point', () => {
        const dfa = buildDFA(2, 0, [1], [{ from: 0, to: 1, on: 0xAA }]);
        const result = dfa.trace([0xBB]);
        expect(result.accepted).toBe(false);
        expect(result.failedAt).toBe(0);
        expect(result.failedByte).toBe(0xBB);
        expect(result.failedState).toBe('s0');
    });
});

describe('buildDFA rule override', () => {
    it('later rules override earlier ones', () => {
        // All bytes go to state 1, except $FF goes to state 2
        const dfa = buildDFA(3, 0, [2], [
            { from: 0, to: 1, on: '*' },
            { from: 0, to: 2, on: 0xFF },
        ]);
        expect(dfa.step(0, 0x00)).toBe(1);
        expect(dfa.step(0, 0xFE)).toBe(1);
        expect(dfa.step(0, 0xFF)).toBe(2);
    });
});
