import { describe, it, expect } from 'vitest';
import {
    parseGrammar,
    analyzeGrammarFromRules,
    compile,
    compileToAssembly,
    compileUniversal,
    TYPE_TAG_OFFSET,
    STATE_OFFSET,
    STATE_LEN_OFFSET,
    REL_DIR_INDEX,
    ABS_DIR_INDEX,
    cellTypeAddr,
    cellStateAddr,
    cellStateLenAddr,
    resolveDirection,
} from '../sokoscript.js';

// ---- Parser tests ----

describe('parseGrammar', () => {
    it('parses a minimal diffusion rule', () => {
        const rules = parseGrammar('x _ : _ x.');
        expect(rules).toHaveLength(1);
        expect(rules[0].type).toBe('transform');
        expect(rules[0].lhs).toHaveLength(2);
        expect(rules[0].lhs[0].type).toBe('x');
        expect(rules[0].lhs[1].type).toBe('_');
        expect(rules[0].rhs).toHaveLength(2);
    });

    it('parses multiple rules', () => {
        const rules = parseGrammar('x _ : _ x.\ny _ : _ y.');
        expect(rules).toHaveLength(2);
    });

    it('parses rules with relative directions', () => {
        const rules = parseGrammar('a >F> b : b a.');
        expect(rules).toHaveLength(1);
        expect(rules[0].lhs[1].addr).toEqual({ op: 'reldir', dir: 'F' });
    });

    it('parses rules with absolute directions', () => {
        const rules = parseGrammar('a >N> b : b a.');
        expect(rules).toHaveLength(1);
        expect(rules[0].lhs[1].addr).toEqual({ op: 'absdir', dir: 'N' });
    });

    it('parses rules with rate attribute', () => {
        const rules = parseGrammar('a b : b a, rate=2.');
        expect(rules).toHaveLength(1);
        expect(rules[0].rate).toBeDefined();
    });

    it('parses rules with state', () => {
        const rules = parseGrammar('a/x b : a/y b.');
        expect(rules).toHaveLength(1);
        expect(rules[0].lhs[0].state).toHaveLength(1);
        expect(rules[0].lhs[0].state[0].op).toBe('char');
        expect(rules[0].lhs[0].state[0].char).toBe('x');
    });

    it('parses inheritance declarations', () => {
        const rules = parseGrammar('child = parent.');
        expect(rules).toHaveLength(1);
        expect(rules[0].type).toBe('inherit');
        expect(rules[0].child).toBe('child');
        expect(rules[0].parents).toEqual(['parent']);
    });

    it('parses an ecosystem grammar', () => {
        const grammar = `
soil : plant, rate=0.05.
plant soil : plant plant, rate=0.02.
herbivore plant : herbivore herbivore, rate=2.
herbivore soil : soil herbivore, rate=0.5.
herbivore : soil, rate=0.02.
predator herbivore : predator predator, rate=3.
predator soil : soil predator, rate=1.
predator : soil, rate=0.05.
`;
        const rules = parseGrammar(grammar);
        expect(rules).toHaveLength(8);
    });

    it('parses wildcard neighbor', () => {
        const rules = parseGrammar('a * : a _.');
        expect(rules).toHaveLength(1);
        expect(rules[0].lhs[1].op).toBe('any');
    });

    it('parses negated type', () => {
        const rules = parseGrammar('a ^b : a _.');
        expect(rules).toHaveLength(1);
        expect(rules[0].lhs[1].op).toBe('negterm');
    });

    it('parses group references on RHS', () => {
        const rules = parseGrammar('a b : $2 $1.');
        expect(rules).toHaveLength(1);
        expect(rules[0].rhs[0].op).toBe('group');
        expect(rules[0].rhs[0].group).toBe(2);
        expect(rules[0].rhs[1].op).toBe('group');
        expect(rules[0].rhs[1].group).toBe(1);
    });
});

// ---- Grammar analysis tests ----

describe('analyzeGrammar', () => {
    it('builds type index for simple grammar', () => {
        const rules = parseGrammar('x _ : _ x.');
        const index = analyzeGrammarFromRules(rules);
        expect(index.types).toContain('_');
        expect(index.types).toContain('x');
        expect(index.typeIndex['_']).toBe(0);
        expect(index.typeIndex['x']).toBeDefined();
    });

    it('organizes rules by subject type', () => {
        const rules = parseGrammar('x _ : _ x.\ny _ : _ y.');
        const index = analyzeGrammarFromRules(rules);
        expect(index.transform['x']).toHaveLength(1);
        expect(index.transform['y']).toHaveLength(1);
    });

    it('handles inheritance', () => {
        const grammar = `
child = parent.
parent _ : _ parent.
`;
        const rules = parseGrammar(grammar);
        const index = analyzeGrammarFromRules(rules);
        // child should inherit parent's rules
        expect(index.transform['child']).toBeDefined();
        expect(index.transform['child'].length).toBeGreaterThan(0);
    });
});

// ---- Address/direction tests ----

describe('address helpers', () => {
    it('computes self type address at 0xA5', () => {
        expect(cellTypeAddr(0)).toBe(0xA5);
    });

    it('computes neighbor type address in correct page', () => {
        // Neighbor idx 1 is at base 1024 = 0x400
        expect(cellTypeAddr(1)).toBe(0x400 + 0xA5);
    });

    it('computes state address', () => {
        expect(cellStateAddr(0, 1)).toBe(0xA8);
        expect(cellStateAddr(0, 2)).toBe(0xA9);
        expect(cellStateAddr(1, 1)).toBe(0x400 + 0xA8);
    });

    it('resolves relative directions', () => {
        expect(resolveDirection({ op: 'reldir', dir: 'F' })).toBe(1);
        expect(resolveDirection({ op: 'reldir', dir: 'R' })).toBe(2);
        expect(resolveDirection({ op: 'reldir', dir: 'B' })).toBe(3);
        expect(resolveDirection({ op: 'reldir', dir: 'L' })).toBe(4);
    });

    it('resolves absolute directions', () => {
        expect(resolveDirection({ op: 'absdir', dir: 'N' })).toBe(3);
        expect(resolveDirection({ op: 'absdir', dir: 'E' })).toBe(2);
        expect(resolveDirection({ op: 'absdir', dir: 'S' })).toBe(1);
        expect(resolveDirection({ op: 'absdir', dir: 'W' })).toBe(4);
    });

    it('defaults to forward when no address given', () => {
        expect(resolveDirection(null)).toBe(1);
        expect(resolveDirection(undefined)).toBe(1);
    });
});

// ---- Compiler output tests ----

describe('compile', () => {
    it('compiles diffusion grammar', () => {
        const result = compile('x _ : _ x.');
        expect(result.types).toContain('x');
        expect(result.typeIndex['x']).toBeDefined();
        expect(result.programs['x']).toBeDefined();
        expect(result.programs['x']).toContain('SokoScript compiled');
    });

    it('produces assembly with type tag checks', () => {
        const result = compile('x _ : _ x.');
        const asm = result.programs['x'];
        // Should check neighbor type = 0 (empty)
        expect(asm).toContain('CMP #$00');
    });

    it('produces assembly with type tag writes', () => {
        const result = compile('x _ : _ x.');
        const asm = result.programs['x'];
        // Should write type tags to self and forward neighbor
        const selfAddr = cellTypeAddr(0).toString(16).padStart(4, '0');
        const fwdAddr = cellTypeAddr(1).toString(16).padStart(4, '0');
        expect(asm).toContain(`STA $${selfAddr}`);
        expect(asm).toContain(`STA $${fwdAddr}`);
    });

    it('compiles multi-rule grammar', () => {
        const grammar = `
soil : plant, rate=0.05.
plant soil : plant plant, rate=0.02.
herbivore plant : herbivore herbivore, rate=2.
herbivore soil : soil herbivore, rate=0.5.
herbivore : soil, rate=0.02.
`;
        const result = compile(grammar);
        expect(result.programs['soil']).toBeDefined();
        expect(result.programs['plant']).toBeDefined();
        expect(result.programs['herbivore']).toBeDefined();
    });

    it('compiles rules with relative directions', () => {
        const result = compile('a >R> b : b a.');
        const asm = result.programs['a'];
        // >R> = right = spiral index 2
        const rightAddr = cellTypeAddr(2).toString(16).padStart(4, '0');
        expect(asm).toContain(`$${rightAddr}`);
    });

    it('compiles rules with absolute directions', () => {
        const result = compile('a >N> b : b a.');
        const asm = result.programs['a'];
        // >N> = north = spiral index 3
        const northAddr = cellTypeAddr(3).toString(16).padStart(4, '0');
        expect(asm).toContain(`$${northAddr}`);
    });

    it('compiles single-term rules (spontaneous transformation)', () => {
        const result = compile('soil : plant.');
        const asm = result.programs['soil'];
        // Should have a rule that transforms soil to plant with no neighbor check
        expect(asm).toBeDefined();
        const plantTag = result.typeIndex['plant'];
        expect(asm).toContain(`#$${plantTag.toString(16).padStart(2, '0')}`);
    });

    it('compiles rules with group references ($1, $2)', () => {
        const result = compile('a b : $2 $1.');
        const asm = result.programs['a'];
        expect(asm).toBeDefined();
        const selfAddr = cellTypeAddr(0).toString(16).padStart(4, '0');
        const fwdAddr = cellTypeAddr(1).toString(16).padStart(4, '0');
        expect(asm).toContain(`LDA $${fwdAddr}`);
        expect(asm).toContain(`STA $${selfAddr}`);
    });

    it('compiles rules with state', () => {
        const result = compile('a/x b : a/y b.');
        const asm = result.programs['a'];
        expect(asm).toBeDefined();
        // Check for state char 'x' (ASCII 120 = 0x78)
        expect(asm).toContain('#$78');
        // Write state char 'y' (ASCII 121 = 0x79)
        expect(asm).toContain('#$79');
    });

    it('generates an empty program', () => {
        const result = compile('x _ : _ x.');
        expect(result.emptyProgram).toBeDefined();
        expect(result.emptyProgram).toContain('LDA #$00');
    });

    it('compiles with wildcard neighbor', () => {
        const result = compile('a * : _ _.');
        const asm = result.programs['a'];
        expect(asm).toBeDefined();
        // Wildcard should not generate any check for the neighbor
        // Just the self type check and the writes
    });

    it('handles BRK yield at rule end', () => {
        const result = compile('x _ : _ x.');
        const asm = result.programs['x'];
        expect(asm).toContain('BRK');
        expect(asm).toContain('.byte $00');
    });
});

// ---- Universal program tests ----

describe('compileUniversal', () => {
    it('produces a universal program with type dispatch', () => {
        const result = compileUniversal('x _ : _ x.');
        expect(result.assembly).toBeDefined();
        expect(result.assembly).toContain('universal');
        const selfTypeAddr = cellTypeAddr(0).toString(16).padStart(4, '0');
        expect(result.assembly).toContain(`LDA $${selfTypeAddr}`);  // read own type tag
    });

    it('includes dispatch for each type', () => {
        const grammar = 'x _ : _ x.\ny _ : _ y.';
        const result = compileUniversal(grammar);
        expect(result.assembly).toContain('@type_x');
        expect(result.assembly).toContain('@type_y');
    });
});

// ---- Integration: ecosystem grammar ----

describe('ecosystem integration', () => {
    it('compiles full ecosystem grammar', () => {
        const grammar = `
soil : plant, rate=0.05.
plant soil : plant plant, rate=0.02.
herbivore plant : herbivore herbivore, rate=2.
herbivore soil : soil herbivore, rate=0.5.
herbivore : soil, rate=0.02.
predator herbivore : predator predator, rate=3.
predator soil : soil predator, rate=1.
predator : soil, rate=0.05.
`;
        const result = compile(grammar);

        // Should have programs for all non-empty types
        expect(Object.keys(result.programs)).toContain('soil');
        expect(Object.keys(result.programs)).toContain('plant');
        expect(Object.keys(result.programs)).toContain('herbivore');
        expect(Object.keys(result.programs)).toContain('predator');

        // Each program should be non-empty assembly
        for (const [type, asm] of Object.entries(result.programs)) {
            expect(asm.length).toBeGreaterThan(0);
            expect(asm).toContain('BRK');
        }

        // Type encoding should be consistent
        expect(result.typeIndex['_']).toBe(0);
        expect(result.typeIndex['soil']).toBeGreaterThan(0);
        expect(result.typeIndex['plant']).toBeGreaterThan(0);
        expect(result.typeIndex['herbivore']).toBeGreaterThan(0);
        expect(result.typeIndex['predator']).toBeGreaterThan(0);

        // All type tags should be unique
        const tags = Object.values(result.typeIndex);
        expect(new Set(tags).size).toBe(tags.length);
    });

    it('herbivore program checks for plant and soil neighbors', () => {
        const grammar = `
soil : plant.
plant soil : plant plant.
herbivore plant : herbivore herbivore.
herbivore soil : soil herbivore.
herbivore : soil.
`;
        const result = compile(grammar);
        const asm = result.programs['herbivore'];

        // Should reference the forward neighbor's type tag address
        const fwdTypeAddr = cellTypeAddr(1).toString(16).padStart(4, '0');
        expect(asm).toContain(`$${fwdTypeAddr}`);

        // Should check against plant and soil type tags
        const plantTag = result.typeIndex['plant'];
        const soilTag = result.typeIndex['soil'];
        expect(asm).toContain(`#$${plantTag.toString(16).padStart(2, '0')}`);
        expect(asm).toContain(`#$${soilTag.toString(16).padStart(2, '0')}`);
    });
});

// ---- Forest fire grammar ----

describe('forest fire integration', () => {
    it('compiles forest fire grammar (auto-only rules)', () => {
        const grammar = `
grass : tree, rate=0.005.
tree : fire, rate=0.002.
tree fire : fire fire, rate=3.
fire : ash, rate=0.2.
ash : grass, rate=0.05.
`;
        const result = compile(grammar);
        expect(result.programs['grass']).toBeDefined();
        expect(result.programs['tree']).toBeDefined();
        expect(result.programs['fire']).toBeDefined();
        expect(result.programs['ash']).toBeDefined();
    });
});

// ---- Game of Life ----

describe('game of life integration', () => {
    it('compiles a simplified Game of Life grammar', () => {
        const grammar = `
live _ : live live, rate=1.
live : dead, rate=0.5.
dead : _, rate=2.
`;
        const result = compile(grammar);
        expect(result.programs['live']).toBeDefined();
        expect(result.programs['dead']).toBeDefined();
        expect(result.typeIndex['live']).toBeGreaterThan(0);
        expect(result.typeIndex['dead']).toBeGreaterThan(0);
        expect(result.typeIndex['_']).toBe(0);
    });
});

// ---- Code size estimation ----

describe('code size', () => {
    it('diffusion program fits in budget', () => {
        const result = compile('x _ : _ x.');
        const lines = result.programs['x'].split('\n')
            .filter(l => l.trim() && !l.trim().startsWith(';'));
        // Rough estimate: each instruction ~2-3 bytes, should be well under 736
        expect(lines.length).toBeLessThan(100);
    });

    it('ecosystem programs fit in budget', () => {
        const grammar = `
soil : plant.
plant soil : plant plant.
herbivore plant : herbivore herbivore.
herbivore soil : soil herbivore.
herbivore : soil.
predator herbivore : predator predator.
predator soil : soil predator.
predator : soil.
`;
        const result = compile(grammar);
        for (const [type, asm] of Object.entries(result.programs)) {
            const lines = asm.split('\n')
                .filter(l => l.trim() && !l.trim().startsWith(';'));
            expect(lines.length).toBeLessThan(200);
        }
    });
});
