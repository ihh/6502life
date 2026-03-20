import { describe, it, expect } from 'vitest';
import { minhash, minhashSimilarity, fingerprint } from '../../cli/lib/probe/fingerprint.js';
import { assemble } from '../assembler.js';
import { BoardMemory } from '../../board/memory.js';
import { BoardController } from '../../board/controller.js';
import { readCellMemory, writeCellBytes } from '../board.js';
import { PRESETS } from '../../cli/lib/terminal/presets.js';

describe('MinHash with randomized board (realistic scenario)', () => {

    it('spreader on randomized board: does it replicate?', async () => {
        const size = 8;
        const mem = new BoardMemory(42, size);
        const controller = new BoardController(mem);
        controller.randomize();

        const bytes = await assemble(PRESETS.spreader.source);
        writeCellBytes(controller, 0, 0, 0, bytes);

        const origCell = readCellMemory(controller, 0, 0);
        const fpOrig = fingerprint(origCell);

        console.log('Spreader on RANDOMIZED 8x8 board:');
        console.log(`  Original cell (0,0): ${bytes.length}B program in random background`);

        const checkpoints = [100, 500, 1000, 5000, 10000];
        let interrupts = 0;
        for (const target of checkpoints) {
            while (interrupts < target) {
                controller.runToNextInterrupt();
                interrupts++;
            }

            let maxSim = 0;
            let aboveThreshold = 0;
            for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                    if (i === 0 && j === 0) continue;
                    const cellBytes = readCellMemory(controller, i, j);
                    const fp = fingerprint(cellBytes);
                    const sim = minhashSimilarity(fpOrig.minhash, fp.minhash);
                    if (sim > maxSim) maxSim = sim;
                    if (sim >= 0.6) aboveThreshold++;
                }
            }
            console.log(`  ${String(interrupts).padStart(5)} intrs: ${aboveThreshold} cells >= 0.6, max_sim=${maxSim.toFixed(3)}`);
        }

        // Also check: did the spreader even change page 2?
        // On a randomized board, the spreader reads random data from its page 2
        // and copies that to a random neighbor. This IS a copy operation,
        // but it copies random junk, not the program code.
        const finalCell = readCellMemory(controller, 0, 0);
        console.log('\n  Cell (0,0) page 0 preservation (first 38 bytes = program):');
        let preserved = 0;
        for (let i = 0; i < bytes.length; i++) {
            if (finalCell[i] === bytes[i]) preserved++;
        }
        console.log(`    ${preserved}/${bytes.length} program bytes still intact`);
    });

    it('copier on randomized board: same page-read bug', async () => {
        const bytes = await assemble(PRESETS.copier.source);
        console.log('Copier reads from:');
        // LDA $0201,Y at bytes 4-6
        console.log(`  $0201,Y (page 2 byte $01+Y) — NOT where the code is`);
        console.log(`  $0101,Y (page 1 byte $01+Y) — stack page, not code`);
        console.log(`  Writes to $0801,Y and $0901,Y (cell 2, pages 0 and 1)`);
        console.log('');
        console.log(`  Code is at page 0 ($000-$${(bytes.length-1).toString(16)})`);
        console.log('  ⟹ Copier copies pages 2+1 of itself, NOT page 0 where code lives');
    });

    it('realistic MinHash test: fingerprinting with --randomize (diverse backgrounds)', async () => {
        // This simulates the REAL situation: cells have random background data
        // A "copy" means some bytes were written from cell A into cell B,
        // but the background bytes of B may be completely different from A.

        const bytes = await assemble(PRESETS.spreader.source);

        let seed = 42;
        const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };

        // Create 20 random cells, inject the program into first 5
        const cells = [];
        for (let i = 0; i < 20; i++) {
            const cell = new Uint8Array(1024);
            for (let j = 0; j < 1024; j++) cell[j] = rng() & 0xFF;
            if (i < 5) cell.set(bytes, 0); // inject program
            cells.push(cell);
        }

        console.log('20 random-background cells, first 5 have the spreader program:');
        console.log('');

        // Full range fingerprints
        const fpsFull = cells.map(c => fingerprint(c, [0, 896]));
        // Tight range fingerprints
        const fpsNarrow = cells.map(c => fingerprint(c, [0, bytes.length + 4]));

        console.log('Full range [0,896) — program-containing cells vs each other:');
        let fullTP = 0, fullFP = 0, fullFN = 0;
        for (let i = 0; i < 5; i++) {
            for (let j = i + 1; j < 5; j++) {
                const sim = minhashSimilarity(fpsFull[i].minhash, fpsFull[j].minhash);
                if (sim >= 0.6) fullTP++; else fullFN++;
            }
        }
        console.log(`  True positives (sim>=0.6 among program cells): ${fullTP}/10`);

        for (let i = 0; i < 5; i++) {
            for (let j = 5; j < 20; j++) {
                const sim = minhashSimilarity(fpsFull[i].minhash, fpsFull[j].minhash);
                if (sim >= 0.6) fullFP++;
            }
        }
        console.log(`  False positives (sim>=0.6, program vs non-program): ${fullFP}/75`);
        console.log(`  False negatives (sim<0.6, program vs program): ${fullFN}/10`);

        console.log('');
        console.log(`Narrow range [0,${bytes.length + 4}) — same test:`);
        let narrowTP = 0, narrowFP = 0, narrowFN = 0;
        for (let i = 0; i < 5; i++) {
            for (let j = i + 1; j < 5; j++) {
                const sim = minhashSimilarity(fpsNarrow[i].minhash, fpsNarrow[j].minhash);
                if (sim >= 0.6) narrowTP++; else narrowFN++;
            }
        }
        console.log(`  True positives: ${narrowTP}/10`);

        for (let i = 0; i < 5; i++) {
            for (let j = 5; j < 20; j++) {
                const sim = minhashSimilarity(fpsNarrow[i].minhash, fpsNarrow[j].minhash);
                if (sim >= 0.6) narrowFP++;
            }
        }
        console.log(`  False positives: ${narrowFP}/75`);
        console.log(`  False negatives: ${narrowFN}/10`);
    });
});
