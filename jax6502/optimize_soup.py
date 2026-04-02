"""Optimize NOP Soup byte distribution for replicator mining.

Finds a multi-tier distribution that maximizes P(replicator per board)
subject to entropy >= current 2-tier entropy.
"""

import numpy as np
from scipy.optimize import minimize

# === Byte categories ===
CORE_BYTES = [0x00, 0x04, 0x50, 0x88, 0x90, 0x99, 0x9D, 0xB5, 0xB7, 0xC8, 0xCA, 0xE8]
SAFE_INSERT_BYTES = [0x08, 0x18, 0x1A, 0x3A, 0x48, 0x58, 0x5A, 0x78, 0x7A, 0x9A, 0xA0, 0xA8, 0xB8, 0xD8, 0xDA, 0xEA, 0xF8, 0xFA]
OFFSET_BYTES = [0xEB, 0xEC, 0xED, 0xEE, 0xEF, 0xF0, 0xF1, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7]

N_CORE = len(CORE_BYTES)       # 12
N_SAFE = len(SAFE_INSERT_BYTES) # 18
N_OFFSET = len(OFFSET_BYTES)   # 12
N_BG = 256 - N_CORE - N_SAFE - N_OFFSET  # 214

assert N_CORE + N_SAFE + N_OFFSET + N_BG == 256

# Number of core variants
N_VARIANTS = 8
# Max inserts to consider
MAX_INSERTS = 12
# Cells per board
CELLS = 4096
# Bytes per cell
BYTES_PER_CELL = 256  # searchable positions in a cell


def compute_metrics(w_core, w_safe, w_offset, w_bg=1.0):
    """Compute P(replicator per board) and entropy H for given weights."""
    Z = N_CORE * w_core + N_SAFE * w_safe + N_OFFSET * w_offset + N_BG * w_bg

    p_core = w_core / Z
    p_safe = w_safe / Z
    p_offset = w_offset / Z
    p_bg = w_bg / Z

    # Entropy
    H = 0
    for n, p in [(N_CORE, p_core), (N_SAFE, p_safe), (N_OFFSET, p_offset), (N_BG, p_bg)]:
        if p > 0:
            H -= n * p * np.log2(p)

    # P(replicator per cell)
    # A core is 8 bytes: 7 core bytes + 1 offset byte
    # With k safe inserts, the total length is 8+k
    # The offset byte determines the branch distance = -(8+k), so for length 8+k
    # the offset is 256-(8+k) = 248-k for k=0..12, giving offsets F8..EC
    # Some offsets are elevated (in OFFSET_BYTES), some might not be

    # Core lengths 8-20 correspond to k=0..12 inserts
    # Branch offset for length L = 8+k is: 256 - L = 248 - k
    # k=0: offset=0xF8 (in SAFE_INSERT_BYTES actually... let me check)
    # Wait, F8 is in SAFE_INSERT_BYTES. Let me re-examine.

    # The elevated bytes list: 00 04 08 18 1A 3A 48 50 58 5A 78 7A 88 90 99 9A 9D
    #   A0 A8 B5 B7 B8 C8 CA D8 DA E8 EA EB EC ED EE EF F0 F1 F3 F4 F5 F6 F7 F8 FA
    # OFFSET_BYTES = EB EC ED EE EF F0 F1 F3 F4 F5 F6 F7
    # These correspond to branch offsets for specific core lengths.
    # F8 is in SAFE_INSERT_BYTES, FA is in SAFE_INSERT_BYTES

    # For core length L=8+k, the branch offset byte is 256-L
    # k=0: L=8, offset=0xF8 -> in SAFE_INSERT_BYTES, prob = p_safe
    # k=1: L=9, offset=0xF7 -> in OFFSET_BYTES, prob = p_offset
    # k=2: L=10, offset=0xF6 -> in OFFSET_BYTES
    # k=3: L=11, offset=0xF5 -> in OFFSET_BYTES
    # k=4: L=12, offset=0xF4 -> in OFFSET_BYTES
    # k=5: L=13, offset=0xF3 -> in OFFSET_BYTES
    # k=6: L=14, offset=0xF2 -> NOT elevated! background prob
    # k=7: L=15, offset=0xF1 -> in OFFSET_BYTES
    # k=8: L=16, offset=0xF0 -> in OFFSET_BYTES
    # k=9: L=17, offset=0xEF -> in OFFSET_BYTES
    # k=10: L=18, offset=0xEE -> in OFFSET_BYTES
    # k=11: L=19, offset=0xED -> in OFFSET_BYTES
    # k=12: L=20, offset=0xEC -> in OFFSET_BYTES
    # k=13: L=21, offset=0xEB -> in OFFSET_BYTES

    # So max_inserts should cover k=0..13 (lengths 8..21)
    # But the problem says "12 branch offset bytes for cores of length 8-21"
    # Length 8 uses F8 (safe insert), length 14 uses F2 (background)
    # The 12 offset bytes cover lengths 9-13,15-21

    offset_for_k = {}
    for k in range(14):  # k=0..13, lengths 8..21
        L = 8 + k
        off = (256 - L) & 0xFF
        if off in OFFSET_BYTES:
            offset_for_k[k] = ('offset', p_offset)
        elif off in SAFE_INSERT_BYTES:
            offset_for_k[k] = ('safe', p_safe)
        elif off in CORE_BYTES:
            offset_for_k[k] = ('core', p_core)
        else:
            offset_for_k[k] = ('bg', p_bg)

    # P(replicator per cell) summed over all insert counts k
    # For each k: 8 variants × C(k+4,k) placements × (p_core^7) × (p_safe^k) × p_offset_k
    # The 7 core bytes each have probability p_core
    # The k insert bytes each have probability p_safe (any of 18 safe insert bytes)
    # But wait - the probability of a SPECIFIC core byte is p_core, and there are
    # specific bytes needed. Let me reconsider.
    #
    # Actually, the formula from the problem statement:
    # P = sum_k 8 * C(k+4,k) * n_safe^k * pE^(7+k) * p_offset
    # where pE is the elevated byte probability.
    #
    # In the 2-tier case, all elevated bytes have the same probability pE.
    # In the multi-tier case, core bytes have prob p_core, safe inserts have prob p_safe.
    #
    # The 7 mandatory core positions each need a SPECIFIC byte (prob = p_core each).
    # The k insert positions each need ANY of the 18 safe insert bytes (prob = 18 * p_safe each).
    # The offset position needs a SPECIFIC byte (prob depends on which tier it's in).
    # Times C(k+4, k) for placement positions, times 8 for variants.

    p_rep_per_cell = 0
    for k in range(14):
        comb = 1
        for i in range(1, k+1):
            comb = comb * (k + 4) // i  # C(k+4, k) = C(k+4, 4)
        # Actually C(k+4, k) = C(k+4, 4)
        from math import comb as mcomb
        c = mcomb(k + 4, k)

        _, p_off = offset_for_k[k]

        # 7 specific core bytes, k safe insert bytes (any of 18), 1 specific offset byte
        p_k = N_VARIANTS * c * (p_core ** 7) * ((N_SAFE * p_safe) ** k) * p_off
        p_rep_per_cell += p_k

    # Searchable positions per cell (overlapping windows of varying length)
    # Approximate: each cell has ~256 start positions
    p_rep_per_cell *= BYTES_PER_CELL

    # P(at least one replicator on board)
    p_board = 1 - (1 - p_rep_per_cell) ** CELLS

    return p_rep_per_cell, p_board, H


def neg_log_p_board(params, H_min):
    """Objective: minimize -log(P_board) subject to H >= H_min."""
    w_core, w_safe, w_offset = np.exp(params)  # ensure positive
    p_cell, p_board, H = compute_metrics(w_core, w_safe, w_offset, w_bg=1.0)

    if H < H_min:
        penalty = 1e6 * (H_min - H) ** 2
    else:
        penalty = 0

    if p_board <= 0:
        return 1e10 + penalty

    return -np.log(p_board + 1e-300) + penalty


# === Main ===
print("=" * 70)
print("NOP Soup Distribution Optimizer")
print("=" * 70)

# Current 2-tier scheme
bw = 100
p_cell_2t, p_board_2t, H_2t = compute_metrics(bw, bw, bw, w_bg=1.0)
print(f"\n--- Current 2-tier (bw={bw}) ---")
print(f"  p_core = p_safe = p_offset = {bw} / Z")
print(f"  P(rep/cell) = {p_cell_2t:.6e}")
print(f"  P(rep/board) = {p_board_2t:.6e}")
print(f"  Entropy H = {H_2t:.4f} bits")

# Expected boards to mine
if p_board_2t > 0:
    print(f"  Expected boards to find replicator: {1/p_board_2t:.1f}")

# === 3-tier grid search ===
print(f"\n--- 3-tier grid search (H >= {H_2t:.4f}) ---")
best_3t = None
best_p_board_3t = 0

for log_wc in np.linspace(np.log(50), np.log(2000), 40):
    for log_ws in np.linspace(np.log(1), np.log(500), 40):
        for log_wo in np.linspace(np.log(1), np.log(500), 20):
            wc, ws, wo = np.exp(log_wc), np.exp(log_ws), np.exp(log_wo)
            pc, pb, h = compute_metrics(wc, ws, wo, w_bg=1.0)
            if h >= H_2t and pb > best_p_board_3t:
                best_p_board_3t = pb
                best_3t = (wc, ws, wo, pc, pb, h)

if best_3t:
    wc, ws, wo, pc, pb, h = best_3t
    print(f"  Best: w_core={wc:.1f}, w_safe={ws:.1f}, w_offset={wo:.1f}")
    print(f"  P(rep/cell) = {pc:.6e}")
    print(f"  P(rep/board) = {pb:.6e}")
    print(f"  Entropy H = {h:.4f} bits")
    print(f"  Expected boards: {1/pb:.1f}")
    print(f"  Speedup vs 2-tier: {pb/p_board_2t:.2f}x")

# === Scipy optimization ===
print(f"\n--- Scipy constrained optimization ---")
H_min = H_2t

best_opt = None
best_p_board_opt = 0

for _ in range(200):
    x0 = np.random.randn(3) * 2
    res = minimize(neg_log_p_board, x0, args=(H_min,), method='Nelder-Mead',
                   options={'maxiter': 5000, 'xatol': 1e-8, 'fatol': 1e-12})
    wc, ws, wo = np.exp(res.x)
    pc, pb, h = compute_metrics(wc, ws, wo, w_bg=1.0)
    if h >= H_min - 0.001 and pb > best_p_board_opt:
        best_p_board_opt = pb
        best_opt = (wc, ws, wo, pc, pb, h)

if best_opt:
    wc, ws, wo, pc, pb, h = best_opt
    print(f"  Best: w_core={wc:.1f}, w_safe={ws:.1f}, w_offset={wo:.1f}")
    print(f"  P(rep/cell) = {pc:.6e}")
    print(f"  P(rep/board) = {pb:.6e}")
    print(f"  Entropy H = {h:.4f} bits")
    print(f"  Expected boards: {1/pb:.1f}")
    print(f"  Speedup vs 2-tier: {pb/p_board_2t:.2f}x")

# === Final recommendation ===
print("\n" + "=" * 70)
print("RECOMMENDATION")
print("=" * 70)

# Pick the best overall
candidates = []
if best_3t:
    candidates.append(('3-tier grid', best_3t))
if best_opt:
    candidates.append(('scipy', best_opt))

if candidates:
    best_name, (wc, ws, wo, pc, pb, h) = max(candidates, key=lambda x: x[1][4])
    print(f"\nBest found ({best_name}):")
    print(f"  Core opcodes (12 bytes):     weight = {wc:.1f}")
    print(f"  Safe inserts (18 bytes):     weight = {ws:.1f}")
    print(f"  Offset bytes (12 bytes):     weight = {wo:.1f}")
    print(f"  Background   (214 bytes):    weight = 1.0")
    print(f"")
    print(f"  P(rep/board 4096 cells) = {pb:.6e}")
    print(f"  Entropy H = {h:.4f} bits (current: {H_2t:.4f})")
    print(f"  Speedup: {pb/p_board_2t:.2f}x faster mining")

    # Show per-byte probabilities
    Z = N_CORE * wc + N_SAFE * ws + N_OFFSET * wo + N_BG * 1.0
    print(f"\n  Per-byte probabilities:")
    print(f"    Core byte:   {wc/Z:.6f} ({wc/Z*256:.3f} × uniform)")
    print(f"    Safe insert: {ws/Z:.6f} ({ws/Z*256:.3f} × uniform)")
    print(f"    Offset byte: {wo/Z:.6f} ({wo/Z*256:.3f} × uniform)")
    print(f"    Background:  {1/Z:.6f} ({1/Z*256:.3f} × uniform)")
