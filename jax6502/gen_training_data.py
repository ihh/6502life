"""Generate labeled training data for supervised HMM training.

Creates candidates by taking known viable cores (BCC/INX, BCC/DEX),
inserting 0-15 bytes at random positions (70% safe NOPs/flag ops,
30% random bytes), fixing the branch offset, and simulating each
on a 4x4 board to get viable/non-viable labels.

Usage:
    python -m jax6502.gen_training_data --num 20000 --output jax6502/training_data_20k.json
"""

import argparse
import json
import time
import sys
import os
import numpy as np

if __name__ != '__main__': pass
else: sys.stdout = open(sys.stdout.fileno(), 'w', buffering=1)

# We need to be able to import jax6502 as a package
from jax6502.train import simulate_candidate
import jax.random as jr

# Known viable 8-byte cores
CORES = [
    [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8],  # BCC, INX
    [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xCA, 0x90, 0xF8],  # BCC, DEX
]

# Safe insert bytes (NOPs, flag ops — don't clobber registers used by the core)
# Per insert position:
#   Position 0 (before LDA): must not clobber X or set carry
#   Position 1 (between LDA operand and STA): must not clobber A
#   Position 2 (between STA and INX/DEX): must not clobber A or X
#   Position 3 (between INX/DEX and branch): must not clobber flags
#   Position 4 (after branch, i.e., tail): weakest constraint
SAFE_BYTES_GENERAL = [
    0xEA,  # NOP
    0x18,  # CLC
    0x38,  # SEC
    0x58,  # CLI
    0x78,  # SEI
    0xB8,  # CLV
    0xD8,  # CLD
    0xF8,  # SED
]

# For position 0 (before LDA zpx): avoid setting carry (SEC would break BCC)
SAFE_POS0 = [0xEA, 0x18, 0x58, 0x78, 0xB8, 0xD8]  # no SEC, no SED

# For position 3 (before branch): must preserve flags, so only NOP
SAFE_POS3 = [0xEA]

# Insert positions are between core bytes (0..7 = 8 core bytes)
# Position 0: before byte 0 (before LDA)
# Position 1: after byte 1 (after LDA operand, before STA)
# Position 2: after byte 4 (after STA abs high, before INX/DEX)
# Position 3: after byte 5 (after INX/DEX, before branch)
# We can also insert at position 4: after byte 6 (after branch opcode, before offset)
# But inserting between branch opcode and its operand would break things.
# Safe insert points: before the core, between pairs, after the core.
INSERT_POINTS = [0, 2, 5, 6, 8]  # indices in the core where inserts go


def make_candidate(rng, core):
    """Generate one candidate by inserting 0-15 random bytes into a core."""
    n_inserts = rng.randint(0, 16)  # 0-15 inserts
    if n_inserts == 0:
        return list(core)

    # Pick an insert point
    insert_idx = rng.choice(len(INSERT_POINTS))
    pos = INSERT_POINTS[insert_idx]

    # Choose safe vs random bytes
    insert_bytes = []
    for _ in range(n_inserts):
        if rng.random() < 0.7:
            # Safe byte
            if insert_idx == 0:
                b = rng.choice(SAFE_POS0)
            elif insert_idx == 3:
                b = rng.choice(SAFE_POS3)
            else:
                b = rng.choice(SAFE_BYTES_GENERAL)
        else:
            # Random byte
            b = rng.randint(0, 256)
        insert_bytes.append(int(b))

    # Build the sequence with inserts
    seq = list(core[:pos]) + insert_bytes + list(core[pos:])

    # Fix branch offset (BCC is second-to-last byte in the original core)
    # Find the BCC opcode (0x90) — it's at original position 6
    # After insertion, its position shifts
    bcc_pos = pos + 6 if pos <= 6 else 6
    # Actually, let's find BCC in the sequence more carefully
    # The branch is always 0x90 followed by its offset
    # In the original: bytes 6,7 = 0x90, 0xF8
    # After insert: branch is at (6 + n_inserts if pos <= 6, else 6)
    if pos <= 6:
        bcc_pos = 6 + n_inserts
    else:
        bcc_pos = 6

    # Branch target should be byte 0 (start of sequence)
    # Branch offset = target - (bcc_pos + 2) mod 256
    total_len = len(seq)
    offset = (0 - (bcc_pos + 2)) & 0xFF
    seq[bcc_pos + 1] = offset

    return seq


def generate_batch(start_idx, count, board_size=4, rng_seed=42):
    """Generate a batch of labeled candidates."""
    rng = np.random.RandomState(rng_seed)
    results = []

    for i in range(count):
        core = CORES[rng.randint(0, len(CORES))]
        seq = make_candidate(rng, core)

        # Simulate
        jax_key = jr.PRNGKey(rng_seed * 100000 + start_idx + i)
        r = simulate_candidate(seq, board_size=board_size, rng_key=jax_key)

        results.append({
            'seq': seq,
            'viable': bool(r['viable']),
            'spread': int(r['spread']),
        })

        if (start_idx + i + 1) % 500 == 0:
            n_viable = sum(1 for r in results if r['viable'])
            print(f'  Generated {start_idx + i + 1} examples, '
                  f'{n_viable}/{len(results)} viable so far')

    return results


def main():
    parser = argparse.ArgumentParser(description='Generate labeled training data')
    parser.add_argument('--num', type=int, default=20000,
                        help='Number of examples to generate')
    parser.add_argument('--output', type=str,
                        default='jax6502/training_data_20k.json',
                        help='Output JSON file')
    parser.add_argument('--board-size', type=int, default=4,
                        help='Board size for simulation')
    parser.add_argument('--seed', type=int, default=42,
                        help='Random seed')
    parser.add_argument('--batch-size', type=int, default=500,
                        help='Batch size for progress reporting')
    args = parser.parse_args()

    print(f'Generating {args.num} labeled training examples...')
    print(f'Board size: {args.board_size}x{args.board_size}')
    print(f'Output: {args.output}')
    t0 = time.time()

    all_results = generate_batch(0, args.num, board_size=args.board_size,
                                 rng_seed=args.seed)

    elapsed = time.time() - t0
    n_viable = sum(1 for r in all_results if r['viable'])
    print(f'\nDone in {elapsed:.0f}s ({elapsed/args.num:.2f}s per example)')
    print(f'Total: {len(all_results)}, viable: {n_viable} '
          f'({100*n_viable/len(all_results):.1f}%)')

    seq_lens = [len(r['seq']) for r in all_results]
    print(f'Sequence lengths: min={min(seq_lens)}, max={max(seq_lens)}, '
          f'mean={np.mean(seq_lens):.1f}')

    with open(args.output, 'w') as f:
        json.dump(all_results, f)
    print(f'Saved to {args.output}')


if __name__ == '__main__':
    main()
