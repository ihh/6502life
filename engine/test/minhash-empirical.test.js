import { describe, it, expect } from 'vitest';
import { minhash, minhashSimilarity, fingerprint } from '../../cli/lib/probe/fingerprint.js';
import { assemble } from '../assembler.js';
import { BoardMemory } from '../../board/memory.js';
import { BoardController } from '../../board/controller.js';
import { readCellMemory, writeCellBytes } from '../board.js';
import { PRESETS } from '../../cli/lib/terminal/presets.js';

// Helper: reset sfotty internal state before each interrupt.
// The controller doesn't reset crashed/cycleCounter/operations between cells,
// so a crash in one cell's decode() leaves stale state that causes assertion
// failures when the next cell tries to run.
function safeRunToNextInterrupt(controller) {
    controller.sfotty.crashed = false;
    controller.sfotty.cycleCounter = 0;
    controller.sfotty.operations = [() => controller.sfotty.decode()];
    return controller.runToNextInterrupt();
}

// Helper: build a cell buffer with program at offset 0, rest zero
async function makeCell(source, fill = 0) {
    const bytes = await assemble(source);
    const cell = new Uint8Array(1024).fill(fill);
    cell.set(bytes, 0);
    return cell;
}

// Helper: mutate n random bytes in a buffer
function mutateBytes(buf, n, rng) {
    const copy = new Uint8Array(buf);
    for (let i = 0; i < n; i++) {
        const pos = rng() % 896; // code region only
        copy[pos] = (copy[pos] + 1 + (rng() % 255)) & 0xFF;
    }
    return copy;
}

// Simple PRNG for reproducibility
function makeRng(seed) {
    let s = seed;
    return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
}

describe('MinHash empirical analysis', () => {

    // ===== EXPERIMENT 1: Exact copies =====
    describe('exact copies of spreader programs', () => {
        for (const [key, preset] of Object.entries(PRESETS)) {
            it(`${key}: exact copy has similarity 1.0`, async () => {
                const cell = await makeCell(preset.source);
                const fpA = fingerprint(cell);
                const fpB = fingerprint(cell);
                expect(minhashSimilarity(fpA.minhash, fpB.minhash)).toBe(1.0);
            });
        }
    });

    // ===== EXPERIMENT 2: Program in zero vs random background =====
    describe('same program, different background fill', () => {
        const fills = [0x00, 0xEA, 0xFF];
        for (const [key, preset] of Object.entries(PRESETS)) {
            it(`${key}: similarity across fill values`, async () => {
                const bytes = await assemble(preset.source);
                const cells = fills.map(fill => {
                    const c = new Uint8Array(1024).fill(fill);
                    c.set(bytes, 0);
                    return c;
                });
                const fps = cells.map(c => fingerprint(c));
                // Compare zero-fill vs NOP-fill, zero-fill vs FF-fill
                const sim01 = minhashSimilarity(fps[0].minhash, fps[1].minhash);
                const sim02 = minhashSimilarity(fps[0].minhash, fps[2].minhash);
                // These should be LOW since most of the 896 bytes differ
                // (program is small, background dominates the k-mer set)
                console.log(`  ${key} (${bytes.length}B): zero-vs-NOP=${sim01.toFixed(3)}, zero-vs-FF=${sim02.toFixed(3)}`);
            });
        }
    });

    // ===== EXPERIMENT 3: Mutation sensitivity =====
    describe('mutation sensitivity (how many byte changes before detection fails)', () => {
        const mutationCounts = [1, 2, 4, 8, 16, 32, 64, 128];

        for (const key of ['spreader', 'copier', 'counter']) {
            it(`${key}: similarity vs mutation count`, async () => {
                const cell = await makeCell(PRESETS[key].source);
                const fpOrig = fingerprint(cell);
                const rng = makeRng(42);
                const results = [];

                for (const n of mutationCounts) {
                    // Average over 10 trials
                    let totalSim = 0;
                    for (let trial = 0; trial < 10; trial++) {
                        const mutated = mutateBytes(cell, n, rng);
                        const fpMut = fingerprint(mutated);
                        totalSim += minhashSimilarity(fpOrig.minhash, fpMut.minhash);
                    }
                    const avgSim = totalSim / 10;
                    results.push({ mutations: n, similarity: avgSim });
                }

                console.log(`  ${key} mutation curve:`);
                for (const r of results) {
                    const bar = '#'.repeat(Math.round(r.similarity * 40));
                    console.log(`    ${String(r.mutations).padStart(3)} mutations: sim=${r.similarity.toFixed(3)} ${bar}`);
                }

                // 1 mutation should still be similar (threshold lower for tiny programs like counter)
                expect(results[0].similarity).toBeGreaterThan(0.5);
            });
        }
    });

    // ===== EXPERIMENT 4: Cross-program false positives =====
    describe('cross-program similarity (false positive risk)', () => {
        it('all preset pairs: similarity matrix', async () => {
            const keys = Object.keys(PRESETS);
            const cells = {};
            for (const k of keys) {
                cells[k] = await makeCell(PRESETS[k].source);
            }
            const fps = {};
            for (const k of keys) {
                fps[k] = fingerprint(cells[k]);
            }

            console.log('  Cross-program similarity matrix (zero-filled background):');
            const header = '          ' + keys.map(k => k.slice(0, 7).padStart(8)).join('');
            console.log(header);

            let falsePositives = 0;
            for (const a of keys) {
                const row = keys.map(b => {
                    const sim = minhashSimilarity(fps[a].minhash, fps[b].minhash);
                    if (a !== b && sim >= 0.6) falsePositives++;
                    return sim.toFixed(2).padStart(8);
                }).join('');
                console.log(`  ${a.slice(0, 8).padEnd(10)}${row}`);
            }

            // With zero-filled background, small programs will look very similar
            // because the k-mer set is dominated by 00 00 00 00
            console.log(`  False positives (sim >= 0.6, excluding self): ${falsePositives}`);
        });
    });

    // ===== EXPERIMENT 5: The zero-fill problem =====
    describe('zero-fill dominance: program size vs background', () => {
        it('similarity of different-size programs in zero-filled cells', async () => {
            // Two completely different programs in zero-filled 896-byte cells
            // The k-mer set is 893 k-mers. If program is 20 bytes, that's ~17 program k-mers
            // vs ~873 zero k-mers. The zero k-mers are all the same (00 00 00 00),
            // so they contribute only 1 unique k-mer to the set.
            //
            // But wait - the zero k-mers are all IDENTICAL (hash to same value),
            // so they only contribute 1 minimum. The program k-mers may or may not
            // beat that minimum across the 32 hash functions.

            const sizes = [8, 16, 32, 64, 128, 256, 512];
            console.log('  Program-size vs similarity (random programs in zero-filled cells):');

            const rng = makeRng(123);
            for (const sz of sizes) {
                let totalSim = 0;
                const trials = 20;
                for (let t = 0; t < trials; t++) {
                    const a = new Uint8Array(1024);
                    const b = new Uint8Array(1024);
                    for (let i = 0; i < sz; i++) {
                        a[i] = rng() & 0xFF;
                        b[i] = rng() & 0xFF;
                    }
                    const fpA = fingerprint(a);
                    const fpB = fingerprint(b);
                    totalSim += minhashSimilarity(fpA.minhash, fpB.minhash);
                }
                const avgSim = totalSim / trials;
                const bar = '#'.repeat(Math.round(avgSim * 40));
                console.log(`    ${String(sz).padStart(3)}B program: avg_sim=${avgSim.toFixed(3)} ${bar}`);
            }
        });
    });

    // ===== EXPERIMENT 6: k-mer composition analysis =====
    describe('k-mer composition', () => {
        it('counts unique k-mers in typical cells', async () => {
            console.log('  Unique 4-mer counts in 896-byte fingerprint region:');
            const k = 4;
            const regionLen = 896;

            for (const [key, preset] of Object.entries(PRESETS)) {
                const cell = await makeCell(preset.source);
                const bytes = await assemble(preset.source);
                const kmers = new Set();
                for (let i = 0; i < regionLen - k + 1; i++) {
                    const kmer = (cell[i] << 24) | (cell[i+1] << 16) | (cell[i+2] << 8) | cell[i+3];
                    kmers.add(kmer);
                }
                const maxKmers = regionLen - k + 1;
                console.log(`    ${key.padEnd(12)} ${bytes.length}B code, ${kmers.size} unique k-mers / ${maxKmers} total (${(kmers.size/maxKmers*100).toFixed(1)}% unique)`);
            }

            // Also test a random-filled cell
            const randCell = new Uint8Array(1024);
            const rng = makeRng(42);
            for (let i = 0; i < 1024; i++) randCell[i] = rng() & 0xFF;
            const kmers = new Set();
            for (let i = 0; i < regionLen - k + 1; i++) {
                const kmer = (randCell[i] << 24) | (randCell[i+1] << 16) | (randCell[i+2] << 8) | randCell[i+3];
                kmers.add(kmer);
            }
            console.log(`    ${'random'.padEnd(12)} 896B code, ${kmers.size} unique k-mers / ${regionLen - k + 1} total`);
        });
    });

    // ===== EXPERIMENT 7: Alternative fingerprint ranges =====
    describe('fingerprint range alternatives', () => {
        it('code-only range vs full range similarity', async () => {
            console.log('  Effect of fingerprint range on cross-program similarity:');
            const presets = ['spreader', 'copier', 'counter', 'nop'];

            for (const range of [[0, 896], [0, 256], [0, 64]]) {
                const fps = {};
                for (const k of presets) {
                    const cell = await makeCell(PRESETS[k].source);
                    fps[k] = fingerprint(cell, range);
                }

                // Average cross-program similarity
                let totalSim = 0, count = 0;
                for (let i = 0; i < presets.length; i++) {
                    for (let j = i + 1; j < presets.length; j++) {
                        totalSim += minhashSimilarity(fps[presets[i]].minhash, fps[presets[j]].minhash);
                        count++;
                    }
                }
                const avgCross = totalSim / count;
                console.log(`    range [${range[0]}, ${range[1]}): avg cross-similarity = ${avgCross.toFixed(3)}`);
            }
        });
    });

    // ===== EXPERIMENT 8: Actual simulation - spreader after N interrupts =====
    describe('live simulation: spreader replication detection', () => {
        it('tracks similarity of copies during actual spreading', async () => {
            const size = 8;
            const mem = new BoardMemory(42, size);
            const controller = new BoardController(mem);

            // Load spreader into cell (0,0)
            const bytes = await assemble(PRESETS.spreader.source);
            writeCellBytes(controller, 0, 0, 0, bytes);

            // Fingerprint the original
            const origCell = readCellMemory(controller, 0, 0);
            const fpOrig = fingerprint(origCell);

            // Run simulation and check periodically
            const checkpoints = [100, 500, 1000, 2000, 5000];
            let interrupts = 0;

            console.log('  Live spreader simulation (8x8 board):');
            console.log('    After N interrupts: cells with sim >= 0.6, max similarity, cells with exact hash match');

            for (const target of checkpoints) {
                while (interrupts < target) {
                    safeRunToNextInterrupt(controller);
                    interrupts++;
                }

                let highSim = 0;
                let exactMatches = 0;
                let aboveThreshold = 0;
                const sims = [];

                for (let i = 0; i < size; i++) {
                    for (let j = 0; j < size; j++) {
                        if (i === 0 && j === 0) continue;
                        const cellBytes = readCellMemory(controller, i, j);
                        const fp = fingerprint(cellBytes);
                        const sim = minhashSimilarity(fpOrig.minhash, fp.minhash);
                        if (sim > highSim) highSim = sim;
                        if (sim >= 0.6) aboveThreshold++;
                        if (fp.hash === fpOrig.hash) exactMatches++;
                        if (sim > 0) sims.push(sim);
                    }
                }

                console.log(`    ${String(interrupts).padStart(5)} interrupts: ${aboveThreshold} cells >= 0.6, max_sim=${highSim.toFixed(3)}, exact=${exactMatches}`);
            }
        });
    });

    // ===== EXPERIMENT 9: numHashes parameter sweep =====
    describe('numHashes parameter sensitivity', () => {
        it('similarity estimation variance at different numHashes', async () => {
            const cellA = await makeCell(PRESETS.spreader.source);
            const rng = makeRng(99);
            const cellB = mutateBytes(cellA, 16, rng);

            console.log('  numHashes vs similarity estimate (spreader + 16 mutations):');
            for (const nH of [8, 16, 32, 64, 128, 256]) {
                const trials = 50;
                const sims = [];
                // Re-compute with different seeds to see variance
                // (Our implementation is deterministic, so measure across different mutation sets)
                for (let t = 0; t < trials; t++) {
                    const mutated = mutateBytes(cellA, 16, rng);
                    const sigA = minhash(cellA, 0, 896, 4, nH);
                    const sigB = minhash(mutated, 0, 896, 4, nH);
                    sims.push(minhashSimilarity(sigA, sigB));
                }
                const mean = sims.reduce((a, b) => a + b) / sims.length;
                const variance = sims.reduce((a, b) => a + (b - mean) ** 2, 0) / sims.length;
                const std = Math.sqrt(variance);
                console.log(`    nH=${String(nH).padStart(3)}: mean=${mean.toFixed(3)}, std=${std.toFixed(3)}, range=[${Math.min(...sims).toFixed(3)}, ${Math.max(...sims).toFixed(3)}]`);
            }
        });
    });

    // ===== EXPERIMENT 10: k (shingle size) sweep =====
    describe('k (shingle size) parameter sensitivity', () => {
        it('cross-program similarity at different k values', async () => {
            const presets = ['spreader', 'copier', 'counter', 'nop', 'painter'];
            const cells = {};
            for (const p of presets) cells[p] = await makeCell(PRESETS[p].source);

            console.log('  k (shingle size) vs avg cross-program similarity (zero-fill):');
            for (const k of [2, 3, 4, 5, 6, 8]) {
                let totalCross = 0, totalSelf = 0, count = 0;
                for (let i = 0; i < presets.length; i++) {
                    for (let j = i + 1; j < presets.length; j++) {
                        const sigA = minhash(cells[presets[i]], 0, 896, k, 32);
                        const sigB = minhash(cells[presets[j]], 0, 896, k, 32);
                        totalCross += minhashSimilarity(sigA, sigB);
                        count++;
                    }
                }

                // Also measure copy detection (spreader + 8 mutations)
                const rng = makeRng(42);
                for (let t = 0; t < 10; t++) {
                    const mutated = mutateBytes(cells.spreader, 8, rng);
                    const sigA = minhash(cells.spreader, 0, 896, k, 32);
                    const sigB = minhash(mutated, 0, 896, k, 32);
                    totalSelf += minhashSimilarity(sigA, sigB);
                }
                const avgCross = totalCross / count;
                const avgMutant = totalSelf / 10;
                console.log(`    k=${k}: cross=${avgCross.toFixed(3)}, mutant_detect=${avgMutant.toFixed(3)}, gap=${(avgMutant - avgCross).toFixed(3)}`);
            }
        });
    });
});
