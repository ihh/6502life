"""
Branchless 6502 CPU step function for JAX.

Pure function: step_one_instruction(pc, a, x, y, s, p, memory) -> (pc, a, x, y, s, p, memory, cycles, brk_operand, halted)

All branching is replaced by parallel computation + indexed selection.
Memory is a flat uint8 array. Size determined by len(memory); addresses wrap
at len(memory)-1.  Pass 2048 bytes for the board's 2KB bare-sim, or 65536
bytes for full-address-space cross-validation.

Designed for jax.vmap over a batch of CPUs.
"""

import jax
import jax.numpy as jnp
from functools import partial

from .opcode_table import (
    OPCODE_TABLE,
    CLS_READ, CLS_STORE, CLS_RMW, CLS_RMW_A, CLS_BRANCH, CLS_IMPLIED,
    CLS_PUSH, CLS_PULL, CLS_JMP_ABS, CLS_JMP_IND, CLS_JSR, CLS_RTS,
    CLS_RTI, CLS_BRK, CLS_JAM, CLS_NOP_SKP,
    AM_IMP, AM_ACC, AM_IMM, AM_ZPG, AM_ZPX, AM_ZPY, AM_ABS, AM_ABX,
    AM_ABY, AM_INX, AM_INY, AM_REL, AM_IND,
    RD_LDA, RD_LDX, RD_LDY, RD_EOR, RD_AND, RD_ORA, RD_ADC, RD_SBC,
    RD_CMP, RD_CPX, RD_CPY, RD_BIT, RD_NOP, RD_LAX, RD_ANC, RD_ALR,
    RD_ARR, RD_AXS,
    ST_STA, ST_STX, ST_STY, ST_SAX,
    RMW_ASL, RMW_LSR, RMW_ROL, RMW_ROR, RMW_INC, RMW_DEC,
    RMW_DCP, RMW_ISC, RMW_SLO, RMW_RLA, RMW_SRE, RMW_RRA,
    BR_BPL, BR_BMI, BR_BVC, BR_BVS, BR_BCC, BR_BCS, BR_BNE, BR_BEQ,
    IM_CLC, IM_SEC, IM_CLI, IM_SEI, IM_CLV, IM_CLD, IM_SED,
    IM_TAX, IM_TXA, IM_TAY, IM_TYA, IM_TSX, IM_TXS,
    IM_DEX, IM_DEY, IM_INX, IM_INY, IM_NOP,
    PUSH_A, PUSH_P, PULL_A, PULL_P,
)

# JAX-constant opcode table
_OPC = jnp.array(OPCODE_TABLE, dtype=jnp.int32)

# P flag bits: NV-BDIZC
F_C = 0x01; F_Z = 0x02; F_I = 0x04; F_D = 0x08
F_B = 0x10; F_U = 0x20; F_V = 0x40; F_N = 0x80


def _nz_flags(val, p):
    """Update N and Z flags from val, preserving other flags."""
    z = jnp.where(val & 0xFF == 0, F_Z, 0)
    n = val & F_N
    return (p & ~(F_N | F_Z)) | n | z


def _exec_adc(a, val, p):
    """ADC: A + val + C. Returns (result, new_p).
    Binary mode only — Sfotty ignores BCD (D flag has no effect)."""
    c_in = p & F_C
    sum16 = a + val + c_in
    result = sum16 & 0xFF
    c_out = jnp.where(sum16 > 255, F_C, 0)
    # Overflow: sign of result differs from both inputs
    v = jnp.where(((a ^ result) & (val ^ result) & 0x80) != 0, F_V, 0)
    new_p = _nz_flags(result, p & ~(F_C | F_V)) | c_out | v
    return result, new_p


def _exec_sbc(a, val, p):
    """SBC: A - val - !C. Returns (result, new_p).
    Binary mode only — Sfotty ignores BCD (D flag has no effect)."""
    c_in = p & F_C
    inv = val ^ 0xFF
    sum16 = a + inv + c_in
    result = sum16 & 0xFF
    c_out = jnp.where(sum16 > 255, F_C, 0)
    v = jnp.where(((a ^ result) & (inv ^ result) & 0x80) != 0, F_V, 0)
    new_p = _nz_flags(result, p & ~(F_C | F_V)) | c_out | v
    return result, new_p


def step_one_instruction(pc, a, x, y, s, p, memory, addr_mask=None):
    """Execute one 6502 instruction branchlessly.

    Args:
        pc: uint16, program counter
        a, x, y, s: uint8, registers
        p: uint8, processor status (NV-BDIZC)
        memory: uint8[N], flat memory (N=2048 for board, 65536 for tests)
        addr_mask: address wrap mask. Defaults to len(memory)-1.

    Returns:
        (new_pc, new_a, new_x, new_y, new_s, new_p, new_memory,
         cycles_used, brk_operand, halted)
        brk_operand: -1 if no BRK, else 0-255
        halted: True if JAM opcode hit
    """
    if addr_mask is None:
        addr_mask = memory.shape[0] - 1

    def mr(addr):
        """Read one byte from memory with wrap."""
        return memory[addr & addr_mask]

    # Cast to int32 for arithmetic
    pc = pc.astype(jnp.int32)
    a = a.astype(jnp.int32)
    x = x.astype(jnp.int32)
    y = y.astype(jnp.int32)
    s = s.astype(jnp.int32)
    p = p.astype(jnp.int32)

    # Fetch opcode (cast to int32 — JAX uint8 indexing is unreliable)
    opcode = mr(pc).astype(jnp.int32)

    # Decode via table lookup
    row = _OPC[opcode]
    cls = row[0]        # instruction class
    addr_mode = row[1]  # addressing mode
    op = row[2]         # operation index
    base_cycles = row[3]
    pcross_flag = row[4]
    nbytes = row[5]
    is_write = row[6]

    # Default next PC (overridden by branches, jumps, BRK)
    next_pc = (pc + nbytes) & 0xFFFF

    # ── Resolve effective address ──
    op1 = mr(pc + 1).astype(jnp.int32)
    op2 = mr(pc + 2).astype(jnp.int32)
    operand_word = (op1 | (op2 << 8)) & 0xFFFF

    addr_zpg = op1
    addr_zpx = (op1 + x) & 0xFF
    addr_zpy = (op1 + y) & 0xFF
    addr_abs = operand_word
    addr_abx = (operand_word + x) & 0xFFFF
    addr_aby = (operand_word + y) & 0xFFFF

    # (indirect,X)
    ptr_lo_inx = mr((op1 + x) & 0xFF).astype(jnp.int32)
    ptr_hi_inx = mr((op1 + x + 1) & 0xFF).astype(jnp.int32)
    addr_inx = (ptr_lo_inx | (ptr_hi_inx << 8)) & 0xFFFF

    # (indirect),Y
    ptr_lo_iny = mr(op1).astype(jnp.int32)
    ptr_hi_iny = mr((op1 + 1) & 0xFF).astype(jnp.int32)
    iny_base = (ptr_lo_iny | (ptr_hi_iny << 8)) & 0xFFFF
    addr_iny = (iny_base + y) & 0xFFFF

    # JMP indirect (with 6502 page-wrap bug)
    ptr_lo_ind = mr(operand_word).astype(jnp.int32)
    ptr_hi_ind = mr((operand_word & 0xFF00) | ((operand_word + 1) & 0xFF)).astype(jnp.int32)
    addr_ind = (ptr_lo_ind | (ptr_hi_ind << 8)) & 0xFFFF

    all_addrs = jnp.array([
        0,              # 0: IMP
        0,              # 1: ACC
        (pc + 1) & 0xFFFF,  # 2: IMM
        addr_zpg,       # 3: ZPG
        addr_zpx,       # 4: ZPX
        addr_zpy,       # 5: ZPY
        addr_abs,       # 6: ABS
        addr_abx,       # 7: ABX
        addr_aby,       # 8: ABY
        addr_inx,       # 9: INX
        addr_iny,       # 10: INY
        0,              # 11: REL (handled separately)
        addr_ind,       # 12: IND
    ], dtype=jnp.int32)

    eff_addr = all_addrs[addr_mode]

    # Page cross detection (Sfotty quirk: >= 255, not >= 256)
    cross_abx = ((operand_word & 0xFF) + x) >= 255
    cross_aby = ((operand_word & 0xFF) + y) >= 255
    cross_iny = ((iny_base & 0xFF) + y) >= 255
    page_crossed = jnp.where(addr_mode == AM_ABX, cross_abx,
                   jnp.where(addr_mode == AM_ABY, cross_aby,
                   jnp.where(addr_mode == AM_INY, cross_iny, False)))

    # Read operand value from effective address
    op1_byte = op1  # already computed above
    operand_val = mr(eff_addr).astype(jnp.int32)

    # Extra cycle from page cross (only for reads, not stores/RMW)
    extra_cycles = jnp.where(page_crossed & (pcross_flag == 1), 1, 0)

    # ── Read operations ──
    r_lda = operand_val
    r_ldx = operand_val
    r_ldy = operand_val
    r_eor = a ^ operand_val
    r_and = a & operand_val
    r_ora = a | operand_val
    adc_result, adc_p = _exec_adc(a, operand_val, p)
    sbc_result, sbc_p = _exec_sbc(a, operand_val, p)
    # CMP/CPX/CPY
    cmp_diff = (a - operand_val) & 0x1FF
    cpx_diff = (x - operand_val) & 0x1FF
    cpy_diff = (y - operand_val) & 0x1FF
    # BIT
    bit_result = a & operand_val
    bit_p = (p & ~(F_N | F_V | F_Z)) | (operand_val & (F_N | F_V)) | jnp.where(bit_result == 0, F_Z, 0)
    # LAX
    r_lax = operand_val
    # ANC
    r_anc = a & operand_val
    # ALR
    r_alr_pre = a & operand_val
    r_alr = r_alr_pre >> 1
    alr_c = r_alr_pre & 1
    # ARR (AND + ROR with special flag handling)
    # Sfotty ARR: AND imm, then ROR using old carry, then set C=bit6, V=bit6^bit5
    r_arr_pre = a & operand_val
    r_arr = ((r_arr_pre >> 1) | ((p & F_C) << 6)) & 0xFF
    arr_c = jnp.where(r_arr & 0x40, F_C, 0)  # C = bit 6 of result
    arr_v = jnp.where(((r_arr ^ (r_arr << 1)) & 0x40) != 0, F_V, 0)  # V = bit6 ^ bit5
    # AXS: (A & X) - imm -> X, no borrow
    r_axs = ((a & x) - operand_val) & 0xFF
    axs_c = jnp.where((a & x) >= operand_val, F_C, 0)

    # Select read result for A register
    read_results_a = jnp.array([
        r_lda, 0, 0, r_eor, r_and, r_ora, adc_result, sbc_result,
        0, 0, 0, 0, 0, r_lax, r_anc, r_alr, r_arr, 0
    ])
    read_new_a = read_results_a[op] & 0xFF

    # Select read result for X register (LDX, LAX, AXS write X)
    read_new_x = jnp.where(op == RD_LDX, r_ldx,
                 jnp.where(op == RD_LAX, r_lax,
                 jnp.where(op == RD_AXS, r_axs, x))) & 0xFF

    # Select read result for Y register (only LDY)
    read_new_y = jnp.where(op == RD_LDY, r_ldy, y) & 0xFF

    # Flags for read operations
    # ARR has special flag handling: N/Z from result, C=bit6, V=bit6^bit5
    arr_p = _nz_flags(r_arr, (p & ~(F_C | F_V))) | arr_c | arr_v

    # For LDX/LDY, N/Z flags are based on the loaded value (operand_val)
    # For LDA/EOR/AND/ORA/LAX, N/Z flags are based on the result in A (read_new_a)
    default_nz_val = jnp.where((op == RD_LDX) | (op == RD_LDY), operand_val, read_new_a)
    read_p = jnp.where(op == RD_ADC, adc_p,
             jnp.where(op == RD_SBC, sbc_p,
             jnp.where(op == RD_BIT, bit_p,
             jnp.where(op == RD_CMP, _nz_flags(cmp_diff, (p & ~F_C) | jnp.where(a >= operand_val, F_C, 0)),
             jnp.where(op == RD_CPX, _nz_flags(cpx_diff, (p & ~F_C) | jnp.where(x >= operand_val, F_C, 0)),
             jnp.where(op == RD_CPY, _nz_flags(cpy_diff, (p & ~F_C) | jnp.where(y >= operand_val, F_C, 0)),
             jnp.where(op == RD_ANC, _nz_flags(r_anc, (p & ~F_C) | jnp.where(r_anc & 0x80, F_C, 0)),
             jnp.where(op == RD_ALR, _nz_flags(r_alr, (p & ~F_C) | alr_c),
             jnp.where(op == RD_ARR, arr_p,
             jnp.where(op == RD_AXS, _nz_flags(r_axs, (p & ~F_C) | axs_c),
             _nz_flags(default_nz_val, p)))))))))))

    # For ops that don't change A (LDX, LDY, CMP, CPX, CPY, BIT, NOP, AXS), restore A
    read_a_final = jnp.where((op == RD_LDX) | (op == RD_LDY) |
                              (op == RD_CMP) | (op == RD_CPX) | (op == RD_CPY) |
                              (op == RD_BIT) | (op == RD_NOP) | (op == RD_AXS),
                              a, read_new_a)

    # ── Store operations ──
    store_val = jnp.where(op == ST_STA, a,
                jnp.where(op == ST_STX, x,
                jnp.where(op == ST_STY, y,
                jnp.where(op == ST_SAX, a & x, 0)))) & 0xFF

    # ── RMW operations (memory) ──
    rmw_asl = (operand_val << 1) & 0xFF
    rmw_lsr = operand_val >> 1
    rmw_rol = ((operand_val << 1) | (p & F_C)) & 0xFF
    rmw_ror = ((operand_val >> 1) | ((p & F_C) << 7)) & 0xFF
    rmw_inc = (operand_val + 1) & 0xFF
    rmw_dec = (operand_val - 1) & 0xFF
    # DCP: DEC then CMP
    rmw_dcp = (operand_val - 1) & 0xFF
    # ISC: INC then SBC
    rmw_isc = (operand_val + 1) & 0xFF
    # SLO: ASL then ORA
    rmw_slo = (operand_val << 1) & 0xFF
    # RLA: ROL then AND
    rmw_rla = ((operand_val << 1) | (p & F_C)) & 0xFF
    # SRE: LSR then EOR
    rmw_sre = operand_val >> 1
    # RRA: ROR then ADC
    rmw_rra = ((operand_val >> 1) | ((p & F_C) << 7)) & 0xFF

    rmw_results = jnp.array([
        rmw_asl, rmw_lsr, rmw_rol, rmw_ror, rmw_inc, rmw_dec,
        rmw_dcp, rmw_isc, rmw_slo, rmw_rla, rmw_sre, rmw_rra
    ])
    rmw_val = rmw_results[jnp.clip(op, 0, 11)] & 0xFF

    # RMW carry flags
    rmw_c = jnp.where((op == RMW_ASL) | (op == RMW_SLO), (operand_val >> 7) & 1,
            jnp.where((op == RMW_LSR) | (op == RMW_SRE), operand_val & 1,
            jnp.where(op == RMW_ROL, (operand_val >> 7) & 1,
            jnp.where((op == RMW_ROR) | (op == RMW_RRA), operand_val & 1,
            p & F_C))))
    # RLA carry: from old bit 7 of original value
    rmw_c = jnp.where(op == RMW_RLA, (operand_val >> 7) & 1, rmw_c)

    # RMW flag updates (compound ops also modify A)
    rmw_p = _nz_flags(rmw_val, (p & ~F_C) | rmw_c)
    # DCP: flags from CMP with decremented value
    dcp_p = _nz_flags((a - rmw_dcp) & 0xFF, (p & ~F_C) | jnp.where(a >= rmw_dcp, F_C, 0))
    # ISC: SBC with incremented value
    isc_result, isc_p = _exec_sbc(a, rmw_isc, p)
    # SLO: ORA with shifted value
    slo_a = a | rmw_slo
    slo_p = _nz_flags(slo_a, (p & ~F_C) | ((operand_val >> 7) & 1))
    # RLA: AND with rotated value
    rla_a = a & rmw_rla
    rla_p = _nz_flags(rla_a, (p & ~F_C) | ((operand_val >> 7) & 1))
    # SRE: EOR with shifted value
    sre_a = a ^ rmw_sre
    sre_p = _nz_flags(sre_a, (p & ~F_C) | (operand_val & 1))
    # RRA: ADC with rotated value
    rra_result, rra_p = _exec_adc(a, rmw_rra, (p & ~F_C) | (operand_val & 1))

    # Select final p for RMW
    rmw_p_final = jnp.where(op == RMW_DCP, dcp_p,
                  jnp.where(op == RMW_ISC, isc_p,
                  jnp.where(op == RMW_SLO, slo_p,
                  jnp.where(op == RMW_RLA, rla_p,
                  jnp.where(op == RMW_SRE, sre_p,
                  jnp.where(op == RMW_RRA, rra_p, rmw_p))))))

    # Select final A for compound RMW ops
    rmw_a = jnp.where(op == RMW_ISC, isc_result,
            jnp.where(op == RMW_SLO, slo_a,
            jnp.where(op == RMW_RLA, rla_a,
            jnp.where(op == RMW_SRE, sre_a,
            jnp.where(op == RMW_RRA, rra_result, a))))) & 0xFF

    # ── RMW accumulator ──
    rmwa_results = jnp.array([
        (a << 1) & 0xFF,       # ASL A
        a >> 1,                 # LSR A
        ((a << 1) | (p & F_C)) & 0xFF,  # ROL A
        ((a >> 1) | ((p & F_C) << 7)) & 0xFF,  # ROR A
    ])
    rmwa_val = rmwa_results[jnp.clip(op, 0, 3)]
    rmwa_c = jnp.where((op == RMW_ASL) | (op == RMW_ROL), (a >> 7) & 1,
                        a & 1)  # LSR, ROR

    # ── Branch operations ──
    branch_conds = jnp.array([
        (p & F_N) == 0,  # BPL
        (p & F_N) != 0,  # BMI
        (p & F_V) == 0,  # BVC
        (p & F_V) != 0,  # BVS
        (p & F_C) == 0,  # BCC
        (p & F_C) != 0,  # BCS
        (p & F_Z) == 0,  # BNE
        (p & F_Z) != 0,  # BEQ
    ])
    branch_taken = branch_conds[jnp.clip(op, 0, 7)]
    offset = jnp.where(op1_byte >= 128, op1_byte - 256, op1_byte)
    branch_target = (pc + 2 + offset) & 0xFFFF
    branch_pc = jnp.where(branch_taken, branch_target, pc + 2)
    branch_same_page = (branch_target >> 8) == ((pc + 2) >> 8)
    branch_extra = jnp.where(branch_taken, jnp.where(branch_same_page, 1, 2), 0)

    # ── Implied operations ──
    imp_results_a = jnp.where(op == IM_TXA, x, jnp.where(op == IM_TYA, y, a))
    imp_results_x = jnp.where(op == IM_TAX, a,
                    jnp.where(op == IM_TSX, s,
                    jnp.where(op == IM_DEX, (x - 1) & 0xFF,
                    jnp.where(op == IM_INX, (x + 1) & 0xFF, x))))
    imp_results_y = jnp.where(op == IM_TAY, a,
                    jnp.where(op == IM_DEY, (y - 1) & 0xFF,
                    jnp.where(op == IM_INY, (y + 1) & 0xFF, y)))
    imp_results_s = jnp.where(op == IM_TXS, x, s)
    # Flags for implied ops
    imp_p = jnp.where(op == IM_CLC, p & ~F_C,
            jnp.where(op == IM_SEC, p | F_C,
            jnp.where(op == IM_CLI, p & ~F_I,
            jnp.where(op == IM_SEI, p | F_I,
            jnp.where(op == IM_CLV, p & ~F_V,
            jnp.where(op == IM_CLD, p & ~F_D,
            jnp.where(op == IM_SED, p | F_D,
            jnp.where(op == IM_TXS, p,  # TXS: no flag changes
            # TSX: Sfotty quirk — does NOT set N/Z
            jnp.where(op == IM_TSX, p,
            p)))))))))
    # NZ flags for register transfer/inc/dec (not for flag ops, TXS, TSX, NOP)
    needs_nz = (op >= IM_TAX) & (op <= IM_INY) & (op != IM_TXS) & (op != IM_TSX) & (op != IM_NOP)
    nz_val = jnp.where((op == IM_TAX) | (op == IM_TXA) | (op == IM_DEX) | (op == IM_INX), imp_results_x,
             jnp.where((op == IM_TAY) | (op == IM_TYA) | (op == IM_DEY) | (op == IM_INY), imp_results_y, 0))
    imp_p = jnp.where(needs_nz, _nz_flags(nz_val, imp_p), imp_p)

    # ── Push/Pull ──
    push_val = jnp.where(op == PUSH_A, a, (p | F_B | F_U))  # PHP always sets B and U
    pull_is_a = op == PULL_A
    pulled_val = mr(0x100 + ((s + 1) & 0xFF)).astype(jnp.int32)
    pull_a = jnp.where(pull_is_a, pulled_val, a)
    pull_p = jnp.where(pull_is_a, _nz_flags(pulled_val, p), (pulled_val | F_U) & ~F_B)
    pull_s = (s + 1) & 0xFF

    # ── JSR ──
    jsr_ret = (pc + 2) & 0xFFFF  # return address - 1
    jsr_target = mr(pc + 1).astype(jnp.int32) | (mr(pc + 2).astype(jnp.int32) << 8)

    # ── RTS ──
    rts_lo = mr(0x100 + ((s + 1) & 0xFF)).astype(jnp.int32)
    rts_hi = mr(0x100 + ((s + 2) & 0xFF)).astype(jnp.int32)
    rts_pc = ((rts_lo | (rts_hi << 8)) + 1) & 0xFFFF

    # ── RTI ──
    rti_p = mr(0x100 + ((s + 1) & 0xFF)).astype(jnp.int32)
    rti_lo = mr(0x100 + ((s + 2) & 0xFF)).astype(jnp.int32)
    rti_hi = mr(0x100 + ((s + 3) & 0xFF)).astype(jnp.int32)
    rti_pc = (rti_lo | (rti_hi << 8)) & 0xFFFF

    # ── BRK ──
    brk_operand_byte = mr(pc + 1).astype(jnp.int32)
    # Sfotty BRK pushes PC+1 (not PC+2) as return address
    brk_ret = (pc + 1) & 0xFFFF
    # Read IRQ vector from 0xFFFE/0xFFFF
    brk_vec_lo = mr(0xFFFE).astype(jnp.int32)
    brk_vec_hi = mr(0xFFFF).astype(jnp.int32)
    brk_target = (brk_vec_lo | (brk_vec_hi << 8)) & 0xFFFF

    # ══════════════════════════════════════════════════════
    # Merge results based on instruction class
    # ══════════════════════════════════════════════════════

    # New PC
    new_pc = jnp.where(cls == CLS_BRANCH, branch_pc,
             jnp.where(cls == CLS_JMP_ABS, eff_addr,
             jnp.where(cls == CLS_JMP_IND, eff_addr,
             jnp.where(cls == CLS_JSR, jsr_target,
             jnp.where(cls == CLS_RTS, rts_pc,
             jnp.where(cls == CLS_RTI, rti_pc,
             jnp.where(cls == CLS_BRK, brk_target,
             next_pc)))))))

    # New A
    new_a = jnp.where(cls == CLS_READ, read_a_final,
            jnp.where(cls == CLS_RMW, rmw_a,
            jnp.where(cls == CLS_RMW_A, rmwa_val,
            jnp.where(cls == CLS_IMPLIED, imp_results_a,
            jnp.where(cls == CLS_PULL, pull_a, a)))))

    # New X
    new_x = jnp.where(cls == CLS_READ, read_new_x,
            jnp.where(cls == CLS_IMPLIED, imp_results_x, x))

    # New Y
    new_y = jnp.where(cls == CLS_READ, read_new_y,
            jnp.where(cls == CLS_IMPLIED, imp_results_y, y))

    # New S
    new_s = jnp.where(cls == CLS_PUSH, (s - 1) & 0xFF,
            jnp.where(cls == CLS_PULL, pull_s,
            jnp.where(cls == CLS_JSR, (s - 2) & 0xFF,
            jnp.where(cls == CLS_RTS, (s + 2) & 0xFF,
            jnp.where(cls == CLS_RTI, (s + 3) & 0xFF,
            jnp.where(cls == CLS_BRK, (s - 3) & 0xFF,
            jnp.where(cls == CLS_IMPLIED, imp_results_s, s)))))))

    # New P
    # BRK: Sfotty does NOT set I flag (unlike hardware 6502)
    brk_p = (p | F_U | F_B)
    new_p = jnp.where(cls == CLS_READ, read_p,
            jnp.where(cls == CLS_RMW, rmw_p_final,
            jnp.where(cls == CLS_RMW_A, _nz_flags(rmwa_val, (p & ~F_C) | rmwa_c),
            jnp.where(cls == CLS_IMPLIED, imp_p,
            jnp.where(cls == CLS_PULL, pull_p,
            jnp.where(cls == CLS_RTI, (rti_p | F_U) & ~F_B,
            jnp.where(cls == CLS_BRK, brk_p, p)))))))
    # Bits 4-5 always set in Sfotty's P representation
    new_p = new_p | F_U | F_B

    # Memory writes
    # Write slot 1: store/RMW to effective address, OR push to stack, OR JSR/BRK stack
    w1_addr = jnp.where((cls == CLS_STORE) | (cls == CLS_RMW), eff_addr,
              jnp.where(cls == CLS_PUSH, 0x100 + s,
              jnp.where(cls == CLS_JSR, 0x100 + s,
              jnp.where(cls == CLS_BRK, 0x100 + s, 0)))) & addr_mask
    w1_val = jnp.where(cls == CLS_STORE, store_val,
             jnp.where(cls == CLS_RMW, rmw_val,
             jnp.where(cls == CLS_PUSH, push_val,
             jnp.where(cls == CLS_JSR, (jsr_ret >> 8) & 0xFF,
             jnp.where(cls == CLS_BRK, (brk_ret >> 8) & 0xFF,
             mr(0)))))) & 0xFF

    # Write slot 2: JSR pushes PCL, BRK pushes PCL
    w2_addr = jnp.where(cls == CLS_JSR, (0x100 + ((s - 1) & 0xFF)) & addr_mask,
              jnp.where(cls == CLS_BRK, (0x100 + ((s - 1) & 0xFF)) & addr_mask, 0))
    w2_val = jnp.where(cls == CLS_JSR, jsr_ret & 0xFF,
             jnp.where(cls == CLS_BRK, brk_ret & 0xFF,
             mr(0))) & 0xFF

    # Write slot 3: BRK pushes P (with B and U set)
    w3_addr = jnp.where(cls == CLS_BRK, (0x100 + ((s - 2) & 0xFF)) & addr_mask, 0)
    w3_val = jnp.where(cls == CLS_BRK, (p | F_B | F_U) & 0xFF,
             mr(0)) & 0xFF

    # Determine which writes are active
    has_w1 = (cls == CLS_STORE) | (cls == CLS_RMW) | (cls == CLS_PUSH) | (cls == CLS_JSR) | (cls == CLS_BRK)
    has_w2 = (cls == CLS_JSR) | (cls == CLS_BRK)
    has_w3 = (cls == CLS_BRK)

    # Apply writes
    new_memory = memory.at[w1_addr].set(jnp.where(has_w1, w1_val, memory[w1_addr]).astype(jnp.uint8))
    new_memory = new_memory.at[w2_addr].set(jnp.where(has_w2, w2_val, new_memory[w2_addr]).astype(jnp.uint8))
    new_memory = new_memory.at[w3_addr].set(jnp.where(has_w3, w3_val, new_memory[w3_addr]).astype(jnp.uint8))

    # Cycles
    cycles_used = base_cycles + jnp.where(cls == CLS_BRANCH, branch_extra, extra_cycles)

    # BRK detection
    brk_op = jnp.where(cls == CLS_BRK, brk_operand_byte, -1)

    # JAM detection
    halted = cls == CLS_JAM

    return (new_pc.astype(jnp.uint16),
            new_a.astype(jnp.uint8),
            new_x.astype(jnp.uint8),
            new_y.astype(jnp.uint8),
            new_s.astype(jnp.uint8),
            new_p.astype(jnp.uint8),
            new_memory,
            cycles_used.astype(jnp.int32),
            brk_op.astype(jnp.int16),
            halted)
