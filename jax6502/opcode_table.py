"""
6502 opcode lookup table for branchless JAX execution.

Each of the 256 opcodes is encoded as a row of 7 integers:
  [instr_class, addr_mode, operation, base_cycles, page_cross_extra, instr_bytes, is_write]

This table is transcribed from wasm/src/cpu.rs (the Rust 6502 port)
and matches Sfotty's behavior exactly, including undocumented opcodes.
"""

import numpy as np

# Instruction classes
CLS_READ    = 0   # LDA, LDX, LDY, CMP, CPX, CPY, ADC, SBC, AND, ORA, EOR, BIT, NOP
CLS_STORE   = 1   # STA, STX, STY
CLS_RMW     = 2   # ASL, LSR, ROL, ROR, INC, DEC (memory)
CLS_RMW_A   = 3   # ASL A, LSR A, ROL A, ROR A (accumulator)
CLS_BRANCH  = 4   # BPL, BMI, BVC, BVS, BCC, BCS, BNE, BEQ
CLS_IMPLIED = 5   # CLC, SEC, CLI, SEI, CLV, CLD, SED, TAX, TXA, TAY, TYA, TSX, TXS, DEX, DEY, INX, INY, NOP
CLS_PUSH    = 6   # PHA, PHP
CLS_PULL    = 7   # PLA, PLP
CLS_JMP_ABS = 8   # JMP absolute
CLS_JMP_IND = 9   # JMP indirect
CLS_JSR     = 10  # JSR
CLS_RTS     = 11  # RTS
CLS_RTI     = 12  # RTI
CLS_BRK     = 13  # BRK
CLS_JAM     = 14  # JAM/HLT (halt CPU)
CLS_NOP_SKP = 15  # Undocumented multi-byte NOPs

# Addressing modes
AM_IMP = 0   # implied (no operand)
AM_ACC = 1   # accumulator
AM_IMM = 2   # immediate
AM_ZPG = 3   # zero page
AM_ZPX = 4   # zero page, X
AM_ZPY = 5   # zero page, Y
AM_ABS = 6   # absolute
AM_ABX = 7   # absolute, X
AM_ABY = 8   # absolute, Y
AM_INX = 9   # (indirect, X)
AM_INY = 10  # (indirect), Y
AM_REL = 11  # relative (branches)
AM_IND = 12  # indirect (JMP only)

# Read operations
RD_LDA = 0;  RD_LDX = 1;  RD_LDY = 2;  RD_EOR = 3;  RD_AND = 4
RD_ORA = 5;  RD_ADC = 6;  RD_SBC = 7;  RD_CMP = 8;  RD_CPX = 9
RD_CPY = 10; RD_BIT = 11; RD_NOP = 12
# Undocumented read ops
RD_LAX = 13; RD_ANC = 14; RD_ALR = 15; RD_ARR = 16; RD_AXS = 17

# Store operations
ST_STA = 0; ST_STX = 1; ST_STY = 2; ST_SAX = 3

# RMW operations
RMW_ASL = 0; RMW_LSR = 1; RMW_ROL = 2; RMW_ROR = 3
RMW_INC = 4; RMW_DEC = 5
# Undocumented RMW
RMW_DCP = 6; RMW_ISC = 7; RMW_SLO = 8; RMW_RLA = 9
RMW_SRE = 10; RMW_RRA = 11

# Branch conditions
BR_BPL = 0; BR_BMI = 1; BR_BVC = 2; BR_BVS = 3
BR_BCC = 4; BR_BCS = 5; BR_BNE = 6; BR_BEQ = 7

# Implied operations
IM_CLC = 0;  IM_SEC = 1;  IM_CLI = 2;  IM_SEI = 3;  IM_CLV = 4
IM_CLD = 5;  IM_SED = 6;  IM_TAX = 7;  IM_TXA = 8;  IM_TAY = 9
IM_TYA = 10; IM_TSX = 11; IM_TXS = 12; IM_DEX = 13; IM_DEY = 14
IM_INX = 15; IM_INY = 16; IM_NOP = 17

# Push/Pull operations
PUSH_A = 0; PUSH_P = 1
PULL_A = 0; PULL_P = 1


def _build_table():
    """Build the [256, 7] opcode table."""
    # Default: JAM (halt) for all undefined opcodes
    t = np.zeros((256, 7), dtype=np.int16)
    t[:, 0] = CLS_JAM   # instr_class
    t[:, 3] = 2          # base_cycles (JAM reads one dummy byte)
    t[:, 5] = 1          # instr_bytes

    def r(opcode, cls, am, op, cycles, pcross, nbytes, write=0):
        t[opcode] = [cls, am, op, cycles, pcross, nbytes, write]

    # ── BRK ──
    r(0x00, CLS_BRK, AM_IMP, 0, 7, 0, 2)

    # ── RTI, RTS ──
    r(0x40, CLS_RTI, AM_IMP, 0, 6, 0, 1)
    r(0x60, CLS_RTS, AM_IMP, 0, 6, 0, 1)

    # ── Push/Pull ──
    r(0x48, CLS_PUSH, AM_IMP, PUSH_A, 3, 0, 1, 1)  # PHA
    r(0x08, CLS_PUSH, AM_IMP, PUSH_P, 3, 0, 1, 1)  # PHP
    r(0x68, CLS_PULL, AM_IMP, PULL_A, 4, 0, 1)       # PLA
    r(0x28, CLS_PULL, AM_IMP, PULL_P, 4, 0, 1)       # PLP

    # ── JSR, JMP ──
    r(0x20, CLS_JSR,     AM_ABS, 0, 6, 0, 3, 1)  # JSR
    r(0x4C, CLS_JMP_ABS, AM_ABS, 0, 3, 0, 3)      # JMP abs
    r(0x6C, CLS_JMP_IND, AM_IND, 0, 5, 0, 3)      # JMP ind

    # ── Branches (all 2 bytes, 2 cycles base) ──
    for opcode, cond in [(0x10, BR_BPL), (0x30, BR_BMI), (0x50, BR_BVC),
                         (0x70, BR_BVS), (0x90, BR_BCC), (0xB0, BR_BCS),
                         (0xD0, BR_BNE), (0xF0, BR_BEQ)]:
        r(opcode, CLS_BRANCH, AM_REL, cond, 2, 0, 2)

    # ── Implied (all 1 byte, 2 cycles) ──
    for opcode, op in [(0x18, IM_CLC), (0x38, IM_SEC), (0x58, IM_CLI),
                       (0x78, IM_SEI), (0xB8, IM_CLV), (0xD8, IM_CLD),
                       (0xF8, IM_SED), (0xA8, IM_TAY), (0x98, IM_TYA),
                       (0xAA, IM_TAX), (0x8A, IM_TXA), (0xBA, IM_TSX),
                       (0x9A, IM_TXS), (0xCA, IM_DEX), (0x88, IM_DEY),
                       (0xE8, IM_INX), (0xC8, IM_INY), (0xEA, IM_NOP)]:
        r(opcode, CLS_IMPLIED, AM_IMP, op, 2, 0, 1)

    # ── Read instructions ──
    # Format: (opcode, addr_mode, operation, cycles, page_cross, bytes)
    read_ops = [
        # LDA
        (0xA9, AM_IMM, RD_LDA, 2, 0, 2), (0xA5, AM_ZPG, RD_LDA, 3, 0, 2),
        (0xAD, AM_ABS, RD_LDA, 4, 0, 3), (0xB5, AM_ZPX, RD_LDA, 4, 0, 2),
        (0xBD, AM_ABX, RD_LDA, 4, 1, 3), (0xB9, AM_ABY, RD_LDA, 4, 1, 3),
        (0xA1, AM_INX, RD_LDA, 6, 0, 2), (0xB1, AM_INY, RD_LDA, 5, 1, 2),
        # LDX
        (0xA2, AM_IMM, RD_LDX, 2, 0, 2), (0xA6, AM_ZPG, RD_LDX, 3, 0, 2),
        (0xAE, AM_ABS, RD_LDX, 4, 0, 3), (0xB6, AM_ZPY, RD_LDX, 4, 0, 2),
        (0xBE, AM_ABY, RD_LDX, 4, 1, 3),
        # LDY
        (0xA0, AM_IMM, RD_LDY, 2, 0, 2), (0xA4, AM_ZPG, RD_LDY, 3, 0, 2),
        (0xAC, AM_ABS, RD_LDY, 4, 0, 3), (0xB4, AM_ZPX, RD_LDY, 4, 0, 2),
        (0xBC, AM_ABX, RD_LDY, 4, 1, 3),
        # EOR
        (0x49, AM_IMM, RD_EOR, 2, 0, 2), (0x45, AM_ZPG, RD_EOR, 3, 0, 2),
        (0x4D, AM_ABS, RD_EOR, 4, 0, 3), (0x55, AM_ZPX, RD_EOR, 4, 0, 2),
        (0x5D, AM_ABX, RD_EOR, 4, 1, 3), (0x59, AM_ABY, RD_EOR, 4, 1, 3),
        (0x41, AM_INX, RD_EOR, 6, 0, 2), (0x51, AM_INY, RD_EOR, 5, 1, 2),
        # AND
        (0x29, AM_IMM, RD_AND, 2, 0, 2), (0x25, AM_ZPG, RD_AND, 3, 0, 2),
        (0x2D, AM_ABS, RD_AND, 4, 0, 3), (0x35, AM_ZPX, RD_AND, 4, 0, 2),
        (0x3D, AM_ABX, RD_AND, 4, 1, 3), (0x39, AM_ABY, RD_AND, 4, 1, 3),
        (0x21, AM_INX, RD_AND, 6, 0, 2), (0x31, AM_INY, RD_AND, 5, 1, 2),
        # ORA
        (0x09, AM_IMM, RD_ORA, 2, 0, 2), (0x05, AM_ZPG, RD_ORA, 3, 0, 2),
        (0x0D, AM_ABS, RD_ORA, 4, 0, 3), (0x15, AM_ZPX, RD_ORA, 4, 0, 2),
        (0x1D, AM_ABX, RD_ORA, 4, 1, 3), (0x19, AM_ABY, RD_ORA, 4, 1, 3),
        (0x01, AM_INX, RD_ORA, 6, 0, 2), (0x11, AM_INY, RD_ORA, 5, 1, 2),
        # ADC
        (0x69, AM_IMM, RD_ADC, 2, 0, 2), (0x65, AM_ZPG, RD_ADC, 3, 0, 2),
        (0x6D, AM_ABS, RD_ADC, 4, 0, 3), (0x75, AM_ZPX, RD_ADC, 4, 0, 2),
        (0x7D, AM_ABX, RD_ADC, 4, 1, 3), (0x79, AM_ABY, RD_ADC, 4, 1, 3),
        (0x61, AM_INX, RD_ADC, 6, 0, 2), (0x71, AM_INY, RD_ADC, 5, 1, 2),
        # SBC
        (0xE9, AM_IMM, RD_SBC, 2, 0, 2), (0xE5, AM_ZPG, RD_SBC, 3, 0, 2),
        (0xED, AM_ABS, RD_SBC, 4, 0, 3), (0xF5, AM_ZPX, RD_SBC, 4, 0, 2),
        (0xFD, AM_ABX, RD_SBC, 4, 1, 3), (0xF9, AM_ABY, RD_SBC, 4, 1, 3),
        (0xE1, AM_INX, RD_SBC, 6, 0, 2), (0xF1, AM_INY, RD_SBC, 5, 1, 2),
        # CMP
        (0xC9, AM_IMM, RD_CMP, 2, 0, 2), (0xC5, AM_ZPG, RD_CMP, 3, 0, 2),
        (0xCD, AM_ABS, RD_CMP, 4, 0, 3), (0xD5, AM_ZPX, RD_CMP, 4, 0, 2),
        (0xDD, AM_ABX, RD_CMP, 4, 1, 3), (0xD9, AM_ABY, RD_CMP, 4, 1, 3),
        (0xC1, AM_INX, RD_CMP, 6, 0, 2), (0xD1, AM_INY, RD_CMP, 5, 1, 2),
        # CPX
        (0xE0, AM_IMM, RD_CPX, 2, 0, 2), (0xE4, AM_ZPG, RD_CPX, 3, 0, 2),
        (0xEC, AM_ABS, RD_CPX, 4, 0, 3),
        # CPY
        (0xC0, AM_IMM, RD_CPY, 2, 0, 2), (0xC4, AM_ZPG, RD_CPY, 3, 0, 2),
        (0xCC, AM_ABS, RD_CPY, 4, 0, 3),
        # BIT
        (0x24, AM_ZPG, RD_BIT, 3, 0, 2), (0x2C, AM_ABS, RD_BIT, 4, 0, 3),
    ]
    for opcode, am, op, cyc, pc, nb in read_ops:
        r(opcode, CLS_READ, am, op, cyc, pc, nb)

    # ── Store instructions ──
    # Sfotty quirk: zpx/zpy stores are 3 cycles (not 4)
    # abx/aby stores are always 5 cycles (no page-cross shortcut)
    store_ops = [
        # STA
        (0x85, AM_ZPG, ST_STA, 3, 0, 2), (0x95, AM_ZPX, ST_STA, 3, 0, 2),  # zpx: 3 cyc!
        (0x8D, AM_ABS, ST_STA, 4, 0, 3), (0x9D, AM_ABX, ST_STA, 5, 0, 3),
        (0x99, AM_ABY, ST_STA, 5, 0, 3), (0x81, AM_INX, ST_STA, 6, 0, 2),
        (0x91, AM_INY, ST_STA, 6, 0, 2),
        # STX
        (0x86, AM_ZPG, ST_STX, 3, 0, 2), (0x96, AM_ZPY, ST_STX, 3, 0, 2),  # zpy: 3 cyc!
        (0x8E, AM_ABS, ST_STX, 4, 0, 3),
        # STY
        (0x84, AM_ZPG, ST_STY, 3, 0, 2), (0x94, AM_ZPX, ST_STY, 3, 0, 2),  # zpx: 3 cyc!
        (0x8C, AM_ABS, ST_STY, 4, 0, 3),
    ]
    for opcode, am, op, cyc, pc, nb in store_ops:
        r(opcode, CLS_STORE, am, op, cyc, pc, nb, write=1)

    # ── RMW (memory) ──
    rmw_ops = [
        # ASL
        (0x06, AM_ZPG, RMW_ASL, 5, 0, 2), (0x16, AM_ZPX, RMW_ASL, 6, 0, 2),
        (0x0E, AM_ABS, RMW_ASL, 6, 0, 3), (0x1E, AM_ABX, RMW_ASL, 7, 0, 3),
        # LSR
        (0x46, AM_ZPG, RMW_LSR, 5, 0, 2), (0x56, AM_ZPX, RMW_LSR, 6, 0, 2),
        (0x4E, AM_ABS, RMW_LSR, 6, 0, 3), (0x5E, AM_ABX, RMW_LSR, 7, 0, 3),
        # ROL
        (0x26, AM_ZPG, RMW_ROL, 5, 0, 2), (0x36, AM_ZPX, RMW_ROL, 6, 0, 2),
        (0x2E, AM_ABS, RMW_ROL, 6, 0, 3), (0x3E, AM_ABX, RMW_ROL, 7, 0, 3),
        # ROR
        (0x66, AM_ZPG, RMW_ROR, 5, 0, 2), (0x76, AM_ZPX, RMW_ROR, 6, 0, 2),
        (0x6E, AM_ABS, RMW_ROR, 6, 0, 3), (0x7E, AM_ABX, RMW_ROR, 7, 0, 3),
        # INC
        (0xE6, AM_ZPG, RMW_INC, 5, 0, 2), (0xF6, AM_ZPX, RMW_INC, 6, 0, 2),
        (0xEE, AM_ABS, RMW_INC, 6, 0, 3), (0xFE, AM_ABX, RMW_INC, 7, 0, 3),
        # DEC
        (0xC6, AM_ZPG, RMW_DEC, 5, 0, 2), (0xD6, AM_ZPX, RMW_DEC, 6, 0, 2),
        (0xCE, AM_ABS, RMW_DEC, 6, 0, 3), (0xDE, AM_ABX, RMW_DEC, 7, 0, 3),
    ]
    for opcode, am, op, cyc, pc, nb in rmw_ops:
        r(opcode, CLS_RMW, am, op, cyc, pc, nb, write=1)

    # ── RMW (accumulator) ──
    r(0x0A, CLS_RMW_A, AM_ACC, RMW_ASL, 2, 0, 1)
    r(0x4A, CLS_RMW_A, AM_ACC, RMW_LSR, 2, 0, 1)
    r(0x2A, CLS_RMW_A, AM_ACC, RMW_ROL, 2, 0, 1)
    r(0x6A, CLS_RMW_A, AM_ACC, RMW_ROR, 2, 0, 1)

    # ── Undocumented: LAX (LDA + LDX) ──
    lax_ops = [
        (0xA7, AM_ZPG, 3, 0, 2), (0xB7, AM_ZPY, 4, 0, 2),
        (0xAF, AM_ABS, 4, 0, 3), (0xBF, AM_ABY, 4, 1, 3),
        (0xA3, AM_INX, 6, 0, 2), (0xB3, AM_INY, 5, 1, 2),
    ]
    for opcode, am, cyc, pc, nb in lax_ops:
        r(opcode, CLS_READ, am, RD_LAX, cyc, pc, nb)

    # ── Undocumented: SAX (A & X -> mem) ──
    sax_ops = [
        (0x87, AM_ZPG, 3, 0, 2), (0x97, AM_ZPY, 3, 0, 2),
        (0x8F, AM_ABS, 4, 0, 3), (0x83, AM_INX, 6, 0, 2),
    ]
    for opcode, am, cyc, pc, nb in sax_ops:
        r(opcode, CLS_STORE, am, ST_SAX, cyc, pc, nb, write=1)

    # ── Undocumented: DCP (DEC + CMP) ──
    dcp_ops = [
        (0xC7, AM_ZPG, 5, 0, 2), (0xD7, AM_ZPX, 6, 0, 2),
        (0xCF, AM_ABS, 6, 0, 3), (0xDF, AM_ABX, 7, 0, 3),
        (0xDB, AM_ABY, 7, 0, 3), (0xC3, AM_INX, 8, 0, 2),
        (0xD3, AM_INY, 8, 0, 2),
    ]
    for opcode, am, cyc, pc, nb in dcp_ops:
        r(opcode, CLS_RMW, am, RMW_DCP, cyc, pc, nb, write=1)

    # ── Undocumented: ISC/ISB (INC + SBC) ──
    isc_ops = [
        (0xE7, AM_ZPG, 5, 0, 2), (0xF7, AM_ZPX, 6, 0, 2),
        (0xEF, AM_ABS, 6, 0, 3), (0xFF, AM_ABX, 7, 0, 3),
        (0xFB, AM_ABY, 7, 0, 3), (0xE3, AM_INX, 8, 0, 2),
        (0xF3, AM_INY, 8, 0, 2),
    ]
    for opcode, am, cyc, pc, nb in isc_ops:
        r(opcode, CLS_RMW, am, RMW_ISC, cyc, pc, nb, write=1)

    # ── Undocumented: SLO (ASL + ORA) ──
    slo_ops = [
        (0x07, AM_ZPG, 5, 0, 2), (0x17, AM_ZPX, 6, 0, 2),
        (0x0F, AM_ABS, 6, 0, 3), (0x1F, AM_ABX, 7, 0, 3),
        (0x1B, AM_ABY, 7, 0, 3), (0x03, AM_INX, 8, 0, 2),
        (0x13, AM_INY, 8, 0, 2),
    ]
    for opcode, am, cyc, pc, nb in slo_ops:
        r(opcode, CLS_RMW, am, RMW_SLO, cyc, pc, nb, write=1)

    # ── Undocumented: RLA (ROL + AND) ──
    rla_ops = [
        (0x27, AM_ZPG, 5, 0, 2), (0x37, AM_ZPX, 6, 0, 2),
        (0x2F, AM_ABS, 6, 0, 3), (0x3F, AM_ABX, 7, 0, 3),
        (0x3B, AM_ABY, 7, 0, 3), (0x23, AM_INX, 8, 0, 2),
        (0x33, AM_INY, 8, 0, 2),
    ]
    for opcode, am, cyc, pc, nb in rla_ops:
        r(opcode, CLS_RMW, am, RMW_RLA, cyc, pc, nb, write=1)

    # ── Undocumented: SRE (LSR + EOR) ──
    sre_ops = [
        (0x47, AM_ZPG, 5, 0, 2), (0x57, AM_ZPX, 6, 0, 2),
        (0x4F, AM_ABS, 6, 0, 3), (0x5F, AM_ABX, 7, 0, 3),
        (0x5B, AM_ABY, 7, 0, 3), (0x43, AM_INX, 8, 0, 2),
        (0x53, AM_INY, 8, 0, 2),
    ]
    for opcode, am, cyc, pc, nb in sre_ops:
        r(opcode, CLS_RMW, am, RMW_SRE, cyc, pc, nb, write=1)

    # ── Undocumented: RRA (ROR + ADC) ──
    rra_ops = [
        (0x67, AM_ZPG, 5, 0, 2), (0x77, AM_ZPX, 6, 0, 2),
        (0x6F, AM_ABS, 6, 0, 3), (0x7F, AM_ABX, 7, 0, 3),
        (0x7B, AM_ABY, 7, 0, 3), (0x63, AM_INX, 8, 0, 2),
        (0x73, AM_INY, 8, 0, 2),
    ]
    for opcode, am, cyc, pc, nb in rra_ops:
        r(opcode, CLS_RMW, am, RMW_RRA, cyc, pc, nb, write=1)

    # ── Undocumented: ANC (AND + copy N to C) ──
    r(0x0B, CLS_READ, AM_IMM, RD_ANC, 2, 0, 2)
    r(0x2B, CLS_READ, AM_IMM, RD_ANC, 2, 0, 2)

    # ── Undocumented: ALR (AND + LSR A) ──
    r(0x4B, CLS_READ, AM_IMM, RD_ALR, 2, 0, 2)

    # ── Undocumented: ARR (AND + ROR with special flags) ──
    r(0x6B, CLS_READ, AM_IMM, RD_ARR, 2, 0, 2)

    # ── Undocumented: AXS/SBX ((A & X) - imm -> X) ──
    r(0xCB, CLS_READ, AM_IMM, RD_AXS, 2, 0, 2)

    # ── Undocumented: SBC duplicate ──
    r(0xEB, CLS_READ, AM_IMM, RD_SBC, 2, 0, 2)

    # ── JAM opcodes (halt CPU) ──
    for opcode in [0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72,
                   0x92, 0xB2, 0xD2, 0xF2]:
        r(opcode, CLS_JAM, AM_IMP, 0, 2, 0, 1)

    # ── Undocumented NOPs (various byte/cycle counts) ──
    # 1-byte 2-cycle NOPs (implied)
    for opcode in [0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA]:
        r(opcode, CLS_IMPLIED, AM_IMP, IM_NOP, 2, 0, 1)

    # 2-byte 2-cycle NOPs (skip one byte)
    for opcode in [0x80, 0x82, 0x89, 0xC2, 0xE2]:
        r(opcode, CLS_NOP_SKP, AM_IMM, 0, 2, 0, 2)

    # 2-byte 3-cycle NOPs (zpg read, discard)
    for opcode in [0x04, 0x44, 0x64]:
        r(opcode, CLS_NOP_SKP, AM_ZPG, 0, 3, 0, 2)

    # 2-byte 4-cycle NOPs (zpx read, discard)
    for opcode in [0x14, 0x34, 0x54, 0x74, 0xD4, 0xF4]:
        r(opcode, CLS_NOP_SKP, AM_ZPX, 0, 4, 0, 2)

    # 3-byte 4-cycle NOPs (abs read, discard)
    for opcode in [0x0C]:
        r(opcode, CLS_NOP_SKP, AM_ABS, 0, 4, 0, 3)

    # 3-byte 4/5-cycle NOPs (abx read, discard, page cross adds 1)
    for opcode in [0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC]:
        r(opcode, CLS_NOP_SKP, AM_ABX, 0, 4, 1, 3)

    # ── Unstable undocumented (treated as NOPs with correct timing) ──
    # XAA/ANE ($8B): 2-byte 2-cycle
    r(0x8B, CLS_NOP_SKP, AM_IMM, 0, 2, 0, 2)
    # AHX/SHA ($93): 2-byte 6-cycle (iny store timing)
    r(0x93, CLS_NOP_SKP, AM_INY, 0, 6, 0, 2)
    # AHX/SHA ($9F): 3-byte 5-cycle (aby store timing)
    r(0x9F, CLS_NOP_SKP, AM_ABY, 0, 5, 0, 3)
    # TAS/SHS ($9B): 3-byte 5-cycle
    r(0x9B, CLS_NOP_SKP, AM_ABY, 0, 5, 0, 3)
    # SHY ($9C): 3-byte 5-cycle
    r(0x9C, CLS_NOP_SKP, AM_ABX, 0, 5, 0, 3)
    # SHX ($9E): 3-byte 5-cycle
    r(0x9E, CLS_NOP_SKP, AM_ABY, 0, 5, 0, 3)
    # LAS ($BB): 3-byte 4/5-cycle (aby read timing)
    r(0xBB, CLS_NOP_SKP, AM_ABY, 0, 4, 1, 3)
    # LAX immediate ($AB): 2-byte 2-cycle (unstable, treated as NOP)
    r(0xAB, CLS_NOP_SKP, AM_IMM, 0, 2, 0, 2)

    return t


OPCODE_TABLE = _build_table()
"""Shape [256, 7], dtype int16. Columns: instr_class, addr_mode, operation, base_cycles, page_cross_extra, instr_bytes, is_write."""
