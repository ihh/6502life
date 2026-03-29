// Branchless 6502 compute shader for WebGPU.
// Each invocation runs one cell's quantum (up to MAX_STEPS instructions).
// Memory: 2048 bytes per cell (own 1024 + neighbor 1024).

const ADDR_MASK: u32 = 0x7FFu;
const MAX_STEPS: u32 = 350u;
const M: u32 = 1024u;

// Flag bits
const F_C: u32 = 0x01u; const F_Z: u32 = 0x02u; const F_I: u32 = 0x04u;
const F_D: u32 = 0x08u; const F_B: u32 = 0x10u; const F_U: u32 = 0x20u;
const F_V: u32 = 0x40u; const F_N: u32 = 0x80u;

// Instruction classes
const CLS_READ: u32 = 0u; const CLS_STORE: u32 = 1u; const CLS_RMW: u32 = 2u;
const CLS_RMW_A: u32 = 3u; const CLS_BRANCH: u32 = 4u; const CLS_IMPLIED: u32 = 5u;
const CLS_PUSH: u32 = 6u; const CLS_PULL: u32 = 7u; const CLS_JMP_ABS: u32 = 8u;
const CLS_JMP_IND: u32 = 9u; const CLS_JSR: u32 = 10u; const CLS_RTS: u32 = 11u;
const CLS_RTI: u32 = 12u; const CLS_BRK: u32 = 13u; const CLS_JAM: u32 = 14u;

// Addressing modes
const AM_IMP: u32 = 0u; const AM_ACC: u32 = 1u; const AM_IMM: u32 = 2u;
const AM_ZPG: u32 = 3u; const AM_ZPX: u32 = 4u; const AM_ZPY: u32 = 5u;
const AM_ABS: u32 = 6u; const AM_ABX: u32 = 7u; const AM_ABY: u32 = 8u;
const AM_INX: u32 = 9u; const AM_INY: u32 = 10u; const AM_REL: u32 = 11u;
const AM_IND: u32 = 12u;

// Register save offsets
const REG_PCHI: u32 = 0xF9u; const REG_PCLO: u32 = 0xFAu;
const REG_P: u32 = 0xFBu; const REG_A: u32 = 0xFCu;
const REG_X: u32 = 0xFDu; const REG_Y: u32 = 0xFEu; const REG_S: u32 = 0xFFu;

// Opcode table: 256 entries × 7 u32 each
@group(0) @binding(0) var<storage, read> opcodeTable: array<u32, 1792>; // 256 * 7

// Board storage: flat byte array
@group(0) @binding(1) var<storage, read_write> boardStorage: array<u32>; // packed as u32

// Per-invocation: pair indices [N×2] and cycle budgets [N]
@group(0) @binding(2) var<storage, read> pairIndices: array<u32>; // [cell_base, nbr_base] pairs
@group(0) @binding(3) var<storage, read> cycleBudgets: array<u32>;

// Helper: read one byte from board storage (packed as u32)
fn readByte(addr: u32) -> u32 {
    let wordIdx = addr >> 2u;
    let byteOff = addr & 3u;
    return (boardStorage[wordIdx] >> (byteOff * 8u)) & 0xFFu;
}

// Helper: write one byte to board storage
fn writeByte(addr: u32, val: u32) {
    let wordIdx = addr >> 2u;
    let byteOff = addr & 3u;
    let mask = ~(0xFFu << (byteOff * 8u));
    let bits = (val & 0xFFu) << (byteOff * 8u);
    boardStorage[wordIdx] = (boardStorage[wordIdx] & mask) | bits;
}

// Read from 2KB local address space, mapped to board storage
fn memRead(cellBase: u32, nbrBase: u32, addr: u32) -> u32 {
    let masked = addr & ADDR_MASK;
    // select(falseVal, trueVal, cond): WGSL order is opposite of C ternary
    let storageAddr = select(nbrBase + (masked - M), cellBase + masked, masked < M);
    return readByte(storageAddr);
}

// Write to 2KB local address space
fn memWrite(cellBase: u32, nbrBase: u32, addr: u32, val: u32) {
    let masked = addr & ADDR_MASK;
    // select(falseVal, trueVal, cond): WGSL order is opposite of C ternary
    let storageAddr = select(nbrBase + (masked - M), cellBase + masked, masked < M);
    writeByte(storageAddr, val);
}

// Update N and Z flags
fn nzFlags(val: u32, p: u32) -> u32 {
    let z = select(0u, F_Z, (val & 0xFFu) == 0u);
    let n = val & F_N;
    return (p & ~(F_N | F_Z)) | n | z;
}

// Lookup opcode table
fn opcLookup(opcode: u32, field: u32) -> u32 {
    return opcodeTable[opcode * 7u + field];
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    let cellBase = pairIndices[idx * 2u];
    let nbrBase = pairIndices[idx * 2u + 1u];
    let budget = cycleBudgets[idx];

    // Read registers from cell's save area
    var pc: u32 = (memRead(cellBase, nbrBase, REG_PCHI) << 8u) |
                   memRead(cellBase, nbrBase, REG_PCLO);
    var a: u32 = memRead(cellBase, nbrBase, REG_A);
    var x: u32 = memRead(cellBase, nbrBase, REG_X);
    var y: u32 = memRead(cellBase, nbrBase, REG_Y);
    var s: u32 = memRead(cellBase, nbrBase, REG_S);
    var p: u32 = memRead(cellBase, nbrBase, REG_P);
    var cyclesUsed: u32 = 0u;
    var done: bool = false;

    // Instruction loop
    for (var step: u32 = 0u; step < MAX_STEPS; step++) {
        if (done) { break; }

        let opcode = memRead(cellBase, nbrBase, pc);
        let cls = opcLookup(opcode, 0u);
        let addrMode = opcLookup(opcode, 1u);
        let op = opcLookup(opcode, 2u);
        let baseCycles = opcLookup(opcode, 3u);
        let pcrossFlag = opcLookup(opcode, 4u);
        let nbytes = opcLookup(opcode, 5u);

        let op1 = memRead(cellBase, nbrBase, (pc + 1u) & 0xFFFFu);
        let op2 = memRead(cellBase, nbrBase, (pc + 2u) & 0xFFFFu);
        let operandWord = (op1 | (op2 << 8u)) & 0xFFFFu;

        // Resolve effective address (branchless: compute all, select one)
        let addrZpg = op1;
        let addrZpx = (op1 + x) & 0xFFu;
        let addrZpy = (op1 + y) & 0xFFu;
        let addrAbs = operandWord;
        let addrAbx = (operandWord + x) & 0xFFFFu;
        let addrAby = (operandWord + y) & 0xFFFFu;

        let ptrInxLo = memRead(cellBase, nbrBase, (op1 + x) & 0xFFu);
        let ptrInxHi = memRead(cellBase, nbrBase, (op1 + x + 1u) & 0xFFu);
        let addrInx = (ptrInxLo | (ptrInxHi << 8u)) & 0xFFFFu;

        let ptrInyLo = memRead(cellBase, nbrBase, op1);
        let ptrInyHi = memRead(cellBase, nbrBase, (op1 + 1u) & 0xFFu);
        let inyBase = (ptrInyLo | (ptrInyHi << 8u)) & 0xFFFFu;
        let addrIny = (inyBase + y) & 0xFFFFu;

        let ptrIndLo = memRead(cellBase, nbrBase, operandWord);
        let ptrIndHi = memRead(cellBase, nbrBase, (operandWord & 0xFF00u) | ((operandWord + 1u) & 0xFFu));
        let addrInd = (ptrIndLo | (ptrIndHi << 8u)) & 0xFFFFu;

        // Select effective address by mode
        var effAddr: u32 = 0u;
        if (addrMode == AM_IMM) { effAddr = (pc + 1u) & 0xFFFFu; }
        else if (addrMode == AM_ZPG) { effAddr = addrZpg; }
        else if (addrMode == AM_ZPX) { effAddr = addrZpx; }
        else if (addrMode == AM_ZPY) { effAddr = addrZpy; }
        else if (addrMode == AM_ABS) { effAddr = addrAbs; }
        else if (addrMode == AM_ABX) { effAddr = addrAbx; }
        else if (addrMode == AM_ABY) { effAddr = addrAby; }
        else if (addrMode == AM_INX) { effAddr = addrInx; }
        else if (addrMode == AM_INY) { effAddr = addrIny; }
        else if (addrMode == AM_IND) { effAddr = addrInd; }

        let operandVal = memRead(cellBase, nbrBase, effAddr);

        // Page cross detection (Sfotty: >= 255)
        let crossAbx = ((operandWord & 0xFFu) + x) >= 255u;
        let crossAby = ((operandWord & 0xFFu) + y) >= 255u;
        let crossIny = ((inyBase & 0xFFu) + y) >= 255u;
        var pageCrossed: bool = false;
        if (addrMode == AM_ABX) { pageCrossed = crossAbx; }
        else if (addrMode == AM_ABY) { pageCrossed = crossAby; }
        else if (addrMode == AM_INY) { pageCrossed = crossIny; }
        let extraCycles = select(0u, pcrossFlag, pageCrossed);

        var nextPc: u32 = (pc + nbytes) & 0xFFFFu;
        var newA = a; var newX = x; var newY = y; var newS = s; var newP = p;
        var writeAddr: u32 = 0u; var writeVal: u32 = 0u; var doWrite: bool = false;
        var branchExtra: u32 = 0u;

        // ── Execute by instruction class ──

        if (cls == CLS_READ) {
            // Compute all read results, select by op
            var result: u32 = operandVal;
            var resultP: u32 = p;

            if (op == 0u) { newA = operandVal; resultP = nzFlags(operandVal, p); }           // LDA
            else if (op == 1u) { newX = operandVal; resultP = nzFlags(operandVal, p); }       // LDX
            else if (op == 2u) { newY = operandVal; resultP = nzFlags(operandVal, p); }       // LDY
            else if (op == 3u) { newA = a ^ operandVal; resultP = nzFlags(a ^ operandVal, p); } // EOR
            else if (op == 4u) { newA = a & operandVal; resultP = nzFlags(a & operandVal, p); } // AND
            else if (op == 5u) { newA = a | operandVal; resultP = nzFlags(a | operandVal, p); } // ORA
            else if (op == 6u) { // ADC
                let sum = a + operandVal + (p & F_C);
                newA = sum & 0xFFu;
                let cOut = select(0u, F_C, sum > 255u);
                let v = select(0u, F_V, ((a ^ newA) & (operandVal ^ newA) & 0x80u) != 0u);
                resultP = nzFlags(newA, (p & ~(F_C | F_V)) | cOut | v);
            }
            else if (op == 7u) { // SBC
                let inv = operandVal ^ 0xFFu;
                let sum = a + inv + (p & F_C);
                newA = sum & 0xFFu;
                let cOut = select(0u, F_C, sum > 255u);
                let v = select(0u, F_V, ((a ^ newA) & (inv ^ newA) & 0x80u) != 0u);
                resultP = nzFlags(newA, (p & ~(F_C | F_V)) | cOut | v);
            }
            else if (op == 8u) { // CMP
                let diff = (a + 256u - operandVal) & 0x1FFu;
                resultP = nzFlags(diff, (p & ~F_C) | select(0u, F_C, a >= operandVal));
            }
            else if (op == 9u) { // CPX
                let diff = (x + 256u - operandVal) & 0x1FFu;
                resultP = nzFlags(diff, (p & ~F_C) | select(0u, F_C, x >= operandVal));
            }
            else if (op == 10u) { // CPY
                let diff = (y + 256u - operandVal) & 0x1FFu;
                resultP = nzFlags(diff, (p & ~F_C) | select(0u, F_C, y >= operandVal));
            }
            else if (op == 11u) { // BIT
                let z = select(0u, F_Z, (a & operandVal) == 0u);
                resultP = (p & ~(F_N | F_V | F_Z)) | (operandVal & (F_N | F_V)) | z;
            }
            else if (op == 13u) { // LAX
                newA = operandVal; newX = operandVal;
                resultP = nzFlags(operandVal, p);
            }
            newP = resultP;
        }
        else if (cls == CLS_STORE) {
            var sv: u32 = a;
            if (op == 1u) { sv = x; }
            else if (op == 2u) { sv = y; }
            else if (op == 3u) { sv = a & x; } // SAX
            writeAddr = effAddr; writeVal = sv & 0xFFu; doWrite = true;
        }
        else if (cls == CLS_RMW) {
            var rmwResult: u32 = operandVal;
            var rmwC: u32 = p & F_C;
            if (op == 0u) { rmwResult = (operandVal << 1u) & 0xFFu; rmwC = (operandVal >> 7u) & 1u; }     // ASL
            else if (op == 1u) { rmwResult = operandVal >> 1u; rmwC = operandVal & 1u; }                   // LSR
            else if (op == 2u) { rmwResult = ((operandVal << 1u) | (p & F_C)) & 0xFFu; rmwC = (operandVal >> 7u) & 1u; } // ROL
            else if (op == 3u) { rmwResult = ((operandVal >> 1u) | ((p & F_C) << 7u)) & 0xFFu; rmwC = operandVal & 1u; } // ROR
            else if (op == 4u) { rmwResult = (operandVal + 1u) & 0xFFu; }                                  // INC
            else if (op == 5u) { rmwResult = (operandVal + 255u) & 0xFFu; }                                // DEC
            writeAddr = effAddr; writeVal = rmwResult & 0xFFu; doWrite = true;
            newP = nzFlags(rmwResult, (p & ~F_C) | rmwC);
        }
        else if (cls == CLS_RMW_A) {
            var rmwResult: u32 = a;
            var rmwC: u32 = p & F_C;
            if (op == 0u) { rmwResult = (a << 1u) & 0xFFu; rmwC = (a >> 7u) & 1u; }
            else if (op == 1u) { rmwResult = a >> 1u; rmwC = a & 1u; }
            else if (op == 2u) { rmwResult = ((a << 1u) | (p & F_C)) & 0xFFu; rmwC = (a >> 7u) & 1u; }
            else if (op == 3u) { rmwResult = ((a >> 1u) | ((p & F_C) << 7u)) & 0xFFu; rmwC = a & 1u; }
            newA = rmwResult; newP = nzFlags(rmwResult, (p & ~F_C) | rmwC);
        }
        else if (cls == CLS_BRANCH) {
            var cond: bool = false;
            if (op == 0u) { cond = (p & F_N) == 0u; }      // BPL
            else if (op == 1u) { cond = (p & F_N) != 0u; }  // BMI
            else if (op == 2u) { cond = (p & F_V) == 0u; }  // BVC
            else if (op == 3u) { cond = (p & F_V) != 0u; }  // BVS
            else if (op == 4u) { cond = (p & F_C) == 0u; }  // BCC
            else if (op == 5u) { cond = (p & F_C) != 0u; }  // BCS
            else if (op == 6u) { cond = (p & F_Z) == 0u; }  // BNE
            else if (op == 7u) { cond = (p & F_Z) != 0u; }  // BEQ
            let brOff = select(i32(op1), i32(op1) - 256, op1 >= 128u);
            let brTarget = u32(i32(pc + 2u) + brOff) & 0xFFFFu;
            if (cond) {
                nextPc = brTarget;
                let samePage = (brTarget >> 8u) == ((pc + 2u) >> 8u);
                branchExtra = select(2u, 1u, samePage);
            }
        }
        else if (cls == CLS_IMPLIED) {
            if (op == 0u) { newP = p & ~F_C; }              // CLC
            else if (op == 1u) { newP = p | F_C; }          // SEC
            else if (op == 2u) { newP = p & ~F_I; }         // CLI
            else if (op == 3u) { newP = p | F_I; }          // SEI
            else if (op == 4u) { newP = p & ~F_V; }         // CLV
            else if (op == 5u) { newP = p & ~F_D; }         // CLD
            else if (op == 6u) { newP = p | F_D; }          // SED
            else if (op == 7u) { newY = a; newP = nzFlags(a, p); }     // TAY
            else if (op == 8u) { newA = y; newP = nzFlags(y, p); }     // TYA
            else if (op == 9u) { newX = a; newP = nzFlags(a, p); }     // TAX
            else if (op == 10u) { newA = x; newP = nzFlags(x, p); }    // TXA
            else if (op == 11u) { newX = s; }                          // TSX (no flags in Sfotty)
            else if (op == 12u) { newS = x; }                          // TXS
            else if (op == 13u) { newX = (x + 255u) & 0xFFu; newP = nzFlags((x + 255u) & 0xFFu, p); } // DEX
            else if (op == 14u) { newY = (y + 255u) & 0xFFu; newP = nzFlags((y + 255u) & 0xFFu, p); } // DEY
            else if (op == 15u) { newX = (x + 1u) & 0xFFu; newP = nzFlags((x + 1u) & 0xFFu, p); }    // INX
            else if (op == 16u) { newY = (y + 1u) & 0xFFu; newP = nzFlags((y + 1u) & 0xFFu, p); }    // INY
        }
        else if (cls == CLS_PUSH) {
            let pushVal = select(a, p | F_B | F_U, op == 1u);
            memWrite(cellBase, nbrBase, 0x100u + s, pushVal);
            newS = (s + 255u) & 0xFFu; // S--
        }
        else if (cls == CLS_PULL) {
            let pullAddr = 0x100u + ((s + 1u) & 0xFFu);
            let pulled = memRead(cellBase, nbrBase, pullAddr);
            if (op == 0u) { newA = pulled; newP = nzFlags(pulled, p); }     // PLA
            else { newP = (pulled | F_U) & ~F_B; }                          // PLP
            newS = (s + 1u) & 0xFFu;
        }
        else if (cls == CLS_JMP_ABS) { nextPc = effAddr; }
        else if (cls == CLS_JMP_IND) { nextPc = effAddr; }
        else if (cls == CLS_JSR) {
            let ret = (pc + 2u) & 0xFFFFu;
            memWrite(cellBase, nbrBase, 0x100u + s, (ret >> 8u) & 0xFFu);
            memWrite(cellBase, nbrBase, 0x100u + ((s + 255u) & 0xFFu), ret & 0xFFu);
            newS = (s + 254u) & 0xFFu; // S -= 2
            nextPc = operandWord;
        }
        else if (cls == CLS_RTS) {
            let lo = memRead(cellBase, nbrBase, 0x100u + ((s + 1u) & 0xFFu));
            let hi = memRead(cellBase, nbrBase, 0x100u + ((s + 2u) & 0xFFu));
            nextPc = ((lo | (hi << 8u)) + 1u) & 0xFFFFu;
            newS = (s + 2u) & 0xFFu;
        }
        else if (cls == CLS_RTI) {
            newP = (memRead(cellBase, nbrBase, 0x100u + ((s + 1u) & 0xFFu)) | F_U) & ~F_B;
            let lo = memRead(cellBase, nbrBase, 0x100u + ((s + 2u) & 0xFFu));
            let hi = memRead(cellBase, nbrBase, 0x100u + ((s + 3u) & 0xFFu));
            nextPc = (lo | (hi << 8u)) & 0xFFFFu;
            newS = (s + 3u) & 0xFFu;
        }
        else if (cls == CLS_BRK || cls == CLS_JAM) {
            // BRK/JAM = yield. Don't advance PC (matches CPU: saves pc at BRK addr).
            break;
        }

        // Apply memory write
        if (doWrite) {
            memWrite(cellBase, nbrBase, writeAddr, writeVal);
        }

        // Update state
        let totalCycles = baseCycles + extraCycles + branchExtra;
        let newCyclesUsed = cyclesUsed + totalCycles;

        // Budget exceeded: break WITHOUT updating pc/regs (matches CPU behavior:
        // CPU breaks after cycles += totalCyc but before pc = nextPc)
        if (newCyclesUsed >= budget) {
            break;
        }
        pc = nextPc; a = newA & 0xFFu; x = newX & 0xFFu;
        y = newY & 0xFFu; s = newS & 0xFFu;
        p = (newP | F_U | F_B) & 0xFFu;
        cyclesUsed = newCyclesUsed;
    }

    // Save registers
    memWrite(cellBase, nbrBase, REG_PCHI, (pc >> 8u) & 0xFFu);
    memWrite(cellBase, nbrBase, REG_PCLO, pc & 0xFFu);
    memWrite(cellBase, nbrBase, REG_P, p);
    memWrite(cellBase, nbrBase, REG_A, a);
    memWrite(cellBase, nbrBase, REG_X, x);
    memWrite(cellBase, nbrBase, REG_Y, y);
    memWrite(cellBase, nbrBase, REG_S, s);
}
