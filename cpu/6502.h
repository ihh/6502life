/*
 * 6502.h — Cycle-accurate NMOS 6502 CPU emulator for 6502life
 *
 * Public API designed for drop-in replacement of Sfotty in controller.js.
 * Memory access is performed via imported JS functions (when compiled to WASM)
 * or via function pointers (when used as a native C library).
 *
 * Cycle model: run() advances the CPU by exactly one clock cycle, matching
 * Sfotty's per-cycle execution model. cycleCounter tracks position within
 * the current instruction (0 = instruction boundary, ready for next decode).
 */

#ifndef CPU_6502_H
#define CPU_6502_H

#include <stdint.h>

/* Status flags — bit positions in the P register */
#define FLAG_C  0x01  /* Carry */
#define FLAG_Z  0x02  /* Zero */
#define FLAG_I  0x04  /* Interrupt disable */
#define FLAG_D  0x08  /* Decimal mode */
#define FLAG_B  0x10  /* Break (not a real flag; only appears on stack) */
#define FLAG_U  0x20  /* Unused (always 1) */
#define FLAG_V  0x40  /* Overflow */
#define FLAG_N  0x80  /* Negative */

/* CPU status codes returned by cpu_run() */
typedef enum {
    CPU_OK              = 0,  /* Normal cycle executed */
    CPU_UNDOCUMENTED    = 1,  /* Undocumented opcode encountered */
    CPU_BREAKPOINT      = 2,  /* PC breakpoint hit */
    CPU_WATCHPOINT_READ = 3,  /* Read watchpoint triggered */
    CPU_WATCHPOINT_WRITE= 4,  /* Write watchpoint triggered */
    CPU_CYCLE_LIMIT     = 5,  /* Cycle limit reached */
} cpu_status_t;

/* Internal state machine phases.
 * The CPU progresses through phases within each instruction.
 * Phase 0 always means "ready to decode next instruction". */
typedef enum {
    PHASE_DECODE = 0,         /* Fetch opcode and set up instruction */
    /* Phases 1..N are instruction-specific sub-cycles */
} cpu_phase_t;

/* Maximum number of watchpoints/breakpoints */
#define MAX_WATCHPOINTS 16
#define MAX_BREAKPOINTS 16

/* Watchpoint type */
typedef struct {
    uint16_t addr;
    uint8_t  active;  /* 0 = inactive, 1 = read, 2 = write, 3 = both */
} watchpoint_t;

/*
 * CPU state structure — contains all registers and internal state.
 *
 * This struct is allocated in WASM linear memory so JS can read/write
 * registers directly via DataView without function call overhead.
 */
typedef struct {
    /* Programmer-visible registers */
    uint16_t PC;              /* Program counter */
    uint8_t  A;               /* Accumulator */
    uint8_t  X;               /* X index register */
    uint8_t  Y;               /* Y index register */
    uint8_t  S;               /* Stack pointer */
    uint8_t  P;               /* Processor status (NV-BDIZC) */

    /* Internal state (not directly visible to 6502 programs) */
    uint8_t  cycleCounter;    /* Cycle within current instruction (0 = boundary) */
    uint8_t  opcode;          /* Current opcode being executed */
    uint8_t  phase;           /* Sub-cycle phase within instruction */
    uint8_t  undocumented;    /* Set to 1 if last decoded opcode was undocumented */

    /* Temporaries used across cycles of a single instruction */
    uint16_t addr;            /* Effective address being computed */
    uint8_t  data;            /* Data byte read/to write */
    uint8_t  data2;           /* Second temporary (for RMW instructions) */
    uint8_t  pageCrossed;     /* 1 if page boundary crossed (extra cycle) */

    /* Optional debug features */
    uint16_t breakpoints[MAX_BREAKPOINTS];
    uint8_t  numBreakpoints;
    watchpoint_t watchpoints[MAX_WATCHPOINTS];
    uint8_t  numWatchpoints;
    uint32_t cycleLimit;      /* 0 = no limit */
    uint32_t totalCycles;     /* Total cycles executed since reset */

    /* Status from last run() call */
    cpu_status_t status;

    /* Last triggered watchpoint address (for debug inspection) */
    uint16_t lastWatchAddr;
} cpu_state_t;

/*
 * Memory interface — these functions must be provided by the host.
 * In WASM builds, they are imported from JavaScript.
 * In native builds, they are set via cpu_set_memory_callbacks().
 */
typedef uint8_t (*mem_read_fn)(uint16_t addr);
typedef void    (*mem_write_fn)(uint16_t addr, uint8_t val);

/* ---- Public API ---- */

/* Initialize CPU state. All registers zeroed, cycleCounter = 0. */
void cpu_init(cpu_state_t *cpu);

/* Execute one CPU cycle. Returns status code. */
cpu_status_t cpu_run(cpu_state_t *cpu);

/* Set P register, expanding into internal flag representation */
void cpu_set_p(cpu_state_t *cpu, uint8_t p);

/* Get P register byte (with B and U bits as specified) */
uint8_t cpu_get_p(cpu_state_t *cpu);

/* Add/remove breakpoints */
int cpu_add_breakpoint(cpu_state_t *cpu, uint16_t addr);
int cpu_remove_breakpoint(cpu_state_t *cpu, uint16_t addr);
void cpu_clear_breakpoints(cpu_state_t *cpu);

/* Add/remove watchpoints */
int cpu_add_watchpoint(cpu_state_t *cpu, uint16_t addr, uint8_t type);
int cpu_remove_watchpoint(cpu_state_t *cpu, uint16_t addr);
void cpu_clear_watchpoints(cpu_state_t *cpu);

/* Set cycle limit (0 = no limit) */
void cpu_set_cycle_limit(cpu_state_t *cpu, uint32_t limit);

/* Set memory callbacks (native builds only; WASM uses imports) */
#ifndef __EMSCRIPTEN__
void cpu_set_memory_callbacks(mem_read_fn read_fn, mem_write_fn write_fn);
#endif

/* ---- WASM exports (when compiled with emscripten) ---- */
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

#endif /* CPU_6502_H */
