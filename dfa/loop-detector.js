#!/usr/bin/env node
/**
 * Loop Detector + Replicator Classifier
 *
 * 1. Walk instruction boundaries from PC=0 through a cell's zero page
 * 2. At each backward branch, record a reachable loop
 * 3. Classify loop contents by counting "interesting interactions"
 * 4. Score against all 18 core variants (2 families × 3 inc/dec × 3 rotations)
 *
 * The 18 core variants:
 *
 * Family X (LDA $00,X + STA abs,X):
 *   R1a: LDA;STA;INX  R1b: LDA;INX;STA  R1c: LDA;STA;DEX
 *   R2a: STA;INX;LDA  R2b: STA;DEX;LDA  R2c: INX;LDA;STA  (= R2a entered mid-loop)
 *   ... actually 3 rotations × 3 inc/dec = 9 variants per family
 *
 * Wait — 3 inc/dec variants:
 *   1. INC after STA (standard): LDA $00,X; STA $0400,X; INX
 *   2. INC before STA (shifted): LDA $00,X; INX; STA $03FF,X
 *   3. DEC after STA:            LDA $00,X; STA $0400,X; DEX
 *
 * And 3 rotations of each:
 *   Rot 0: LDA; STA; INC; BCC
 *   Rot 1: STA; INC; LDA; BCC  (STA first)
 *   Rot 2: INC; LDA; STA; BCC  (INC first)
 *
 * Family Y (LAX $00,Y + STA abs,Y): same structure with B7/99/C8/88
 *
 * Total: 2 × 3 × 3 = 18 core variants (ignoring branch opcode choice)
 * × 8 branch opcodes = 144 patterns to test
 *
 * @module dfa/loop-detector
 */

// ── 6502 instruction length table ────────────────────────────────────
// Maps opcode → instruction length (1, 2, or 3 bytes). 0 = JAM/halt.

const OPCODE_LENGTHS = new Uint8Array(256);
{
    // Default: 1 byte (implied/accumulator)
    OPCODE_LENGTHS.fill(1);

    // 2-byte: immediate, zero page, zpx, zpy, relative, (ind,x), (ind),y
    const twoByteOpcodes = [
        // Immediate
        0x09, 0x29, 0x49, 0x69, 0xA0, 0xA2, 0xA9, 0xC0, 0xC9, 0xE0, 0xE9,
        // Zero page
        0x05, 0x06, 0x24, 0x25, 0x26, 0x45, 0x46, 0x65, 0x66, 0x84, 0x85,
        0x86, 0xA4, 0xA5, 0xA6, 0xC4, 0xC5, 0xC6, 0xE4, 0xE5, 0xE6,
        // Zero page,X
        0x15, 0x16, 0x35, 0x36, 0x55, 0x56, 0x75, 0x76, 0x94, 0x95,
        0xB4, 0xB5, 0xD5, 0xD6, 0xF5, 0xF6,
        // Zero page,Y
        0x96, 0xB6,
        // Relative (branches)
        0x10, 0x30, 0x50, 0x70, 0x90, 0xB0, 0xD0, 0xF0,
        // (Indirect,X)
        0x01, 0x21, 0x41, 0x61, 0x81, 0xA1, 0xC1, 0xE1,
        // (Indirect),Y
        0x11, 0x31, 0x51, 0x71, 0x91, 0xB1, 0xD1, 0xF1,
        // Undocumented 2-byte
        0x80, 0x82, 0x89, 0xC2, 0xE2,  // NOP imm
        0x04, 0x44, 0x64,  // NOP zpg
        0x14, 0x34, 0x54, 0x74, 0xD4, 0xF4,  // NOP zpx
        0xA7, 0xB7,  // LAX zpg, LAX zpy
        0x87, 0x97,  // SAX zpg, SAX zpy
        0xC7, 0xD7, 0xC3, 0xD3,  // DCP zpg/zpx/inx/iny
        0xE7, 0xF7, 0xE3, 0xF3,  // ISC zpg/zpx/inx/iny
        0x07, 0x17, 0x03, 0x13,  // SLO
        0x27, 0x37, 0x23, 0x33,  // RLA
        0x47, 0x57, 0x43, 0x53,  // SRE
        0x67, 0x77, 0x63, 0x73,  // RRA
        0x0B, 0x2B,  // ANC
        0x4B,  // ALR
        0x6B,  // ARR
        0xAB,  // LAX imm (unstable)
        0x8B,  // XAA (unstable)
        0xCB,  // AXS
        0xEB,  // SBC imm (undoc duplicate)
    ];
    for (const op of twoByteOpcodes) OPCODE_LENGTHS[op] = 2;

    // 3-byte: absolute, abs,X, abs,Y, indirect
    const threeByteOpcodes = [
        // Absolute
        0x0D, 0x0E, 0x20, 0x2C, 0x2D, 0x2E, 0x4C, 0x4D, 0x4E, 0x6C,
        0x6D, 0x6E, 0x8C, 0x8D, 0x8E, 0xAC, 0xAD, 0xAE, 0xCC, 0xCD,
        0xCE, 0xEC, 0xED, 0xEE,
        // Absolute,X
        0x1D, 0x1E, 0x3D, 0x3E, 0x5D, 0x5E, 0x7D, 0x7E, 0x9D, 0xBC,
        0xBD, 0xDD, 0xDE, 0xFD, 0xFE,
        // Absolute,Y
        0x19, 0x39, 0x59, 0x79, 0x99, 0xB9, 0xBE, 0xD9, 0xF9,
        // Undocumented 3-byte
        0x0C,  // NOP abs
        0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC,  // NOP abs,X
        0x0F, 0x1F, 0x1B,  // SLO abs/abx/aby
        0x2F, 0x3F, 0x3B,  // RLA
        0x4F, 0x5F, 0x5B,  // SRE
        0x6F, 0x7F, 0x7B,  // RRA
        0xAF, 0xBF, 0xB3,  // LAX abs/aby/iny
        0x8F, 0x83,  // SAX abs/inx
        0xCF, 0xDF, 0xDB,  // DCP
        0xEF, 0xFF, 0xFB,  // ISC
        0x9F, 0x93,  // AHX/SHA
        0x9B,  // TAS/SHS
        0x9C,  // SHY
        0x9E,  // SHX
        0xBB,  // LAS
    ];
    for (const op of threeByteOpcodes) OPCODE_LENGTHS[op] = 3;

    // JAM opcodes (halt CPU) — length 0 means "stop"
    for (const op of [0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72,
                       0x92, 0xB2, 0xD2, 0xF2]) {
        OPCODE_LENGTHS[op] = 0;
    }

    // BRK = 2 bytes (opcode + operand)
    OPCODE_LENGTHS[0x00] = 2;
}

// Branch opcodes
const BRANCH_OPCODES = new Set([0x10, 0x30, 0x50, 0x70, 0x90, 0xB0, 0xD0, 0xF0]);
const BRANCH_NAMES = {
    0x10: 'BPL', 0x30: 'BMI', 0x50: 'BVC', 0x70: 'BVS',
    0x90: 'BCC', 0xB0: 'BCS', 0xD0: 'BNE', 0xF0: 'BEQ',
};

// ── Loop detection ───────────────────────────────────────────────────

/**
 * Walk instruction boundaries from PC=0, find all reachable backward branches.
 *
 * @param {Uint8Array} cellBytes - first 256 bytes of a cell
 * @returns {Array<{branchPos: number, targetPos: number, branchOp: number, loopBytes: Uint8Array}>}
 */
function findReachableLoops(cellBytes) {
    const loops = [];
    let pc = 0;

    while (pc < cellBytes.length) {
        const opcode = cellBytes[pc];
        const len = OPCODE_LENGTHS[opcode];

        if (len === 0) break;  // JAM — execution halts
        if (pc + len > cellBytes.length) break;  // instruction runs off end

        if (BRANCH_OPCODES.has(opcode) && pc + 1 < cellBytes.length) {
            const offset = cellBytes[pc + 1];
            // Signed offset: target = pc + 2 + signed(offset)
            const signed_offset = offset >= 128 ? offset - 256 : offset;
            const target = pc + 2 + signed_offset;

            if (target >= 0 && target < pc) {
                // Backward branch — this is a loop!
                const loopBody = cellBytes.slice(target, pc + 2);
                loops.push({
                    branchPos: pc,
                    branchOp: opcode,
                    branchName: BRANCH_NAMES[opcode],
                    targetPos: target,
                    loopLen: pc + 2 - target,
                    loopBytes: loopBody,
                });
            }
        }

        pc += len;
    }

    return loops;
}


// ── Loop classification ──────────────────────────────────────────────

/**
 * @typedef {Object} LoopClassification
 * @property {number} level - 0-10 interest level
 * @property {string} description - human-readable description
 * @property {string[]} tags - classification tags
 * @property {Object} coreMatch - best core variant match (if any)
 */

// The 18 core variant patterns.
// Each is [family, rotation_name, components] where components is
// an ordered list of {type, opcode, operandConstraint} objects.
//
// For matching, we check if the loop body contains these components
// in the specified cyclic order.

const CORE_VARIANTS = [];

function addVariants(family, ldaOp, staOp, incOps, decOps) {
    const fName = family === 'X' ? 'X-indexed' : 'Y-indexed';
    // inc/dec × rotation
    for (const [incOp, incName, staAddr] of [
        ...incOps.map(op => [op, op === 0xE8 ? 'INX' : 'INY', 0x0400]),
        ...decOps.map(op => [op, op === 0xCA ? 'DEX' : 'DEY', 0x0400]),
    ]) {
        // Rotation 0: LDA; STA; INC
        CORE_VARIANTS.push({
            family: fName, rotation: 0,
            incName,
            description: `${fName} LDA;STA;${incName}`,
            ops: [
                { type: 'load', opcode: ldaOp, addrByte: 0x00 },
                { type: 'store', opcode: staOp, addrHi: 0x04 },
                { type: 'inc', opcode: incOp },
            ],
        });
        // Rotation 1: STA; INC; LDA
        CORE_VARIANTS.push({
            family: fName, rotation: 1,
            incName,
            description: `${fName} STA;${incName};LDA`,
            ops: [
                { type: 'store', opcode: staOp, addrHi: 0x04 },
                { type: 'inc', opcode: incOp },
                { type: 'load', opcode: ldaOp, addrByte: 0x00 },
            ],
        });
        // Rotation 2: INC; LDA; STA
        CORE_VARIANTS.push({
            family: fName, rotation: 2,
            incName,
            description: `${fName} ${incName};LDA;STA`,
            ops: [
                { type: 'inc', opcode: incOp },
                { type: 'load', opcode: ldaOp, addrByte: 0x00 },
                { type: 'store', opcode: staOp, addrHi: 0x04 },
            ],
        });
    }
}

// X-family: LDA zpx (B5), STA abs,X (9D)
addVariants('X', 0xB5, 0x9D, [0xE8], [0xCA]);
// Y-family: LAX zpy (B7), STA abs,Y (99)
addVariants('Y', 0xB7, 0x99, [0xC8], [0x88]);


/**
 * Disassemble a loop body into instruction records.
 */
function disassembleLoop(loopBytes, startPos) {
    const instrs = [];
    let pc = 0;
    while (pc < loopBytes.length) {
        const opcode = loopBytes[pc];
        const len = OPCODE_LENGTHS[opcode];
        if (len === 0 || pc + len > loopBytes.length) break;
        const operands = Array.from(loopBytes.slice(pc + 1, pc + len));
        instrs.push({
            pos: startPos + pc,
            opcode,
            len,
            operands,
        });
        pc += len;
    }
    return instrs;
}


/**
 * Count "interesting" properties of instructions in a loop.
 */
function analyzeLoop(instrs) {
    const tags = [];
    let hasLoad = false, hasStore = false, hasInc = false;
    let hasIndexedLoad = false, hasIndexedStore = false;
    let hasNeighborWrite = false, hasSelfWrite = false;
    let loadReg = null, storeReg = null, incReg = null;

    for (const instr of instrs) {
        const op = instr.opcode;
        const ops = instr.operands;

        // Loads
        if ([0xA9, 0xA5, 0xAD, 0xB5, 0xBD, 0xB9, 0xA1, 0xB1].includes(op)) {
            hasLoad = true;
            if ([0xB5, 0xBD, 0xB9, 0xA1, 0xB1].includes(op)) hasIndexedLoad = true;
            if (op === 0xB5) loadReg = 'X';
            if (op === 0xB9 || op === 0xB1) loadReg = 'Y';
        }
        // LAX
        if ([0xA7, 0xB7, 0xAF, 0xBF, 0xA3, 0xB3].includes(op)) {
            hasLoad = true; hasIndexedLoad = true;
            if (op === 0xB7) loadReg = 'Y';
        }
        // Stores
        if ([0x85, 0x8D, 0x95, 0x9D, 0x99, 0x81, 0x91].includes(op)) {
            hasStore = true;
            if ([0x95, 0x9D, 0x99, 0x81, 0x91].includes(op)) hasIndexedStore = true;
            if (op === 0x9D || op === 0x95) storeReg = 'X';
            if (op === 0x99 || op === 0x91) storeReg = 'Y';
            // Check target address
            if (instr.len === 3) {
                const addrHi = ops[1];
                if (addrHi >= 0x04 && addrHi <= 0x07) hasNeighborWrite = true;
                if (addrHi <= 0x03) hasSelfWrite = true;
            }
            if (instr.len === 2) hasSelfWrite = true;  // zpg write
        }
        // Increments
        if ([0xE8, 0xCA].includes(op)) { hasInc = true; incReg = 'X'; }
        if ([0xC8, 0x88].includes(op)) { hasInc = true; incReg = 'Y'; }
    }

    // Count interesting bytes
    let interestingCount = 0;
    if (hasLoad) interestingCount++;
    if (hasStore) interestingCount++;
    if (hasInc) interestingCount++;
    if (hasNeighborWrite) interestingCount++;
    if (hasIndexedLoad && hasIndexedStore && loadReg === storeReg) interestingCount++;

    // Tags
    if (hasLoad) tags.push('has-load');
    if (hasStore) tags.push('has-store');
    if (hasInc) tags.push('has-inc');
    if (hasIndexedLoad) tags.push('indexed-load');
    if (hasIndexedStore) tags.push('indexed-store');
    if (hasNeighborWrite) tags.push('writes-neighbor');
    if (hasSelfWrite) tags.push('writes-self');
    if (loadReg && storeReg && loadReg === storeReg) tags.push('matched-index');
    if (loadReg && storeReg && loadReg !== storeReg) tags.push('mixed-index');

    return { interestingCount, tags, hasLoad, hasStore, hasInc,
             hasIndexedLoad, hasIndexedStore, hasNeighborWrite,
             loadReg, storeReg, incReg };
}


/**
 * Score loop against all 18 core variants.
 * Returns the best match with details.
 */
function matchCoreVariants(instrs, loopBytes) {
    let bestMatch = null;
    let bestScore = 0;

    for (const variant of CORE_VARIANTS) {
        let score = 0;
        let matchedOps = [];
        let issues = [];

        // Try to find each component in order (cyclically in the loop)
        let searchFrom = 0;
        let allFound = true;

        for (const component of variant.ops) {
            let found = false;
            for (let i = searchFrom; i < instrs.length; i++) {
                const instr = instrs[i];
                if (instr.opcode === component.opcode) {
                    score++;
                    matchedOps.push(instr);

                    // Check address constraints
                    if (component.addrByte !== undefined && instr.operands[0] !== component.addrByte) {
                        issues.push(`${component.type} addr=${instr.operands[0].toString(16)} (expected ${component.addrByte.toString(16)})`);
                        score -= 0.3;
                    }
                    if (component.addrHi !== undefined && instr.len === 3 && instr.operands[1] !== component.addrHi) {
                        issues.push(`${component.type} page=${instr.operands[1].toString(16)} (expected ${component.addrHi.toString(16)})`);
                        score -= 0.3;
                    }

                    searchFrom = i + 1;
                    found = true;
                    break;
                }
            }
            if (!found) {
                allFound = false;
                issues.push(`missing ${component.type} (${component.opcode.toString(16)})`);
            }
        }

        if (score > bestScore) {
            bestScore = score;
            bestMatch = {
                variant: variant.description,
                score,
                allFound,
                matchedOps,
                issues,
            };
        }
    }

    return bestMatch;
}


/**
 * Classify a single loop.
 */
function classifyLoop(loop) {
    const instrs = disassembleLoop(loop.loopBytes, loop.targetPos);
    const analysis = analyzeLoop(instrs);
    const coreMatch = matchCoreVariants(instrs, loop.loopBytes);

    // Determine level
    let level = 1;  // has loop
    if (analysis.interestingCount >= 1) level = 2;
    if (analysis.interestingCount >= 2) level = 3;
    if (analysis.hasLoad && analysis.hasStore) level = Math.max(level, 3);
    if (analysis.hasLoad && analysis.hasStore && analysis.hasInc) level = 4;
    if (analysis.hasNeighborWrite) level = Math.max(level, 4);
    if (analysis.hasIndexedLoad && analysis.hasIndexedStore) level = Math.max(level, 5);
    if (analysis.hasNeighborWrite && analysis.hasIndexedLoad) level = Math.max(level, 5);
    if (coreMatch && coreMatch.score >= 2) level = Math.max(level, 6);
    if (coreMatch && coreMatch.allFound) level = Math.max(level, 7);
    if (coreMatch && coreMatch.allFound && coreMatch.issues.length === 0) level = 8;

    // Description
    let desc = `L${level} ${loop.branchName} loop (${loop.loopLen} bytes, pos ${loop.targetPos}-${loop.branchPos + 1})`;
    if (coreMatch && coreMatch.score >= 2) {
        desc += ` | best match: ${coreMatch.variant} (score ${coreMatch.score.toFixed(1)})`;
        if (coreMatch.issues.length > 0) desc += ` [${coreMatch.issues.join('; ')}]`;
    }

    return {
        level,
        description: desc,
        tags: analysis.tags,
        analysis,
        coreMatch,
        loop,
        instrs,
    };
}


/**
 * Analyze a full cell: find all reachable loops and classify them.
 *
 * @param {Uint8Array} cellBytes - 256 bytes of cell zero page
 * @returns {Array<Object>} classified loops, sorted by level (highest first)
 */
export function analyzeCell(cellBytes) {
    const loops = findReachableLoops(cellBytes);
    const classified = loops.map(classifyLoop);
    classified.sort((a, b) => b.level - a.level);
    return classified;
}


/**
 * Quick check: does this cell have any loop at level >= threshold?
 */
export function hasInterestingLoop(cellBytes, threshold = 4) {
    const loops = findReachableLoops(cellBytes);
    for (const loop of loops) {
        const cls = classifyLoop(loop);
        if (cls.level >= threshold) return cls;
    }
    return null;
}

export { findReachableLoops, classifyLoop, CORE_VARIANTS, OPCODE_LENGTHS, BRANCH_OPCODES };


// ── CLI demo ─────────────────────────────────────────────────────────

if (process.argv[1]?.includes('loop-detector')) {
    // Generate some biased random cells and analyze them
    const { PRNG } = await import('../webgpu/prng.js');

    const ELEVATED = new Set([
        0x00, 0x04, 0x08, 0x18, 0x1A, 0x3A, 0x48, 0x50,
        0x58, 0x5A, 0x78, 0x7A, 0x88, 0x90, 0x99, 0x9A,
        0x9D, 0xA0, 0xA8, 0xB5, 0xB7, 0xB8, 0xC8, 0xCA,
        0xD8, 0xDA, 0xE8, 0xEA, 0xF8, 0xFA,
    ]);
    const elevList = [...ELEVATED];
    const bgList = [];
    for (let i = 0; i < 256; i++) if (!ELEVATED.has(i)) bgList.push(i);

    const biasWeight = parseInt(process.argv[2] || '100');
    const numCells = parseInt(process.argv[3] || '1000');

    const N1 = elevList.length, N0 = bgList.length;
    const pElev = (N1 * biasWeight) / (N1 * biasWeight + N0);

    const rng = new PRNG(42);
    const levelCounts = new Array(11).fill(0);
    let bestSeen = null;

    console.log(`Analyzing ${numCells} biased cells (biasWeight=${biasWeight})\n`);

    for (let c = 0; c < numCells; c++) {
        // Generate biased 256-byte cell
        const cell = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            if (rng.real() < pElev) {
                cell[i] = elevList[rng.below(elevList.length)];
            } else {
                cell[i] = bgList[rng.below(bgList.length)];
            }
        }

        const results = analyzeCell(cell);
        if (results.length > 0) {
            const best = results[0];
            levelCounts[best.level]++;

            if (!bestSeen || best.level > bestSeen.level ||
                (best.level === bestSeen.level && best.coreMatch &&
                 (!bestSeen.coreMatch || best.coreMatch.score > bestSeen.coreMatch.score))) {
                bestSeen = best;
            }

            if (best.level >= 6) {
                const hex = Array.from(best.loop.loopBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
                console.log(`Cell ${c}: ${best.description}`);
                console.log(`  Loop: ${hex}`);
                console.log(`  Tags: ${best.tags.join(', ')}`);
                if (best.coreMatch) {
                    console.log(`  Core: ${best.coreMatch.variant} (${best.coreMatch.issues.join(', ') || 'perfect'})`);
                }
                console.log();
            }
        } else {
            levelCounts[0]++;
        }
    }

    console.log('\nLevel distribution:');
    for (let l = 0; l <= 10; l++) {
        if (levelCounts[l] > 0) {
            console.log(`  L${l}: ${levelCounts[l]} (${(levelCounts[l] / numCells * 100).toFixed(1)}%)`);
        }
    }

    if (bestSeen) {
        console.log(`\nBest seen: ${bestSeen.description}`);
    }
}
