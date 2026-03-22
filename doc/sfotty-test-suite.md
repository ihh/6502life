# Sfotty Test Suite Analysis and Ported Test Cases

## Source

The Sfotty 6502 emulator ([github.com/cyco130/sfotty-pie](https://github.com/cyco130/sfotty-pie))
uses the [SingleStepTests/65x02](https://github.com/SingleStepTests/65x02) test suite
(formerly known as the Tom Harte processor tests). These are the gold standard for
cycle-accurate 6502 validation.

### How Sfotty's tests work

The test file is at `packages/sfotty/test/test.ts`. For each of the 151 official NMOS
6502 opcodes, it loads a JSON file (e.g. `ea.json` for NOP) containing ~10,000 test
vectors per opcode. Each vector specifies:

- **Initial state**: PC, A, X, Y, S, P registers + sparse RAM contents
- **Final state**: same register set + sparse RAM contents
- **Cycle log**: every bus access (address, value, read/write) for the instruction

The test runner validates all three: registers, memory, and bus cycle accuracy.
Sfotty calls `run()` once per cycle (it is cycle-accurate, not instruction-level).
For an N-cycle instruction, it calls `run()` N+1 times and captures PC after the
N-th call.

### P register handling

Sfotty's test masks bits 4 and 5 of the P register (`P | 0x30`) before comparison,
since these bits (B flag and unused bit) have special behavior on the 6502.

## Ported Test Cases

### File: `cpu/sfotty-test-cases.json`

**2,265 test cases** covering all 151 official NMOS 6502 opcodes (15 per opcode).
Generated using Sfotty itself as the reference oracle, with a seeded PRNG for
reproducibility.

### Format

```json
{
  "name": "LDA_imm_a9_0",
  "setup": {
    "PC": 520,
    "A": 66,
    "X": 88,
    "Y": 59,
    "S": 200,
    "P": 43,
    "memory": { "520": 169, "521": 42 }
  },
  "expected": {
    "PC": 522,
    "A": 42,
    "X": 88,
    "Y": 59,
    "S": 200,
    "P": 33
  },
  "expectedCycles": 2,
  "cycles": [
    [520, 169, "read"],
    [521, 42, "read"]
  ],
  "finalMemory": {}
}
```

Fields:
- **name**: `MNEMONIC_MODE_OPCODE_INDEX`
- **setup.memory**: sparse map of `address -> byte` for all memory locations accessed
  during the instruction (from the bus cycle log)
- **expected**: register state after instruction completes. P has bits 4,5 forced on.
- **expectedCycles**: number of bus cycles for the instruction
- **cycles**: bus access log `[address, value, "read"|"write"]` per cycle
- **finalMemory**: sparse map of addresses that changed value (writes)

### How to use for Rust CPU validation

1. Parse the JSON file
2. For each test case:
   - Initialize 64KB RAM, fill with `0xEA` (NOP), then apply `setup.memory`
   - Set CPU registers from `setup`
   - Execute exactly `expectedCycles` bus cycles (or one instruction)
   - Compare registers against `expected` (mask P with `| 0x30`)
   - Compare RAM at addresses in `finalMemory`
   - Optionally validate the bus cycle log

### Coverage

All 56 mnemonics across all addressing modes:

| Category | Mnemonics |
|----------|-----------|
| Load/Store | LDA, LDX, LDY, STA, STX, STY |
| Arithmetic | ADC, SBC, INC, DEC, INX, INY, DEX, DEY |
| Logic | AND, ORA, EOR, BIT |
| Shift | ASL, LSR, ROL, ROR |
| Compare | CMP, CPX, CPY |
| Branch | BCC, BCS, BEQ, BNE, BMI, BPL, BVC, BVS |
| Jump | JMP, JSR, RTS, RTI |
| Stack | PHA, PLA, PHP, PLP |
| Transfer | TAX, TAY, TXA, TYA, TSX, TXS |
| Flags | CLC, SEC, CLI, SEI, CLV, CLD, SED |
| Other | NOP, BRK |

### Relationship to SingleStepTests/65x02

The original test suite has ~10,000 vectors per opcode (1.5 million total, ~4MB per
opcode file). Our extracted set of 15 per opcode is designed to be lightweight enough
to include in the repo while still catching most implementation bugs. For exhaustive
testing, download the full suite from
[github.com/SingleStepTests/65x02](https://github.com/SingleStepTests/65x02).

### Generator script

`cpu/generate-test-cases.js` regenerates the test cases using Sfotty as the oracle.
Run with `node cpu/generate-test-cases.js`. The PRNG seed is fixed so output is
deterministic.

## Klaus Dormann's Functional Test

The Sfotty repo does not reference Klaus Dormann's 6502 functional test suite
(`6502_functional_test.bin`). That test is a comprehensive integration test
(not per-instruction) available at
[github.com/Klaus2m5/6502_65C02_functional_tests](https://github.com/Klaus2m5/6502_65C02_functional_tests).
It is complementary to the SingleStepTests approach: Dormann tests exercise instruction
sequences and edge cases that single-instruction tests may miss, while SingleStepTests
provide exhaustive per-opcode cycle-level coverage.
