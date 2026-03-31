/**
 * Multi-slide training: generate candidates with 1-byte opcode slides
 * at various positions, simulate, and learn per-position weights.
 *
 * The 29 non-lethal single-byte opcodes (from prefix sweep) are:
 *   24 safe (P=1.0 with all 4 viable pairs)
 *    5 risky (P=0.5 — carry-setters, kill BCC but not BVC)
 *
 * Multi-slide interactions can produce new probability values:
 * e.g., SEC (sets C) then CLC (clears C) → BCC survives.
 */

import { simulateCandidate } from './simulate.js';
import { correctOffsetAt } from './reviewers/offset.js';
import { PRNG } from '../webgpu/prng.js';

// 24 safe single-byte opcodes (from prefix sweep, all P=1.0)
const SAFE_OPS = [
    0x08, 0x18, 0x1A, 0x28, 0x3A, 0x48, 0x58, 0x5A,
    0x60, 0x68, 0x78, 0x7A, 0x88, 0x8A, 0x98, 0x9A,
    0xA8, 0xB8, 0xC8, 0xD8, 0xDA, 0xEA, 0xF8, 0xFA,
];

// 5 risky single-byte opcodes (carry-setters, P=0.5)
const RISKY_OPS = [0x0A, 0x2A, 0x38, 0x4A, 0x6A];

const ALL_SLIDE_OPS = [...SAFE_OPS, ...RISKY_OPS];

// The 4 viable (inc, branch) pairs
const VIABLE_PAIRS = [
    { inc: 0xE8, branch: 0x50, name: 'INX+BVC' },
    { inc: 0xE8, branch: 0x90, name: 'INX+BCC' },
    { inc: 0xCA, branch: 0x50, name: 'DEX+BVC' },
    { inc: 0xCA, branch: 0x90, name: 'DEX+BCC' },
];

export { SAFE_OPS, RISKY_OPS, ALL_SLIDE_OPS, VIABLE_PAIRS };

// Slide insertion points in the 8-byte template:
// [slide0*] B5 00 [slide1*] 9D 00 04 [slide2*] INC [slide3*] BRANCH OFFSET
// slide0: before LDA
// slide1: between addr and STA
// slide2: between page and INC
// slide3: between INC and BRANCH
const SLIDE_POSITIONS = [0, 2, 5, 7]; // indices into the base 8-byte template

/**
 * Build a candidate with slide bytes inserted at specified positions.
 *
 * @param {Object} opts
 * @param {number[][]} opts.slides - array of [position, opcode] pairs.
 *   Position 0 = before LDA, 1 = between addr and STA, 2 = between page
 *   and INC, 3 = between INC and branch.
 * @param {Object} opts.pair - { inc, branch }
 * @returns {Uint8Array}
 */
export function buildSlideCandidate(opts) {
    const { slides = [], pair = VIABLE_PAIRS[0] } = opts;

    // Organize slides by position (each position can have multiple insertions)
    const byPos = [[], [], [], []]; // positions 0-3
    for (const [pos, op] of slides) {
        byPos[pos].push(op);
    }

    // Build sequence
    const seq = [
        ...byPos[0],           // slide0: before LDA
        0xB5, 0x00,            // LDA $00,X
        ...byPos[1],           // slide1: between addr and STA
        0x9D, 0x00, 0x04,      // STA $0400,X
        ...byPos[2],           // slide2: between page and INC
        pair.inc,               // INX or DEX
        ...byPos[3],           // slide3: between INC and branch
        pair.branch,            // branch opcode
    ];

    // Append correct offset for this total length
    const offset = correctOffsetAt(seq.length);
    seq.push(offset);

    return new Uint8Array(seq);
}

/**
 * Generate random multi-slide candidates.
 *
 * @param {number} N - number of candidates
 * @param {Object} rng - PRNG
 * @param {Object} [opts]
 * @param {number} [opts.maxSlides=3] - max total slide bytes
 * @param {number} [opts.maxPerPos=2] - max slides at one position
 * @returns {Object[]} candidates with metadata
 */
export function generateCandidates(N, rng, opts = {}) {
    const { maxSlides = 3, maxPerPos = 2 } = opts;
    const candidates = [];

    for (let i = 0; i < N; i++) {
        // Random pair
        const pair = VIABLE_PAIRS[rng.below(VIABLE_PAIRS.length)];

        // Random number of slides (0 to maxSlides)
        const nSlides = rng.below(maxSlides + 1);

        const slides = [];
        for (let s = 0; s < nSlides; s++) {
            const pos = rng.below(4); // which slide position
            const op = ALL_SLIDE_OPS[rng.below(ALL_SLIDE_OPS.length)];
            slides.push([pos, op]);
        }

        const bytes = buildSlideCandidate({ slides, pair });

        candidates.push({
            bytes,
            pair,
            slides,
            length: bytes.length,
        });
    }

    return candidates;
}

/**
 * Simulate a batch of candidates and record results.
 *
 * @param {Object[]} candidates - from generateCandidates
 * @param {Object} [opts]
 * @param {number} [opts.passes=80]
 * @param {number} [opts.seed=42]
 * @returns {Promise<Object[]>}
 */
export async function simulateBatch(candidates, opts = {}) {
    const { passes = 80, seed = 42 } = opts;
    const results = [];

    for (const c of candidates) {
        const sim = await simulateCandidate(c.bytes, { passes, seed });
        results.push({
            ...c,
            spread: sim.spread,
            copied: sim.copied,
            fidelity: sim.fidelity,
        });
    }

    return results;
}

/**
 * Train per-opcode, per-position weights from simulation results.
 *
 * For each (position, opcode) pair, computes:
 *   P(spread | opcode at position)
 *
 * Also computes interaction effects for multi-slide combinations.
 *
 * @param {Object[]} results - from simulateBatch
 * @returns {Object}
 */
export function trainSlideWeights(results) {
    // Per (position, opcode) counts
    const counts = {};  // key = `${pos}:${op}` → { total, spread }
    // Per pair counts
    const pairCounts = {};

    // Baseline: no-slide rate per pair
    const baseCounts = {};

    for (const r of results) {
        const pairKey = r.pair.name;
        pairCounts[pairKey] = pairCounts[pairKey] || { total: 0, spread: 0 };
        pairCounts[pairKey].total++;
        if (r.copied) pairCounts[pairKey].spread++;

        if (r.slides.length === 0) {
            baseCounts[pairKey] = baseCounts[pairKey] || { total: 0, spread: 0 };
            baseCounts[pairKey].total++;
            if (r.copied) baseCounts[pairKey].spread++;
        }

        // Record each slide opcode's contribution
        for (const [pos, op] of r.slides) {
            const key = `${pos}:${op.toString(16).padStart(2, '0')}`;
            counts[key] = counts[key] || { total: 0, spread: 0, op, pos };
            counts[key].total++;
            if (r.copied) counts[key].spread++;
        }
    }

    // Compute weights
    const weights = {};
    for (const [key, c] of Object.entries(counts)) {
        weights[key] = {
            p: c.total > 0 ? c.spread / c.total : 0,
            total: c.total,
            spread: c.spread,
            op: c.op,
            pos: c.pos,
        };
    }

    // Base rates
    const baseRates = {};
    for (const [key, c] of Object.entries(baseCounts)) {
        baseRates[key] = c.total > 0 ? c.spread / c.total : 0;
    }

    const totalSpread = results.filter(r => r.copied).length;

    return {
        weights,
        pairCounts,
        baseRates,
        overallRate: results.length > 0 ? totalSpread / results.length : 0,
        n: results.length,
        nSpread: totalSpread,
    };
}

/**
 * Run the full multi-slide training experiment.
 *
 * @param {Object} [opts]
 * @param {number} [opts.batchSize=200]
 * @param {number} [opts.passes=80]
 * @param {number} [opts.seed=42]
 * @param {number} [opts.maxSlides=3]
 * @returns {Promise<Object>}
 */
export async function runSlideExperiment(opts = {}) {
    const { batchSize = 200, passes = 80, seed = 42, maxSlides = 3 } = opts;
    const rng = new PRNG(seed);

    const candidates = generateCandidates(batchSize, rng, { maxSlides });
    const results = await simulateBatch(candidates, { passes, seed });
    const trained = trainSlideWeights(results);

    return { candidates, results, trained };
}
