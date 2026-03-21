# Beebjit WASM Investigation

Investigation into whether the beebjit 6502 emulator could be compiled to
WebAssembly and used as a faster CPU backend for 6502life.

Repository: https://github.com/scarybeasts/beebjit

## 1. Beebjit Architecture Overview

### Language and Size
- Written in C (91.5%) with platform-specific assembly (7.4% -- x64 and ARM64).
- Key files: `interp.c` (3071 lines), `inturbo.c` (943), `jit.c` (988),
  `jit_compiler.c` (1978), `bbc.c` (3249), plus ~7700 lines of hand-written
  x64/ARM64 assembly.

### Three CPU Execution Modes
1. **Interpreter** (`interp.c`, mode `k_cpu_mode_interp`): Pure C switch-based
   interpreter. Runs one instruction per iteration of a `while(1)` loop with a
   256-case switch on the opcode byte. Memory access goes through
   `p_mem_read[]`/`p_mem_write[]` flat arrays with callback thresholds for
   I/O-mapped addresses.

2. **Inturbo** (`inturbo.c`, mode `k_cpu_mode_inturbo`): An "interpreted turbo"
   mode that pre-compiles each of the 256 opcodes into a native code snippet.
   Uses `mmap` + `mprotect` to allocate executable memory. Falls back to the
   interpreter for complex opcodes. Requires platform-specific assembly
   (`asm_inturbo_x64.S` or `asm_inturbo_arm64.S`).

3. **JIT** (`jit.c`, `jit_compiler.c`, mode `k_cpu_mode_jit`): Full JIT that
   compiles 6502 basic blocks into native x64 or ARM64 machine code. Uses
   `mmap`/`mprotect` for executable pages, signal handlers (`SIGSEGV`) for
   write-protect traps, and the `os_fault` subsystem. This is what gives
   beebjit its headline "3-10 GHz effective speed."

### CPU State
`state_6502.h` defines the CPU state struct with registers stored as `uint32_t`
(A, X, Y, S, PC, flags) in an ABI-compatible layout shared between C and the
assembly backends. Clean accessor functions: `state_6502_get_registers()`,
`state_6502_set_registers()`, `state_6502_get_cycles()`, etc.

### Memory Access Architecture
`memory_access.h` defines a clean memory interface with:
- `p_mem_read` / `p_mem_write`: flat 64KB byte arrays for direct access
- `memory_read_callback` / `memory_write_callback`: function pointers for I/O
  addresses
- `memory_read_needs_callback_from` / `memory_write_needs_callback_from`:
  threshold addresses above which callbacks are needed (optimization -- below
  the threshold, direct array access is used)

### Dependencies
- **Build**: gcc, standard C library
- **JIT/Inturbo**: `mmap`, `mprotect`, SIGSEGV signal handlers, platform
  assembly (x64 or ARM64)
- **Interpreter**: No OS-specific dependencies beyond standard C
- **Full emulator**: X11, ALSA, PulseAudio, pthreads (but these are
  peripheral/UI -- not CPU core)

### Null Platform Backend
There is an `asm/null/` directory with stub implementations of all assembly
functions. When the null backend is used, `asm_jit_is_enabled()` and
`asm_inturbo_is_enabled()` return 0, effectively disabling JIT and inturbo.
The interpreter still works.

## 2. WASM Compilation Feasibility

### What would work: The Interpreter

The interpreter (`interp.c`) is **pure portable C** with zero OS-specific
calls. Its dependencies are:
- `state_6502.c` (230 lines) -- CPU state management
- `defs_6502.c` (588 lines) -- opcode tables
- `timing.c` (557 lines) -- cycle-counting timer system
- `memory_access.h` -- memory interface (a struct of function pointers)
- `cpu_driver.c` (212 lines) -- driver abstraction
- `util.c` (736 lines) -- malloc wrappers, string utils
- `log.c` (144 lines) -- logging
- `debug.c` (2674 lines) -- debugger (could be stubbed out)

Total: roughly 5000-8000 lines of C to compile, all portable. The `timing`
subsystem is a self-contained callback-based timer that has no OS dependencies.

This could be compiled with **emscripten** using the null assembly backend.

### What would NOT work: JIT and Inturbo

Both require:
- **Executable memory allocation** (`mmap` with `PROT_EXEC`) -- WASM has no
  equivalent. The WASM sandbox does not allow runtime code generation.
- **Signal handlers** (`SIGSEGV` for write-protect faults) -- not available in
  WASM.
- **Platform-specific assembly** (x64/ARM64 `.S` files) -- obviously
  incompatible with WASM's stack machine.

There is no workaround for these. The JIT is fundamentally incompatible with
WASM's security model.

### Compilation Strategy

Using the null backend + emscripten:
1. Compile with `asm/null/` stubs (JIT and inturbo disabled)
2. Replace `os_alloc_posix.c` with simple `malloc`-based implementations
3. Stub out `os_fault`, `os_thread`, `os_sound`, `os_window`, `os_terminal`
4. Strip out all BBC Micro peripherals (`bbc.c`, `via.c`, `video.c`, etc.)
5. Export `interp_enter_with_countdown()` and `state_6502_*` functions to JS
6. Provide custom `memory_access` callbacks that route to 6502life's
   BoardMemory

Estimated feasibility: **Medium**. The interpreter is well-separated from the
BBC peripherals. The main challenge is the `timing` and `memory_access`
integration.

## 3. Integration with 6502life

### Current Interface (Sfotty)

6502life uses Sfotty with this interface:
- `sfotty.run()` -- execute one CPU cycle
- `sfotty.A`, `.X`, `.Y`, `.S`, `.P`, `.PC` -- register properties
- `sfotty.cycleCounter` -- total cycles
- Memory access via BoardMemory object passed to constructor (implements
  `read(addr)` and `write(addr, val)`)
- Cycle-accurate: `run()` advances exactly 1 cycle, multi-cycle instructions
  require multiple `run()` calls

### Beebjit's Interpreter Interface

Beebjit's interpreter operates differently:
- `interp_enter_with_countdown(interp, countdown)` -- runs until countdown
  reaches zero (typically hundreds or thousands of cycles)
- Memory: uses flat 64KB arrays (`p_mem_read[]` / `p_mem_write[]`) with
  callback function pointers for I/O addresses
- Registers: accessed via `state_6502_get_registers()` /
  `state_6502_set_registers()` before/after execution

### Integration Challenges

**Major: Execution granularity mismatch.**
6502life calls `sfotty.run()` once per cycle. Beebjit's interpreter runs in
batches (countdown-based). To replicate 6502life's cycle-by-cycle control, you
would need to set countdown=1 and call `interp_enter_with_countdown` once per
cycle -- but this would negate most of the performance benefit, since the
function entry/exit overhead (register load/save, flag conversion) would
dominate.

However, 6502life's `BoardController.runCycles()` already runs N cycles in a
loop. The integration could be restructured: instead of calling `sfotty.run()`
N times, call beebjit's interpreter with `countdown=N`. This would require
refactoring how write tracking and BRK interception work (currently done via
the memory object's `write()` method on each individual write).

**Medium: Memory model translation.**
Beebjit expects a flat 64KB address space as a byte array. 6502life's
BoardMemory provides a virtual 64KB space that maps through translation tables
(rotation, neighborhood mapping) to a shared grid. Two approaches:
1. **Snapshot**: Before each cell execution burst, copy the cell's visible
   memory into a flat 64KB buffer, run beebjit, then copy writes back. This
   would work but adds copy overhead.
2. **Callback**: Use beebjit's `memory_read_callback` /
   `memory_write_callback` for all accesses. This is slower (every memory
   access goes through a function pointer / WASM-to-JS bridge) and would
   likely be slower than Sfotty.

The best approach would be hybrid: populate `p_mem_read[]` with a snapshot of
the mapped memory before execution, but use `memory_write_callback` (or
post-execution diffing) to track writes. This maps well to beebjit's
threshold-based callback optimization.

**Medium: BRK interception.**
6502life intercepts `BRK` instructions for cell swap/copy operations. Beebjit's
interpreter handles BRK internally (pushes PC and flags to stack, jumps to IRQ
vector). 6502life would need to either:
- Hook BRK via a custom `memory_read_callback` on the IRQ vector, or
- Add a BRK callback to beebjit's interpreter (minor C modification)

**Low: WASM-JS bridge overhead.**
Every memory callback crosses the WASM-JS boundary. If using the callback
approach for all memory access, this would be very expensive (millions of
boundary crossings per second). The snapshot approach avoids this.

### Expected Performance

**Interpreter-only beebjit vs. Sfotty (JavaScript):**
- Beebjit's interpreter is a highly optimized C switch-based interpreter with
  careful memory access patterns (direct array reads below callback threshold).
  Compiled to WASM with -O3, this should be 3-10x faster than a JavaScript
  interpreter for raw instruction throughput.
- However, the WASM-JS bridge cost for memory callbacks would eat into this.
  With the snapshot approach (flat buffer pre-populated), the interpreter inner
  loop stays entirely in WASM, and the speedup should hold.
- The JIT (unavailable in WASM) is what gives beebjit its 100-1000x speedup.
  Without it, we are comparing two interpreters -- the C/WASM one is faster
  but not transformatively so.

**Rough estimate:** 3-5x improvement in CPU instruction throughput with the
snapshot approach. Less if memory callback overhead dominates.

**Context:** Whether this matters depends on where time is actually spent. If
6502life spends most of its time in the scheduler, memory mapping, write
tracking, or visualization rather than raw 6502 execution, a 3-5x CPU speedup
may have little overall impact. Profiling the current bottleneck should come
first.

## 4. Recommendation

### Verdict: Technically feasible, but likely not worth the effort.

**Feasibility: MEDIUM.**
The interpreter can be compiled to WASM. The null backend exists. The C code is
clean and portable. Emscripten compilation would work with moderate stubbing.

**Estimated effort: 2-3 weeks** for a working prototype:
- Week 1: Strip beebjit to interpreter core, emscripten build, basic WASM
  module
- Week 2: Integration layer (memory snapshot, register bridge, BRK
  interception)
- Week 3: Testing, debugging edge cases (undocumented opcodes, BCD mode,
  interrupt timing)

**Key blockers:**
1. **No JIT in WASM.** The killer feature of beebjit (native JIT compilation)
   is fundamentally incompatible with WebAssembly's security model. We would
   only get the interpreter, which is the slowest of beebjit's three modes.
2. **Execution granularity.** 6502life's cycle-by-cycle execution model with
   per-write tracking requires either restructuring the controller or accepting
   snapshot-based execution with post-diffing.
3. **Memory model mismatch.** The snapshot-copy-diff approach adds overhead
   that may partially offset the WASM speedup.

**Better alternatives to consider:**
- **Profile first.** Determine whether 6502 execution is actually the
  bottleneck before optimizing it.
- **Write a custom C/WASM interpreter.** A minimal 6502 interpreter designed
  specifically for 6502life's memory model (no BBC Micro baggage, no timing
  system, direct integration with BoardMemory) would be simpler, faster to
  build, and likely perform equally well. A minimal 6502 interpreter is
  ~500-1000 lines of C.
- **Batch execution in Sfotty.** If Sfotty's per-cycle overhead is the
  bottleneck, modifying it to execute N instructions per call (rather than 1
  cycle) could provide a significant speedup without any WASM complexity.
- **Consider other WASM 6502 cores.** Projects like `v6502` or `fake6502` are
  simple, self-contained C 6502 interpreters (~500 lines) that would be far
  easier to compile to WASM and integrate.
