# WASM 6502 CPU Emulator — Design Document

## Overview

A cycle-accurate NMOS 6502 CPU emulator written in C, compiled to WebAssembly
via Emscripten, designed as a drop-in replacement for the Sfotty JavaScript
emulator used in 6502life's `BoardController`.

## Motivation

While profiling shows CPU execution is only 2-12% of wall time (see
`doc/profiling-results.md`), a WASM CPU opens the door to moving the
entire inner loop (CPU + memory access) into WASM in a future phase.
The C implementation also eliminates Sfotty's `console.error` hack for
undocumented opcodes and provides built-in debugger features (watchpoints,
breakpoints, cycle limits).

## Architecture

### Decode Table

A static 256-entry lookup table maps each opcode to three fields:

- **Addressing mode** (13 modes: IMP, IMM, ZPG, ZPX, ZPY, ABS, ABX, ABY,
  INX, INY, REL, IND, ACC)
- **Operation** (the ALU/register operation to perform)
- **Instruction type** (READ, STORE, RMW, SPECIAL, IMP)

Undocumented opcodes map to `OP_UND` and are detected without crashing.

### Cycle-Accurate State Machine

Each call to `cpu_run()` advances the CPU by exactly one clock cycle,
matching Sfotty's `run()` semantics. The state machine uses two fields:

- `phase`: which sub-cycle of the current instruction we're in (0 = ready
  to decode next instruction)
- `cycleCounter`: total cycles within the current instruction (0 = boundary)

Phase 0 is the decode phase: fetch the opcode, look it up in the decode
table, and advance to phase 1. Subsequent phases handle the addressing
mode's memory accesses and the ALU operation.

The cycle counts match documented NMOS 6502 behavior exactly:

| Addressing Mode      | Read  | Store | RMW   |
|---------------------|-------|-------|-------|
| Implied/Accumulator | 2     | —     | 2     |
| Immediate           | 2     | —     | —     |
| Zero Page           | 3     | 3     | 5     |
| Zero Page,X/Y       | 4     | 4     | 6     |
| Absolute            | 4     | 4     | 6     |
| Absolute,X/Y (read) | 4-5*  | 5     | 7     |
| (Indirect,X)        | 6     | 6     | —     |
| (Indirect),Y (read) | 5-6*  | 6     | —     |
| Relative (branch)   | 2-4†  | —     | —     |

\* +1 cycle on page boundary crossing
† 2 not taken, 3 taken same page, 4 taken with page cross

Special instructions: BRK=7, JSR=6, RTS=6, RTI=6, PHA/PHP=3, PLA/PLP=4,
JMP abs=3, JMP ind=5.

### NMOS Bugs Emulated

- **JMP indirect page wrap bug**: `JMP ($xxFF)` reads the high byte from
  `$xx00` instead of `$xx00+$100`, matching NMOS hardware behavior.
- **BCD mode**: ADC/SBC in decimal mode use NMOS-specific flag behavior
  (N and Z set based on intermediate results, not the BCD result).

### Undocumented Opcode Handling

When an undocumented opcode is encountered:

1. `cpu->undocumented` is set to 1
2. `cpu_run()` returns `CPU_UNDOCUMENTED`
3. PC is NOT advanced (stays pointing at the undocumented opcode)
4. No `console.error` or crash — the host decides what to do

This matches how `BoardController` handles bad opcodes: it treats them as
`BRK 0` (7-cycle cost, PC reset to 0).

## Memory Interface

### WASM Builds (Emscripten)

Memory access uses imported JavaScript functions:

```c
extern uint8_t mem_read(uint16_t addr);
extern void    mem_write(uint16_t addr, uint8_t val);
```

These are provided by the JS host when instantiating the WASM module.
The JS functions call through to `BoardMemory.read()` and
`BoardMemory.write()`, preserving the address translation, rotation,
and undo history logic.

### Native Builds

Function pointers set via `cpu_set_memory_callbacks()`:

```c
void cpu_set_memory_callbacks(mem_read_fn read_fn, mem_write_fn write_fn);
```

## CPU State Structure

All CPU state lives in a single `cpu_state_t` struct allocated in WASM
linear memory. This enables JS to read/write registers directly via
`DataView` without function call overhead (for hot paths like
`readRegisters`/`writeRegisters`).

```c
typedef struct {
    uint16_t PC;           // Program counter
    uint8_t  A, X, Y, S;  // Registers
    uint8_t  P;            // Status register (NV-BDIZC)
    uint8_t  cycleCounter; // Cycle within instruction (0 = boundary)
    uint8_t  phase;        // Internal state machine phase
    uint8_t  opcode;       // Current opcode
    uint8_t  undocumented; // 1 if last opcode was undocumented
    // ... temporaries, debug features
} cpu_state_t;
```

Key difference from Sfotty: flags are stored as a single P byte, not as
individual booleans. The controller already uses `sfotty.P` as a raw
property for save/restore, so this simplifies the interface.

## WASM API

### Lifecycle Functions

```javascript
import createCPU6502 from './cpu/dist/6502.js';

const Module = await createCPU6502({
    mem_read: (addr) => memory.read(addr),
    mem_write: (addr, val) => memory.write(addr, val),
});

Module._cpu_wasm_init();  // Initialize CPU state
```

### Per-Cycle Execution

```javascript
const status = Module._cpu_wasm_run();  // Execute one cycle
// Returns: 0=OK, 1=undocumented, 2=breakpoint, 3/4=watchpoint, 5=cycle_limit
```

### Register Access

```javascript
// Via exported accessor functions
Module._cpu_get_pc();  Module._cpu_set_pc(0x0200);
Module._cpu_get_a();   Module._cpu_set_a(0x42);
// ... etc for X, Y, S, P, cycleCounter, phase
```

### Debug Features

```javascript
Module._cpu_add_breakpoint(cpuPtr, 0x0200);
Module._cpu_add_watchpoint(cpuPtr, 0x00FF, 3); // 1=read, 2=write, 3=both
Module._cpu_set_cycle_limit(cpuPtr, 1000000);
```

## Integration Plan

### Phase 1: Drop-in Replacement (Current)

Replace `Sfotty` in `BoardController` with the WASM CPU:

```javascript
// Before (Sfotty):
this.sfotty = new Sfotty(this.memory);
this.sfotty.run();
if (this.sfotty.cycleCounter === 0) { /* instruction boundary */ }

// After (WASM CPU):
const Module = await createCPU6502({
    mem_read: (addr) => this.memory.read(addr),
    mem_write: (addr, val) => this.memory.write(addr, val),
});
Module._cpu_wasm_init();
// Wrap in a Sfotty-compatible interface:
this.sfotty = {
    run: () => Module._cpu_wasm_run(),
    get PC() { return Module._cpu_get_pc(); },
    set PC(v) { Module._cpu_set_pc(v); },
    get A() { return Module._cpu_get_a(); },
    set A(v) { Module._cpu_set_a(v); },
    // ... etc
    get cycleCounter() { return Module._cpu_get_cycle_counter(); },
    set cycleCounter(v) { Module._cpu_set_cycle_counter(v); },
    get P() { return Module._cpu_get_p_reg(); },
    set P(v) { Module._cpu_set_p_reg(v); },
    get I() { return !!(Module._cpu_get_p_reg() & 0x04); },
    get crashed() { return Module._cpu_get_crashed(); },
    set crashed(v) { Module._cpu_set_crashed(v); },
    decode: () => { Module._cpu_set_phase(0); Module._cpu_set_cycle_counter(0); },
};
```

Changes needed in `BoardController`:
- Async initialization (WASM module loading)
- Remove the `console.error` suppression hack (`newSfotty`)
- Check return value of `run()` for undocumented opcode detection
  instead of checking `this.isValidOpcode[nextOpcode]`

### Phase 2: Inner Loop in WASM (Future)

Move `runToNextInterrupt()` into C/WASM:
- Memory read/write callbacks stay in JS (address translation is complex)
- But the per-cycle loop, BRK detection, and cycle counting move to WASM
- This eliminates JS<->WASM call overhead per cycle

### Phase 3: Full Memory in WASM (Future)

Move `BoardMemory` storage into WASM linear memory:
- The 64KB address space visible to the CPU becomes a slice of WASM memory
- Address translation logic (neighbor mapping, rotation) moves to C
- Memory read/write become direct array accesses in WASM
- This is where the real performance win would come from

## Performance Expectations

### Phase 1 (CPU only)

Modest improvement. The profiling shows CPU execution at 2-12% of wall
time, so even a 10x CPU speedup yields only 2-11% overall improvement.
The main benefit is code quality: no `console.error` hack, built-in
debug features, and a cleaner interface.

### Phase 2 (Inner loop)

Moderate improvement. Eliminates JS<->WASM call overhead for each cycle
in the inner loop. Could save 20-40% of the CPU execution time.

### Phase 3 (Full memory)

Significant improvement. Direct memory access in WASM eliminates all
address translation overhead. The bulk operations (swapCells, copyCellWithNoise)
that currently dominate wall time (30-68%) would become simple `memcpy`
operations in WASM linear memory.

## Build Instructions

### Prerequisites

- [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
  installed and activated

### Building

```bash
cd cpu
./build.sh
```

This produces:
- `cpu/dist/6502.js` — ES module (Node.js + browser)
- `cpu/dist/6502.wasm` — WebAssembly binary

### Testing

```bash
# Test cycle counts and register behavior against Sfotty
node cpu/test.js

# Test with WASM build (after building)
node cpu/test.js --wasm
```

### Native Testing (Optional)

If a C compiler is available, `build.sh` also builds a native test binary:

```bash
cpu/dist/test_native
```

## File Structure

```
cpu/
  6502.h       — Public API header
  6502.c       — C implementation (~800 lines)
  build.sh     — Emscripten build script
  test.js      — Test suite (compares against Sfotty)
  dist/        — Build output (gitignored)
    6502.js    — Emscripten-generated JS glue
    6502.wasm  — WebAssembly binary
```
