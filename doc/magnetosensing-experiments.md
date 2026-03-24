# Magnetosensing Experiments

Experiments with organisms that read `$FA` (orientation register) to navigate
directionally on the board.

## Background

When `boardParams.magnetosensing=true`, the scheduler writes
`(orientation << 2)` to `$FA` before each cell executes. Orientation is 0--3,
so `$FA` takes values 0, 4, 8, 12. The memory-mapped neighborhood is randomly
rotated each scheduling, but `$FA` tells the program HOW it was rotated,
enabling absolute-direction navigation.

## Compass Spreader Design

`presets/compass-spreader.asm` (42 bytes) always copies toward physical
direction (0,+1) regardless of orientation. It reads `$FA` and selects the
BRK operand that maps to (0,+1) for each rotation:

| Orientation | `$FA` | Mapped cell reaching (0,+1) | BRK operand |
|-------------|-------|-----------------------------|-------------|
| 0           | 0     | cell 1                      | `$F5`       |
| 1           | 4     | cell 2                      | `$F6`       |
| 2           | 8     | cell 3                      | `$F7`       |
| 3           | 12    | cell 4                      | `$F8`       |

The organism also writes hue=42 (0x2A) to `$03A0` as a visual marker.

## Experiment Results

All experiments on 8x8 board, seed=42, magnetosensing=true.

### Step 2: Directional Spreading (epsilon=0)

Compass-spreader seeded at (4,4). Tracked via hue=42 marker at `$3A0`.

| Interrupts | Hue=42 cells | In row i=4 | Other rows | % in row |
|------------|-------------|------------|------------|----------|
| 100        | 3           | 3          | 0          | 100%     |
| 200        | 6           | 4          | 2          | 67%      |
| 500        | 17          | 6          | 11         | 35%      |
| 1000       | 38          | 7          | 31         | 18%      |
| 2000       | 64          | 8          | 56         | 13%      |
| 5000       | 52          | 8          | 44         | 15%      |
| 10000      | 64          | 8          | 56         | 13%      |
| 50000      | 64          | 8          | 56         | 13%      |

**Findings**: Clear directional bias at early stages (100% at t=100, 67% at
t=200). The wave initially propagates along the j-axis (the +j direction).
Children inherit the compass code and also copy northward from their new
positions, creating a chain reaction that fills the entire 8x8 board by t=2000.
The dip to 52 at t=5000 suggests temporary overwrites by cells executing other
code, which recover by t=10000.

### Step 3: Compass vs Nano-2x Competition (epsilon=0)

Compass-spreader at (0,0) vs nano-2x at (4,4), both at epsilon=0.

| Metric | Count |
|--------|-------|
| Compass-spreader cells (sim > 0.8) | 0 |
| Nano-2x cells (sim > 0.8) | 64 |
| Other/mixed | 0 |

**Findings**: Nano-2x completely dominates. At 8 bytes vs 42 bytes,
nano-2x is far more resistant to being overwritten by random cell schedulings.
The compass-spreader's directional advantage cannot compensate for its code
size disadvantage. Smaller replicators win in direct competition because:

1. They have less code to corrupt when another cell overwrites them.
2. Their copies are more likely to remain functional.
3. They copy in two directions (forward + right) vs one direction.

### Step 4: Compass with Noise (epsilon=1/131072)

Compass-spreader at (4,4), epsilon=1/131072.

After 50k interrupts: 64 non-trivial cells (full board).

**Findings**: At very low noise, the compass-spreader still functions and fills
the board. The 42-byte code is large enough to occasionally suffer bit-flips,
but at 1/131072 per bit the expected mutations per copy are ~0.003
(42 bytes x 8 bits x 1/131072), meaning most copies are perfect.

### Step 5: Hue Tracking Over Time (epsilon=1/131072)

Compass-spreader at (4,4), epsilon=1/131072.

| Interrupts | Hue=42 cells | Non-trivial |
|------------|-------------|-------------|
| 10000      | 56          | 64          |
| 20000      | 64          | 64          |
| 30000      | 64          | 64          |
| 40000      | 64          | 64          |
| 50000      | 64          | 64          |

**Findings**: The hue marker is maintained across the board. At t=10000,
8 cells have lost the exact hue=42 marker (possibly due to noise or
temporary overwrites), but by t=20000 all 64 cells carry it. The BRK noisy
copy copies the entire cell (including `$3A0`), so children inherit the hue.
At this low noise level, the hue byte itself is rarely corrupted.

## Conclusions

1. **Magnetosensing enables directional navigation**: The compass-spreader
   successfully uses `$FA` to always copy in the same absolute direction,
   creating a directional wave visible at early time steps.

2. **Chain replication erases directionality**: Because children inherit the
   compass code and also copy northward, the directional wave quickly becomes
   omnidirectional. On a small toroidal board, this leads to full saturation.
   On a larger board, the directional bias would be more visible as a wavefront.

3. **Code size matters more than direction**: In competition with nano-2x
   (8 bytes), the compass-spreader (42 bytes) is completely outcompeted.
   Directional spreading provides no advantage when the competitor is
   5x smaller and copies in multiple directions.

4. **Low noise preserves function**: At epsilon=1/131072, the compass-spreader
   maintains its population and hue markers despite its larger code size.

## Future Directions

- Test on larger boards (32x32, 64x64) where directional wavefronts are more
  distinct and take longer to saturate.
- Design a smaller compass-spreader (fewer branches, lookup table approach).
- Combine magnetosensing with movement (BRK swap) for directional migration.
- Test compass organisms that spread in all four cardinal directions
  sequentially but prefer one direction, creating an anisotropic expansion.
- Evolve magnetosensing de novo by seeding with random code at epsilon > 0 and
  checking if any surviving organisms read `$FA`.
