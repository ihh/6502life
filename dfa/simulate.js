/**
 * Simulation integration: test candidate byte sequences for replication.
 *
 * Places a candidate in cell (0,0) of a small board, runs it,
 * and checks whether it copies itself to neighbors.
 */

import { BareSimCPU } from '../webgpu/bare-sim-cpu.js';

/**
 * Simulate a candidate byte sequence and check for replication.
 *
 * @param {Uint8Array|number[]} cellBytes - candidate program bytes
 * @param {Object} [opts]
 * @param {number} [opts.boardSize=8] - board dimension
 * @param {number} [opts.passes=50] - scheduler passes to run
 * @param {number} [opts.seed=42] - PRNG seed
 * @returns {Promise<SimResult>}
 *
 * @typedef {Object} SimResult
 * @property {boolean} loops - T1: does the program loop (writes to neighbor)?
 * @property {boolean} copied - T2: did it copy its bytes to a neighbor?
 * @property {number} fidelity - fraction of bytes that match in best copy
 * @property {number} spread - number of cells containing a copy
 * @property {number} functional - census functional count
 */
export async function simulateCandidate(cellBytes, opts = {}) {
    const { boardSize = 8, passes = 50, seed = 42 } = opts;
    const bytes = cellBytes instanceof Uint8Array ? cellBytes : new Uint8Array(cellBytes);
    const L = bytes.length;

    const sim = new BareSimCPU(boardSize, 1024, { seed });

    // Place candidate in cell (0,0)
    sim.writeCell(0, 0, 0, bytes);
    // Init registers: PC=0, S=$FF, P=$30 (default flags)
    sim.writeCell(0, 0, 0xF9, [0x00, 0x00]); // PCHI, PCLO = 0
    sim.writeCell(0, 0, 0xFB, [0x30]);        // P
    sim.writeCell(0, 0, 0xFF, [0xFF]);         // S

    // Run
    for (let p = 0; p < passes; p++) {
        await sim.runPass();
    }

    // Check neighbors for copies
    const B = boardSize, M = 1024;
    let bestFidelity = 0;
    let spread = 0;

    for (let ci = 0; ci < B; ci++) {
        for (let cj = 0; cj < B; cj++) {
            if (ci === 0 && cj === 0) continue;
            const base = (ci * B + cj) * M;
            let matching = 0;
            for (let k = 0; k < L; k++) {
                if (sim.storage[base + k] === bytes[k]) matching++;
            }
            const fid = matching / L;
            if (fid > bestFidelity) bestFidelity = fid;
            if (fid >= 1.0) spread++;
        }
    }

    // T1: did it write anything to the neighbor region?
    // Check if any cell other than (0,0) has non-zero write activity
    let hasWrites = false;
    for (let ci = 0; ci < B; ci++) {
        for (let cj = 0; cj < B; cj++) {
            if (ci === 0 && cj === 0) continue;
            const base = (ci * B + cj) * M;
            for (let k = 0; k < L; k++) {
                if (sim.lastWrite[base + k] > 0) { hasWrites = true; break; }
            }
            if (hasWrites) break;
        }
        if (hasWrites) break;
    }

    const census = await sim.census();

    return {
        loops: hasWrites,
        copied: spread > 0,
        fidelity: bestFidelity,
        spread,
        functional: census.functional,
    };
}

/**
 * Quick check: does the candidate replicate at all?
 * Cheaper version — fewer passes, just checks copied flag.
 *
 * @param {Uint8Array|number[]} cellBytes
 * @param {Object} [opts]
 * @returns {Promise<boolean>}
 */
export async function quickReplicationCheck(cellBytes, opts = {}) {
    const result = await simulateCandidate(cellBytes, {
        passes: 30,
        seed: opts.seed || 42,
        ...opts,
    });
    return result.copied;
}
