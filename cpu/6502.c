/*
 * 6502.c — Cycle-accurate NMOS 6502 CPU emulator for 6502life
 *
 * Architecture:
 *   Each call to cpu_run() advances the CPU by exactly one clock cycle.
 *   Instructions are decomposed into micro-operations (one per cycle),
 *   tracked by the `phase` field in cpu_state_t.
 *
 *   The opcode decode table maps each opcode to an addressing mode and
 *   an operation. The phase state machine handles the addressing mode's
 *   multi-cycle memory accesses, then performs the operation on the last
 *   cycle (which also resets cycleCounter to 0 for the next instruction).
 *
 * Cycle counts match the NMOS 6502 exactly:
 *   - Implied/Accumulator: 2 cycles
 *   - Immediate: 2 cycles
 *   - Zero page: 3 cycles (load/store), 5 cycles (RMW)
 *   - Zero page,X/Y: 4 cycles (load/store), 6 cycles (RMW)
 *   - Absolute: 4 cycles (load/store), 6 cycles (RMW)
 *   - Absolute,X/Y: 4 cycles (load, no page cross), 5 cycles (load, page cross
 *                    or store), 7 cycles (RMW)
 *   - (Indirect,X): 6 cycles (load/store)
 *   - (Indirect),Y: 5 cycles (load, no page cross), 6 cycles (load, page cross
 *                    or store)
 *   - Relative (branch): 2 (not taken), 3 (taken, same page), 4 (taken, page cross)
 *   - BRK: 7 cycles
 *   - JSR: 6 cycles
 *   - RTS: 6 cycles
 *   - RTI: 6 cycles
 *   - PHA/PHP: 3 cycles
 *   - PLA/PLP: 4 cycles
 *   - JMP abs: 3 cycles
 *   - JMP (ind): 5 cycles
 *
 * Undocumented opcodes: detected and flagged via cpu->undocumented = 1,
 * without crashing. The CPU treats them as a 1-byte NOP (2 cycles) that
 * sets the undocumented flag. The host (controller.js) can then handle
 * them as BRK 0.
 */

#include "6502.h"
#include <string.h>

/* ---- Memory interface ---- */

#ifdef __EMSCRIPTEN__
/* In WASM builds, memory functions are imported from JavaScript */
extern uint8_t mem_read(uint16_t addr);
extern void    mem_write(uint16_t addr, uint8_t val);
#else
/* In native builds, use function pointers */
static mem_read_fn  g_mem_read  = NULL;
static mem_write_fn g_mem_write = NULL;

void cpu_set_memory_callbacks(mem_read_fn read_fn, mem_write_fn write_fn) {
    g_mem_read  = read_fn;
    g_mem_write = write_fn;
}

static inline uint8_t mem_read(uint16_t addr) {
    return g_mem_read ? g_mem_read(addr) : 0;
}

static inline void mem_write(uint16_t addr, uint8_t val) {
    if (g_mem_write) g_mem_write(addr, val);
}
#endif

/* ---- Watchpoint checking ---- */

/* Check read watchpoints. Returns 1 if triggered. */
static inline int check_read_watch(cpu_state_t *cpu, uint16_t addr) {
    for (int i = 0; i < cpu->numWatchpoints; i++) {
        if (cpu->watchpoints[i].addr == addr &&
            (cpu->watchpoints[i].active & 1)) {
            cpu->lastWatchAddr = addr;
            return 1;
        }
    }
    return 0;
}

/* Check write watchpoints. Returns 1 if triggered. */
static inline int check_write_watch(cpu_state_t *cpu, uint16_t addr) {
    for (int i = 0; i < cpu->numWatchpoints; i++) {
        if (cpu->watchpoints[i].addr == addr &&
            (cpu->watchpoints[i].active & 2)) {
            cpu->lastWatchAddr = addr;
            return 1;
        }
    }
    return 0;
}

/* Memory read with optional watchpoint check */
static inline uint8_t cpu_read(cpu_state_t *cpu, uint16_t addr) {
    if (cpu->numWatchpoints && check_read_watch(cpu, addr)) {
        cpu->status = CPU_WATCHPOINT_READ;
    }
    return mem_read(addr);
}

/* Memory write with optional watchpoint check */
static inline void cpu_write(cpu_state_t *cpu, uint16_t addr, uint8_t val) {
    if (cpu->numWatchpoints && check_write_watch(cpu, addr)) {
        cpu->status = CPU_WATCHPOINT_WRITE;
    }
    mem_write(addr, val);
}

/* ---- Flag helpers ---- */

static inline void set_nz(cpu_state_t *cpu, uint8_t val) {
    cpu->P = (cpu->P & ~(FLAG_N | FLAG_Z))
           | (val & FLAG_N)
           | (val ? 0 : FLAG_Z);
}

static inline void push(cpu_state_t *cpu, uint8_t val) {
    cpu_write(cpu, 0x100 + cpu->S, val);
    cpu->S = (cpu->S - 1) & 0xFF;
}

/* ---- Opcode decode table ---- */

/*
 * Addressing modes.
 * Each mode determines how many cycles the instruction takes and
 * what memory accesses happen on each cycle.
 */
typedef enum {
    AM_IMP,   /* Implied / Accumulator */
    AM_IMM,   /* Immediate */
    AM_ZPG,   /* Zero page */
    AM_ZPX,   /* Zero page, X */
    AM_ZPY,   /* Zero page, Y */
    AM_ABS,   /* Absolute */
    AM_ABX,   /* Absolute, X */
    AM_ABY,   /* Absolute, Y */
    AM_INX,   /* (Indirect, X) */
    AM_INY,   /* (Indirect), Y */
    AM_REL,   /* Relative (branches) */
    AM_IND,   /* Indirect (JMP only) */
    AM_ACC,   /* Accumulator (shift/rotate) */
    AM_NON,   /* Not a valid opcode */
} addr_mode_t;

/*
 * Operations. Each opcode maps to one of these operations plus
 * an addressing mode. The operation is performed after the
 * effective address / data has been resolved.
 */
typedef enum {
    /* Load/Store */
    OP_LDA, OP_LDX, OP_LDY,
    OP_STA, OP_STX, OP_STY,
    /* Arithmetic */
    OP_ADC, OP_SBC,
    /* Logic */
    OP_AND, OP_ORA, OP_EOR,
    /* Compare */
    OP_CMP, OP_CPX, OP_CPY,
    /* Shift/Rotate */
    OP_ASL, OP_LSR, OP_ROL, OP_ROR,
    /* Inc/Dec */
    OP_INC, OP_DEC, OP_INX, OP_INY, OP_DEX, OP_DEY,
    /* Branch */
    OP_BPL, OP_BMI, OP_BVC, OP_BVS, OP_BCC, OP_BCS, OP_BNE, OP_BEQ,
    /* Jump */
    OP_JMP, OP_JSR, OP_RTS, OP_RTI,
    /* Stack */
    OP_PHA, OP_PLA, OP_PHP, OP_PLP,
    /* Flags */
    OP_CLC, OP_SEC, OP_CLI, OP_SEI, OP_CLV, OP_CLD, OP_SED,
    /* Transfer */
    OP_TAX, OP_TXA, OP_TAY, OP_TYA, OP_TXS, OP_TSX,
    /* Misc */
    OP_BRK, OP_NOP, OP_BIT,
    /* Undocumented */
    OP_UND,
} operation_t;

/*
 * Instruction type: read, store, or read-modify-write.
 * Determines the cycle pattern for each addressing mode.
 */
typedef enum {
    IT_READ,    /* Read from effective address (LDA, CMP, ADC, etc.) */
    IT_STORE,   /* Write to effective address (STA, STX, STY) */
    IT_RMW,     /* Read-modify-write (INC, DEC, ASL, LSR, ROL, ROR) */
    IT_SPECIAL, /* BRK, JSR, RTS, RTI, PHA/PHP, PLA/PLP, JMP, branch */
    IT_IMP,     /* Implied (flag set/clear, transfers, NOP) */
} instr_type_t;

typedef struct {
    uint8_t     mode;   /* addr_mode_t */
    uint8_t     op;     /* operation_t */
    uint8_t     type;   /* instr_type_t */
} opcode_entry_t;

/* Macro helpers for the decode table */
#define R(m, o) { m, o, IT_READ }
#define S(m, o) { m, o, IT_STORE }
#define W(m, o) { m, o, IT_RMW }
#define P(m, o) { m, o, IT_SPECIAL }
#define I(m, o) { m, o, IT_IMP }
#define U       { AM_NON, OP_UND, IT_IMP }

/*
 * Full 256-entry decode table.
 * Undocumented opcodes map to U (AM_NON / OP_UND).
 */
static const opcode_entry_t decode_table[256] = {
    /* 0x00 */ P(AM_IMP, OP_BRK), R(AM_INX, OP_ORA), U,                U,
    /* 0x04 */ U,                  R(AM_ZPG, OP_ORA), W(AM_ZPG, OP_ASL), U,
    /* 0x08 */ P(AM_IMP, OP_PHP), R(AM_IMM, OP_ORA), W(AM_ACC, OP_ASL), U,
    /* 0x0C */ U,                  R(AM_ABS, OP_ORA), W(AM_ABS, OP_ASL), U,

    /* 0x10 */ P(AM_REL, OP_BPL), R(AM_INY, OP_ORA), U,                U,
    /* 0x14 */ U,                  R(AM_ZPX, OP_ORA), W(AM_ZPX, OP_ASL), U,
    /* 0x18 */ I(AM_IMP, OP_CLC), R(AM_ABY, OP_ORA), U,                U,
    /* 0x1C */ U,                  R(AM_ABX, OP_ORA), W(AM_ABX, OP_ASL), U,

    /* 0x20 */ P(AM_ABS, OP_JSR), R(AM_INX, OP_AND), U,                U,
    /* 0x24 */ R(AM_ZPG, OP_BIT), R(AM_ZPG, OP_AND), W(AM_ZPG, OP_ROL), U,
    /* 0x28 */ P(AM_IMP, OP_PLP), R(AM_IMM, OP_AND), W(AM_ACC, OP_ROL), U,
    /* 0x2C */ R(AM_ABS, OP_BIT), R(AM_ABS, OP_AND), W(AM_ABS, OP_ROL), U,

    /* 0x30 */ P(AM_REL, OP_BMI), R(AM_INY, OP_AND), U,                U,
    /* 0x34 */ U,                  R(AM_ZPX, OP_AND), W(AM_ZPX, OP_ROL), U,
    /* 0x38 */ I(AM_IMP, OP_SEC), R(AM_ABY, OP_AND), U,                U,
    /* 0x3C */ U,                  R(AM_ABX, OP_AND), W(AM_ABX, OP_ROL), U,

    /* 0x40 */ P(AM_IMP, OP_RTI), R(AM_INX, OP_EOR), U,                U,
    /* 0x44 */ U,                  R(AM_ZPG, OP_EOR), W(AM_ZPG, OP_LSR), U,
    /* 0x48 */ P(AM_IMP, OP_PHA), R(AM_IMM, OP_EOR), W(AM_ACC, OP_LSR), U,
    /* 0x4C */ P(AM_ABS, OP_JMP), R(AM_ABS, OP_EOR), W(AM_ABS, OP_LSR), U,

    /* 0x50 */ P(AM_REL, OP_BVC), R(AM_INY, OP_EOR), U,                U,
    /* 0x54 */ U,                  R(AM_ZPX, OP_EOR), W(AM_ZPX, OP_LSR), U,
    /* 0x58 */ I(AM_IMP, OP_CLI), R(AM_ABY, OP_EOR), U,                U,
    /* 0x5C */ U,                  R(AM_ABX, OP_EOR), W(AM_ABX, OP_LSR), U,

    /* 0x60 */ P(AM_IMP, OP_RTS), R(AM_INX, OP_ADC), U,                U,
    /* 0x64 */ U,                  R(AM_ZPG, OP_ADC), W(AM_ZPG, OP_ROR), U,
    /* 0x68 */ P(AM_IMP, OP_PLA), R(AM_IMM, OP_ADC), W(AM_ACC, OP_ROR), U,
    /* 0x6C */ P(AM_IND, OP_JMP), R(AM_ABS, OP_ADC), W(AM_ABS, OP_ROR), U,

    /* 0x70 */ P(AM_REL, OP_BVS), R(AM_INY, OP_ADC), U,                U,
    /* 0x74 */ U,                  R(AM_ZPX, OP_ADC), W(AM_ZPX, OP_ROR), U,
    /* 0x78 */ I(AM_IMP, OP_SEI), R(AM_ABY, OP_ADC), U,                U,
    /* 0x7C */ U,                  R(AM_ABX, OP_ADC), W(AM_ABX, OP_ROR), U,

    /* 0x80 */ U,                  S(AM_INX, OP_STA), U,                U,
    /* 0x84 */ S(AM_ZPG, OP_STY), S(AM_ZPG, OP_STA), S(AM_ZPG, OP_STX), U,
    /* 0x88 */ I(AM_IMP, OP_DEY), U,                  I(AM_IMP, OP_TXA), U,
    /* 0x8C */ S(AM_ABS, OP_STY), S(AM_ABS, OP_STA), S(AM_ABS, OP_STX), U,

    /* 0x90 */ P(AM_REL, OP_BCC), S(AM_INY, OP_STA), U,                U,
    /* 0x94 */ S(AM_ZPX, OP_STY), S(AM_ZPX, OP_STA), S(AM_ZPY, OP_STX), U,
    /* 0x98 */ I(AM_IMP, OP_TYA), S(AM_ABY, OP_STA), I(AM_IMP, OP_TXS), U,
    /* 0x9C */ U,                  S(AM_ABX, OP_STA), U,                U,

    /* 0xA0 */ R(AM_IMM, OP_LDY), R(AM_INX, OP_LDA), R(AM_IMM, OP_LDX), U,
    /* 0xA4 */ R(AM_ZPG, OP_LDY), R(AM_ZPG, OP_LDA), R(AM_ZPG, OP_LDX), U,
    /* 0xA8 */ I(AM_IMP, OP_TAY), R(AM_IMM, OP_LDA), I(AM_IMP, OP_TAX), U,
    /* 0xAC */ R(AM_ABS, OP_LDY), R(AM_ABS, OP_LDA), R(AM_ABS, OP_LDX), U,

    /* 0xB0 */ P(AM_REL, OP_BCS), R(AM_INY, OP_LDA), U,                U,
    /* 0xB4 */ R(AM_ZPX, OP_LDY), R(AM_ZPX, OP_LDA), R(AM_ZPY, OP_LDX), U,
    /* 0xB8 */ I(AM_IMP, OP_CLV), R(AM_ABY, OP_LDA), I(AM_IMP, OP_TSX), U,
    /* 0xBC */ R(AM_ABX, OP_LDY), R(AM_ABX, OP_LDA), R(AM_ABY, OP_LDX), U,

    /* 0xC0 */ R(AM_IMM, OP_CPY), R(AM_INX, OP_CMP), U,                U,
    /* 0xC4 */ R(AM_ZPG, OP_CPY), R(AM_ZPG, OP_CMP), W(AM_ZPG, OP_DEC), U,
    /* 0xC8 */ I(AM_IMP, OP_INY), R(AM_IMM, OP_CMP), I(AM_IMP, OP_DEX), U,
    /* 0xCC */ R(AM_ABS, OP_CPY), R(AM_ABS, OP_CMP), W(AM_ABS, OP_DEC), U,

    /* 0xD0 */ P(AM_REL, OP_BNE), R(AM_INY, OP_CMP), U,                U,
    /* 0xD4 */ U,                  R(AM_ZPX, OP_CMP), W(AM_ZPX, OP_DEC), U,
    /* 0xD8 */ I(AM_IMP, OP_CLD), R(AM_ABY, OP_CMP), U,                U,
    /* 0xDC */ U,                  R(AM_ABX, OP_CMP), W(AM_ABX, OP_DEC), U,

    /* 0xE0 */ R(AM_IMM, OP_CPX), R(AM_INX, OP_SBC), U,                U,
    /* 0xE4 */ R(AM_ZPG, OP_CPX), R(AM_ZPG, OP_SBC), W(AM_ZPG, OP_INC), U,
    /* 0xE8 */ I(AM_IMP, OP_INX), R(AM_IMM, OP_SBC), I(AM_IMP, OP_NOP), U,
    /* 0xEC */ R(AM_ABS, OP_CPX), R(AM_ABS, OP_SBC), W(AM_ABS, OP_INC), U,

    /* 0xF0 */ P(AM_REL, OP_BEQ), R(AM_INY, OP_SBC), U,                U,
    /* 0xF4 */ U,                  R(AM_ZPX, OP_SBC), W(AM_ZPX, OP_INC), U,
    /* 0xF8 */ I(AM_IMP, OP_SED), R(AM_ABY, OP_SBC), U,                U,
    /* 0xFC */ U,                  R(AM_ABX, OP_SBC), W(AM_ABX, OP_INC), U,
};

/* ---- ALU operations ---- */

/*
 * Perform the ALU operation. Called after the effective data has been
 * loaded into cpu->data. For RMW instructions, the result is placed
 * back in cpu->data for the writeback cycle.
 */
static void do_operation(cpu_state_t *cpu, operation_t op) {
    uint8_t val = cpu->data;
    uint16_t tmp;

    switch (op) {
    /* ---- Load ---- */
    case OP_LDA: cpu->A = val; set_nz(cpu, val); break;
    case OP_LDX: cpu->X = val; set_nz(cpu, val); break;
    case OP_LDY: cpu->Y = val; set_nz(cpu, val); break;

    /* ---- Logic ---- */
    case OP_AND: cpu->A &= val; set_nz(cpu, cpu->A); break;
    case OP_ORA: cpu->A |= val; set_nz(cpu, cpu->A); break;
    case OP_EOR: cpu->A ^= val; set_nz(cpu, cpu->A); break;

    /* ---- Arithmetic ---- */
    case OP_ADC:
        if (cpu->P & FLAG_D) {
            /* BCD mode (NMOS behavior) */
            int al = (cpu->A & 0x0F) + (val & 0x0F) + ((cpu->P & FLAG_C) ? 1 : 0);
            if (al > 9) al += 6;
            int ah = (cpu->A >> 4) + (val >> 4) + (al > 15 ? 1 : 0);
            /* V flag is set based on binary result, per NMOS */
            cpu->P = (cpu->P & ~FLAG_V)
                   | ((~(cpu->A ^ val) & (cpu->A ^ (ah << 4)) & 0x80) ? FLAG_V : 0);
            if (ah > 9) ah += 6;
            cpu->P = (cpu->P & ~FLAG_C) | ((ah > 15) ? FLAG_C : 0);
            cpu->A = ((ah << 4) | (al & 0x0F)) & 0xFF;
            set_nz(cpu, cpu->A);
        } else {
            tmp = (uint16_t)cpu->A + (uint16_t)val + ((cpu->P & FLAG_C) ? 1 : 0);
            cpu->P = (cpu->P & ~(FLAG_C | FLAG_V))
                   | ((tmp > 255) ? FLAG_C : 0)
                   | (((~(cpu->A ^ val) & (cpu->A ^ tmp)) & 0x80) ? FLAG_V : 0);
            cpu->A = tmp & 0xFF;
            set_nz(cpu, cpu->A);
        }
        break;

    case OP_SBC:
        if (cpu->P & FLAG_D) {
            /* BCD mode (NMOS behavior) */
            int c = (cpu->P & FLAG_C) ? 1 : 0;
            int diff = (int)cpu->A + (int)(val ^ 0xFF) + c;
            int al = (cpu->A & 0x0F) - (val & 0x0F) - (c ? 0 : 1);
            if ((al & 0xFF) > 127) al -= 6;
            int ah = (cpu->A >> 4) - (val >> 4) - (((al & 0xFF) > 127) ? 1 : 0);
            cpu->P = (cpu->P & ~(FLAG_C | FLAG_V))
                   | ((diff > 255) ? FLAG_C : 0)
                   | ((((cpu->A ^ val) & (cpu->A ^ diff)) & 0x80) ? FLAG_V : 0);
            if (ah & 0x80) ah -= 6;
            cpu->A = ((ah << 4) | (al & 0x0F)) & 0xFF;
            set_nz(cpu, cpu->A);
        } else {
            val ^= 0xFF;
            int carry7 = (cpu->A & 0x7F) + (val & 0x7F) + ((cpu->P & FLAG_C) ? 1 : 0);
            int result = carry7 + (cpu->A & 0x80) + (val & 0x80);
            cpu->P = (cpu->P & ~(FLAG_N | FLAG_C | FLAG_Z | FLAG_V))
                   | ((result & 0x80) ? FLAG_N : 0)
                   | ((result >= 256) ? FLAG_C : 0)
                   | (((result & 0xFF) == 0) ? FLAG_Z : 0)
                   | ((((result >> 2) ^ (carry7 >> 1)) & 0x40) ? FLAG_V : 0);
            cpu->A = result & 0xFF;
        }
        break;

    /* ---- Compare ---- */
    case OP_CMP: tmp = (uint16_t)cpu->A + (uint16_t)(val ^ 0xFF) + 1;
                 cpu->P = (cpu->P & ~FLAG_C) | ((tmp > 255) ? FLAG_C : 0);
                 set_nz(cpu, tmp & 0xFF); break;
    case OP_CPX: tmp = (uint16_t)cpu->X + (uint16_t)(val ^ 0xFF) + 1;
                 cpu->P = (cpu->P & ~FLAG_C) | ((tmp > 255) ? FLAG_C : 0);
                 set_nz(cpu, tmp & 0xFF); break;
    case OP_CPY: tmp = (uint16_t)cpu->Y + (uint16_t)(val ^ 0xFF) + 1;
                 cpu->P = (cpu->P & ~FLAG_C) | ((tmp > 255) ? FLAG_C : 0);
                 set_nz(cpu, tmp & 0xFF); break;

    /* ---- BIT ---- */
    case OP_BIT:
        cpu->P = (cpu->P & ~(FLAG_N | FLAG_V | FLAG_Z))
               | (val & (FLAG_N | FLAG_V))
               | ((cpu->A & val) ? 0 : FLAG_Z);
        break;

    /* ---- Shift/Rotate (RMW — result goes back to cpu->data for writeback) ---- */
    case OP_ASL:
        cpu->P = (cpu->P & ~FLAG_C) | ((val & 0x80) ? FLAG_C : 0);
        cpu->data = (val << 1) & 0xFF;
        set_nz(cpu, cpu->data);
        break;
    case OP_LSR:
        cpu->P = (cpu->P & ~FLAG_C) | ((val & 0x01) ? FLAG_C : 0);
        cpu->data = val >> 1;
        set_nz(cpu, cpu->data);
        break;
    case OP_ROL: {
        uint8_t old_c = (cpu->P & FLAG_C) ? 1 : 0;
        cpu->P = (cpu->P & ~FLAG_C) | ((val & 0x80) ? FLAG_C : 0);
        cpu->data = ((val << 1) | old_c) & 0xFF;
        set_nz(cpu, cpu->data);
        break;
    }
    case OP_ROR: {
        uint8_t old_c = (cpu->P & FLAG_C) ? 0x80 : 0;
        cpu->P = (cpu->P & ~FLAG_C) | ((val & 0x01) ? FLAG_C : 0);
        cpu->data = (val >> 1) | old_c;
        set_nz(cpu, cpu->data);
        break;
    }

    /* ---- Inc/Dec ---- */
    case OP_INC: cpu->data = (val + 1) & 0xFF; set_nz(cpu, cpu->data); break;
    case OP_DEC: cpu->data = (val - 1) & 0xFF; set_nz(cpu, cpu->data); break;

    /* These should never be called via do_operation (handled as implied) */
    default: break;
    }
}

/* ---- Public API ---- */

EXPORT void cpu_init(cpu_state_t *cpu) {
    memset(cpu, 0, sizeof(*cpu));
    cpu->P = FLAG_U | FLAG_I;  /* Unused always set, I set on reset */
    cpu->S = 0xFD;             /* Standard post-reset stack pointer */
    cpu->cycleCounter = 0;
    cpu->phase = PHASE_DECODE;
    cpu->status = CPU_OK;
}

EXPORT void cpu_set_p(cpu_state_t *cpu, uint8_t p) {
    cpu->P = (p | FLAG_U) & ~FLAG_B;  /* U always set, B not stored */
}

EXPORT uint8_t cpu_get_p(cpu_state_t *cpu) {
    return cpu->P | FLAG_U;
}

EXPORT int cpu_add_breakpoint(cpu_state_t *cpu, uint16_t addr) {
    if (cpu->numBreakpoints >= MAX_BREAKPOINTS) return -1;
    cpu->breakpoints[cpu->numBreakpoints++] = addr;
    return 0;
}

EXPORT int cpu_remove_breakpoint(cpu_state_t *cpu, uint16_t addr) {
    for (int i = 0; i < cpu->numBreakpoints; i++) {
        if (cpu->breakpoints[i] == addr) {
            cpu->breakpoints[i] = cpu->breakpoints[--cpu->numBreakpoints];
            return 0;
        }
    }
    return -1;
}

EXPORT void cpu_clear_breakpoints(cpu_state_t *cpu) {
    cpu->numBreakpoints = 0;
}

EXPORT int cpu_add_watchpoint(cpu_state_t *cpu, uint16_t addr, uint8_t type) {
    if (cpu->numWatchpoints >= MAX_WATCHPOINTS) return -1;
    cpu->watchpoints[cpu->numWatchpoints].addr = addr;
    cpu->watchpoints[cpu->numWatchpoints].active = type;
    cpu->numWatchpoints++;
    return 0;
}

EXPORT int cpu_remove_watchpoint(cpu_state_t *cpu, uint16_t addr) {
    for (int i = 0; i < cpu->numWatchpoints; i++) {
        if (cpu->watchpoints[i].addr == addr) {
            cpu->watchpoints[i] = cpu->watchpoints[--cpu->numWatchpoints];
            return 0;
        }
    }
    return -1;
}

EXPORT void cpu_clear_watchpoints(cpu_state_t *cpu) {
    cpu->numWatchpoints = 0;
}

EXPORT void cpu_set_cycle_limit(cpu_state_t *cpu, uint32_t limit) {
    cpu->cycleLimit = limit;
    cpu->totalCycles = 0;
}

/*
 * cpu_run — Execute one CPU cycle.
 *
 * This is the heart of the emulator. It uses a two-level state machine:
 *
 *   Level 1: phase (cycle within instruction)
 *     - Phase 0 = decode: fetch opcode, look up in decode table, set up
 *       the addressing mode state machine
 *     - Phases 1..N: addressing mode cycles (fetch operands, compute
 *       effective address, read/write data)
 *
 *   Level 2: The addressing mode + instruction type determines what
 *     happens on each phase. Rather than having a separate operations
 *     array (like Sfotty), we use a switch on (mode, phase) pairs.
 *
 * The key insight: phase 0 is always "instruction boundary". When the
 * last cycle of an instruction completes, it sets phase = 0 and
 * cycleCounter = 0, signaling readiness for the next decode.
 */
EXPORT cpu_status_t cpu_run(cpu_state_t *cpu) {
    /* Check cycle limit */
    if (cpu->cycleLimit && cpu->totalCycles >= cpu->cycleLimit) {
        cpu->status = CPU_CYCLE_LIMIT;
        return CPU_CYCLE_LIMIT;
    }

    cpu->status = CPU_OK;
    cpu->totalCycles++;

    /* ======== PHASE 0: DECODE ======== */
    if (cpu->phase == 0) {
        /* Check breakpoints */
        for (int i = 0; i < cpu->numBreakpoints; i++) {
            if (cpu->breakpoints[i] == cpu->PC) {
                cpu->status = CPU_BREAKPOINT;
                return CPU_BREAKPOINT;
            }
        }

        /* Fetch opcode */
        cpu->opcode = cpu_read(cpu, cpu->PC);
        const opcode_entry_t *entry = &decode_table[cpu->opcode];

        /* Undocumented opcode? */
        if (entry->op == OP_UND) {
            cpu->undocumented = 1;
            cpu->status = CPU_UNDOCUMENTED;
            /* Don't advance PC — let the host handle it (like Sfotty's crashed behavior).
             * The controller will read the opcode, treat it as BRK 0, and set PC. */
            return CPU_UNDOCUMENTED;
        }

        cpu->undocumented = 0;
        cpu->PC = (cpu->PC + 1) & 0xFFFF;
        cpu->phase = 1;
        cpu->cycleCounter = 1;
        cpu->pageCrossed = 0;

        /* For implied instructions, the opcode fetch IS the first cycle.
         * We still need a second cycle (the "throw away" read of the next byte).
         * That happens in phase 1. */
        return cpu->status;
    }

    /* ======== PHASES 1..N: Instruction execution ======== */

    cpu->cycleCounter++;

    const opcode_entry_t *entry = &decode_table[cpu->opcode];
    addr_mode_t mode = (addr_mode_t)entry->mode;
    operation_t op   = (operation_t)entry->op;
    instr_type_t type = (instr_type_t)entry->type;

    /* ---- Special instructions (unique cycle patterns) ---- */
    if (type == IT_SPECIAL) {
        switch (op) {

        /* ==== BRK (7 cycles) ==== */
        case OP_BRK:
            switch (cpu->phase) {
            case 1: /* Read and discard next byte (BRK signature byte) */
                cpu_read(cpu, cpu->PC);
                cpu->PC = (cpu->PC + 1) & 0xFFFF;
                break;
            case 2: /* Push PCH */
                push(cpu, (cpu->PC >> 8) & 0xFF);
                break;
            case 3: /* Push PCL */
                push(cpu, cpu->PC & 0xFF);
                break;
            case 4: /* Push P with B set */
                push(cpu, cpu->P | FLAG_B | FLAG_U);
                break;
            case 5: /* Fetch IRQ vector low */
                cpu->addr = cpu_read(cpu, 0xFFFE);
                cpu->P |= FLAG_I;
                break;
            case 6: /* Fetch IRQ vector high, jump */
                cpu->PC = ((uint16_t)cpu_read(cpu, 0xFFFF) << 8) | cpu->addr;
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                break;
            }
            if (cpu->phase) cpu->phase++;
            return cpu->status;

        /* ==== JSR (6 cycles) ==== */
        case OP_JSR:
            switch (cpu->phase) {
            case 1: /* Fetch low byte of target */
                cpu->addr = cpu_read(cpu, cpu->PC);
                cpu->PC = (cpu->PC + 1) & 0xFFFF;
                break;
            case 2: /* Internal (read stack, throwaway) */
                cpu_read(cpu, 0x100 + cpu->S);
                break;
            case 3: /* Push PCH */
                push(cpu, (cpu->PC >> 8) & 0xFF);
                break;
            case 4: /* Push PCL */
                push(cpu, cpu->PC & 0xFF);
                break;
            case 5: /* Fetch high byte of target, set PC */
                cpu->PC = ((uint16_t)cpu_read(cpu, cpu->PC) << 8) | cpu->addr;
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                break;
            }
            if (cpu->phase) cpu->phase++;
            return cpu->status;

        /* ==== RTS (6 cycles) ==== */
        case OP_RTS:
            switch (cpu->phase) {
            case 1: /* Dummy read */
                cpu_read(cpu, cpu->PC);
                break;
            case 2: /* Increment S (dummy read from stack) */
                cpu_read(cpu, 0x100 + cpu->S);
                cpu->S = (cpu->S + 1) & 0xFF;
                break;
            case 3: /* Pull PCL */
                cpu->PC = (cpu->PC & 0xFF00) | cpu_read(cpu, 0x100 + cpu->S);
                cpu->S = (cpu->S + 1) & 0xFF;
                break;
            case 4: /* Pull PCH */
                cpu->PC = (cpu->PC & 0x00FF) | ((uint16_t)cpu_read(cpu, 0x100 + cpu->S) << 8);
                break;
            case 5: /* Increment PC */
                cpu->PC = (cpu->PC + 1) & 0xFFFF;
                cpu_read(cpu, cpu->PC);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                break;
            }
            if (cpu->phase) cpu->phase++;
            return cpu->status;

        /* ==== RTI (6 cycles) ==== */
        case OP_RTI:
            switch (cpu->phase) {
            case 1: /* Dummy read */
                cpu_read(cpu, cpu->PC);
                break;
            case 2: /* Increment S (dummy read from stack) */
                cpu_read(cpu, 0x100 + cpu->S);
                cpu->S = (cpu->S + 1) & 0xFF;
                break;
            case 3: /* Pull P */
                cpu_set_p(cpu, cpu_read(cpu, 0x100 + cpu->S));
                cpu->S = (cpu->S + 1) & 0xFF;
                break;
            case 4: /* Pull PCL */
                cpu->PC = (cpu->PC & 0xFF00) | cpu_read(cpu, 0x100 + cpu->S);
                cpu->S = (cpu->S + 1) & 0xFF;
                break;
            case 5: /* Pull PCH */
                cpu->PC = (cpu->PC & 0x00FF) | ((uint16_t)cpu_read(cpu, 0x100 + cpu->S) << 8);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                break;
            }
            if (cpu->phase) cpu->phase++;
            return cpu->status;

        /* ==== PHA / PHP (3 cycles) ==== */
        case OP_PHA:
            switch (cpu->phase) {
            case 1: cpu_read(cpu, cpu->PC); break;
            case 2:
                push(cpu, cpu->A);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                break;
            }
            if (cpu->phase) cpu->phase++;
            return cpu->status;

        case OP_PHP:
            switch (cpu->phase) {
            case 1: cpu_read(cpu, cpu->PC); break;
            case 2:
                push(cpu, cpu->P | FLAG_B | FLAG_U);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                break;
            }
            if (cpu->phase) cpu->phase++;
            return cpu->status;

        /* ==== PLA (4 cycles) ==== */
        case OP_PLA:
            switch (cpu->phase) {
            case 1: cpu_read(cpu, cpu->PC); break;
            case 2: /* Dummy read from stack */
                cpu_read(cpu, 0x100 + cpu->S);
                cpu->S = (cpu->S + 1) & 0xFF;
                break;
            case 3:
                cpu->A = cpu_read(cpu, 0x100 + cpu->S);
                set_nz(cpu, cpu->A);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                break;
            }
            if (cpu->phase) cpu->phase++;
            return cpu->status;

        /* ==== PLP (4 cycles) ==== */
        case OP_PLP:
            switch (cpu->phase) {
            case 1: cpu_read(cpu, cpu->PC); break;
            case 2:
                cpu_read(cpu, 0x100 + cpu->S);
                cpu->S = (cpu->S + 1) & 0xFF;
                break;
            case 3:
                cpu_set_p(cpu, cpu_read(cpu, 0x100 + cpu->S));
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                break;
            }
            if (cpu->phase) cpu->phase++;
            return cpu->status;

        /* ==== JMP absolute (3 cycles) ==== */
        case OP_JMP:
            if (mode == AM_ABS) {
                switch (cpu->phase) {
                case 1: /* Fetch low byte */
                    cpu->addr = cpu_read(cpu, cpu->PC);
                    cpu->PC = (cpu->PC + 1) & 0xFFFF;
                    break;
                case 2: /* Fetch high byte, jump */
                    cpu->PC = ((uint16_t)cpu_read(cpu, cpu->PC) << 8) | cpu->addr;
                    cpu->phase = 0;
                    cpu->cycleCounter = 0;
                    break;
                }
                if (cpu->phase) cpu->phase++;
            } else {
                /* JMP indirect (5 cycles) */
                switch (cpu->phase) {
                case 1: /* Fetch pointer low */
                    cpu->addr = cpu_read(cpu, cpu->PC);
                    cpu->PC = (cpu->PC + 1) & 0xFFFF;
                    break;
                case 2: /* Fetch pointer high */
                    cpu->addr |= ((uint16_t)cpu_read(cpu, cpu->PC) << 8);
                    break;
                case 3: /* Read low byte from pointer */
                    cpu->data = cpu_read(cpu, cpu->addr);
                    break;
                case 4: {
                    /* Read high byte from pointer+1 (with NMOS page wrap bug) */
                    uint16_t hi_addr = (cpu->addr & 0xFF00) | ((cpu->addr + 1) & 0x00FF);
                    cpu->PC = ((uint16_t)cpu_read(cpu, hi_addr) << 8) | cpu->data;
                    cpu->phase = 0;
                    cpu->cycleCounter = 0;
                    break;
                }
                }
                if (cpu->phase) cpu->phase++;
            }
            return cpu->status;

        /* ==== Branches (2-4 cycles) ==== */
        case OP_BPL: case OP_BMI: case OP_BVC: case OP_BVS:
        case OP_BCC: case OP_BCS: case OP_BNE: case OP_BEQ:
            switch (cpu->phase) {
            case 1: /* Fetch offset */
                cpu->data = cpu_read(cpu, cpu->PC);
                cpu->PC = (cpu->PC + 1) & 0xFFFF;
                break;
            case 2: {
                /* Evaluate condition */
                int taken = 0;
                switch (op) {
                case OP_BPL: taken = !(cpu->P & FLAG_N); break;
                case OP_BMI: taken =  (cpu->P & FLAG_N); break;
                case OP_BVC: taken = !(cpu->P & FLAG_V); break;
                case OP_BVS: taken =  (cpu->P & FLAG_V); break;
                case OP_BCC: taken = !(cpu->P & FLAG_C); break;
                case OP_BCS: taken =  (cpu->P & FLAG_C); break;
                case OP_BNE: taken = !(cpu->P & FLAG_Z); break;
                case OP_BEQ: taken =  (cpu->P & FLAG_Z); break;
                default: break;
                }
                if (!taken) {
                    /* Branch not taken: 2 cycles total, done */
                    cpu->phase = 0;
                    cpu->cycleCounter = 0;
                } else {
                    /* Branch taken: compute target, check page cross */
                    cpu_read(cpu, cpu->PC); /* dummy read */
                    int8_t offset = (int8_t)cpu->data;
                    cpu->addr = (cpu->PC + offset) & 0xFFFF;
                    if ((cpu->addr >> 8) == (cpu->PC >> 8)) {
                        /* Same page: 3 cycles total, done */
                        cpu->PC = cpu->addr;
                        cpu->phase = 0;
                        cpu->cycleCounter = 0;
                    } else {
                        /* Page cross: fix low byte now, high byte next cycle */
                        cpu->PC = (cpu->PC & 0xFF00) | (cpu->addr & 0x00FF);
                    }
                }
                break;
            }
            case 3: /* Page cross fixup cycle */
                cpu->PC = cpu->addr;
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                break;
            }
            if (cpu->phase) cpu->phase++;
            return cpu->status;

        default: break;
        }
        /* Should not reach here */
        cpu->phase = 0;
        cpu->cycleCounter = 0;
        return cpu->status;
    }

    /* ---- Implied instructions (2 cycles: opcode fetch + dummy read) ---- */
    if (type == IT_IMP) {
        /* Phase 1: dummy read of next byte, then execute */
        cpu_read(cpu, cpu->PC); /* throw-away read */
        switch (op) {
        case OP_CLC: cpu->P &= ~FLAG_C; break;
        case OP_SEC: cpu->P |= FLAG_C;  break;
        case OP_CLI: cpu->P &= ~FLAG_I; break;
        case OP_SEI: cpu->P |= FLAG_I;  break;
        case OP_CLV: cpu->P &= ~FLAG_V; break;
        case OP_CLD: cpu->P &= ~FLAG_D; break;
        case OP_SED: cpu->P |= FLAG_D;  break;
        case OP_TAX: cpu->X = cpu->A; set_nz(cpu, cpu->X); break;
        case OP_TXA: cpu->A = cpu->X; set_nz(cpu, cpu->A); break;
        case OP_TAY: cpu->Y = cpu->A; set_nz(cpu, cpu->Y); break;
        case OP_TYA: cpu->A = cpu->Y; set_nz(cpu, cpu->A); break;
        case OP_TXS: cpu->S = cpu->X; break;
        case OP_TSX: cpu->X = cpu->S; set_nz(cpu, cpu->X); break;
        case OP_INX: cpu->X = (cpu->X + 1) & 0xFF; set_nz(cpu, cpu->X); break;
        case OP_DEX: cpu->X = (cpu->X - 1) & 0xFF; set_nz(cpu, cpu->X); break;
        case OP_INY: cpu->Y = (cpu->Y + 1) & 0xFF; set_nz(cpu, cpu->Y); break;
        case OP_DEY: cpu->Y = (cpu->Y - 1) & 0xFF; set_nz(cpu, cpu->Y); break;
        case OP_NOP: break;
        default: break;
        }
        cpu->phase = 0;
        cpu->cycleCounter = 0;
        return cpu->status;
    }

    /* ---- Accumulator mode (2 cycles: opcode fetch + dummy read + operate) ---- */
    if (mode == AM_ACC) {
        /* Phase 1: dummy read, do shift/rotate on A */
        cpu_read(cpu, cpu->PC);
        cpu->data = cpu->A;
        do_operation(cpu, op);
        cpu->A = cpu->data;
        cpu->phase = 0;
        cpu->cycleCounter = 0;
        return cpu->status;
    }

    /*
     * ---- Standard addressing modes ----
     *
     * For each addressing mode, we decompose cycles into:
     *   - Fetch operand bytes
     *   - Compute effective address
     *   - Read data / write data / read-modify-write
     *
     * The phase numbers correspond to cycles after the opcode fetch.
     */
    switch (mode) {

    /* ==== Immediate: 2 cycles ==== */
    case AM_IMM:
        /* Phase 1: fetch immediate value, do operation */
        cpu->data = cpu_read(cpu, cpu->PC);
        cpu->PC = (cpu->PC + 1) & 0xFFFF;
        do_operation(cpu, op);
        cpu->phase = 0;
        cpu->cycleCounter = 0;
        return cpu->status;

    /* ==== Zero Page: 3 cycles (read/store), 5 cycles (RMW) ==== */
    case AM_ZPG:
        switch (cpu->phase) {
        case 1: /* Fetch zero-page address */
            cpu->addr = cpu_read(cpu, cpu->PC);
            cpu->PC = (cpu->PC + 1) & 0xFFFF;
            break;
        case 2:
            if (type == IT_STORE) {
                /* Write value to address */
                uint8_t val = 0;
                switch (op) {
                case OP_STA: val = cpu->A; break;
                case OP_STX: val = cpu->X; break;
                case OP_STY: val = cpu->Y; break;
                default: break;
                }
                cpu_write(cpu, cpu->addr, val);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                return cpu->status;
            }
            /* Read value from address */
            cpu->data = cpu_read(cpu, cpu->addr);
            if (type == IT_READ) {
                do_operation(cpu, op);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                return cpu->status;
            }
            /* RMW: continue to write-back cycles */
            break;
        case 3: /* RMW: write back original value (dummy write) */
            cpu_write(cpu, cpu->addr, cpu->data);
            do_operation(cpu, op);
            break;
        case 4: /* RMW: write modified value */
            cpu_write(cpu, cpu->addr, cpu->data);
            cpu->phase = 0;
            cpu->cycleCounter = 0;
            return cpu->status;
        }
        cpu->phase++;
        return cpu->status;

    /* ==== Zero Page,X: 4 cycles (read/store), 6 cycles (RMW) ==== */
    case AM_ZPX:
        switch (cpu->phase) {
        case 1: /* Fetch zero-page base address */
            cpu->addr = cpu_read(cpu, cpu->PC);
            cpu->PC = (cpu->PC + 1) & 0xFFFF;
            break;
        case 2: /* Dummy read from base, add X with wrap */
            cpu_read(cpu, cpu->addr);
            cpu->addr = (cpu->addr + cpu->X) & 0xFF;
            break;
        case 3:
            if (type == IT_STORE) {
                uint8_t val = 0;
                switch (op) {
                case OP_STA: val = cpu->A; break;
                case OP_STX: val = cpu->X; break;
                case OP_STY: val = cpu->Y; break;
                default: break;
                }
                cpu_write(cpu, cpu->addr, val);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                return cpu->status;
            }
            cpu->data = cpu_read(cpu, cpu->addr);
            if (type == IT_READ) {
                do_operation(cpu, op);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                return cpu->status;
            }
            break;
        case 4: /* RMW dummy write */
            cpu_write(cpu, cpu->addr, cpu->data);
            do_operation(cpu, op);
            break;
        case 5: /* RMW writeback */
            cpu_write(cpu, cpu->addr, cpu->data);
            cpu->phase = 0;
            cpu->cycleCounter = 0;
            return cpu->status;
        }
        cpu->phase++;
        return cpu->status;

    /* ==== Zero Page,Y: 4 cycles (read/store) ==== */
    case AM_ZPY:
        switch (cpu->phase) {
        case 1:
            cpu->addr = cpu_read(cpu, cpu->PC);
            cpu->PC = (cpu->PC + 1) & 0xFFFF;
            break;
        case 2:
            cpu_read(cpu, cpu->addr);
            cpu->addr = (cpu->addr + cpu->Y) & 0xFF;
            break;
        case 3:
            if (type == IT_STORE) {
                uint8_t val = 0;
                switch (op) {
                case OP_STA: val = cpu->A; break;
                case OP_STX: val = cpu->X; break;
                case OP_STY: val = cpu->Y; break;
                default: break;
                }
                cpu_write(cpu, cpu->addr, val);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                return cpu->status;
            }
            cpu->data = cpu_read(cpu, cpu->addr);
            do_operation(cpu, op);
            cpu->phase = 0;
            cpu->cycleCounter = 0;
            return cpu->status;
        }
        cpu->phase++;
        return cpu->status;

    /* ==== Absolute: 4 cycles (read/store), 6 cycles (RMW) ==== */
    case AM_ABS:
        switch (cpu->phase) {
        case 1: /* Fetch low byte of address */
            cpu->addr = cpu_read(cpu, cpu->PC);
            cpu->PC = (cpu->PC + 1) & 0xFFFF;
            break;
        case 2: /* Fetch high byte */
            cpu->addr |= ((uint16_t)cpu_read(cpu, cpu->PC) << 8);
            cpu->PC = (cpu->PC + 1) & 0xFFFF;
            break;
        case 3:
            if (type == IT_STORE) {
                uint8_t val = 0;
                switch (op) {
                case OP_STA: val = cpu->A; break;
                case OP_STX: val = cpu->X; break;
                case OP_STY: val = cpu->Y; break;
                default: break;
                }
                cpu_write(cpu, cpu->addr, val);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                return cpu->status;
            }
            cpu->data = cpu_read(cpu, cpu->addr);
            if (type == IT_READ) {
                do_operation(cpu, op);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                return cpu->status;
            }
            break;
        case 4: /* RMW: dummy write original */
            cpu_write(cpu, cpu->addr, cpu->data);
            do_operation(cpu, op);
            break;
        case 5: /* RMW: write modified */
            cpu_write(cpu, cpu->addr, cpu->data);
            cpu->phase = 0;
            cpu->cycleCounter = 0;
            return cpu->status;
        }
        cpu->phase++;
        return cpu->status;

    /* ==== Absolute,X: 4-5 cycles (read), 5 cycles (store), 7 cycles (RMW) ==== */
    case AM_ABX:
        switch (cpu->phase) {
        case 1: /* Fetch low byte */
            cpu->addr = cpu_read(cpu, cpu->PC);
            cpu->PC = (cpu->PC + 1) & 0xFFFF;
            break;
        case 2: /* Fetch high byte */
            cpu->addr |= ((uint16_t)cpu_read(cpu, cpu->PC) << 8);
            cpu->PC = (cpu->PC + 1) & 0xFFFF;
            break;
        case 3: {
            /* Add X. If page crossed (or store/RMW), dummy read from wrong address. */
            uint16_t lo_sum = (cpu->addr & 0xFF) + cpu->X;
            uint16_t hi = cpu->addr & 0xFF00;
            if (type == IT_READ && lo_sum <= 0xFF) {
                /* No page cross on read: skip penalty cycle */
                cpu->data = cpu_read(cpu, cpu->addr + cpu->X);
                do_operation(cpu, op);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                return cpu->status;
            }
            /* Dummy read from partially-computed address */
            cpu_read(cpu, hi | (lo_sum & 0xFF));
            cpu->addr += cpu->X;
            break;
        }
        case 4:
            if (type == IT_STORE) {
                uint8_t val = 0;
                switch (op) {
                case OP_STA: val = cpu->A; break;
                case OP_STX: val = cpu->X; break;
                case OP_STY: val = cpu->Y; break;
                default: break;
                }
                cpu_write(cpu, cpu->addr, val);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                return cpu->status;
            }
            cpu->data = cpu_read(cpu, cpu->addr);
            if (type == IT_READ) {
                do_operation(cpu, op);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                return cpu->status;
            }
            break;
        case 5: /* RMW: dummy write original */
            cpu_write(cpu, cpu->addr, cpu->data);
            do_operation(cpu, op);
            break;
        case 6: /* RMW: write modified */
            cpu_write(cpu, cpu->addr, cpu->data);
            cpu->phase = 0;
            cpu->cycleCounter = 0;
            return cpu->status;
        }
        cpu->phase++;
        return cpu->status;

    /* ==== Absolute,Y: 4-5 cycles (read), 5 cycles (store) ==== */
    case AM_ABY:
        switch (cpu->phase) {
        case 1:
            cpu->addr = cpu_read(cpu, cpu->PC);
            cpu->PC = (cpu->PC + 1) & 0xFFFF;
            break;
        case 2:
            cpu->addr |= ((uint16_t)cpu_read(cpu, cpu->PC) << 8);
            cpu->PC = (cpu->PC + 1) & 0xFFFF;
            break;
        case 3: {
            uint16_t lo_sum = (cpu->addr & 0xFF) + cpu->Y;
            uint16_t hi = cpu->addr & 0xFF00;
            if (type == IT_READ && lo_sum <= 0xFF) {
                cpu->data = cpu_read(cpu, cpu->addr + cpu->Y);
                do_operation(cpu, op);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                return cpu->status;
            }
            cpu_read(cpu, hi | (lo_sum & 0xFF));
            cpu->addr += cpu->Y;
            break;
        }
        case 4:
            if (type == IT_STORE) {
                uint8_t val = 0;
                switch (op) {
                case OP_STA: val = cpu->A; break;
                case OP_STX: val = cpu->X; break;
                case OP_STY: val = cpu->Y; break;
                default: break;
                }
                cpu_write(cpu, cpu->addr, val);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                return cpu->status;
            }
            cpu->data = cpu_read(cpu, cpu->addr);
            if (type == IT_READ) {
                do_operation(cpu, op);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                return cpu->status;
            }
            break;
        }
        cpu->phase++;
        return cpu->status;

    /* ==== (Indirect,X): 6 cycles ==== */
    case AM_INX:
        switch (cpu->phase) {
        case 1: /* Fetch zero-page base */
            cpu->addr = cpu_read(cpu, cpu->PC);
            cpu->PC = (cpu->PC + 1) & 0xFFFF;
            break;
        case 2: /* Dummy read from base */
            cpu_read(cpu, cpu->addr);
            cpu->data2 = (cpu->addr + cpu->X) & 0xFF;
            break;
        case 3: /* Fetch effective address low */
            cpu->addr = cpu_read(cpu, cpu->data2);
            cpu->data2 = (cpu->data2 + 1) & 0xFF;
            break;
        case 4: /* Fetch effective address high */
            cpu->addr |= ((uint16_t)cpu_read(cpu, cpu->data2) << 8);
            break;
        case 5:
            if (type == IT_STORE) {
                uint8_t val = 0;
                switch (op) {
                case OP_STA: val = cpu->A; break;
                case OP_STX: val = cpu->X; break;
                case OP_STY: val = cpu->Y; break;
                default: break;
                }
                cpu_write(cpu, cpu->addr, val);
            } else {
                cpu->data = cpu_read(cpu, cpu->addr);
                do_operation(cpu, op);
            }
            cpu->phase = 0;
            cpu->cycleCounter = 0;
            return cpu->status;
        }
        cpu->phase++;
        return cpu->status;

    /* ==== (Indirect),Y: 5-6 cycles (read), 6 cycles (store) ==== */
    case AM_INY:
        switch (cpu->phase) {
        case 1: /* Fetch zero-page pointer address */
            cpu->data2 = cpu_read(cpu, cpu->PC);
            cpu->PC = (cpu->PC + 1) & 0xFFFF;
            break;
        case 2: /* Read pointer low byte */
            cpu->addr = cpu_read(cpu, cpu->data2);
            cpu->data2 = (cpu->data2 + 1) & 0xFF;
            break;
        case 3: /* Read pointer high byte */
            cpu->addr |= ((uint16_t)cpu_read(cpu, cpu->data2) << 8);
            break;
        case 4: {
            /* Add Y, check page cross */
            uint16_t lo_sum = (cpu->addr & 0xFF) + cpu->Y;
            uint16_t hi = cpu->addr & 0xFF00;
            if (type == IT_READ && lo_sum <= 0xFF) {
                /* No page cross: skip penalty */
                cpu->data = cpu_read(cpu, cpu->addr + cpu->Y);
                do_operation(cpu, op);
                cpu->phase = 0;
                cpu->cycleCounter = 0;
                return cpu->status;
            }
            /* Dummy read from wrong address */
            cpu_read(cpu, hi | (lo_sum & 0xFF));
            cpu->addr += cpu->Y;
            break;
        }
        case 5:
            if (type == IT_STORE) {
                uint8_t val = 0;
                switch (op) {
                case OP_STA: val = cpu->A; break;
                case OP_STX: val = cpu->X; break;
                case OP_STY: val = cpu->Y; break;
                default: break;
                }
                cpu_write(cpu, cpu->addr, val);
            } else {
                cpu->data = cpu_read(cpu, cpu->addr);
                do_operation(cpu, op);
            }
            cpu->phase = 0;
            cpu->cycleCounter = 0;
            return cpu->status;
        }
        cpu->phase++;
        return cpu->status;

    default:
        /* Should never reach here */
        cpu->phase = 0;
        cpu->cycleCounter = 0;
        break;
    }

    return cpu->status;
}

/* ---- WASM-specific exports ---- */

#ifdef __EMSCRIPTEN__

/* Single global CPU instance for WASM (JS can also allocate its own via malloc) */
static cpu_state_t g_cpu;

EXPORT cpu_state_t* cpu_get_instance(void) {
    return &g_cpu;
}

EXPORT void cpu_wasm_init(void) {
    cpu_init(&g_cpu);
}

EXPORT int cpu_wasm_run(void) {
    return (int)cpu_run(&g_cpu);
}

/* Direct register accessors for JS (avoid needing to know struct offsets) */
EXPORT uint16_t cpu_get_pc(void) { return g_cpu.PC; }
EXPORT void     cpu_set_pc(uint16_t v) { g_cpu.PC = v; }
EXPORT uint8_t  cpu_get_a(void)  { return g_cpu.A; }
EXPORT void     cpu_set_a(uint8_t v) { g_cpu.A = v; }
EXPORT uint8_t  cpu_get_x(void)  { return g_cpu.X; }
EXPORT void     cpu_set_x(uint8_t v) { g_cpu.X = v; }
EXPORT uint8_t  cpu_get_y(void)  { return g_cpu.Y; }
EXPORT void     cpu_set_y(uint8_t v) { g_cpu.Y = v; }
EXPORT uint8_t  cpu_get_s(void)  { return g_cpu.S; }
EXPORT void     cpu_set_s(uint8_t v) { g_cpu.S = v; }
EXPORT uint8_t  cpu_get_p_reg(void)  { return g_cpu.P; }
EXPORT void     cpu_set_p_reg(uint8_t v) { g_cpu.P = v; }
EXPORT uint8_t  cpu_get_cycle_counter(void) { return g_cpu.cycleCounter; }
EXPORT void     cpu_set_cycle_counter(uint8_t v) { g_cpu.cycleCounter = v; }
EXPORT uint8_t  cpu_get_phase(void)  { return g_cpu.phase; }
EXPORT void     cpu_set_phase(uint8_t v) { g_cpu.phase = v; }
EXPORT uint8_t  cpu_get_undocumented(void) { return g_cpu.undocumented; }
EXPORT uint8_t  cpu_get_crashed(void) { return g_cpu.undocumented; } /* alias for Sfotty compat */
EXPORT void     cpu_set_crashed(uint8_t v) { g_cpu.undocumented = v; }

#endif /* __EMSCRIPTEN__ */
