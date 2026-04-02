"""
GPU transducer-based replicator scanner.

Fixed-size state machine that walks instruction boundaries and
tracks core opcode positions. Fully branchless, vmappable over cells.

State: 17 int8 positions + uint32 boundary mask
  - bytes_remaining (0-2)
  - pos_lda_x, pos_lax_y
  - pos_sta_0400_x, pos_sta_03ff_x, pos_sta_0400_y, pos_sta_03ff_y
  - pos_inx, pos_inx_2nd, pos_dex, pos_dex_2nd
  - pos_iny, pos_iny_2nd, pos_dey, pos_dey_2nd
  - boundary_mask (uint32)
"""

from functools import partial
import jax
import jax.numpy as jnp
import numpy as np
import time
import sys

from .mine_blake3 import blake3_compress, IV, CHUNK_START, CHUNK_END, ROOT
from .mine_turtles_tiers import SOUP_WEIGHTS, build_soup_lookup

# ── Precomputed tables ────────────────────────────────────────────────

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

ILEN_TABLE = jnp.array(_ilen, dtype=jnp.int32)

# Boolean tables
# Only BCC (0x90) and BVC (0x50) reliably loop — other branches
# depend on N/Z/C flags that get set unpredictably by inserts
_is_branch = np.zeros(256, dtype=np.bool_)
for op in [0x90, 0x50]: _is_branch[op] = True
IS_BRANCH = jnp.array(_is_branch)

CELL_LEN = 32  # bytes per cell to scan


# ── Transducer: single cell scan ──────────────────────────────────────

# State indices (in a flat int32 array for JAX compatibility)
# 0: pc (current position)
# 1: bytes_remaining
# 2: jammed (0 or 1)
# 3: pos_lda_x     (LDA $00,X = B5 00)
# 4: pos_lax_y     (LAX $00,Y = B7 00)
# 5: pos_sta0400x  (STA $0400,X = 9D 00 04)
# 6: pos_sta03ffx  (STA $03FF,X = 9D FF 03)
# 7: pos_sta0400y  (STA $0400,Y = 99 00 04)
# 8: pos_sta03ffy  (STA $03FF,Y = 99 FF 03)
# 9:  pos_inx       10: pos_inx_2nd
# 11: pos_dex       12: pos_dex_2nd
# 13: pos_iny       14: pos_iny_2nd
# 15: pos_dey       16: pos_dey_2nd
N_STATE = 17
SENTINEL = -1

def _init_state():
    s = jnp.full(N_STATE, SENTINEL, dtype=jnp.int32)
    s = s.at[0].set(0)   # pc = 0
    s = s.at[1].set(0)   # bytes_remaining = 0
    s = s.at[2].set(0)   # not jammed
    return s


def _scan_step(state, cell):
    """One step of the transducer. Called for each byte position."""
    pc = state[0]
    remaining = state[1]
    jammed = state[2]

    pos = pc  # current position in the cell
    byte = cell[pos]
    byte_i = byte.astype(jnp.int32)

    # Are we at an opcode boundary?
    at_boundary = (remaining == 0) & (jammed == 0)

    ilen = ILEN_TABLE[byte_i]
    is_jam = (ilen == 0) & at_boundary

    # Next state
    new_remaining = jnp.where(at_boundary, jnp.maximum(ilen - 1, 0), remaining - 1)
    new_jammed = jnp.where(is_jam, 1, jammed)
    new_pc = jnp.where(jammed | is_jam, pc, pc + 1)
    # Clamp pc
    new_pc = jnp.minimum(new_pc, CELL_LEN - 1)

    new_state = state.at[0].set(new_pc)
    new_state = new_state.at[1].set(new_remaining)
    new_state = new_state.at[2].set(new_jammed)

    # Update position trackers (only at opcode boundaries)
    # Need to peek at operand bytes for multi-byte opcodes
    byte1 = cell[jnp.minimum(pos + 1, CELL_LEN - 1)]
    byte2 = cell[jnp.minimum(pos + 2, CELL_LEN - 1)]

    # LDA $00,X: opcode B5, operand 00
    is_lda_x = at_boundary & (byte == 0xB5) & (byte1 == 0x00)
    new_state = jnp.where(is_lda_x, new_state.at[3].set(pos), new_state)

    # LAX $00,Y: opcode B7, operand 00
    is_lax_y = at_boundary & (byte == 0xB7) & (byte1 == 0x00)
    new_state = jnp.where(is_lax_y, new_state.at[4].set(pos), new_state)

    # STA $0400,X: opcode 9D, operands 00 04
    is_sta0400x = at_boundary & (byte == 0x9D) & (byte1 == 0x00) & (byte2 == 0x04)
    new_state = jnp.where(is_sta0400x, new_state.at[5].set(pos), new_state)

    # STA $03FF,X: opcode 9D, operands FF 03
    is_sta03ffx = at_boundary & (byte == 0x9D) & (byte1 == 0xFF) & (byte2 == 0x03)
    new_state = jnp.where(is_sta03ffx, new_state.at[6].set(pos), new_state)

    # STA $0400,Y: opcode 99, operands 00 04
    is_sta0400y = at_boundary & (byte == 0x99) & (byte1 == 0x00) & (byte2 == 0x04)
    new_state = jnp.where(is_sta0400y, new_state.at[7].set(pos), new_state)

    # STA $03FF,Y: opcode 99, operands FF 03
    is_sta03ffy = at_boundary & (byte == 0x99) & (byte1 == 0xFF) & (byte2 == 0x03)
    new_state = jnp.where(is_sta03ffy, new_state.at[8].set(pos), new_state)

    # INX (E8): track last two positions
    is_inx = at_boundary & (byte == 0xE8)
    new_state = jnp.where(is_inx, new_state.at[10].set(new_state[9]), new_state)  # 2nd = old 1st
    new_state = jnp.where(is_inx, new_state.at[9].set(pos), new_state)

    # DEX (CA)
    is_dex = at_boundary & (byte == 0xCA)
    new_state = jnp.where(is_dex, new_state.at[12].set(new_state[11]), new_state)
    new_state = jnp.where(is_dex, new_state.at[11].set(pos), new_state)

    # INY (C8)
    is_iny = at_boundary & (byte == 0xC8)
    new_state = jnp.where(is_iny, new_state.at[14].set(new_state[13]), new_state)
    new_state = jnp.where(is_iny, new_state.at[13].set(pos), new_state)

    # DEY (88)
    is_dey = at_boundary & (byte == 0x88)
    new_state = jnp.where(is_dey, new_state.at[16].set(new_state[15]), new_state)
    new_state = jnp.where(is_dey, new_state.at[15].set(pos), new_state)

    # Emit: is this position an opcode boundary?
    is_opcode = at_boundary & (~is_jam)
    return new_state, is_opcode


def _check_variants(state, cell, boundary_mask):
    """Check all variant×branch combos at each backward branch."""
    found = jnp.bool_(False)

    # For each position, check if it's a backward branch
    def check_pos(pos):
        byte = cell[pos]
        is_br = IS_BRANCH[byte.astype(jnp.int32)]
        is_boundary = boundary_mask[pos]

        offset_byte = cell[jnp.minimum(pos + 1, CELL_LEN - 1)]
        signed_off = jnp.where(offset_byte >= 128, offset_byte.astype(jnp.int32) - 256,
                                offset_byte.astype(jnp.int32))
        target = pos + 2 + signed_off
        is_backward = (target >= 0) & (target < pos)
        is_valid_branch = is_br & is_boundary & is_backward

        # Check target is an opcode boundary
        target_clamped = jnp.clip(target, 0, CELL_LEN - 1)
        target_is_boundary = boundary_mask[target_clamped]
        is_valid_branch = is_valid_branch & target_is_boundary

        # Check variants: need LDA + STA + INC all within [target, pos]
        def in_loop(p):
            return (p >= target) & (p <= pos) & (p >= 0)

        # X-family standard: lda_x + sta0400x + (dex or inx)
        x_std_dex = (in_loop(state[3]) & in_loop(state[5]) & in_loop(state[11]) &
                     ~in_loop(state[12]))  # no 2nd DEX in loop
        x_std_inx = (in_loop(state[3]) & in_loop(state[5]) & in_loop(state[9]) &
                     ~in_loop(state[10]))  # no 2nd INX

        # X-family shifted: lda_x + sta03ffx + inx (shifted needs INX)
        x_shift = (in_loop(state[3]) & in_loop(state[6]) & in_loop(state[9]) &
                   ~in_loop(state[10]))

        # Y-family standard: lax_y + sta0400y + (dey or iny)
        y_std_dey = (in_loop(state[4]) & in_loop(state[7]) & in_loop(state[15]) &
                     ~in_loop(state[16]))
        y_std_iny = (in_loop(state[4]) & in_loop(state[7]) & in_loop(state[13]) &
                     ~in_loop(state[14]))

        # Y-family shifted: lax_y + sta03ffy + iny
        y_shift = (in_loop(state[4]) & in_loop(state[8]) & in_loop(state[13]) &
                   ~in_loop(state[14]))

        any_variant = x_std_dex | x_std_inx | x_shift | y_std_dey | y_std_iny | y_shift
        return is_valid_branch & any_variant

    # Check all 32 positions
    hits = jax.vmap(check_pos)(jnp.arange(CELL_LEN, dtype=jnp.int32))
    return jnp.any(hits)


def scan_cell_gpu(cell):
    """Full transducer: scan + variant check. Returns bool."""
    init = _init_state()
    final_state, boundaries = jax.lax.scan(
        lambda s, _: _scan_step(s, cell),
        init,
        jnp.arange(CELL_LEN)
    )
    boundary_mask = boundaries  # bool[32]
    return _check_variants(final_state, cell, boundary_mask)


# ── BLAKE3 + bias + transducer pipeline ───────────────────────────────

def blake3_cell_24(seed, cell_index):
    msg = jnp.zeros(16, dtype=jnp.uint32)
    msg = msg.at[0].set(seed)
    msg = msg.at[1].set(cell_index)
    flags = CHUNK_START | CHUNK_END | ROOT
    out = blake3_compress(msg, IV, jnp.uint32(0), jnp.uint32(8), flags)
    return out[:6].view(jnp.uint8)  # 24 bytes


def apply_bias(raw, lookup):
    idx = raw.astype(jnp.uint32) * 257
    idx = jnp.clip(idx, 0, 65535)
    return lookup[idx]


@partial(jax.jit, static_argnames=('board_size',))
def scan_board(seed, lookup, board_size=64):
    """Generate biased cells + run transducer on all cells."""
    n_cells = board_size * board_size

    def process_cell(ci):
        raw = blake3_cell_24(seed, ci)
        biased = apply_bias(raw, lookup)
        # Pad to 32 bytes (transducer expects 32)
        padded = jnp.zeros(CELL_LEN, dtype=jnp.uint8)
        padded = padded.at[:24].set(biased)
        return scan_cell_gpu(padded)

    return jax.vmap(process_cell)(jnp.arange(n_cells, dtype=jnp.uint32))


# ── Main ──────────────────────────────────────────────────────────────

if __name__ == '__main__':
    try:
        sys.stdout = open(sys.stdout.fileno(), 'w', buffering=1)
    except OSError:
        pass

    lookup = build_soup_lookup()

    print("Transducer GPU miner", flush=True)
    print("JIT warmup...", end=' ', flush=True)
    t_jit = time.time()
    result = scan_board(jnp.uint32(0), lookup, 64)
    jax.block_until_ready(result)
    print(f"done ({time.time()-t_jit:.1f}s)", flush=True)

    from .train import simulate_candidate

    t0 = time.time()
    total_seeds = 0
    total_hits = 0
    total_viable = 0
    lookup_np = np.array(lookup)

    for seed in range(10000000):
        matches = scan_board(jnp.uint32(seed), lookup, 64)
        jax.block_until_ready(matches)
        hit_cells = np.where(np.asarray(matches))[0]

        for ci in hit_cells:
            total_hits += 1
            # Regenerate cell for CPU verification
            raw = np.array(blake3_cell_24(jnp.uint32(seed), jnp.uint32(int(ci))))
            biased = lookup_np[(raw.astype(np.uint32) * 257).clip(0, 65535)]

            from .mine_turtles_tiers import scan_cell
            match = scan_cell(biased)
            if match is None:
                continue

            result = simulate_candidate(match['program'], board_size=4)
            elapsed = time.time() - t0
            hp = ' '.join(f'{b:02X}' for b in match['program'][:16])

            if result['viable']:
                total_viable += 1
                print(f"⭐ VIABLE seed={seed} ({int(ci)//64},{int(ci)%64}) "
                      f"{match['variant']}/{match['branch']} L={match['length']} "
                      f"[{hp}] spread={result['spread']} {elapsed:.1f}s", flush=True)
            else:
                print(f"   near-miss seed={seed} ({int(ci)//64},{int(ci)%64}) "
                      f"{match['variant']}/{match['branch']} L={match['length']} "
                      f"[{hp}] spread={result['spread']} {elapsed:.1f}s", flush=True)

        total_seeds += 1
        if total_seeds % 1000 == 0:
            elapsed = time.time() - t0
            print(f"  {total_seeds} seeds, {total_seeds/elapsed:.0f}/s, "
                  f"{total_hits} hits, {total_viable} viable, {elapsed:.0f}s", flush=True)
