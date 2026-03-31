/**
 * Experiment: parameter sweep + Baum-Welch weight estimation.
 *
 * For the strict 8-byte replicator, the free parameters are:
 *   addr (byte 1=3): 256 values
 *   inc/dec (byte 5): INX ($E8) or DEX ($CA)
 *   branch (byte 6): BPL($10) BMI($30) BVC($50) BVS($70)
 *                     BCC($90) BCS($B0) BNE($D0) BEQ(not valid — no opcode)
 *                     + BRK($00)
 *   offset (byte 7): determined by length (always $F8 for 8 bytes)
 *
 * The opcode reviewer allows branches: $90,$B0,$D0,$10,$30,$50,$70,$00
 * (BCC, BCS, BNE, BPL, BMI, BVC, BVS, BRK)
 */

import { simulateCandidate } from './simulate.js';
import { correctOffsetAt } from './reviewers/offset.js';

const BRANCHES = [0x10, 0x30, 0x50, 0x70, 0x90, 0xB0, 0xD0, 0x00];
const BRANCH_NAMES = {
    0x10: 'BPL', 0x30: 'BMI', 0x50: 'BVC', 0x70: 'BVS',
    0x90: 'BCC', 0xB0: 'BCS', 0xD0: 'BNE', 0x00: 'BRK',
};
const INC_OPS = [0xE8, 0xCA];
const INC_NAMES = { 0xE8: 'INX', 0xCA: 'DEX' };

export { BRANCHES, BRANCH_NAMES, INC_OPS, INC_NAMES };

/**
 * Build an 8-byte replicator from parameters.
 * @param {Object} params
 * @param {number} params.addr - source/dest address (byte 1 = byte 3)
 * @param {number} params.inc - 0xE8 (INX) or 0xCA (DEX)
 * @param {number} params.branch - branch opcode
 * @param {number} [params.length=8] - total length
 * @returns {Uint8Array}
 */
export function buildCandidate(params) {
    const { addr = 0, inc = 0xE8, branch = 0x90, length = 8 } = params;
    const offset = correctOffsetAt(length - 1);
    return new Uint8Array([0xB5, addr, 0x9D, addr, 0x04, inc, branch, offset]);
}

/**
 * Sweep branch opcodes: simulate each and return results.
 * @param {Object} [opts]
 * @param {number} [opts.addr=0] - fixed addr value
 * @param {number} [opts.inc=0xE8] - fixed inc/dec
 * @param {number} [opts.passes=80] - simulation passes
 * @param {number} [opts.seed=42] - PRNG seed
 * @returns {Promise<Object[]>}
 */
export async function sweepBranch(opts = {}) {
    const { addr = 0, inc = 0xE8, passes = 80, seed = 42 } = opts;
    const results = [];
    for (const branch of BRANCHES) {
        const bytes = buildCandidate({ addr, inc, branch });
        const sim = await simulateCandidate(bytes, { passes, seed });
        results.push({
            branch,
            name: BRANCH_NAMES[branch],
            ...sim,
            bytes: [...bytes],
        });
    }
    return results;
}

/**
 * Sweep addr values: simulate each and return results.
 * @param {Object} [opts]
 * @param {number[]} [opts.addrs] - addr values to test (default: 0-255)
 * @param {number} [opts.branch=0x90] - fixed branch
 * @param {number} [opts.inc=0xE8] - fixed inc/dec
 * @param {number} [opts.passes=80]
 * @param {number} [opts.seed=42]
 * @returns {Promise<Object[]>}
 */
export async function sweepAddr(opts = {}) {
    const {
        addrs = Array.from({ length: 256 }, (_, i) => i),
        branch = 0x90, inc = 0xE8, passes = 80, seed = 42,
    } = opts;
    const results = [];
    for (const addr of addrs) {
        const bytes = buildCandidate({ addr, inc, branch });
        const sim = await simulateCandidate(bytes, { passes, seed });
        results.push({ addr, ...sim, bytes: [...bytes] });
    }
    return results;
}

/**
 * Sweep INX vs DEX.
 */
export async function sweepInc(opts = {}) {
    const { addr = 0, branch = 0x90, passes = 80, seed = 42 } = opts;
    const results = [];
    for (const inc of INC_OPS) {
        const bytes = buildCandidate({ addr, inc, branch });
        const sim = await simulateCandidate(bytes, { passes, seed });
        results.push({ inc, name: INC_NAMES[inc], ...sim, bytes: [...bytes] });
    }
    return results;
}

/**
 * Full parameter sweep: all combinations of branch × inc.
 * (addr=0 fixed since all addrs work equivalently with enough budget.)
 *
 * @param {Object} [opts]
 * @param {number} [opts.passes=80]
 * @param {number} [opts.seed=42]
 * @returns {Promise<Object[]>}
 */
export async function fullSweep(opts = {}) {
    const { passes = 80, seed = 42 } = opts;
    const results = [];
    for (const inc of INC_OPS) {
        for (const branch of BRANCHES) {
            const bytes = buildCandidate({ addr: 0, inc, branch });
            const sim = await simulateCandidate(bytes, { passes, seed });
            results.push({
                inc, incName: INC_NAMES[inc],
                branch, branchName: BRANCH_NAMES[branch],
                ...sim,
                bytes: [...bytes],
            });
        }
    }
    return results;
}

/**
 * Estimate joint (inc, branch) weights from simulation data.
 * Returns P(replicates | inc, branch) for each combination.
 *
 * @param {Object[]} examples - from fullSweep or similar
 * @returns {Object} weights
 */
export function estimateWeights(examples) {
    // Joint weights: key = `${inc}:${branch}`
    const jointCounts = {};
    const jointSuccess = {};
    // Marginals for reporting
    const branchCounts = {}, branchSuccess = {};
    const incCounts = {}, incSuccess = {};

    for (const ex of examples) {
        const b = ex.branch, i = ex.inc;
        const key = `${i}:${b}`;
        const ok = ex.copied ? 1 : 0;

        jointCounts[key] = (jointCounts[key] || 0) + 1;
        jointSuccess[key] = (jointSuccess[key] || 0) + ok;

        branchCounts[b] = (branchCounts[b] || 0) + 1;
        branchSuccess[b] = (branchSuccess[b] || 0) + ok;
        incCounts[i] = (incCounts[i] || 0) + 1;
        incSuccess[i] = (incSuccess[i] || 0) + ok;
    }

    const jointWeights = {};
    for (const key of Object.keys(jointCounts)) {
        jointWeights[key] = jointSuccess[key] / jointCounts[key];
    }

    const branchWeights = {};
    for (const b of BRANCHES) {
        const n = branchCounts[b] || 0;
        branchWeights[b] = n > 0 ? (branchSuccess[b] || 0) / n : 0;
    }

    const incWeights = {};
    for (const i of INC_OPS) {
        const n = incCounts[i] || 0;
        incWeights[i] = n > 0 ? (incSuccess[i] || 0) / n : 0;
    }

    const totalSuccess = examples.filter(e => e.copied).length;

    return {
        jointWeights,
        branchWeights,
        incWeights,
        baseRate: examples.length > 0 ? totalSuccess / examples.length : 0,
        n: examples.length,
        nSuccess: totalSuccess,
    };
}

/**
 * Theoretical predictions for branch opcodes.
 * Given initial P=$30 (N=0, V=0, Z=0, C=0), X=0:
 *
 * The loop is: LDA zp,X / STA abs,X / INX|DEX / Bxx offset
 * The branch tests flags SET BY INX/DEX (not by LDA).
 *
 * INX: X goes 0→1→2→...→127→128(N=1)→...→255→0(Z=1)
 *   BPL: falls through at X=128 (N=1). Copies bytes 0-127. Works (spread=5).
 *   BMI: never taken first iter (X=1,N=0). Fails.
 *   BVC: always taken (V unchanged). Infinite loop. Works (spread=63).
 *   BVS: never taken (V=0). Fails.
 *   BCC: always taken (C unchanged). Infinite loop. Works (spread=63).
 *   BCS: never taken (C=0). Fails.
 *   BNE: falls through at X=0 (Z=1). Copies all 256 bytes. Works (spread=5).
 *   BRK: breaks immediately. Fails.
 *
 * DEX: X goes 0→0xFF(N=1)→0xFE→...→0x80→0x7F(N=0)→...→0x01→0x00(Z=1)
 *   BPL: X=0xFF has N=1 → NOT taken first iter. Fails.
 *   BMI: falls through at X=0x7F (N=0). Copies bytes at X=0,FF,...,80.
 *         Bytes 1-7 NOT copied (X never reaches 1-7). Fails.
 *   BVC: always taken (V unchanged). Infinite loop. Works (spread=63).
 *   BVS: never taken (V=0). Fails.
 *   BCC: always taken (C unchanged). Infinite loop. Works (spread=63).
 *   BCS: never taken (C=0). Fails.
 *   BNE: copies all 256 bytes in order 0,FF,FE,...,1 then falls through.
 *         Post-loop PC goes to byte 8 (garbage). Copy order + register save
 *         timing makes replication unreliable. Fails empirically.
 *   BRK: breaks immediately. Fails.
 */
export function theoreticalBranchPredictions() {
    return {
        INX: {
            0x10: true,   // BPL: finite loop (128 iter), copies bytes 0-127
            0x30: false,  // BMI: N=0 after first INX, never taken
            0x50: true,   // BVC: infinite loop (V unchanged)
            0x70: false,  // BVS: V=0, never taken
            0x90: true,   // BCC: infinite loop (C unchanged)
            0xB0: false,  // BCS: C=0, never taken
            0xD0: true,   // BNE: finite loop (256 iter), copies all bytes
            0x00: false,  // BRK: breaks immediately
        },
        DEX: {
            0x10: false,  // BPL: X=0xFF→N=1, not taken first iter
            0x30: false,  // BMI: copies X=0,FF..80 only — misses bytes 1-7
            0x50: true,   // BVC: infinite loop (V unchanged)
            0x70: false,  // BVS: V=0, never taken
            0x90: true,   // BCC: infinite loop (C unchanged)
            0xB0: false,  // BCS: C=0, never taken
            0xD0: false,  // BNE: copies all bytes but post-loop corruption
            0x00: false,  // BRK: breaks immediately
        },
    };
}

/**
 * Compute effective B_eff accounting for which options actually replicate.
 *
 * B_eff = sum of log2(256/N_working) for each constrained position.
 *
 * @param {Object} weights - from estimateWeights
 * @returns {Object} B_eff breakdown
 */
export function computeEffectiveBeff(weights) {
    // Position 0 (LDA): exactly 1 option → 8 bits
    const bitsLDA = 8;
    // Position 1 (addr): must be $00 for copy to land at offset 0.
    // Other values cause rotated writes (byte 0 goes to stack page).
    // Simulation-discovered constraint: 8 bits, not 0!
    const bitsAddr = 8;
    // Position 2 (STA): exactly 1 option → 8 bits
    const bitsSTA = 8;
    // Position 3 (addr): determined by pos 1 → 8 bits
    const bitsAddrMatch = 8;
    // Position 4 (page): exactly 1 option → 8 bits
    const bitsPage = 8;
    // Positions 5+6 (inc+branch jointly): count working (inc,branch) pairs
    const workingPairs = Object.values(weights.jointWeights || {}).filter(w => w > 0.5).length;
    // These 2 bytes have 256×256 = 65536 possibilities, workingPairs of which replicate
    const bitsIncBranch = Math.log2(65536 / Math.max(1, workingPairs));
    // Also compute marginals for reporting
    const workingInc = Object.values(weights.incWeights).filter(w => w > 0.5).length;
    const workingBranch = Object.values(weights.branchWeights).filter(w => w > 0.5).length;
    const bitsInc = Math.log2(256 / Math.max(1, workingInc));
    const bitsBranch = Math.log2(256 / Math.max(1, workingBranch));
    // Position 7 (offset): exactly 1 option → 8 bits
    const bitsOffset = 8;

    const total = bitsLDA + bitsAddr + bitsSTA + bitsAddrMatch +
                  bitsPage + bitsIncBranch + bitsOffset;

    return {
        bitsLDA, bitsAddr, bitsSTA, bitsAddrMatch,
        bitsPage, bitsInc, bitsBranch, bitsIncBranch, bitsOffset,
        total,
        workingInc, workingBranch, workingPairs,
    };
}

/**
 * Sample candidates using trained joint weights.
 * Samples (inc, branch) pairs proportional to joint weight,
 * then picks a random addr.
 *
 * @param {Object} weights - from estimateWeights (needs jointWeights)
 * @param {number} N - number of candidates
 * @param {Object} rng - PRNG with .real() method
 * @returns {Uint8Array[]}
 */
export function sampleWithWeights(weights, N, rng) {
    // Build list of (inc, branch) pairs with weight > 0
    const options = [];
    let totalWeight = 0;
    for (const inc of INC_OPS) {
        for (const branch of BRANCHES) {
            const key = `${inc}:${branch}`;
            const w = weights.jointWeights?.[key] ?? 0;
            if (w > 0) {
                options.push({ inc, branch, weight: w });
                totalWeight += w;
            }
        }
    }

    if (options.length === 0 || totalWeight === 0) return [];

    const samples = [];
    for (let i = 0; i < N; i++) {
        // addr=0 is the only value that produces exact self-copies.
        // Other values cause rotated writes where byte 0 misses offset 0.
        const addr = 0;

        // Weighted sample from joint distribution
        let r = rng.real() * totalWeight;
        let chosen = options[options.length - 1];
        for (const opt of options) {
            r -= opt.weight;
            if (r <= 0) { chosen = opt; break; }
        }

        samples.push(buildCandidate({ addr, inc: chosen.inc, branch: chosen.branch }));
    }
    return samples;
}

/**
 * Run the full training loop and return history.
 *
 * @param {Object} [opts]
 * @param {number} [opts.iterations=3]
 * @param {number} [opts.batchSize=16]
 * @param {number} [opts.passes=60]
 * @param {number} [opts.seed=42]
 * @returns {Promise<Object[]>} iteration history
 */
export async function runTrainingLoop(opts = {}) {
    const { iterations = 3, batchSize = 16, passes = 60, seed = 42 } = opts;

    const { PRNG } = await import('../webgpu/prng.js');
    const rng = new PRNG(seed);

    // Start with uniform joint weights
    const uniformJoint = {};
    for (const inc of INC_OPS) {
        for (const branch of BRANCHES) {
            uniformJoint[`${inc}:${branch}`] = 1;
        }
    }
    let weights = {
        jointWeights: uniformJoint,
        branchWeights: Object.fromEntries(BRANCHES.map(b => [b, 1])),
        incWeights: Object.fromEntries(INC_OPS.map(i => [i, 1])),
        baseRate: 0.5,
    };

    const history = [];

    for (let iter = 0; iter < iterations; iter++) {
        // Sample with current weights
        const candidates = sampleWithWeights(weights, batchSize, rng);

        // Simulate
        const examples = [];
        for (const bytes of candidates) {
            const sim = await simulateCandidate(bytes, { passes, seed: seed + iter });
            examples.push({
                ...sim,
                bytes: [...bytes],
                inc: bytes[5],
                branch: bytes[6],
                addr: bytes[1],
            });
        }

        // Update weights
        weights = estimateWeights(examples);

        const replicators = examples.filter(e => e.copied);
        history.push({
            iter,
            weights: { ...weights },
            replicationRate: replicators.length / examples.length,
            nReplicators: replicators.length,
            nTotal: examples.length,
            examples,
        });
    }

    return history;
}
