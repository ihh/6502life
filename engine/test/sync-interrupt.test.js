import { describe, it, expect, beforeEach } from 'vitest';
import { assemble } from '../assembler.js';
import { BoardMemory } from '../../board/memory.js';
import { BoardController } from '../../board/controller.js';
import { readCellMemory, writeCellBytes } from '../board.js';

// Suppress console.error during tests
const origError = console.error;
beforeEach(() => { console.error = () => {}; });

const SYNC_NANO_SOURCE = `
; Sync Nano: periodic self-replicator using sync interrupts
@start:
LDX #$F4
LDY #$01
BRK
.byte $61
BRK
.byte $31
BNE @start
BEQ @start
`;

const NANO_2X_SOURCE = `
; Nano 2x: 8-byte BRK spreader, two directions
@start:
BRK
.byte $31
BRK
.byte $32
BNE @start
BEQ @start
`;

const SYNC_NANO_2X_SOURCE = `
; Sync Nano 2x: periodic two-direction replicator
; Request sync, then copy forward and right
@start:
LDX #$F4
LDY #$01
BRK
.byte $61
BRK
.byte $31
BRK
.byte $32
BNE @start
BEQ @start
`;

function loadProgram(controller, i, j, bytes) {
    writeCellBytes(controller, i, j, 0, bytes);
    // Set PC to 0 for this cell
    const mem = controller.memory;
    const base = mem.ijbToByteIndex(i, j, 0);
    mem.setByteWithoutUndo(base + 0xF9, 0x00); // PCHI
    mem.setByteWithoutUndo(base + 0xFA, 0x00); // PCLO
}

function runAndTrackScheduling(controller, numInterrupts) {
    const B = controller.memory.B;
    const counts = new Array(B * B).fill(0);
    for (let n = 0; n < numInterrupts; n++) {
        const i = controller.memory.iOrig;
        const j = controller.memory.jOrig;
        const idx = i * B + j;
        counts[idx]++;
        controller.runToNextInterrupt();
    }
    return counts;
}

function countNonZeroCells(controller) {
    const B = controller.memory.B;
    let count = 0;
    for (let i = 0; i < B; i++) {
        for (let j = 0; j < B; j++) {
            const cellMem = readCellMemory(controller, i, j);
            // Check if any bytes in first 16 are non-zero (has code)
            let hasCode = false;
            for (let b = 0; b < 16; b++) {
                if (cellMem[b] !== 0) { hasCode = true; break; }
            }
            if (hasCode) count++;
        }
    }
    return count;
}

describe('Sync interrupt experiments', () => {

    describe('Step 2: Sync scheduling regularity', () => {
        // A sync-only program (no copy) isolates the scheduling effect.
        // Without copies, only cell (0,0) ever requests sync interrupts,
        // so it should reliably get more than its uniform share.
        const SYNC_ONLY_SOURCE = `
@start:
LDX #$F4
LDY #$01
BRK
.byte $61
JMP @start
`;

        it('sync-only cell gets scheduled more than uniform (no copy dilution)', async () => {
            const size = 8;
            const numInterrupts = 50000;
            const totalCells = size * size;
            const expectedUniform = numInterrupts / totalCells;

            const syncOnlyBytes = await assemble(SYNC_ONLY_SOURCE);
            const mem = new BoardMemory(42, size);
            const controller = new BoardController(mem, { implementsSync: true, implementsCopy: true });
            loadProgram(controller, 0, 0, syncOnlyBytes);

            const counts = runAndTrackScheduling(controller, numInterrupts);
            const cell00Count = counts[0];
            const ratio = cell00Count / expectedUniform;

            console.log(`\n=== Sync-Only Scheduling (${numInterrupts} interrupts, ${size}x${size}) ===`);
            console.log(`Cell (0,0) schedulings: ${cell00Count}`);
            console.log(`Expected if uniform: ${expectedUniform.toFixed(0)}`);
            console.log(`Ratio: ${ratio.toFixed(2)}x`);

            // With no copy, only cell (0,0) uses sync — it should be
            // scheduled substantially more than uniform
            expect(cell00Count).toBeGreaterThan(expectedUniform * 1.2);
        });

        it('sync-nano with copy: cell (0,0) advantage diluted as copies spread (observational)', async () => {
            // When sync-nano copies itself, neighbors also request sync
            // interrupts, diluting cell (0,0)'s advantage. This test is
            // observational — it logs results but only asserts completion.
            const size = 8;
            const numInterrupts = 50000;
            const totalCells = size * size;
            const expectedUniform = numInterrupts / totalCells;

            const syncBytes = await assemble(SYNC_NANO_SOURCE);
            const mem = new BoardMemory(42, size);
            const controller = new BoardController(mem, { implementsSync: true, implementsCopy: true });
            loadProgram(controller, 0, 0, syncBytes);

            const counts = runAndTrackScheduling(controller, numInterrupts);
            const cell00Count = counts[0];
            // Count total sync-eligible schedulings (all cells with code)
            const totalSyncSchedulings = counts.reduce((a, b) => a + b, 0);

            console.log(`\n=== Sync-Nano with Copy (${numInterrupts} interrupts, ${size}x${size}) ===`);
            console.log(`Cell (0,0): ${cell00Count} (${(cell00Count / expectedUniform).toFixed(2)}x uniform)`);
            console.log(`Total schedulings: ${totalSyncSchedulings}`);
            console.log(`Note: sync advantage is shared across all copies of the program`);

            expect(controller.totalCycles).toBeGreaterThan(0);
        });
    });

    describe('Step 3: Sync vs async competition', () => {
        it('sync-nano at (0,0) vs nano-2x at (4,4) - who spreads more?', async () => {
            const size = 8;
            const mem = new BoardMemory(42, size);
            const controller = new BoardController(mem, { implementsSync: true, implementsCopy: true });

            const syncBytes = await assemble(SYNC_NANO_SOURCE);
            const nanoBytes = await assemble(NANO_2X_SOURCE);

            loadProgram(controller, 0, 0, syncBytes);
            loadProgram(controller, 4, 4, nanoBytes);

            const numInterrupts = 200000;

            // Track copy events per source cell
            let syncCopies = 0;
            let nanoCopies = 0;
            const origOnBrk = controller.onBrkEvent;
            controller.onBrkEvent = (type, src, dest) => {
                if (type === 'copy') {
                    const i = controller.memory.iOrig;
                    const j = controller.memory.jOrig;
                    if (i === 0 && j === 0) syncCopies++;
                    else if (i === 4 && j === 4) nanoCopies++;
                }
            };

            for (let n = 0; n < numInterrupts; n++) {
                controller.runToNextInterrupt();
            }

            // Check similarity of each cell to each organism using byte-level comparison
            // A cell is "like" an organism if >50% of its program bytes match
            function similarity(cellMem, template) {
                let matching = 0;
                for (let b = 0; b < template.length; b++) {
                    if (cellMem[b] === template[b]) matching++;
                }
                return matching / template.length;
            }

            let syncLikeCells = 0;
            let nanoLikeCells = 0;
            let neitherCells = 0;
            const threshold = 0.5;
            for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                    const cellMem = readCellMemory(controller, i, j);
                    const syncSim = similarity(cellMem, syncBytes);
                    const nanoSim = similarity(cellMem, nanoBytes);
                    if (syncSim > threshold && syncSim >= nanoSim) syncLikeCells++;
                    else if (nanoSim > threshold && nanoSim > syncSim) nanoLikeCells++;
                    else neitherCells++;
                }
            }

            console.log(`\n=== Competition: Sync-Nano vs Nano-2x (${numInterrupts} interrupts, ${size}x${size}) ===`);
            console.log(`Sync-nano copies issued: ${syncCopies}`);
            console.log(`Nano-2x   copies issued: ${nanoCopies}`);
            console.log(`Cells similar to sync-nano (>50%): ${syncLikeCells}/${size * size}`);
            console.log(`Cells similar to nano-2x   (>50%): ${nanoLikeCells}/${size * size}`);
            console.log(`Neither: ${neitherCells}/${size * size}`);
            console.log(`Winner by territory: ${syncLikeCells > nanoLikeCells ? 'SYNC-NANO' : nanoLikeCells > syncLikeCells ? 'NANO-2X' : 'TIE'}`);
            console.log(`Winner by copies:    ${syncCopies > nanoCopies ? 'SYNC-NANO' : nanoCopies > syncCopies ? 'NANO-2X' : 'TIE'}\n`);

            // Just verify the experiment ran to completion
            expect(controller.totalCycles).toBeGreaterThan(0);
        });
    });

    describe('Step 4: Optimal sync period', () => {
        it('test sync-nano with different periods: 100, 500, 2000, 10000', async () => {
            const size = 8;
            const numInterrupts = 50000;
            const periods = [100, 500, 2000, 10000];
            const results = [];

            for (const period of periods) {
                const lo = period & 0xFF;
                const hi = (period >> 8) & 0xFF;
                const source = `
@start:
LDX #$${lo.toString(16).padStart(2, '0')}
LDY #$${hi.toString(16).padStart(2, '0')}
BRK
.byte $61
BRK
.byte $31
BNE @start
BEQ @start
`;
                const bytes = await assemble(source);
                const mem = new BoardMemory(42, size);
                const controller = new BoardController(mem, { implementsSync: true, implementsCopy: true });
                loadProgram(controller, 0, 0, bytes);

                let copies = 0;
                controller.onBrkEvent = (type) => {
                    if (type === 'copy') copies++;
                };

                const counts = runAndTrackScheduling(controller, numInterrupts);
                const cell00Count = counts[0];
                const expected = numInterrupts / (size * size);

                // Count cells that have been populated
                const populated = countNonZeroCells(controller);

                results.push({
                    period,
                    schedulings: cell00Count,
                    ratio: cell00Count / expected,
                    copies,
                    populated,
                    totalCycles: controller.totalCycles
                });
            }

            console.log(`\n=== Sync Period Optimization (${numInterrupts} interrupts, ${size}x${size} board) ===`);
            console.log(`${'Period'.padStart(8)} | ${'Sched'.padStart(7)} | ${'Ratio'.padStart(6)} | ${'Copies'.padStart(7)} | ${'Populated'.padStart(10)} | ${'TotalCycles'.padStart(12)}`);
            console.log('-'.repeat(70));
            for (const r of results) {
                console.log(
                    `${r.period.toString().padStart(8)} | ${r.schedulings.toString().padStart(7)} | ${r.ratio.toFixed(2).padStart(6)} | ${r.copies.toString().padStart(7)} | ${(r.populated + '/' + size * size).padStart(10)} | ${r.totalCycles.toString().padStart(12)}`
                );
            }

            // Find best period by number of populated cells, then by copies
            const best = results.reduce((a, b) => {
                if (b.populated > a.populated) return b;
                if (b.populated === a.populated && b.copies > a.copies) return b;
                return a;
            });
            console.log(`\nOptimal period: ${best.period} cycles (${best.populated} cells populated, ${best.copies} copies)\n`);

            // Verify all periods produced some scheduling advantage
            for (const r of results) {
                expect(r.schedulings).toBeGreaterThan(0);
            }
        });
    });

    describe('Step 3b: Sync-nano-2x vs nano-2x competition', () => {
        it('sync-nano-2x at (0,0) vs nano-2x at (4,4)', async () => {
            const size = 8;
            const mem = new BoardMemory(42, size);
            const controller = new BoardController(mem, { implementsSync: true, implementsCopy: true });

            const syncBytes = await assemble(SYNC_NANO_2X_SOURCE);
            const nanoBytes = await assemble(NANO_2X_SOURCE);

            loadProgram(controller, 0, 0, syncBytes);
            loadProgram(controller, 4, 4, nanoBytes);

            const numInterrupts = 200000;

            let syncCopies = 0;
            let nanoCopies = 0;
            controller.onBrkEvent = (type, src, dest) => {
                if (type === 'copy') {
                    const i = controller.memory.iOrig;
                    const j = controller.memory.jOrig;
                    if (i === 0 && j === 0) syncCopies++;
                    else if (i === 4 && j === 4) nanoCopies++;
                }
            };

            for (let n = 0; n < numInterrupts; n++) {
                controller.runToNextInterrupt();
            }

            function similarity(cellMem, template) {
                let matching = 0;
                for (let b = 0; b < template.length; b++) {
                    if (cellMem[b] === template[b]) matching++;
                }
                return matching / template.length;
            }

            let syncLikeCells = 0;
            let nanoLikeCells = 0;
            let neitherCells = 0;
            const threshold = 0.5;
            for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                    const cellMem = readCellMemory(controller, i, j);
                    const syncSim = similarity(cellMem, syncBytes);
                    const nanoSim = similarity(cellMem, nanoBytes);
                    if (syncSim > threshold && syncSim >= nanoSim) syncLikeCells++;
                    else if (nanoSim > threshold && nanoSim > syncSim) nanoLikeCells++;
                    else neitherCells++;
                }
            }

            // Count how many cells still have a valid BRK $FD (sync request) in their code
            let cellsWithSync = 0;
            for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                    const cellMem = readCellMemory(controller, i, j);
                    // Scan first 16 bytes for BRK $FD pattern
                    for (let b = 0; b < 15; b++) {
                        if (cellMem[b] === 0x00 && cellMem[b + 1] === 0xFD) {
                            cellsWithSync++;
                            break;
                        }
                    }
                }
            }

            console.log(`\n=== Competition: Sync-Nano-2x vs Nano-2x (${numInterrupts} interrupts, ${size}x${size}) ===`);
            console.log(`Sync-nano-2x (${syncBytes.length} bytes) vs Nano-2x (${nanoBytes.length} bytes)`);
            console.log(`Sync-nano-2x copies: ${syncCopies}  |  Nano-2x copies: ${nanoCopies}`);
            console.log(`Cells similar to sync-nano-2x: ${syncLikeCells}/${size * size}`);
            console.log(`Cells similar to nano-2x:      ${nanoLikeCells}/${size * size}`);
            console.log(`Neither:                       ${neitherCells}/${size * size}`);
            console.log(`Cells with intact BRK $FD:     ${cellsWithSync}/${size * size}`);
            console.log(`Winner by territory: ${syncLikeCells > nanoLikeCells ? 'SYNC-NANO-2X' : nanoLikeCells > syncLikeCells ? 'NANO-2X' : 'TIE'}`);
            console.log(`Note: sync-nano-2x is ${syncBytes.length} bytes vs ${nanoBytes.length} bytes for nano-2x.`);
            console.log(`      Larger genome = more bits to corrupt under noisy copy.\n`);

            expect(controller.totalCycles).toBeGreaterThan(0);
        });
    });
});
