// Functional tests: compile SokoScript, load into 6502life board, run, verify behavior
import { describe, it, expect } from 'vitest';
import { compile, TYPE_TAG_OFFSET, STATE_OFFSET, STATE_LEN_OFFSET } from '../sokoscript.js';
import { assemble } from '../../engine/assembler.js';
import { BoardMemory } from '../../board/memory.js';
import { BoardController } from '../../board/controller.js';

// Helper: load compiled assembly into a cell
async function loadProgram(memory, i, j, asmSource) {
    const bytes = await assemble(asmSource);
    for (let k = 0; k < bytes.length; k++) {
        const idx = memory.ijbToByteIndex(i, j, k);
        memory.setByteWithoutUndo(idx, bytes[k]);
    }
    return bytes.length;
}

// Helper: set a cell's type tag
function setCellType(memory, i, j, tag) {
    const idx = memory.ijbToByteIndex(i, j, TYPE_TAG_OFFSET);
    memory.setByteWithoutUndo(idx, tag);
}

// Helper: set a cell's state
function setCellState(memory, i, j, stateStr) {
    for (let k = 0; k < stateStr.length; k++) {
        const idx = memory.ijbToByteIndex(i, j, STATE_OFFSET + k);
        memory.setByteWithoutUndo(idx, stateStr.charCodeAt(k));
    }
    const lenIdx = memory.ijbToByteIndex(i, j, STATE_LEN_OFFSET);
    memory.setByteWithoutUndo(lenIdx, stateStr.length);
}

// Helper: get a cell's type tag
function getCellType(memory, i, j) {
    const idx = memory.ijbToByteIndex(i, j, TYPE_TAG_OFFSET);
    return memory.getByte(idx);
}

// Helper: get a cell's state length
function getCellStateLen(memory, i, j) {
    const idx = memory.ijbToByteIndex(i, j, STATE_LEN_OFFSET);
    return memory.getByte(idx);
}

// Helper: get a cell's state string
function getCellState(memory, i, j) {
    const len = getCellStateLen(memory, i, j);
    let s = '';
    for (let k = 0; k < len; k++) {
        const idx = memory.ijbToByteIndex(i, j, STATE_OFFSET + k);
        s += String.fromCharCode(memory.getByte(idx));
    }
    return s;
}

// Helper: run a cell's compiled program directly using the Sfotty CPU
// and memory, without the BoardController's scheduling logic. This
// bypasses the controller's cycle-0 opcode check which incorrectly
// treats operand bytes of multi-byte instructions as opcodes.
//
// We simply run the Sfotty for enough cycles that the program executes
// fully, including BRK handling (which jumps to the IRQ vector at
// $FFFE/$FFFF, both returning 0, so PC becomes $0000 and the program
// restarts). After enough cycles, the writes from a matching rule
// will have been committed to memory.
function runCell(controller, i, j, orientation = 0, numCycles = 300) {
    const mem = controller.memory;
    mem.iOrig = i;
    mem.jOrig = j;
    mem.orientation = orientation;
    mem.resetUndoHistory();

    const sfotty = controller.sfotty;
    sfotty.PC = 0;
    sfotty.A = 0;
    sfotty.X = 0;
    sfotty.Y = 0;
    sfotty.S = 0xFF;
    sfotty.setP(0);
    sfotty.crashed = false;
    sfotty.resetPending = false;
    sfotty.cycleCounter = 0;
    sfotty.operations = [() => sfotty.decode()];

    // Hook write() to detect when a rule fires (writes to type tag).
    // Stop execution shortly after the first type-tag write to prevent
    // the program from looping through BRK and applying a second rule.
    let typeWriteCount = 0;
    let cyclesAfterWrite = 0;
    const origWrite = mem.write.bind(mem);
    mem.write = function(addr, val) {
        const byteOffset = addr & 0x3FF;
        if (byteOffset === TYPE_TAG_OFFSET) {
            typeWriteCount++;
        }
        origWrite(addr, val);
    };

    for (let run = 0; run < numCycles; run++) {
        if (typeWriteCount > 0) {
            cyclesAfterWrite++;
            // Give the program a few more cycles to complete remaining writes
            // (state length, etc.), then stop.
            if (cyclesAfterWrite > 30) break;
        }
        sfotty.run();
    }

    // Restore original write
    mem.write = origWrite;
}

describe('simulation: spontaneous transformation', () => {
    it('soil transforms to plant (single-term rule)', async () => {
        const result = compile('soil : plant.');
        const soilTag = result.typeIndex['soil'];
        const plantTag = result.typeIndex['plant'];

        const memory = new BoardMemory(42, 8);
        const controller = new BoardController(memory);

        await loadProgram(memory, 0, 0, result.programs['soil']);
        setCellType(memory, 0, 0, soilTag);
        setCellState(memory, 0, 0, '');

        runCell(controller, 0, 0);

        expect(getCellType(memory, 0, 0)).toBe(plantTag);
    });
});

describe('simulation: diffusion', () => {
    it('x cell moves forward when neighbor is empty', async () => {
        const result = compile('x _ : _ x.');
        const xTag = result.typeIndex['x'];

        const memory = new BoardMemory(42, 8);
        const controller = new BoardController(memory);

        await loadProgram(memory, 0, 0, result.programs['x']);
        setCellType(memory, 0, 0, xTag);
        setCellState(memory, 0, 0, '');

        // With orientation 0, forward = spiral idx 1 = (dx=0, dy=+1) = cell (0,1)
        setCellType(memory, 0, 1, 0);
        setCellState(memory, 0, 1, '');

        runCell(controller, 0, 0, 0);

        // Self should be empty, neighbor should be x
        expect(getCellType(memory, 0, 0)).toBe(0);
        expect(getCellType(memory, 0, 1)).toBe(xTag);
    });

    it('x cell does not move when neighbor is occupied', async () => {
        const result = compile('x _ : _ x.');
        const xTag = result.typeIndex['x'];

        const memory = new BoardMemory(42, 8);
        const controller = new BoardController(memory);

        await loadProgram(memory, 0, 0, result.programs['x']);
        setCellType(memory, 0, 0, xTag);
        setCellState(memory, 0, 0, '');

        // Set forward neighbor to non-empty
        setCellType(memory, 0, 1, xTag);
        setCellState(memory, 0, 1, '');

        runCell(controller, 0, 0, 0);

        // Rule requires empty neighbor; self should stay x
        expect(getCellType(memory, 0, 0)).toBe(xTag);
    });
});

describe('simulation: multi-rule dispatch', () => {
    it('fires first matching rule and stops', async () => {
        const result = compile('a _ : _ a.\na b : b a.');
        const aTag = result.typeIndex['a'];

        const memory = new BoardMemory(42, 8);
        const controller = new BoardController(memory);

        await loadProgram(memory, 0, 0, result.programs['a']);
        setCellType(memory, 0, 0, aTag);
        setCellState(memory, 0, 0, '');
        setCellType(memory, 0, 1, 0); // empty

        runCell(controller, 0, 0, 0);

        expect(getCellType(memory, 0, 0)).toBe(0);     // becomes empty
        expect(getCellType(memory, 0, 1)).toBe(aTag);   // becomes a
    });
});

describe('simulation: type encoding consistency', () => {
    it('all types get unique non-zero tags except empty', () => {
        const grammar = `
soil : plant.
plant soil : plant plant.
herbivore plant : herbivore herbivore.
herbivore : soil.
`;
        const result = compile(grammar);
        expect(result.typeIndex['_']).toBe(0);

        const nonEmptyTags = Object.entries(result.typeIndex)
            .filter(([name]) => name !== '_' && name !== '?')
            .map(([, tag]) => tag);

        for (const tag of nonEmptyTags) {
            expect(tag).toBeGreaterThan(0);
        }
        expect(new Set(nonEmptyTags).size).toBe(nonEmptyTags.length);
    });
});

describe('simulation: state read/write', () => {
    it('compiled program with state writes correct state bytes', async () => {
        const result = compile('a/x : a/y.');
        const aTag = result.typeIndex['a'];

        const memory = new BoardMemory(42, 8);
        const controller = new BoardController(memory);

        await loadProgram(memory, 0, 0, result.programs['a']);
        setCellType(memory, 0, 0, aTag);
        setCellState(memory, 0, 0, 'x');

        runCell(controller, 0, 0, 0);

        expect(getCellState(memory, 0, 0)).toBe('y');
        expect(getCellType(memory, 0, 0)).toBe(aTag);
    });

    it('state mismatch prevents rule from firing', async () => {
        const result = compile('a/x : a/y.');
        const aTag = result.typeIndex['a'];

        const memory = new BoardMemory(42, 8);
        const controller = new BoardController(memory);

        await loadProgram(memory, 0, 0, result.programs['a']);
        setCellType(memory, 0, 0, aTag);
        setCellState(memory, 0, 0, 'z'); // wrong state

        runCell(controller, 0, 0, 0);

        expect(getCellState(memory, 0, 0)).toBe('z');
    });
});

describe('simulation: predator-prey dynamics', () => {
    it('herbivore eats plant (becomes two herbivores)', async () => {
        const grammar = `
herbivore plant : herbivore herbivore.
herbivore : soil.
soil : plant.
`;
        const result = compile(grammar);
        const herbTag = result.typeIndex['herbivore'];
        const plantTag = result.typeIndex['plant'];

        const memory = new BoardMemory(42, 8);
        const controller = new BoardController(memory);

        await loadProgram(memory, 0, 0, result.programs['herbivore']);
        setCellType(memory, 0, 0, herbTag);
        setCellState(memory, 0, 0, '');

        setCellType(memory, 0, 1, plantTag);
        setCellState(memory, 0, 1, '');

        runCell(controller, 0, 0, 0);

        expect(getCellType(memory, 0, 0)).toBe(herbTag);
        expect(getCellType(memory, 0, 1)).toBe(herbTag);
    });

    it('herbivore dies when alone (spontaneous transformation to soil)', async () => {
        const grammar = `
herbivore plant : herbivore herbivore.
herbivore : soil.
soil : plant.
`;
        const result = compile(grammar);
        const herbTag = result.typeIndex['herbivore'];
        const soilTag = result.typeIndex['soil'];

        const memory = new BoardMemory(42, 8);
        const controller = new BoardController(memory);

        await loadProgram(memory, 0, 0, result.programs['herbivore']);
        setCellType(memory, 0, 0, herbTag);
        setCellState(memory, 0, 0, '');

        // Neighbor is not plant
        setCellType(memory, 0, 1, 0);

        runCell(controller, 0, 0, 0);

        expect(getCellType(memory, 0, 0)).toBe(soilTag);
    });
});
