#!/usr/bin/env python3
"""Run Turtle's Tiers CPU mining."""
import sys, numpy as np, time
sys.stdout = open(sys.stdout.fileno(), 'w', buffering=1)

from jax6502.mine_turtles_tiers import scan_cell, SOUP_WEIGHTS
from jax6502.train import simulate_candidate

total = float(SOUP_WEIGHTS.sum())
cdf = np.cumsum(SOUP_WEIGHTS / total)
lut = np.zeros(65536, dtype=np.uint8)
bi = 0
for i in range(65536):
    while bi < 255 and cdf[bi] < (i+0.5)/65536: bi += 1
    lut[i] = bi

print("Turtle's Tiers CPU miner (insert safety checked)", flush=True)
t0 = time.time()
n_seeds = 0; n_hits = 0

for seed in range(10000000):
    rng = np.random.RandomState(seed * 2654435761 & 0xFFFFFFFF)
    for ci in range(4096):
        raw = rng.randint(0, 65536, 32, dtype=np.uint16)
        cell = lut[raw]
        match = scan_cell(cell)
        if match is not None:
            n_hits += 1
            r = simulate_candidate(match['program'], board_size=4)
            elapsed = time.time() - t0
            hp = ' '.join(f'{b:02X}' for b in match['program'][:20])
            status = 'VIABLE!' if r['viable'] else f'spread={r["spread"]}'
            print(f'#{n_hits} seed={seed} ({ci//64},{ci%64}) {match["variant"]}/{match["branch"]} '
                  f'L={match["length"]} [{hp}] {status} {elapsed:.1f}s', flush=True)
            if r['viable']:
                print(f'\nFOUND IT! seed={seed} cell=({ci//64},{ci%64})')
                print(f'Variant: {match["variant"]}, Branch: {match["branch"]}')
                print(f'Length: {match["length"]}, Program: {hp}')
                print(f'Spread: {r["spread"]}')
                print(f'Total: {n_seeds} seeds, {elapsed:.1f}s')
                sys.exit(0)
    n_seeds += 1
    if n_seeds % 200 == 0:
        elapsed = time.time() - t0
        print(f'  {n_seeds} seeds, {n_hits} hits, {n_seeds/elapsed:.1f}/s, {elapsed:.0f}s', flush=True)
