"""
Replicator DFA: 18 parallel deterministic finite automata for
detecting viable copy-loop cores in biased byte sequences.

Each DFA tracks one variant×rotation pattern:
  6 variants (DEX, INX, DEY, INY, INX3FF, INY3FF)
  × 3 rotations (LDA-STA-INC, STA-INC-LDA, INC-LDA-STA)
  = 18 patterns

States per DFA:
  0: START (accepting safe inserts, waiting for first core byte)
  1: consumed core byte 1, waiting for its operand(s)
  2: consumed core byte 1 + operands, waiting for core byte 2 or insert
  3: consumed core byte 2, waiting for operands
  4: consumed core byte 2 + operands, waiting for core byte 3 or insert
  5: consumed core byte 3, waiting for branch opcode or insert
  6: consumed branch opcode, waiting for offset byte (E0-F8 = accept)
  DEAD: jammed or invalid byte seen

Multi-byte core opcodes (LDA=2 bytes, STA=3 bytes) need sub-states
for consuming operand bytes and verifying their values.

Safe inserts at states 0, 2, 4, 5 self-loop (1-byte) or go through
operand-consuming sub-states (2-byte, 3-byte inserts).
"""

import numpy as np
import jax.numpy as jnp
import jax
from functools import partial

# ── Instruction lengths ───────────────────────────────────────────────

_ilen = np.ones(256, dtype=np.int32)
for op in [0x09,0x29,0x49,0x69,0xA0,0xA2,0xA9,0xC0,0xC9,0xE0,0xE9,
           0x05,0x06,0x24,0x25,0x26,0x45,0x46,0x65,0x66,0x84,0x85,
           0x86,0xA4,0xA5,0xA6,0xC4,0xC5,0xC6,0xE4,0xE5,0xE6,
           0x15,0x16,0x35,0x36,0x55,0x56,0x75,0x76,0x94,0x95,
           0xB4,0xB5,0xD5,0xD6,0xF5,0xF6,0x96,0xB6,
           0x10,0x30,0x50,0x70,0x90,0xB0,0xD0,0xF0,
           0x01,0x21,0x41,0x61,0x81,0xA1,0xC1,0xE1,
           0x11,0x31,0x51,0x71,0x91,0xB1,0xD1,0xF1,
           0x80,0x82,0x89,0xC2,0xE2,0x04,0x44,0x64,
           0x14,0x34,0x54,0x74,0xD4,0xF4,
           0xA7,0xB7,0x87,0x97,0xC7,0xD7,0xC3,0xD3,
           0xE7,0xF7,0xE3,0xF3,0x07,0x17,0x03,0x13,
           0x27,0x37,0x23,0x33,0x47,0x57,0x43,0x53,
           0x67,0x77,0x63,0x73,0x0B,0x2B,0x4B,0x6B,
           0xAB,0x8B,0xCB,0xEB,0x00]: _ilen[op] = 2
for op in [0x0D,0x0E,0x20,0x2C,0x2D,0x2E,0x4C,0x4D,0x4E,0x6C,
           0x6D,0x6E,0x8C,0x8D,0x8E,0xAC,0xAD,0xAE,0xCC,0xCD,
           0xCE,0xEC,0xED,0xEE,0x1D,0x1E,0x3D,0x3E,0x5D,0x5E,
           0x7D,0x7E,0x9D,0xBC,0xBD,0xDD,0xDE,0xFD,0xFE,
           0x19,0x39,0x59,0x79,0x99,0xB9,0xBE,0xD9,0xF9,
           0x0C,0x1C,0x3C,0x5C,0x7C,0xDC,0xFC,
           0x0F,0x1F,0x1B,0x2F,0x3F,0x3B,0x4F,0x5F,0x5B,
           0x6F,0x7F,0x7B,0xAF,0xBF,0xB3,0x8F,0x83,
           0xCF,0xDF,0xDB,0xEF,0xFF,0xFB,
           0x9F,0x93,0x9B,0x9C,0x9E,0xBB]: _ilen[op] = 3
for op in [0x02,0x12,0x22,0x32,0x42,0x52,0x62,0x72,
           0x92,0xB2,0xD2,0xF2]: _ilen[op] = 0
ILEN = _ilen

# ── Safe inserts ──────────────────────────────────────────────────────

# 1-byte safe inserts (conservative: safe for ALL variants)
SAFE_1B = frozenset([
    0xEA, 0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA,  # NOPs
    0x08, 0x48, 0x58, 0x78, 0x9A, 0xD8, 0xF8,   # PHA PHP CLI SEI TXS CLD SED
    0x18, 0xB8,  # CLC CLV (safe for BCC/BVC)
])
# 2-byte safe prefixes (operand consumed harmlessly)
SAFE_2B = frozenset([
    0x80, 0x82, 0x89, 0xC2, 0xE2,  # undoc imm NOPs
    0x04, 0x44, 0x64,              # undoc zpg NOPs
    0x14, 0x34, 0x54, 0x74, 0xD4, 0xF4,  # undoc zpx NOPs
])
# 3-byte safe prefixes
SAFE_3B = frozenset([
    0x0C, 0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC,  # undoc abs NOPs
])

# Valid offset bytes: E0 through F8 (loop lengths 8-32)
VALID_OFFSETS = frozenset(range(0xE0, 0xF9))

# Branch opcodes (BCC and BVC only)
BRANCH_OPS = frozenset([0x90, 0x50])

# ── Build DFA transition tables ──────────────────────────────────────

# States:
# 0: WAIT_CORE1 (start / insert loop)
# 1: CORE1_OP1  (consumed core opcode 1, waiting for operand 1)
# 2: CORE1_OP2  (consumed core opcode 1 + op1, waiting for operand 2 if 3-byte)
# 3: WAIT_CORE2 (consumed core group 1 fully, insert loop)
# 4: CORE2_OP1
# 5: CORE2_OP2
# 6: WAIT_CORE3 (consumed core groups 1+2, insert loop)
# 7: WAIT_BRANCH (consumed all 3 core groups, insert loop waiting for branch)
# 8: WAIT_OFFSET (consumed branch opcode, one byte: the offset)
# 9: ACCEPT
# 10: INS_2B_0   (consuming operand of 2-byte insert from state 0)
# 11: INS_3B_0a  (consuming operand 1 of 3-byte insert from state 0)
# 12: INS_3B_0b  (consuming operand 2 of 3-byte insert from state 0)
# 13: INS_2B_3   (2-byte insert from state 3)
# 14: INS_3B_3a
# 15: INS_3B_3b
# 16: INS_2B_6   (2-byte insert from state 6)
# 17: INS_3B_6a
# 18: INS_3B_6b
# 19: INS_2B_7   (2-byte insert from state 7)
# 20: INS_3B_7a
# 21: INS_3B_7b
# 22: CORE3_OP1 (consuming operand 1 of group 3, e.g., LDA's 00)
# 23: CORE3_OP2 (consuming operand 2 of group 3, e.g., STA's 04)
# 24: DEAD
N_STATES = 25
DEAD = 24
ACCEPT = 9

def build_one_dfa(core_bytes):
    """Build transition table for one variant×rotation.

    core_bytes: list of (opcode, [operand1, operand2, ...]) for each core group.
    The core has 3 groups. Each group is one instruction.
    Example for DEX rotation 0:
      group1 = (0xB5, [0x00])        # LDA $00,X
      group2 = (0x9D, [0x00, 0x04])  # STA $0400,X
      group3 = (0xCA, [])            # DEX
    """
    g1_op, g1_operands = core_bytes[0]
    g2_op, g2_operands = core_bytes[1]
    g3_op, g3_operands = core_bytes[2]

    g1_len = 1 + len(g1_operands)  # instruction length
    g2_len = 1 + len(g2_operands)
    g3_len = 1 + len(g3_operands)

    # Transition table: [N_STATES, 256] → next state
    T = np.full((N_STATES, 256), DEAD, dtype=np.int32)

    def add_insert_transitions(wait_state, ins2b_state, ins3b_a, ins3b_b):
        """Add safe insert self-loops from a wait state."""
        for b in SAFE_1B:
            T[wait_state, b] = wait_state
        for b in SAFE_2B:
            T[wait_state, b] = ins2b_state
        for b in SAFE_3B:
            T[wait_state, b] = ins3b_a
        # Insert operand consumption: any byte returns to wait state
        T[ins2b_state, :] = wait_state
        T[ins3b_a, :] = ins3b_b
        T[ins3b_b, :] = wait_state

    # State 0: WAIT_CORE1 (accept inserts or first core opcode)
    add_insert_transitions(0, 10, 11, 12)
    T[0, g1_op] = 1  # found core group 1 opcode

    # State 1: CORE1_OP1 (waiting for first operand of group 1)
    if len(g1_operands) >= 1:
        T[1, g1_operands[0]] = 2 if len(g1_operands) >= 2 else 3
        # All other bytes → DEAD (wrong operand)
    else:
        # 1-byte core instruction: go straight to next wait state
        # This shouldn't happen since state 1 is "waiting for operand"
        pass

    # State 2: CORE1_OP2 (waiting for second operand of group 1, if 3-byte)
    if len(g1_operands) >= 2:
        T[2, g1_operands[1]] = 3

    # State 3: WAIT_CORE2 (accept inserts or second core opcode)
    add_insert_transitions(3, 13, 14, 15)
    T[3, g2_op] = 4

    # State 4: CORE2_OP1
    if len(g2_operands) >= 1:
        T[4, g2_operands[0]] = 5 if len(g2_operands) >= 2 else 6
    else:
        # 1-byte instruction → skip to state 6
        # Handled below
        pass

    # State 5: CORE2_OP2
    if len(g2_operands) >= 2:
        T[5, g2_operands[1]] = 6

    # If group 2 is 1-byte (no operands), state 4 goes directly to state 6
    if len(g2_operands) == 0:
        # State 3 should transition to 6 on g2_op, skipping 4/5
        T[3, g2_op] = 6

    # State 6: WAIT_CORE3 (accept inserts or third core opcode)
    add_insert_transitions(6, 16, 17, 18)
    if len(g3_operands) == 0:
        T[6, g3_op] = 7  # 1-byte group 3 → WAIT_BRANCH
    elif len(g3_operands) == 1:
        T[6, g3_op] = 22  # → CORE3_OP1 (state 22)
        T[22, :] = DEAD
        T[22, g3_operands[0]] = 7
    elif len(g3_operands) == 2:
        T[6, g3_op] = 22  # → CORE3_OP1
        T[22, :] = DEAD
        T[22, g3_operands[0]] = 23  # → CORE3_OP2
        T[23, :] = DEAD
        T[23, g3_operands[1]] = 7

    # State 7: WAIT_BRANCH (accept inserts or branch opcode)
    add_insert_transitions(7, 19, 20, 21)
    for br in BRANCH_OPS:
        T[7, br] = 8  # found branch

    # State 8: WAIT_OFFSET (accept E0-F8)
    for off in VALID_OFFSETS:
        T[8, off] = ACCEPT

    # State 9: ACCEPT (absorbing)
    T[ACCEPT, :] = ACCEPT

    # State 22: DEAD (absorbing)
    T[DEAD, :] = DEAD

    # Fix: 1-byte group 1 (e.g., DEX in rotation 2: INC-LDA-STA)
    if len(g1_operands) == 0:
        T[0, g1_op] = 3  # skip operand states, go to WAIT_CORE2

    # Fix: 1-byte group 2
    if len(g2_operands) == 0:
        T[3, g2_op] = 6  # skip operand states, go to WAIT_CORE3

    return T


def build_all_dfas():
    """Build transition tables for all 18 patterns."""
    # The 6 variants × 3 rotations
    # Each variant defines 3 core instructions; rotations permute them
    variants = {
        'DEX':    [(0xB5, [0x00]), (0x9D, [0x00, 0x04]), (0xCA, [])],
        'INX':    [(0xB5, [0x00]), (0x9D, [0x00, 0x04]), (0xE8, [])],
        'DEY':    [(0xB7, [0x00]), (0x99, [0x00, 0x04]), (0x88, [])],
        'INY':    [(0xB7, [0x00]), (0x99, [0x00, 0x04]), (0xC8, [])],
        'INX3FF': [(0xB5, [0x00]), (0x9D, [0xFF, 0x03]), (0xE8, [])],
        'INY3FF': [(0xB7, [0x00]), (0x99, [0xFF, 0x03]), (0xC8, [])],
    }

    tables = []
    names = []
    for vname, groups in variants.items():
        for rot in range(3):
            # Rotate: [g1, g2, g3] → rotation
            rotated = [groups[(rot + i) % 3] for i in range(3)]
            T = build_one_dfa(rotated)
            tables.append(T)
            rot_names = ['LDA-STA-INC', 'STA-INC-LDA', 'INC-LDA-STA']
            names.append(f'{vname}/{rot_names[rot]}')

    # Stack into [18, N_STATES, 256]
    return np.stack(tables), names


ALL_DFAS, DFA_NAMES = build_all_dfas()
ALL_DFAS_JAX = jnp.array(ALL_DFAS)  # [18, 23, 256]


# ── Run DFAs on a cell ───────────────────────────────────────────────

def run_dfas(cell):
    """Run all 18 DFAs on a cell. Returns True if any accepts."""
    # Initial state: all DFAs start at state 0
    states = jnp.zeros(18, dtype=jnp.int32)

    def step(states, byte):
        byte_i = byte.astype(jnp.int32)
        # For each DFA, look up next state
        new_states = jax.vmap(lambda s, table: table[s, byte_i])(states, ALL_DFAS_JAX)
        return new_states, None

    final_states, _ = jax.lax.scan(step, states, cell)

    # Any DFA in accept state?
    return jnp.any(final_states == ACCEPT)


# ── Test ──────────────────────────────────────────────────────────────

def test_cell(name, prog, expect):
    """Test a program against the DFA."""
    cell = np.zeros(32, dtype=np.uint8)
    cell[:len(prog)] = prog
    result = bool(run_dfas(jnp.array(cell)))
    ok = '✓' if result == expect else '✗'
    # Which DFAs accepted?
    states = np.zeros(18, dtype=np.int32)
    for b in cell:
        for d in range(18):
            states[d] = ALL_DFAS[d, states[d], b]
    accepted = [DFA_NAMES[d] for d in range(18) if states[d] == ACCEPT]
    acc_str = ', '.join(accepted) if accepted else 'none'
    print(f'{ok} {name:40s} → {result} (exp {expect}) [{acc_str}]')


if __name__ == '__main__':
    print("DFA test suite")
    print("=" * 80)

    # Known viable
    test_cell('DEX/BCC bare', [0xB5,0x00,0x9D,0x00,0x04,0xCA,0x90,0xF8], True)
    test_cell('DEX/BVC bare', [0xB5,0x00,0x9D,0x00,0x04,0xCA,0x50,0xF8], True)
    test_cell('INX/BCC bare', [0xB5,0x00,0x9D,0x00,0x04,0xE8,0x90,0xF8], True)

    # Rotations
    test_cell('Rot1 STA;DEX;LDA;BCC', [0x9D,0x00,0x04,0xCA,0xB5,0x00,0x90,0xF8], True)
    test_cell('Rot2 DEX;LDA;STA;BCC', [0xCA,0xB5,0x00,0x9D,0x00,0x04,0x90,0xF8], True)

    # Y-family
    test_cell('DEY/BCC (Y-family)', [0xB7,0x00,0x99,0x00,0x04,0x88,0x90,0xF8], True)
    test_cell('INY/BVC (Y-family)', [0xB7,0x00,0x99,0x00,0x04,0xC8,0x50,0xF8], True)

    # With inserts
    test_cell('NOP + DEX/BCC', [0xEA,0xB5,0x00,0x9D,0x00,0x04,0xCA,0x90,0xF7], True)
    test_cell('CLD + DEX/BCC', [0xD8,0xB5,0x00,0x9D,0x00,0x04,0xCA,0x90,0xF7], True)
    test_cell('2-byte NOP insert', [0x80,0x42,0xB5,0x00,0x9D,0x00,0x04,0xCA,0x90,0xF6], True)
    test_cell('3-byte NOP insert', [0x0C,0x42,0x42,0xB5,0x00,0x9D,0x00,0x04,0xCA,0x90,0xF5], True)
    test_cell('Insert between STA and DEX', [0xB5,0x00,0x9D,0x00,0x04,0xEA,0xCA,0x90,0xF7], True)

    # Shifted
    # Shifted rot0: LDA-STA-INX = B5 00 9D FF 03 E8 90 F8
    test_cell('INX3FF shifted rot0', [0xB5,0x00,0x9D,0xFF,0x03,0xE8,0x90,0xF8], True)
    # Shifted rot2: INX-LDA-STA = E8 B5 00 9D FF 03 90 F8
    test_cell('INX3FF shifted rot2', [0xE8,0xB5,0x00,0x9D,0xFF,0x03,0x90,0xF8], True)
    test_cell('INY3FF shifted rot0', [0xB7,0x00,0x99,0xFF,0x03,0xC8,0x50,0xF8], True)

    # Should reject
    test_cell('Wrong STA page', [0xB5,0x00,0x9D,0x00,0x05,0xCA,0x90,0xF8], False)
    test_cell('Wrong LDA addr', [0xB5,0x01,0x9D,0x00,0x04,0xCA,0x90,0xF8], False)
    test_cell('Forward branch', [0xB5,0x00,0x9D,0x00,0x04,0xCA,0x90,0x08], False)
    test_cell('Random junk', [0x42,0x13,0x37,0xDE,0xAD,0xBE,0xEF,0x00], False)
    test_cell('JAM at start', [0x02,0xB5,0x00,0x9D,0x00,0x04,0xCA,0x90,0xF8], False)
    test_cell('BNE (wrong branch)', [0xB5,0x00,0x9D,0x00,0x04,0xCA,0xD0,0xF8], False)
