// Test that compiled SokoScript assembly can be assembled to valid 6502 machine code
import { describe, it, expect } from 'vitest';
import { compile, compileUniversal } from '../sokoscript.js';
import { assemble } from '../../engine/assembler.js';

describe('assembly validation', () => {
    it('assembles diffusion program', async () => {
        const result = compile('x _ : _ x.');
        const bytes = await assemble(result.programs['x']);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.length).toBeGreaterThan(0);
        expect(bytes.length).toBeLessThan(736); // must fit in code budget
    });

    it('assembles ecosystem programs', async () => {
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
        for (const [type, asm] of Object.entries(result.programs)) {
            const bytes = await assemble(asm);
            expect(bytes.length).toBeGreaterThan(0);
            expect(bytes.length).toBeLessThan(736);
        }
    });

    it('assembles forest fire programs', async () => {
        const grammar = `
grass : tree, rate=0.005.
tree : fire, rate=0.002.
tree fire : fire fire, rate=3.
fire : ash, rate=0.2.
ash : grass, rate=0.05.
`;
        const result = compile(grammar);
        for (const [type, asm] of Object.entries(result.programs)) {
            const bytes = await assemble(asm);
            expect(bytes.length).toBeGreaterThan(0);
            expect(bytes.length).toBeLessThan(736);
        }
    });

    it('assembles program with group references', async () => {
        const result = compile('a b : $2 $1.');
        const bytes = await assemble(result.programs['a']);
        expect(bytes.length).toBeGreaterThan(0);
    });

    it('assembles program with state', async () => {
        const result = compile('a/x b : a/y b.');
        const bytes = await assemble(result.programs['a']);
        expect(bytes.length).toBeGreaterThan(0);
    });

    it('assembles program with relative direction', async () => {
        const result = compile('a >R> b : b a.');
        const bytes = await assemble(result.programs['a']);
        expect(bytes.length).toBeGreaterThan(0);
    });

    it('assembles program with absolute direction', async () => {
        const result = compile('a >N> b : b a.');
        const bytes = await assemble(result.programs['a']);
        expect(bytes.length).toBeGreaterThan(0);
    });

    it('assembles universal diffusion program', async () => {
        const result = compileUniversal('x _ : _ x.');
        const bytes = await assemble(result.assembly);
        expect(bytes.length).toBeGreaterThan(0);
        expect(bytes.length).toBeLessThan(736);
    });

    it('assembles empty cell program', async () => {
        const result = compile('x _ : _ x.');
        const bytes = await assemble(result.emptyProgram);
        expect(bytes.length).toBeGreaterThan(0);
        expect(bytes.length).toBeLessThan(20);
    });

    it('assembles program with wildcard neighbor', async () => {
        const result = compile('a * : _ _.');
        const bytes = await assemble(result.programs['a']);
        expect(bytes.length).toBeGreaterThan(0);
    });

    it('assembles program with single-term rule', async () => {
        const result = compile('soil : plant.');
        const bytes = await assemble(result.programs['soil']);
        expect(bytes.length).toBeGreaterThan(0);
    });
});

describe('code size budget', () => {
    it('diffusion: under 50 bytes', async () => {
        const result = compile('x _ : _ x.');
        const bytes = await assemble(result.programs['x']);
        expect(bytes.length).toBeLessThan(50);
    });

    it('ecosystem type programs: each under 200 bytes', async () => {
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
            const bytes = await assemble(asm);
            expect(bytes.length).toBeLessThan(200);
        }
    });
});
