# 6502life Performance Profiling Results

**Date:** 2026-03-20
**Branch:** `investigate/wasm-cpu`
**Machine:** macOS (Darwin 24.1.0), Node.js v20.8.1
**Tool:** `cli/bin/profile.js`

## Methodology

Instrumented `runToNextInterrupt()` by reimplementing the inner loop with
`performance.now()` timing around each phase. JIT warmup of 10K interrupts
precedes each measured run. Three scenarios tested:

1. **8x8 board, brk-spreader at (0,0), 1M interrupts** — spreader actively replicating
2. **8x8 board, pure random content, 1M interrupts** — baseline random opcodes
3. **16x16 board, brk-spreader at (0,0), 100K interrupts** — larger board, fewer BRK hits

## Timing Breakdown

### Scenario 1: 8x8 + brk-spreader (1M interrupts)

| Phase                        |    Time (ms) |    % |
|------------------------------|-------------|------|
| CPU execution (sfotty.run)   |        360  |  2.1 |
| Scheduler total              |      2,147  | 12.4 |
|   sampleNextMove             |        224  |  1.3 |
|   readRegisters              |        398  |  2.3 |
|   writeRng                   |      1,525  |  8.8 |
| Commit writes                |      1,153  |  6.7 |
| BRK total                    |     13,165  | 76.3 |
|   BRK swap (commitMove)      |     11,793  | 68.4 |
|   BRK copy (noisy)           |      1,297  |  7.5 |
| Other/overhead               |        420  |  2.4 |
| **TOTAL**                    | **17,245**  |      |

- 84,520 swaps, 6,182 copies, 313K sfotty.run() calls
- Avg 0.3 sfotty.run() calls per interrupt

### Scenario 2: 8x8 pure random (1M interrupts)

| Phase                        |    Time (ms) |    % |
|------------------------------|-------------|------|
| CPU execution (sfotty.run)   |        393  |  7.3 |
| Scheduler total              |      1,831  | 34.0 |
|   sampleNextMove             |        196  |  3.6 |
|   readRegisters              |        336  |  6.2 |
|   writeRng                   |      1,299  | 24.1 |
| Commit writes                |        963  | 17.9 |
| BRK total                    |      1,843  | 34.2 |
|   BRK swap (commitMove)      |      1,611  | 29.9 |
|   BRK copy (noisy)           |        176  |  3.3 |
| Other/overhead               |        355  |  6.6 |
| **TOTAL**                    |  **5,385**  |      |

- 11,013 swaps, 889 copies, 808K sfotty.run() calls
- Avg 0.8 sfotty.run() calls per interrupt

### Scenario 3: 16x16 + brk-spreader (100K interrupts)

| Phase                        |    Time (ms) |    % |
|------------------------------|-------------|------|
| CPU execution (sfotty.run)   |         60  | 12.0 |
| Scheduler total              |        175  | 35.1 |
| Commit writes                |        110  | 22.1 |
| BRK total                    |        116  | 23.3 |
| Other/overhead               |         37  |  7.5 |
| **TOTAL**                    |    **499**  |      |

- 699 swaps, 34 copies, 121K sfotty.run() calls
- Avg 1.2 sfotty.run() calls per interrupt

## Analysis

### Is Sfotty the bottleneck?

**No.** CPU execution (sfotty.run()) accounts for only **2-12%** of wall time
across all scenarios. Even in the most CPU-heavy scenario (16x16 board with
fewer BRK events), it is only 12%.

The low call count per interrupt is expected: random memory produces invalid
opcodes that immediately trigger a software interrupt (BRK 0), and the
brk-spreader itself executes only ~5 instructions before hitting BRK.

### What IS the bottleneck?

The bottleneck depends on the workload:

**1. BRK cell swaps (`commitMove` -> `swapCells` -> `swapPages`) — 30-68% of time**

This is the largest single cost. `swapPages` swaps 4 pages (1024 bytes) by
calling `memory.read()` and `memory.write()` for each byte. Each call goes
through the full address translation pipeline:

- `addrToByteIndex()` -> `addrToCellCoords()` with coordinate wrapping
- Vector rotation checks (`doRotateTopBits`, `addrIsInVectorRange`)
- Undo history bookkeeping (`setByteWithUndo`)

For a single swap: 4 pages x 256 bytes x 4 memory ops = **4,096 memory operations**
through the full translation path. At ~140 us per swap, each memory operation
costs ~34 ns — all of which is address translation overhead.

**This is unnecessary.** `swapCells` operates on known cell indices and could
use direct `getByte`/`setByteWithoutUndo` on computed storage indices, bypassing
address translation entirely.

**2. writeRng — 9-24% of time**

`writeRng()` calls `writeDword()` which calls `memory.write()` 4 times. These 4
writes go through the full address translation path for addresses 0xFC-0xFF.
Since these are known fixed offsets in the origin cell, they could be written
directly to `storage[]`.

**3. Commit writes — 7-22% of time**

`commitWrites()` iterates `Object.keys(this.memory.undoHistory)` converting string
keys back to integers and decomposing them into (i,j,b) coordinates. This
is an O(n) iteration over a plain object used as a sparse set.

**4. readRegisters — 2-6% of time**

Reads 7 bytes through `memory.read()` with full address translation. Same
issue as writeRng: these are fixed-offset reads from the origin cell.

## Recommended Optimizations (in priority order)

### 1. Bypass address translation in bulk operations (estimated 50-75% speedup)

`swapPages`, `copyCellWithNoise`, `writeRegisters`, `readRegisters`, and
`writeRng` all operate on known cell indices/offsets. They should compute the
storage index once and use direct `getByte`/`setByteWithoutUndo` calls.

Example for swapPages:
```js
swapPages(i, j) {
    const mem = this.memory;
    const iBase = /* compute storage base for cell i */;
    const jBase = /* compute storage base for cell j */;
    for (let b = 0; b < 256; b++) {
        const tmp = mem.storage[iBase + b];
        mem.storage[iBase + b] = mem.storage[jBase + b];
        mem.storage[jBase + b] = tmp;
    }
}
```

This eliminates ~4,096 address translations per swap and ~2,048 per copy.

### 2. Use TypedArray swap for page-level operations

`Uint8Array.set()` or manual 32-bit word swaps could further speed up bulk copy:
```js
// Swap via typed array views or DataView for 4-byte-at-a-time operations
```

### 3. Replace Object-based undoHistory with a flat array log

The current `undoHistory = {}` uses string keys and `Object.keys()` iteration.
A flat `Uint32Array` log of (address, oldValue) pairs with an integer length
counter would eliminate string conversion overhead and improve GC behavior.

### 4. Cache sampleNextMove results

`sampleNextMove` calls `mt.int()` 4 times per interrupt. The Mersenne Twister
is pure JS and each call is ~50ns. Not a major bottleneck but could be
batched if needed.

## Should we write a WASM 6502 interpreter?

**No. A WASM 6502 interpreter would not produce meaningful speedup.**

CPU execution is only 2-12% of wall time. Even if a WASM interpreter were
infinitely fast (reducing CPU time to zero), the overall speedup would be
at most 1.02x-1.14x — not worth the development effort.

The actual bottleneck is the memory subsystem overhead in bulk operations
(swapPages, copyCellWithNoise) and per-interrupt bookkeeping (writeRng,
commitWrites, readRegisters). These are all pure JS operations that could
be optimized by:

1. Bypassing address translation for bulk/fixed-offset operations
2. Using typed arrays instead of object-based undo history
3. Avoiding `memory.read()`/`memory.write()` when the storage index is already known

These JS-level optimizations are simpler to implement, maintain, and debug
than a WASM 6502 interpreter, and target the phases that actually consume
80-90% of wall time.

### When WASM would matter

If the above optimizations are applied and CPU execution becomes the dominant
cost (which could happen on larger boards with fewer BRK events and more
real instruction execution), then a WASM interpreter could be reconsidered.
The threshold would be CPU execution exceeding ~40% of wall time.
