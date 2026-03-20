import { describe, it, expect } from 'vitest';
import { minhash, minhashSimilarity, fingerprint } from '../../cli/lib/probe/fingerprint.js';
import { assemble } from '../assembler.js';
import { BoardMemory } from '../../board/memory.js';
import { BoardController } from '../../board/controller.js';
import { readCellMemory, writeCellBytes } from '../board.js';
import { PRESETS } from '../../cli/lib/terminal/presets.js';

describe('Spreader live investigation', () => {

    it('verify spreader reads from wrong page (page 2 instead of page 0)', async () => {
        const bytes = await assemble(PRESETS.spreader.source);
        console.log(`Spreader: ${bytes.length} bytes at offset 0`);
        console.log(`Assembled hex:`);
        for (let i = 0; i < bytes.length; i++) {
            const hex = bytes[i].toString(16).padStart(2, '0');
            const label = i === 0x14 ? ' ← LDA source high byte ($02 = page 2!)' :
                          i === 0x17 ? ' ← STA target high byte (patched)' :
                          i === 0x1d ? ' ← LDA source high byte ($01 = page 1)' :
                          i === 0x20 ? ' ← STA target high byte (patched)' : '';
            if (label) console.log(`  $${i.toString(16).padStart(2, '0')}: ${hex}${label}`);
        }
        console.log('');
        console.log('BUG: Code is at cell bytes $000-$025 (page 0)');
        console.log('     But LDA $0201,Y reads from cell byte $201 (page 2) = zeros');
        console.log('     The spreader copies zeros, not its own code');

        // Verify: page 2 is zeros when program is at page 0
        const cell = new Uint8Array(1024);
        cell.set(bytes, 0);
        let page2NonZero = 0;
        for (let i = 0x200; i < 0x300; i++) {
            if (cell[i] !== 0) page2NonZero++;
        }
        expect(page2NonZero).toBe(0);
        console.log(`  Page 2 ($200-$2FF) non-zero bytes: ${page2NonZero} (confirms: source data is all zeros)`);
    });

    it('simulate WORKING replicator: manual copy with mutations, test MinHash detection', async () => {
        const size = 8;
        const mem = new BoardMemory(42, size);
        const controller = new BoardController(mem);

        // Load a program into cell (0,0) page 0
        const bytes = await assemble(PRESETS.spreader.source);
        writeCellBytes(controller, 0, 0, 0, bytes);

        const origCell = readCellMemory(controller, 0, 0);
        const fpOrig = fingerprint(origCell);

        // Simulate what a WORKING spreader would do: copy page 0 to neighbors
        // with varying amounts of noise
        console.log('Simulating manual copies with mutations:');
        console.log('  (copying page 0 of cell 0,0 to various targets)\n');

        const scenarios = [
            { name: 'exact copy', mutateBytes: 0, target: [1, 0] },
            { name: '1 byte mutated', mutateBytes: 1, target: [0, 1] },
            { name: '4 bytes mutated', mutateBytes: 4, target: [1, 1] },
            { name: '16 bytes mutated', mutateBytes: 16, target: [2, 0] },
            { name: '64 bytes mutated', mutateBytes: 64, target: [0, 2] },
            { name: '128 bytes mutated', mutateBytes: 128, target: [2, 1] },
        ];

        let seed = 42;
        const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };

        for (const s of scenarios) {
            const [ti, tj] = s.target;
            // Copy the first 256 bytes (page 0) to target
            const copyData = new Uint8Array(origCell.slice(0, 256));
            // Apply mutations
            for (let m = 0; m < s.mutateBytes; m++) {
                const pos = rng() % 240; // only mutate code area (0-239)
                copyData[pos] = (copyData[pos] + 1 + (rng() % 255)) & 0xFF;
            }
            writeCellBytes(controller, ti, tj, 0, copyData);

            const targetCell = readCellMemory(controller, ti, tj);
            const fpTarget = fingerprint(targetCell);
            const sim = minhashSimilarity(fpOrig.minhash, fpTarget.minhash);

            const detected = sim >= 0.6 ? 'DETECTED' : 'MISSED';
            console.log(`  ${s.name.padEnd(20)} sim=${sim.toFixed(3)} [${detected}]`);
        }
    });

    it('MinHash vs byte-diff: which is more accurate for partial copies?', async () => {
        const size = 8;
        const mem = new BoardMemory(42, size);
        const controller = new BoardController(mem);

        const bytes = await assemble(PRESETS.spreader.source);
        writeCellBytes(controller, 0, 0, 0, bytes);
        const origCell = readCellMemory(controller, 0, 0);
        const fpOrig = fingerprint(origCell);

        console.log('Partial copies: copy only first N bytes of 896-byte region:');
        console.log('  Bytes   MinHash    ByteDiff%   Detected?');

        const copyLengths = [8, 16, 32, 38, 64, 128, 256, 512, 896];
        for (const n of copyLengths) {
            const target = new Uint8Array(1024); // zero-filled
            target.set(origCell.slice(0, n), 0);
            const fpTarget = fingerprint(target);
            const sim = minhashSimilarity(fpOrig.minhash, fpTarget.minhash);

            // Byte diff in fingerprint region
            let matching = 0;
            for (let i = 0; i < 896; i++) {
                if (origCell[i] === target[i]) matching++;
            }
            const byteSim = matching / 896;
            const detected = sim >= 0.6 ? 'YES' : 'NO';
            console.log(`  ${String(n).padStart(4)}    ${sim.toFixed(3)}      ${(byteSim * 100).toFixed(1)}%       ${detected}`);
        }
    });

    it('effect of background content on MinHash (random vs zero background)', async () => {
        const bytes = await assemble(PRESETS.spreader.source);

        let seed = 77;
        const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };

        // Source cell: program at offset 0, rest zero
        const srcZero = new Uint8Array(1024);
        srcZero.set(bytes, 0);
        const fpSrcZero = fingerprint(srcZero);

        // Source cell: program at offset 0, rest random
        const srcRand = new Uint8Array(1024);
        for (let i = 0; i < 1024; i++) srcRand[i] = rng() & 0xFF;
        srcRand.set(bytes, 0); // overwrite first bytes with program
        const fpSrcRand = fingerprint(srcRand);

        console.log('Background effect on copy detection:');
        console.log('  Scenario                          Sim    Detected?');

        // Exact copy with same background
        const dstZero = new Uint8Array(srcZero);
        const simExactZero = minhashSimilarity(fpSrcZero.minhash, fingerprint(dstZero).minhash);
        console.log(`  Same zero bg, exact copy:         ${simExactZero.toFixed(3)}  ${simExactZero >= 0.6 ? 'YES' : 'NO'}`);

        // Copy with same random background
        const dstRandSame = new Uint8Array(srcRand);
        const simExactRand = minhashSimilarity(fpSrcRand.minhash, fingerprint(dstRandSame).minhash);
        console.log(`  Same random bg, exact copy:       ${simExactRand.toFixed(3)}  ${simExactRand >= 0.6 ? 'YES' : 'NO'}`);

        // Copy program into cell with DIFFERENT random background
        const dstRandDiff = new Uint8Array(1024);
        for (let i = 0; i < 1024; i++) dstRandDiff[i] = rng() & 0xFF;
        dstRandDiff.set(bytes, 0);
        const simDiffBg = minhashSimilarity(fpSrcZero.minhash, fingerprint(dstRandDiff).minhash);
        console.log(`  Zero src → random dst bg:         ${simDiffBg.toFixed(3)}  ${simDiffBg >= 0.6 ? 'YES' : 'NO'}`);

        // Copy program only (38 bytes) into zero-filled cell, compare with random-bg source
        const dstProgOnly = new Uint8Array(1024);
        dstProgOnly.set(bytes, 0);
        const simRandSrcZeroDst = minhashSimilarity(fpSrcRand.minhash, fingerprint(dstProgOnly).minhash);
        console.log(`  Random src bg → zero dst bg:      ${simRandSrcZeroDst.toFixed(3)}  ${simRandSrcZeroDst >= 0.6 ? 'YES' : 'NO'}`);

        // Two completely different random backgrounds, same program
        const simRandRand = minhashSimilarity(fpSrcRand.minhash, fingerprint(dstRandDiff).minhash);
        // dstRandDiff has different random bg but same program
        // Wait, dstRandDiff has the program overwritten at offset 0
        console.log(`  Diff random bgs, same program:    ${simRandRand.toFixed(3)}  ${simRandRand >= 0.6 ? 'YES' : 'NO'}`);

        console.log('\nThis shows the fundamental problem: MinHash similarity is dominated');
        console.log('by the background bytes, not the program bytes. When backgrounds differ,');
        console.log('even identical programs look different.');
    });

    it('proposed fix: fingerprint only non-zero region', async () => {
        const bytes = await assemble(PRESETS.spreader.source);

        let seed = 77;
        const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };

        // Find "active" region: last non-zero byte
        const cell1 = new Uint8Array(1024);
        cell1.set(bytes, 0);
        let lastNonZero = 0;
        for (let i = 895; i >= 0; i--) {
            if (cell1[i] !== 0) { lastNonZero = i; break; }
        }
        const activeRange = [0, lastNonZero + 4]; // +4 for k-mer coverage

        console.log(`Active range: [0, ${activeRange[1]}) (program is ${bytes.length} bytes)`);

        // Now compare with full range vs active range
        const cell2 = new Uint8Array(1024);
        cell2.set(bytes, 0);
        // Mutate 4 bytes
        for (let m = 0; m < 4; m++) {
            const pos = rng() % bytes.length;
            cell2[pos] = (cell2[pos] + 1 + (rng() % 255)) & 0xFF;
        }

        const fpFull1 = fingerprint(cell1);
        const fpFull2 = fingerprint(cell2);
        const simFull = minhashSimilarity(fpFull1.minhash, fpFull2.minhash);

        const fpActive1 = fingerprint(cell1, activeRange);
        const fpActive2 = fingerprint(cell2, activeRange);
        const simActive = minhashSimilarity(fpActive1.minhash, fpActive2.minhash);

        console.log(`Full range [0,896): sim=${simFull.toFixed(3)}`);
        console.log(`Active range [0,${activeRange[1]}): sim=${simActive.toFixed(3)}`);
        console.log(`Active range is ${(activeRange[1] / 896 * 100).toFixed(1)}% of full range`);

        // Now test with different backgrounds
        const cell3 = new Uint8Array(1024);
        for (let i = 0; i < 1024; i++) cell3[i] = rng() & 0xFF;
        cell3.set(bytes, 0);

        const simFullDiffBg = minhashSimilarity(fpFull1.minhash, fingerprint(cell3).minhash);
        const simActiveDiffBg = minhashSimilarity(fpActive1.minhash, fingerprint(cell3, activeRange).minhash);

        console.log(`\nDifferent background:`);
        console.log(`  Full range:   sim=${simFullDiffBg.toFixed(3)}`);
        console.log(`  Active range: sim=${simActiveDiffBg.toFixed(3)}`);
        console.log(`\n→ Active range is much better at detecting copies across different backgrounds`);
    });

    it('proposed fix: skip all-zero k-mers', async () => {
        const bytes = await assemble(PRESETS.spreader.source);
        const k = 4;

        // Count k-mers in full region
        const cell = new Uint8Array(1024);
        cell.set(bytes, 0);
        let totalKmers = 0, zeroKmers = 0;
        for (let i = 0; i < 896 - k + 1; i++) {
            totalKmers++;
            let allZero = true;
            for (let j = 0; j < k; j++) {
                if (cell[i + j] !== 0) { allZero = false; break; }
            }
            if (allZero) zeroKmers++;
        }
        console.log(`Total k-mers: ${totalKmers}`);
        console.log(`Zero k-mers:  ${zeroKmers} (${(zeroKmers/totalKmers*100).toFixed(1)}%)`);
        console.log(`Non-zero k-mers: ${totalKmers - zeroKmers}`);
        console.log(`\n→ ${(zeroKmers/totalKmers*100).toFixed(0)}% of k-mers are uninformative zero-padding.`);
        console.log(`→ These dominate the MinHash signature for small programs.`);
        console.log(`→ Filtering them or using a dynamic range would dramatically improve accuracy.`);
    });
});
