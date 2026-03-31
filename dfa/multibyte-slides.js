/**
 * Multi-byte opcode slides: generate and test replicators with
 * 2-byte and 3-byte slide opcodes.
 *
 * Multi-byte opcodes are more B_eff-efficient: a 2-byte opcode
 * costs ~3.7 bits for the opcode but 0 bits for the operand
 * (~1.85 bits/byte vs 3.4 bits/byte for 1-byte slides).
 */

import { buildOpcodeTable } from '../webgpu/opcode_table.js';
import { simulateCandidate } from './simulate.js';
import { correctOffsetAt } from './reviewers/offset.js';

const opcTable = buildOpcodeTable();

// Unsafe instruction classes: writes memory, changes PC, halts
const UNSAFE_CLS = new Set([1, 4, 8, 9, 10, 11, 12, 13, 14]);
// 1=STORE, 4=BRANCH, 8=JMP_ABS, 9=JMP_IND, 10=JSR, 11=RTS, 12=RTI, 13=BRK, 14=JAM

/**
 * Get opcode info from the table.
 */
function opcInfo(op) {
    const i = op * 7;
    return {
        cls: opcTable[i],
        addrMode: opcTable[i + 1],
        oper: opcTable[i + 2],
        cycles: opcTable[i + 3],
        nbytes: opcTable[i + 5],
    };
}

/**
 * Classify an opcode as potentially safe for slides.
 * "Potentially" because flag effects depend on branch opcode.
 *
 * Returns: { safe: bool, nbytes: number, reason: string }
 */
function classifyOpcode(op) {
    const info = opcInfo(op);

    if (UNSAFE_CLS.has(info.cls))
        return { safe: false, nbytes: info.nbytes, reason: 'unsafe class' };

    if (info.cls === 2) // RMW on memory
        return { safe: false, nbytes: info.nbytes, reason: 'writes memory' };

    if (info.cls === 3) // RMW on A (ASL A, LSR A, ROL A, ROR A)
        return { safe: false, nbytes: info.nbytes, reason: 'corrupts A + sets C' };

    if (info.cls === 0) { // READ
        // LDA (oper=0), LDX (oper=1), LAX (oper=13) corrupt A or X
        if (info.oper === 0 || info.oper === 1 || info.oper === 13)
            return { safe: false, nbytes: info.nbytes, reason: 'corrupts A or X' };
    }

    if (info.cls === 7 && info.oper === 0) // PLA: corrupts A
        return { safe: false, nbytes: info.nbytes, reason: 'PLA corrupts A' };

    return { safe: true, nbytes: info.nbytes, reason: 'ok' };
}

/**
 * Build the catalog of safe slide opcodes by byte count.
 */
export function buildSlideCatalog() {
    const catalog = { 1: [], 2: [], 3: [] };

    for (let op = 0; op < 256; op++) {
        const { safe, nbytes, reason } = classifyOpcode(op);
        if (safe && catalog[nbytes]) {
            catalog[nbytes].push(op);
        }
    }

    return catalog;
}

/**
 * Build a candidate with multi-byte slides.
 *
 * @param {Object} opts
 * @param {number[][]} opts.slides - array of [position, opcode, ...operands]
 *   position: 0-3 (slide position in the template)
 * @param {Object} opts.pair - { inc, branch }
 * @returns {Uint8Array}
 */
export function buildMultibyteCandidate(opts) {
    const { slides = [], pair = { inc: 0xE8, branch: 0x90 } } = opts;

    const byPos = [[], [], [], []];
    for (const [pos, ...bytes] of slides) {
        byPos[pos].push(...bytes);
    }

    const seq = [
        ...byPos[0],
        0xB5, 0x00,
        ...byPos[1],
        0x9D, 0x00, 0x04,
        ...byPos[2],
        pair.inc,
        ...byPos[3],
        pair.branch,
    ];
    seq.push(correctOffsetAt(seq.length));
    return new Uint8Array(seq);
}

/**
 * Sweep multi-byte opcodes at a given slide position.
 * Tests each safe opcode (with random operands) across viable pairs.
 *
 * @param {number} slidePos - 0-3
 * @param {Object} [opts]
 * @param {number} [opts.passes=80]
 * @param {number} [opts.seed=42]
 * @param {number} [opts.operandTrials=3] - test this many random operand values per opcode
 * @returns {Promise<Object[]>}
 */
export async function sweepMultibyteSlides(slidePos, opts = {}) {
    const { passes = 80, seed = 42, operandTrials = 3 } = opts;
    const catalog = buildSlideCatalog();

    const PAIRS = [
        { inc: 0xE8, branch: 0x50, name: 'INX+BVC' },
        { inc: 0xE8, branch: 0x90, name: 'INX+BCC' },
        { inc: 0xCA, branch: 0x50, name: 'DEX+BVC' },
        { inc: 0xCA, branch: 0x90, name: 'DEX+BCC' },
    ];

    const results = [];

    for (const nbytes of [1, 2, 3]) {
        for (const op of catalog[nbytes]) {
            let totalSpread = 0, totalTrials = 0, totalViable = 0;

            for (const pair of PAIRS) {
                for (let trial = 0; trial < operandTrials; trial++) {
                    // Build operand bytes (random-ish, deterministic from seed)
                    const operands = [];
                    for (let i = 1; i < nbytes; i++) {
                        operands.push((seed * 31 + op * 17 + trial * 7 + i * 53) & 0xFF);
                    }

                    const bytes = buildMultibyteCandidate({
                        slides: [[slidePos, op, ...operands]],
                        pair,
                    });

                    const sim = await simulateCandidate(bytes, { passes, seed });
                    totalSpread += sim.spread;
                    totalTrials++;
                    if (sim.copied) totalViable++;
                }
            }

            results.push({
                op,
                hex: op.toString(16).padStart(2, '0'),
                nbytes,
                meanSpread: totalSpread / totalTrials,
                viableRate: totalViable / totalTrials,
                nViable: totalViable,
                nTrials: totalTrials,
            });
        }
    }

    results.sort((a, b) => b.viableRate - a.viableRate || b.meanSpread - a.meanSpread);
    return results;
}

/**
 * Compute effective B_eff per byte for different slide strategies.
 *
 * @param {Object[]} sweepResults - from sweepMultibyteSlides
 * @returns {Object}
 */
export function analyzeSlideCost(sweepResults) {
    const byNbytes = { 1: [], 2: [], 3: [] };
    for (const r of sweepResults) {
        byNbytes[r.nbytes].push(r);
    }

    const analysis = {};
    for (const [nb, ops] of Object.entries(byNbytes)) {
        const nbNum = Number(nb);
        const viable = ops.filter(o => o.viableRate > 0.5);
        const nSafe = viable.length;
        const costPerSlide = nSafe > 0 ? Math.log2(256 / nSafe) : Infinity;
        const costPerByte = costPerSlide / nbNum;

        analysis[nb] = {
            nSafe,
            nTotal: ops.length,
            costPerSlide: costPerSlide.toFixed(2),
            costPerByte: costPerByte.toFixed(2),
            examples: viable.slice(0, 5).map(o =>
                `$${o.hex} (${o.viableRate.toFixed(2)})`),
        };
    }

    return analysis;
}
