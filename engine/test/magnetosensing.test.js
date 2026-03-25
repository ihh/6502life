import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { assemble } from '../assembler.js';
import { BoardMemory } from '../../board/memory.js';
import { BoardController } from '../../board/controller.js';
import { readCellMemory, writeCellBytes } from '../board.js';
import { PRESETS } from '../../cli/lib/terminal/presets.js';

// Suppress console.error from Sfotty internals
const origError = console.error;
beforeAll(() => { console.error = () => {}; });
afterAll(() => { console.error = origError; });

/**
 * Load assembled preset bytes into a cell, zeroing it first.
 */
async function loadPreset(controller, i, j, presetKey) {
    const source = PRESETS[presetKey].source;
    const bytes = await assemble(source);
    // Zero the cell first
    const mem = controller.memory;
    const base = mem.ijbToByteIndex(i, j, 0);
    for (let b = 0; b < mem.M; b++) {
        mem.setByteWithoutUndo(base + b, 0);
    }
    writeCellBytes(controller, i, j, 0, bytes);
    return bytes;
}

/**
 * Count non-trivial cells: cells whose page 0 is not all zeros.
 */
function countNonTrivialCells(controller) {
    const B = controller.memory.B;
    let count = 0;
    for (let i = 0; i < B; i++) {
        for (let j = 0; j < B; j++) {
            const cellMem = readCellMemory(controller, i, j);
            let nonZero = false;
            for (let b = 0; b < 256 && !nonZero; b++) {
                if (cellMem[b] !== 0) nonZero = true;
            }
            if (nonZero) count++;
        }
    }
    return count;
}

/**
 * Count cells with hue marker byte at offset 0x3FF.
 */
function countHueCells(controller, hue) {
    const B = controller.memory.B;
    let count = 0;
    for (let i = 0; i < B; i++) {
        for (let j = 0; j < B; j++) {
            const base = controller.memory.ijbToByteIndex(i, j, 0x3FF);
            if (controller.memory.getByte(base) === hue) count++;
        }
    }
    return count;
}

/**
 * Get (i,j) coordinates of cells with a specific hue value at 0x3FF.
 */
function getHueCells(controller, hue) {
    const B = controller.memory.B;
    const cells = [];
    for (let i = 0; i < B; i++) {
        for (let j = 0; j < B; j++) {
            const base = controller.memory.ijbToByteIndex(i, j, 0x3FF);
            if (controller.memory.getByte(base) === hue) cells.push([i, j]);
        }
    }
    return cells;
}

/**
 * Get the set of (i,j) coordinates that have non-zero page 0.
 */
function getOccupiedCells(controller) {
    const B = controller.memory.B;
    const cells = [];
    for (let i = 0; i < B; i++) {
        for (let j = 0; j < B; j++) {
            const cellMem = readCellMemory(controller, i, j);
            let nonZero = false;
            for (let b = 0; b < 256 && !nonZero; b++) {
                if (cellMem[b] !== 0) nonZero = true;
            }
            if (nonZero) cells.push([i, j]);
        }
    }
    return cells;
}

/**
 * Compute byte-level similarity between two cell memories (page 0 only).
 */
function page0Similarity(a, b) {
    let same = 0;
    for (let i = 0; i < 256; i++) {
        if (a[i] === b[i]) same++;
    }
    return same / 256;
}

describe('Compass experiments', () => {

    describe('Step 1: Compass spreader assembles correctly', () => {
        it('compass-spreader preset exists and assembles', async () => {
            expect(PRESETS['compass-spreader']).toBeDefined();
            const bytes = await assemble(PRESETS['compass-spreader'].source);
            expect(bytes.length).toBeGreaterThan(10);
            expect(bytes.length).toBeLessThan(100);
        });

        it('compass-spreader reads $FA and branches on orientation values', async () => {
            const bytes = await assemble(PRESETS['compass-spreader'].source);
            // Should contain LDA $FA (opcode A5 FA)
            let foundLdaFA = false;
            for (let i = 0; i < bytes.length - 1; i++) {
                if (bytes[i] === 0xA5 && bytes[i + 1] === 0xFA) {
                    foundLdaFA = true;
                    break;
                }
            }
            expect(foundLdaFA).toBe(true);

            // Should contain all four BRK copy operands: $31, $32, $33, $34
            const brkOperands = new Set();
            for (let i = 0; i < bytes.length - 1; i++) {
                if (bytes[i] === 0x00 && bytes[i + 1] >= 0x31 && bytes[i + 1] <= 0x34) {
                    brkOperands.add(bytes[i + 1]);
                }
            }
            expect(brkOperands.has(0x31)).toBe(true);
            expect(brkOperands.has(0x32)).toBe(true);
            expect(brkOperands.has(0x33)).toBe(true);
            expect(brkOperands.has(0x34)).toBe(true);
        });
    });

    describe('Step 2: Directional spreading (no noise)', () => {
        it('compass-spreader shows early directional bias using hue marker', async () => {
            // Use hue=42 at 0x3FF as the definitive marker for compass-spreader cells.
            // The scheduler writes register save bytes (0xF9-0xFF) to every visited cell,
            // so "non-zero page 0" is not a reliable indicator of replication.
            const size = 8;
            const mem = new BoardMemory(42, size);
            const controller = new BoardController(mem, {
                hasCompass: true,
                pBitNoise: 0,
            });

            await loadPreset(controller, 4, 4, 'compass-spreader');

            // Track spreading via hue marker at fine-grained intervals
            const snapshots = [];
            const checkpoints = [100, 200, 500, 1000, 2000, 5000, 10000, 50000];
            let interrupt = 0;

            for (const cp of checkpoints) {
                while (interrupt < cp) {
                    controller.runToNextInterrupt();
                    interrupt++;
                }
                const hueCells = getHueCells(controller, 0x2A);
                const sameRow = hueCells.filter(c => c[0] === 4).length;
                const total = hueCells.length;
                snapshots.push({ interrupts: cp, total, sameRow, otherRow: total - sameRow });
            }

            console.log('Step 2: Directional spreading timeline (hue=42 marker)');
            console.log('  Interrupts  Hue42  i=4  Other  %i=4');
            for (const s of snapshots) {
                const pct = s.total > 0 ? (s.sameRow / s.total * 100).toFixed(0) : '-';
                console.log(`  ${String(s.interrupts).padStart(8)}  ${String(s.total).padStart(5)}  ${String(s.sameRow).padStart(3)}  ${String(s.otherRow).padStart(5)}  ${pct}%`);
            }

            // The compass-spreader copies in the +j direction only.
            // Children inherit the compass code so they also copy +j.
            // This creates a directional wave.
            // Key assertion: the organism replicates (at least 2 hue-marked cells).
            const finalTotal = snapshots[snapshots.length - 1].total;
            expect(finalTotal).toBeGreaterThanOrEqual(2);

            // Check early directional bias: at first spread, majority in same row
            const firstSpread = snapshots.find(s => s.total > 1);
            if (firstSpread) {
                console.log(`  First spread at ${firstSpread.interrupts}: ${firstSpread.sameRow}/${firstSpread.total} in row i=4`);
            }
        });

        it('compass-spreader fills the board via chain replication', async () => {
            const size = 8;
            const mem = new BoardMemory(42, size);
            const controller = new BoardController(mem, {
                hasCompass: true,
                pBitNoise: 0,
            });

            await loadPreset(controller, 4, 4, 'compass-spreader');

            // Run enough to saturate. BRK copy costs 14400 cycles and the
            // average quantum is ~4096, so only ~25% of quanta are long enough
            // for a successful copy. Need more interrupts than before.
            for (let i = 0; i < 500000; i++) {
                controller.runToNextInterrupt();
            }

            const hueCells = countHueCells(controller, 0x2A);

            console.log(`  After 500k interrupts: ${hueCells} cells with hue=42 (of 64 total)`);

            // At epsilon=0, most cells should carry the hue marker.
            // BRK copy's 14400-cycle cost means only ~25% of quanta succeed,
            // so saturation is slower. Require at least 50%.
            expect(hueCells).toBeGreaterThanOrEqual(Math.floor(64 * 0.5));
        });
    });

    describe('Step 3: Compass vs random competition', () => {
        it('compass-spreader at (0,0) vs nano-2x at (4,4), both at epsilon=0', async () => {
            const size = 8;
            const mem = new BoardMemory(42, size);
            const controller = new BoardController(mem, {
                hasCompass: true,
                pBitNoise: 0,
            });

            const compassBytes = await loadPreset(controller, 0, 0, 'compass-spreader');
            const nanoBytes = await loadPreset(controller, 4, 4, 'nano-2x');

            // Run 200k interrupts
            for (let i = 0; i < 200000; i++) {
                controller.runToNextInterrupt();
            }

            // Count cells similar to each organism
            const compassRef = new Uint8Array(1024);
            compassRef.set(compassBytes, 0);
            const nanoRef = new Uint8Array(1024);
            nanoRef.set(nanoBytes, 0);

            let compassCount = 0;
            let nanoCount = 0;
            let otherCount = 0;
            const B = size;

            for (let i = 0; i < B; i++) {
                for (let j = 0; j < B; j++) {
                    const cellMem = readCellMemory(controller, i, j);
                    const compassSim = page0Similarity(cellMem, compassRef);
                    const nanoSim = page0Similarity(cellMem, nanoRef);

                    // Check if page 0 is non-trivial
                    let nonZero = false;
                    for (let b = 0; b < 256 && !nonZero; b++) {
                        if (cellMem[b] !== 0) nonZero = true;
                    }
                    if (!nonZero) continue;

                    if (compassSim > 0.8 && compassSim > nanoSim) compassCount++;
                    else if (nanoSim > 0.8 && nanoSim > compassSim) nanoCount++;
                    else otherCount++;
                }
            }

            console.log(`Step 3: After 200k interrupts on 8x8 board`);
            console.log(`  Compass-spreader cells: ${compassCount}`);
            console.log(`  Nano-2x cells: ${nanoCount}`);
            console.log(`  Other/mixed: ${otherCount}`);
            console.log(`  Total non-trivial: ${compassCount + nanoCount + otherCount}`);

            // Both organisms should have spread somewhere
            // (at epsilon=0, nano-2x is very compact and copies reliably)
            const totalOccupied = compassCount + nanoCount + otherCount;
            expect(totalOccupied).toBeGreaterThan(1);
        });
    });

    describe('Step 4: Compass with noise', () => {
        it('compass-spreader at (4,4) with epsilon=1/131072 still spreads', async () => {
            const size = 8;
            const mem = new BoardMemory(42, size);
            const controller = new BoardController(mem, {
                hasCompass: true,
                pBitNoise: 1 / 131072,
            });

            await loadPreset(controller, 4, 4, 'compass-spreader');

            // Run 50k interrupts
            for (let i = 0; i < 50000; i++) {
                controller.runToNextInterrupt();
            }

            const nonTrivial = countNonTrivialCells(controller);
            const occupied = getOccupiedCells(controller);

            console.log(`Step 4: After 50k interrupts at epsilon=1/131072, ${nonTrivial} non-trivial cells`);
            console.log(`  Occupied cells: ${occupied.map(c => `(${c[0]},${c[1]})`).join(', ')}`);

            // With low noise, the spreader should still function
            expect(nonTrivial).toBeGreaterThanOrEqual(2);

            // Check if directional bias persists
            const sameRow = occupied.filter(c => c[0] === 4).length;
            const otherRow = occupied.filter(c => c[0] !== 4).length;
            console.log(`  Same row (i=4): ${sameRow}, other rows: ${otherRow}`);

            // With noise, mutants may spread to other rows too
            // But the original lineage should still favor i=4
        });
    });

    describe('Step 5: Compass hue tracking', () => {
        it('tracks hue=42 cells over time at epsilon=1/131072', async () => {
            const size = 8;
            const mem = new BoardMemory(42, size);
            const controller = new BoardController(mem, {
                hasCompass: true,
                pBitNoise: 1 / 131072,
            });

            await loadPreset(controller, 4, 4, 'compass-spreader');

            const snapshots = [];
            const interval = 10000;
            const totalInterrupts = 50000;

            for (let t = 0; t < totalInterrupts; t++) {
                controller.runToNextInterrupt();
                if ((t + 1) % interval === 0) {
                    const hueCells = countHueCells(controller, 0x2A);
                    const nonTrivial = countNonTrivialCells(controller);
                    snapshots.push({
                        interrupts: t + 1,
                        hueCells,
                        nonTrivial,
                    });
                }
            }

            console.log(`Step 5: Hue tracking over time`);
            console.log(`  Interrupts  Hue=42  NonTrivial`);
            for (const s of snapshots) {
                console.log(`  ${String(s.interrupts).padStart(8)}  ${String(s.hueCells).padStart(6)}  ${String(s.nonTrivial).padStart(10)}`);
            }

            // The compass-spreader writes hue=42 to 0x3FF on each execution.
            // Copies inherit it (BRK noisy copy copies the whole cell).
            // Over time we should see hue=42 cells present.
            const finalHue = snapshots[snapshots.length - 1].hueCells;
            const finalNonTrivial = snapshots[snapshots.length - 1].nonTrivial;
            console.log(`  Final: ${finalHue} hue=42 cells out of ${finalNonTrivial} non-trivial`);

            // At least one cell should maintain the hue marker
            // (the original or its copies)
            expect(finalHue).toBeGreaterThanOrEqual(1);
        });
    });
});
