/**
 * SCFG organism generator: construct replicator programs pseudorandomly.
 *
 * Given a seed, deterministically produces a viable self-replicating 6502
 * program with controlled randomness. The grammar ensures structural
 * validity (correct opcodes, branch offsets) while allowing variation
 * in length, insert opcodes, and rare exotic behavior.
 *
 * Three core types (fitness tiers):
 *   1. BRK-reset (7 bytes, fastest): B5 00 9D 00 04 {E8|CA} 00
 *   2. Branch loop (8 bytes, common): B5 00 9D 00 04 {E8|CA} {90|50} offset
 *   3. Extended (9+ bytes, rare): core with safe inserts, rare risky ops
 *
 * @module coin/organism-generator
 */

import { PRNG } from '../webgpu/prng.js';

// ── Safe insert opcodes ──────────────────────────────────────────────

/** Single-byte opcodes that don't affect the copy loop. */
const SAFE_1BYTE = [
    0xEA, // NOP
    0xC8, // INY
    0x88, // DEY
    0xA8, // TAY
    0x18, // CLC
    0x58, // CLI
    0x78, // SEI
    0xB8, // CLV
    0xD8, // CLD
    0xF8, // SED
    0x48, // PHA
    0x08, // PHP
    0x9A, // TXS
    // Undocumented single-byte NOPs
    0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA,
];

/** Two-byte opcodes: prefix + any operand byte. */
const SAFE_2BYTE_PREFIX = [
    0xA0, // LDY #imm
    0x80, 0x82, 0x89, 0xC2, 0xE2,  // undocumented 2-byte NOPs
];

/** Three-byte undocumented NOPs (abs addressing, read-only). */
const SAFE_3BYTE_PREFIX = [
    0x0C, // NOP abs
    0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC,  // NOP abs,X
];

/**
 * "Risky" single-byte opcodes that might create interesting behavior.
 * These are safe in SOME contexts but can interact with the copy loop
 * in unexpected ways (e.g., affecting flags, stack, or register state).
 */
const RISKY_1BYTE = [
    0x98, // TYA — clobbers A (safe after STA, before LDA)
    0x68, // PLA — pops A from stack (unpredictable A value)
    0x28, // PLP — pops flags (might set carry/overflow)
    0xBA, // TSX — clobbers X with stack pointer!
    0xAA, // TAX — clobbers X with A!
];


// ── SCFG production rules ────────────────────────────────────────────

/**
 * Generate a replicator program from a seed.
 *
 * @param {number} seed - integer seed for the PRNG
 * @param {Object} [opts]
 * @param {number} [opts.pBrk=0.3] - probability of BRK-reset core (fastest)
 * @param {number} [opts.pBranch=0.5] - probability of branch-loop core
 * @param {number} [opts.pExtended=0.2] - probability of extended core
 * @param {number} [opts.pInsert=0.3] - probability of inserting at each slot
 * @param {number} [opts.pRisky=0.05] - probability of risky opcode per insert
 * @param {number} [opts.p2byte=0.15] - probability of 2-byte insert
 * @param {number} [opts.p3byte=0.05] - probability of 3-byte insert
 * @param {number} [opts.maxInserts=4] - max total insert bytes per slot
 * @returns {{ program: Uint8Array, type: string, length: number, description: string }}
 */
export function generateOrganism(seed, opts = {}) {
    const rng = new PRNG(seed);

    const pBrk = opts.pBrk ?? 0.3;
    const pBranch = opts.pBranch ?? 0.5;
    // pExtended = 1 - pBrk - pBranch
    const pInsert = opts.pInsert ?? 0.3;
    const pRisky = opts.pRisky ?? 0.05;
    const p2byte = opts.p2byte ?? 0.15;
    const p3byte = opts.p3byte ?? 0.05;
    const maxInserts = opts.maxInserts ?? 4;

    // Choose core type
    const r = rng.real();
    let type, useBrk;
    if (r < pBrk) {
        type = 'brk';
        useBrk = true;
    } else if (r < pBrk + pBranch) {
        type = 'branch';
        useBrk = false;
    } else {
        type = 'extended';
        useBrk = false;
    }

    // Choose increment opcode
    const incOp = rng.int() & 1 ? 0xE8 : 0xCA;  // INX or DEX
    const incName = incOp === 0xE8 ? 'INX' : 'DEX';

    // For branch cores, choose branch opcode
    const branchOp = rng.int() & 1 ? 0x90 : 0x50;  // BCC or BVC
    const branchName = branchOp === 0x90 ? 'BCC' : 'BVC';

    // Generate inserts for each slot
    function generateInserts(slotName) {
        const bytes = [];
        if (type !== 'extended' && slotName !== 'prefix' && slotName !== 'suffix') {
            return bytes;  // non-extended cores get no mid-inserts
        }
        let remaining = maxInserts;
        while (remaining > 0 && rng.real() < pInsert) {
            const ir = rng.real();
            if (ir < p3byte && remaining >= 3) {
                // 3-byte insert
                bytes.push(SAFE_3BYTE_PREFIX[rng.below(SAFE_3BYTE_PREFIX.length)]);
                bytes.push(rng.below(256));
                bytes.push(rng.below(256));
                remaining -= 3;
            } else if (ir < p3byte + p2byte && remaining >= 2) {
                // 2-byte insert
                bytes.push(SAFE_2BYTE_PREFIX[rng.below(SAFE_2BYTE_PREFIX.length)]);
                bytes.push(rng.below(256));
                remaining -= 2;
            } else {
                // 1-byte insert
                if (rng.real() < pRisky) {
                    bytes.push(RISKY_1BYTE[rng.below(RISKY_1BYTE.length)]);
                } else {
                    bytes.push(SAFE_1BYTE[rng.below(SAFE_1BYTE.length)]);
                }
                remaining -= 1;
            }
        }
        return bytes;
    }

    // Build the program
    const parts = [];
    let description = '';

    // Prefix inserts (I₀)
    const prefix = generateInserts('prefix');
    parts.push(...prefix);

    // Core: LDA $00,X; STA $0400,X
    const m1Pos = parts.length;
    parts.push(0xB5, 0x00);   // LDA $00,X

    // Mid inserts between LDA and STA (I₁)
    const mid1 = generateInserts('mid1');
    parts.push(...mid1);

    parts.push(0x9D, 0x00, 0x04);  // STA $0400,X

    // Mid inserts between STA and inc (I₂)
    const mid2 = generateInserts('mid2');
    parts.push(...mid2);

    parts.push(incOp);  // INX or DEX

    if (useBrk) {
        // BRK-reset core: just BRK
        parts.push(0x00);  // BRK
        description = `BRK-reset ${incName}`;
    } else {
        // Mid inserts between inc and branch (I₃)
        const mid3 = generateInserts('mid3');
        parts.push(...mid3);

        // Branch opcode
        parts.push(branchOp);

        // Branch offset: target = m1Pos, current = parts.length (offset byte position)
        const offsetPos = parts.length;
        const offset = (m1Pos - offsetPos - 1) & 0xFF;
        parts.push(offset);

        description = `${branchName}/${incName}`;
        if (type === 'extended') {
            const totalInserts = prefix.length + mid1.length + mid2.length + mid3.length;
            description += ` +${totalInserts} inserts`;
        }
    }

    const program = new Uint8Array(parts);

    return {
        program,
        type,
        length: program.length,
        description,
        seed,
        m1Pos,
    };
}


/**
 * Generate a board with a pseudorandom organism placed on it.
 *
 * @param {number} seed - master seed
 * @param {number} boardSize - board dimension
 * @param {Object} [opts] - organism generation options
 * @returns {{ organism: Object, cellI: number, cellJ: number, boardSeed: number }}
 */
export function generateBoardWithOrganism(seed, boardSize = 64, opts = {}) {
    const rng = new PRNG(seed);

    // Split seed into board seed and organism seed
    const boardSeed = rng.int();
    const organismSeed = rng.int();

    // Choose cell position pseudorandomly
    const cellI = rng.below(boardSize);
    const cellJ = rng.below(boardSize);

    // Generate organism
    const organism = generateOrganism(organismSeed, opts);

    return {
        organism,
        cellI,
        cellJ,
        boardSeed,
        masterSeed: seed,
    };
}


// ── CLI ──────────────────────────────────────────────────────────────

if (process.argv[1]?.includes('organism-generator')) {
    const seed = parseInt(process.argv[2] || '42');
    const count = parseInt(process.argv[3] || '20');

    console.log(`Generating ${count} organisms from seeds ${seed}..${seed + count - 1}\n`);

    const stats = { brk: 0, branch: 0, extended: 0 };
    const lengths = [];

    for (let s = seed; s < seed + count; s++) {
        const org = generateOrganism(s);
        stats[org.type]++;
        lengths.push(org.length);
        const hex = Array.from(org.program).map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`Seed ${s}: [${org.description}] L=${org.length} ${hex}`);
    }

    console.log(`\nType distribution: brk=${stats.brk} branch=${stats.branch} extended=${stats.extended}`);
    console.log(`Length distribution: min=${Math.min(...lengths)} max=${Math.max(...lengths)} mean=${(lengths.reduce((a,b)=>a+b,0)/lengths.length).toFixed(1)}`);
}
