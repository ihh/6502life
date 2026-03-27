/**
 * Generate the 256-entry opcode lookup table for the branchless 6502.
 * Same data as jax6502/opcode_table.py, encoded as a flat Uint32Array
 * for uploading to GPU uniform buffer.
 *
 * Each entry: 7 × uint32 = 28 bytes.
 * [instr_class, addr_mode, operation, base_cycles, page_cross_extra, instr_bytes, is_write]
 */

// Instruction classes
const CLS_READ = 0, CLS_STORE = 1, CLS_RMW = 2, CLS_RMW_A = 3;
const CLS_BRANCH = 4, CLS_IMPLIED = 5, CLS_PUSH = 6, CLS_PULL = 7;
const CLS_JMP_ABS = 8, CLS_JMP_IND = 9, CLS_JSR = 10, CLS_RTS = 11;
const CLS_RTI = 12, CLS_BRK = 13, CLS_JAM = 14, CLS_NOP_SKP = 15;

// Addressing modes
const AM_IMP = 0, AM_ACC = 1, AM_IMM = 2, AM_ZPG = 3, AM_ZPX = 4;
const AM_ZPY = 5, AM_ABS = 6, AM_ABX = 7, AM_ABY = 8, AM_INX = 9;
const AM_INY = 10, AM_REL = 11, AM_IND = 12;

export function buildOpcodeTable() {
    // 256 opcodes × 7 fields
    const table = new Int32Array(256 * 7);

    function set(opcode, cls, am, op, cycles, pcross, nbytes, write = 0) {
        const i = opcode * 7;
        table[i] = cls; table[i+1] = am; table[i+2] = op;
        table[i+3] = cycles; table[i+4] = pcross;
        table[i+5] = nbytes; table[i+6] = write;
    }

    // Default: JAM
    for (let i = 0; i < 256; i++) set(i, CLS_JAM, AM_IMP, 0, 2, 0, 1);

    // BRK
    set(0x00, CLS_BRK, AM_IMP, 0, 7, 0, 2);

    // RTI, RTS
    set(0x40, CLS_RTI, AM_IMP, 0, 6, 0, 1);
    set(0x60, CLS_RTS, AM_IMP, 0, 6, 0, 1);

    // Push/Pull
    set(0x48, CLS_PUSH, AM_IMP, 0, 3, 0, 1, 1); // PHA
    set(0x08, CLS_PUSH, AM_IMP, 1, 3, 0, 1, 1); // PHP
    set(0x68, CLS_PULL, AM_IMP, 0, 4, 0, 1);     // PLA
    set(0x28, CLS_PULL, AM_IMP, 1, 4, 0, 1);     // PLP

    // JSR, JMP
    set(0x20, CLS_JSR, AM_ABS, 0, 6, 0, 3, 1);
    set(0x4C, CLS_JMP_ABS, AM_ABS, 0, 3, 0, 3);
    set(0x6C, CLS_JMP_IND, AM_IND, 0, 5, 0, 3);

    // Branches
    for (const [op, cond] of [[0x10,0],[0x30,1],[0x50,2],[0x70,3],
                               [0x90,4],[0xB0,5],[0xD0,6],[0xF0,7]])
        set(op, CLS_BRANCH, AM_REL, cond, 2, 0, 2);

    // Implied
    for (const [op, fn] of [[0x18,0],[0x38,1],[0x58,2],[0x78,3],[0xB8,4],
                             [0xD8,5],[0xF8,6],[0xA8,7],[0x98,8],[0xAA,9],
                             [0x8A,10],[0xBA,11],[0x9A,12],[0xCA,13],
                             [0x88,14],[0xE8,15],[0xC8,16],[0xEA,17]])
        set(op, CLS_IMPLIED, AM_IMP, fn, 2, 0, 1);

    // Read instructions (LDA, LDX, LDY, EOR, AND, ORA, ADC, SBC, CMP, CPX, CPY, BIT)
    const reads = [
        [0xA9,AM_IMM,0,2,0,2],[0xA5,AM_ZPG,0,3,0,2],[0xAD,AM_ABS,0,4,0,3],
        [0xB5,AM_ZPX,0,4,0,2],[0xBD,AM_ABX,0,4,1,3],[0xB9,AM_ABY,0,4,1,3],
        [0xA1,AM_INX,0,6,0,2],[0xB1,AM_INY,0,5,1,2],
        [0xA2,AM_IMM,1,2,0,2],[0xA6,AM_ZPG,1,3,0,2],[0xAE,AM_ABS,1,4,0,3],
        [0xB6,AM_ZPY,1,4,0,2],[0xBE,AM_ABY,1,4,1,3],
        [0xA0,AM_IMM,2,2,0,2],[0xA4,AM_ZPG,2,3,0,2],[0xAC,AM_ABS,2,4,0,3],
        [0xB4,AM_ZPX,2,4,0,2],[0xBC,AM_ABX,2,4,1,3],
        [0x49,AM_IMM,3,2,0,2],[0x45,AM_ZPG,3,3,0,2],[0x4D,AM_ABS,3,4,0,3],
        [0x55,AM_ZPX,3,4,0,2],[0x5D,AM_ABX,3,4,1,3],[0x59,AM_ABY,3,4,1,3],
        [0x41,AM_INX,3,6,0,2],[0x51,AM_INY,3,5,1,2],
        [0x29,AM_IMM,4,2,0,2],[0x25,AM_ZPG,4,3,0,2],[0x2D,AM_ABS,4,4,0,3],
        [0x35,AM_ZPX,4,4,0,2],[0x3D,AM_ABX,4,4,1,3],[0x39,AM_ABY,4,4,1,3],
        [0x21,AM_INX,4,6,0,2],[0x31,AM_INY,4,5,1,2],
        [0x09,AM_IMM,5,2,0,2],[0x05,AM_ZPG,5,3,0,2],[0x0D,AM_ABS,5,4,0,3],
        [0x15,AM_ZPX,5,4,0,2],[0x1D,AM_ABX,5,4,1,3],[0x19,AM_ABY,5,4,1,3],
        [0x01,AM_INX,5,6,0,2],[0x11,AM_INY,5,5,1,2],
        [0x69,AM_IMM,6,2,0,2],[0x65,AM_ZPG,6,3,0,2],[0x6D,AM_ABS,6,4,0,3],
        [0x75,AM_ZPX,6,4,0,2],[0x7D,AM_ABX,6,4,1,3],[0x79,AM_ABY,6,4,1,3],
        [0x61,AM_INX,6,6,0,2],[0x71,AM_INY,6,5,1,2],
        [0xE9,AM_IMM,7,2,0,2],[0xE5,AM_ZPG,7,3,0,2],[0xED,AM_ABS,7,4,0,3],
        [0xF5,AM_ZPX,7,4,0,2],[0xFD,AM_ABX,7,4,1,3],[0xF9,AM_ABY,7,4,1,3],
        [0xE1,AM_INX,7,6,0,2],[0xF1,AM_INY,7,5,1,2],
        [0xC9,AM_IMM,8,2,0,2],[0xC5,AM_ZPG,8,3,0,2],[0xCD,AM_ABS,8,4,0,3],
        [0xD5,AM_ZPX,8,4,0,2],[0xDD,AM_ABX,8,4,1,3],[0xD9,AM_ABY,8,4,1,3],
        [0xC1,AM_INX,8,6,0,2],[0xD1,AM_INY,8,5,1,2],
        [0xE0,AM_IMM,9,2,0,2],[0xE4,AM_ZPG,9,3,0,2],[0xEC,AM_ABS,9,4,0,3],
        [0xC0,AM_IMM,10,2,0,2],[0xC4,AM_ZPG,10,3,0,2],[0xCC,AM_ABS,10,4,0,3],
        [0x24,AM_ZPG,11,3,0,2],[0x2C,AM_ABS,11,4,0,3],
    ];
    for (const [op, am, fn, cyc, pc, nb] of reads)
        set(op, CLS_READ, am, fn, cyc, pc, nb);

    // Store instructions (Sfotty: zpx/zpy stores are 3 cycles)
    const stores = [
        [0x85,AM_ZPG,0,3,0,2],[0x95,AM_ZPX,0,3,0,2],[0x8D,AM_ABS,0,4,0,3],
        [0x9D,AM_ABX,0,5,0,3],[0x99,AM_ABY,0,5,0,3],[0x81,AM_INX,0,6,0,2],
        [0x91,AM_INY,0,6,0,2],
        [0x86,AM_ZPG,1,3,0,2],[0x96,AM_ZPY,1,3,0,2],[0x8E,AM_ABS,1,4,0,3],
        [0x84,AM_ZPG,2,3,0,2],[0x94,AM_ZPX,2,3,0,2],[0x8C,AM_ABS,2,4,0,3],
    ];
    for (const [op, am, fn, cyc, pc, nb] of stores)
        set(op, CLS_STORE, am, fn, cyc, pc, nb, 1);

    // RMW (memory)
    const rmws = [
        [0x06,AM_ZPG,0,5,0,2],[0x16,AM_ZPX,0,6,0,2],[0x0E,AM_ABS,0,6,0,3],[0x1E,AM_ABX,0,7,0,3],
        [0x46,AM_ZPG,1,5,0,2],[0x56,AM_ZPX,1,6,0,2],[0x4E,AM_ABS,1,6,0,3],[0x5E,AM_ABX,1,7,0,3],
        [0x26,AM_ZPG,2,5,0,2],[0x36,AM_ZPX,2,6,0,2],[0x2E,AM_ABS,2,6,0,3],[0x3E,AM_ABX,2,7,0,3],
        [0x66,AM_ZPG,3,5,0,2],[0x76,AM_ZPX,3,6,0,2],[0x6E,AM_ABS,3,6,0,3],[0x7E,AM_ABX,3,7,0,3],
        [0xE6,AM_ZPG,4,5,0,2],[0xF6,AM_ZPX,4,6,0,2],[0xEE,AM_ABS,4,6,0,3],[0xFE,AM_ABX,4,7,0,3],
        [0xC6,AM_ZPG,5,5,0,2],[0xD6,AM_ZPX,5,6,0,2],[0xCE,AM_ABS,5,6,0,3],[0xDE,AM_ABX,5,7,0,3],
    ];
    for (const [op, am, fn, cyc, pc, nb] of rmws)
        set(op, CLS_RMW, am, fn, cyc, pc, nb, 1);

    // RMW accumulator
    set(0x0A, CLS_RMW_A, AM_ACC, 0, 2, 0, 1);
    set(0x4A, CLS_RMW_A, AM_ACC, 1, 2, 0, 1);
    set(0x2A, CLS_RMW_A, AM_ACC, 2, 2, 0, 1);
    set(0x6A, CLS_RMW_A, AM_ACC, 3, 2, 0, 1);

    // Undocumented: LAX, SAX, DCP, ISC, SLO, RLA, SRE, RRA, ANC, ALR, ARR, AXS
    for (const [op,am,cyc,pc,nb] of [[0xA7,AM_ZPG,3,0,2],[0xB7,AM_ZPY,4,0,2],
        [0xAF,AM_ABS,4,0,3],[0xBF,AM_ABY,4,1,3],[0xA3,AM_INX,6,0,2],[0xB3,AM_INY,5,1,2]])
        set(op, CLS_READ, am, 13, cyc, pc, nb); // LAX
    for (const [op,am,cyc,pc,nb] of [[0x87,AM_ZPG,3,0,2],[0x97,AM_ZPY,3,0,2],
        [0x8F,AM_ABS,4,0,3],[0x83,AM_INX,6,0,2]])
        set(op, CLS_STORE, am, 3, cyc, pc, nb, 1); // SAX
    for (const [op,am,cyc] of [[0xC7,AM_ZPG,5],[0xD7,AM_ZPX,6],[0xCF,AM_ABS,6],
        [0xDF,AM_ABX,7],[0xDB,AM_ABY,7],[0xC3,AM_INX,8],[0xD3,AM_INY,8]])
        set(op, CLS_RMW, am, 6, cyc, 0, am >= AM_ABS ? 3 : 2, 1); // DCP
    for (const [op,am,cyc] of [[0xE7,AM_ZPG,5],[0xF7,AM_ZPX,6],[0xEF,AM_ABS,6],
        [0xFF,AM_ABX,7],[0xFB,AM_ABY,7],[0xE3,AM_INX,8],[0xF3,AM_INY,8]])
        set(op, CLS_RMW, am, 7, cyc, 0, am >= AM_ABS ? 3 : 2, 1); // ISC
    for (const [op,am,cyc] of [[0x07,AM_ZPG,5],[0x17,AM_ZPX,6],[0x0F,AM_ABS,6],
        [0x1F,AM_ABX,7],[0x1B,AM_ABY,7],[0x03,AM_INX,8],[0x13,AM_INY,8]])
        set(op, CLS_RMW, am, 8, cyc, 0, am >= AM_ABS ? 3 : 2, 1); // SLO
    for (const [op,am,cyc] of [[0x27,AM_ZPG,5],[0x37,AM_ZPX,6],[0x2F,AM_ABS,6],
        [0x3F,AM_ABX,7],[0x3B,AM_ABY,7],[0x23,AM_INX,8],[0x33,AM_INY,8]])
        set(op, CLS_RMW, am, 9, cyc, 0, am >= AM_ABS ? 3 : 2, 1); // RLA
    for (const [op,am,cyc] of [[0x47,AM_ZPG,5],[0x57,AM_ZPX,6],[0x4F,AM_ABS,6],
        [0x5F,AM_ABX,7],[0x5B,AM_ABY,7],[0x43,AM_INX,8],[0x53,AM_INY,8]])
        set(op, CLS_RMW, am, 10, cyc, 0, am >= AM_ABS ? 3 : 2, 1); // SRE
    for (const [op,am,cyc] of [[0x67,AM_ZPG,5],[0x77,AM_ZPX,6],[0x6F,AM_ABS,6],
        [0x7F,AM_ABX,7],[0x7B,AM_ABY,7],[0x63,AM_INX,8],[0x73,AM_INY,8]])
        set(op, CLS_RMW, am, 11, cyc, 0, am >= AM_ABS ? 3 : 2, 1); // RRA

    set(0x0B, CLS_READ, AM_IMM, 14, 2, 0, 2); // ANC
    set(0x2B, CLS_READ, AM_IMM, 14, 2, 0, 2);
    set(0x4B, CLS_READ, AM_IMM, 15, 2, 0, 2); // ALR
    set(0x6B, CLS_READ, AM_IMM, 16, 2, 0, 2); // ARR
    set(0xCB, CLS_READ, AM_IMM, 17, 2, 0, 2); // AXS
    set(0xEB, CLS_READ, AM_IMM, 7, 2, 0, 2);  // SBC dup

    // JAM
    for (const op of [0x02,0x12,0x22,0x32,0x42,0x52,0x62,0x72,0x92,0xB2,0xD2,0xF2])
        set(op, CLS_JAM, AM_IMP, 0, 2, 0, 1);

    // Undocumented NOPs
    for (const op of [0x1A,0x3A,0x5A,0x7A,0xDA,0xFA])
        set(op, CLS_IMPLIED, AM_IMP, 17, 2, 0, 1);
    for (const op of [0x80,0x82,0x89,0xC2,0xE2])
        set(op, CLS_NOP_SKP, AM_IMM, 0, 2, 0, 2);
    for (const op of [0x04,0x44,0x64])
        set(op, CLS_NOP_SKP, AM_ZPG, 0, 3, 0, 2);
    for (const op of [0x14,0x34,0x54,0x74,0xD4,0xF4])
        set(op, CLS_NOP_SKP, AM_ZPX, 0, 4, 0, 2);
    set(0x0C, CLS_NOP_SKP, AM_ABS, 0, 4, 0, 3);
    for (const op of [0x1C,0x3C,0x5C,0x7C,0xDC,0xFC])
        set(op, CLS_NOP_SKP, AM_ABX, 0, 4, 1, 3);

    // Unstable (treated as NOPs)
    set(0x8B, CLS_NOP_SKP, AM_IMM, 0, 2, 0, 2);
    set(0x93, CLS_NOP_SKP, AM_INY, 0, 6, 0, 2);
    set(0x9F, CLS_NOP_SKP, AM_ABY, 0, 5, 0, 3);
    set(0x9B, CLS_NOP_SKP, AM_ABY, 0, 5, 0, 3);
    set(0x9C, CLS_NOP_SKP, AM_ABX, 0, 5, 0, 3);
    set(0x9E, CLS_NOP_SKP, AM_ABY, 0, 5, 0, 3);
    set(0xBB, CLS_NOP_SKP, AM_ABY, 0, 4, 1, 3);
    set(0xAB, CLS_NOP_SKP, AM_IMM, 0, 2, 0, 2);

    return table;
}
