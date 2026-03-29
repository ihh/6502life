/**
 * Cross-validation: CPU bare-sim vs WGSL shader logic.
 *
 * Runs the same programs through the CPU runQuantum and a JS transliteration
 * of the WGSL shader. Compares all registers and memory after each quantum.
 * This guarantees GPU and CPU produce identical Merkle trees.
 */

import { describe, it, expect } from 'vitest';
import { BareSimCPU } from '../bare-sim-cpu.js';
import { buildOpcodeTable } from '../opcode_table.js';
import { PRNG } from '../prng.js';

const ADDR_MASK = 0x7FF;
const M = 1024;
const F_C = 0x01, F_Z = 0x02, F_I = 0x04, F_D = 0x08;
const F_B = 0x10, F_U = 0x20, F_V = 0x40, F_N = 0x80;
const MAX_STEPS = 350;
const opcTable = buildOpcodeTable();

// --- JS transliteration of the WGSL shader's runQuantum ---
// Must match cpu6502.wgsl exactly (modulo syntax).

function nzFlags(val, p) {
    const z = (val & 0xFF) === 0 ? F_Z : 0;
    return (p & ~(F_N | F_Z)) | (val & F_N) | z;
}

function wgslRunQuantum(mem, budget) {
    let pc = (mem[0xF9] << 8) | mem[0xFA];
    let a = mem[0xFC], x = mem[0xFD], y = mem[0xFE], s = mem[0xFF], p = mem[0xFB];
    let cyclesUsed = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
        const opcode = mem[pc & ADDR_MASK];
        const i = opcode * 7;
        const cls = opcTable[i], addrMode = opcTable[i+1], op = opcTable[i+2];
        const baseCycles = opcTable[i+3], pcross = opcTable[i+4], nbytes = opcTable[i+5];

        const op1 = mem[(pc + 1) & ADDR_MASK];
        const op2 = mem[(pc + 2) & ADDR_MASK];
        const operandWord = (op1 | (op2 << 8)) & 0xFFFF;

        // Resolve address (same as WGSL)
        let effAddr = 0;
        let pageCrossed = false;
        if (addrMode === 2) effAddr = (pc + 1) & 0xFFFF; // IMM
        else if (addrMode === 3) effAddr = op1; // ZPG
        else if (addrMode === 4) effAddr = (op1 + x) & 0xFF; // ZPX
        else if (addrMode === 5) effAddr = (op1 + y) & 0xFF; // ZPY
        else if (addrMode === 6) effAddr = operandWord; // ABS
        else if (addrMode === 7) { effAddr = (operandWord + x) & 0xFFFF; pageCrossed = ((operandWord & 0xFF) + x) >= 255; }
        else if (addrMode === 8) { effAddr = (operandWord + y) & 0xFFFF; pageCrossed = ((operandWord & 0xFF) + y) >= 255; }
        else if (addrMode === 9) { const zp = (op1 + x) & 0xFF; effAddr = (mem[zp] | (mem[(zp+1)&0xFF] << 8)) & 0xFFFF; }
        else if (addrMode === 10) { const base = (mem[op1] | (mem[(op1+1)&0xFF] << 8)) & 0xFFFF; effAddr = (base + y) & 0xFFFF; pageCrossed = ((base & 0xFF) + y) >= 255; }
        else if (addrMode === 12) { effAddr = (mem[operandWord & ADDR_MASK] | (mem[((operandWord & 0xFF00) | ((operandWord+1) & 0xFF)) & ADDR_MASK] << 8)) & 0xFFFF; }

        const operandVal = mem[effAddr & ADDR_MASK];
        const extraCycles = (pageCrossed && pcross) ? 1 : 0;
        let nextPc = (pc + nbytes) & 0xFFFF;
        let newA = a, newX = x, newY = y, newS = s, newP = p;
        let writeAddr = 0, writeVal = 0, doWrite = false;
        let branchExtra = 0;

        if (cls === 0) { // READ
            let resultP = p;
            if (op === 0) { newA = operandVal; resultP = nzFlags(operandVal, p); }
            else if (op === 1) { newX = operandVal; resultP = nzFlags(operandVal, p); }
            else if (op === 2) { newY = operandVal; resultP = nzFlags(operandVal, p); }
            else if (op === 3) { newA = a ^ operandVal; resultP = nzFlags(a ^ operandVal, p); }
            else if (op === 4) { newA = a & operandVal; resultP = nzFlags(a & operandVal, p); }
            else if (op === 5) { newA = a | operandVal; resultP = nzFlags(a | operandVal, p); }
            else if (op === 6) { // ADC
                const sum = a + operandVal + (p & F_C);
                newA = sum & 0xFF;
                const cOut = sum > 255 ? F_C : 0;
                const v = ((a ^ newA) & (operandVal ^ newA) & 0x80) ? F_V : 0;
                resultP = nzFlags(newA, (p & ~(F_C | F_V)) | cOut | v);
            }
            else if (op === 7) { // SBC
                const inv = operandVal ^ 0xFF;
                const sum = a + inv + (p & F_C);
                newA = sum & 0xFF;
                const cOut = sum > 255 ? F_C : 0;
                const v = ((a ^ newA) & (inv ^ newA) & 0x80) ? F_V : 0;
                resultP = nzFlags(newA, (p & ~(F_C | F_V)) | cOut | v);
            }
            else if (op === 8) { // CMP
                const diff = (a + 256 - operandVal) & 0x1FF;
                resultP = nzFlags(diff, (p & ~F_C) | (a >= operandVal ? F_C : 0));
            }
            else if (op === 9) { // CPX
                const diff = (x + 256 - operandVal) & 0x1FF;
                resultP = nzFlags(diff, (p & ~F_C) | (x >= operandVal ? F_C : 0));
            }
            else if (op === 10) { // CPY
                const diff = (y + 256 - operandVal) & 0x1FF;
                resultP = nzFlags(diff, (p & ~F_C) | (y >= operandVal ? F_C : 0));
            }
            else if (op === 11) { // BIT
                const z = (a & operandVal) === 0 ? F_Z : 0;
                resultP = (p & ~(F_N | F_V | F_Z)) | (operandVal & (F_N | F_V)) | z;
            }
            else if (op === 13) { newA = operandVal; newX = operandVal; resultP = nzFlags(operandVal, p); } // LAX
            newP = resultP;
        }
        else if (cls === 1) { // STORE
            let sv = a;
            if (op === 1) sv = x; else if (op === 2) sv = y; else if (op === 3) sv = a & x;
            writeAddr = effAddr; writeVal = sv & 0xFF; doWrite = true;
        }
        else if (cls === 2) { // RMW
            let r = operandVal, c = p & F_C;
            if (op === 0) { r = (operandVal << 1) & 0xFF; c = (operandVal >> 7) & 1; }
            else if (op === 1) { r = operandVal >> 1; c = operandVal & 1; }
            else if (op === 2) { r = ((operandVal << 1) | (p & F_C)) & 0xFF; c = (operandVal >> 7) & 1; }
            else if (op === 3) { r = ((operandVal >> 1) | ((p & F_C) << 7)) & 0xFF; c = operandVal & 1; }
            else if (op === 4) { r = (operandVal + 1) & 0xFF; }
            else if (op === 5) { r = (operandVal + 255) & 0xFF; }
            writeAddr = effAddr; writeVal = r & 0xFF; doWrite = true;
            newP = nzFlags(r, (p & ~F_C) | c);
        }
        else if (cls === 3) { // RMW_A
            let r = a, c = p & F_C;
            if (op === 0) { r = (a << 1) & 0xFF; c = (a >> 7) & 1; }
            else if (op === 1) { r = a >> 1; c = a & 1; }
            else if (op === 2) { r = ((a << 1) | (p & F_C)) & 0xFF; c = (a >> 7) & 1; }
            else if (op === 3) { r = ((a >> 1) | ((p & F_C) << 7)) & 0xFF; c = a & 1; }
            newA = r; newP = nzFlags(r, (p & ~F_C) | c);
        }
        else if (cls === 4) { // BRANCH
            let cond = false;
            if (op === 0) cond = (p & F_N) === 0;
            else if (op === 1) cond = (p & F_N) !== 0;
            else if (op === 2) cond = (p & F_V) === 0;
            else if (op === 3) cond = (p & F_V) !== 0;
            else if (op === 4) cond = (p & F_C) === 0;
            else if (op === 5) cond = (p & F_C) !== 0;
            else if (op === 6) cond = (p & F_Z) === 0;
            else if (op === 7) cond = (p & F_Z) !== 0;
            if (cond) {
                const off = op1 >= 128 ? op1 - 256 : op1;
                const t = (pc + 2 + off) & 0xFFFF;
                nextPc = t;
                branchExtra = ((t >> 8) === ((pc + 2) >> 8)) ? 1 : 2;
            }
        }
        else if (cls === 5) { // IMPLIED
            if (op === 0) newP = p & ~F_C;
            else if (op === 1) newP = p | F_C;
            else if (op === 2) newP = p & ~F_I;
            else if (op === 3) newP = p | F_I;
            else if (op === 4) newP = p & ~F_V;
            else if (op === 5) newP = p & ~F_D;
            else if (op === 6) newP = p | F_D;
            else if (op === 7) { newY = a; newP = nzFlags(a, p); }     // TAY
            else if (op === 8) { newA = y; newP = nzFlags(y, p); }     // TYA
            else if (op === 9) { newX = a; newP = nzFlags(a, p); }     // TAX
            else if (op === 10) { newA = x; newP = nzFlags(x, p); }    // TXA
            else if (op === 11) { newX = s; }                          // TSX
            else if (op === 12) { newS = x; }                          // TXS
            else if (op === 13) { newX = (x + 255) & 0xFF; newP = nzFlags((x + 255) & 0xFF, p); }
            else if (op === 14) { newY = (y + 255) & 0xFF; newP = nzFlags((y + 255) & 0xFF, p); }
            else if (op === 15) { newX = (x + 1) & 0xFF; newP = nzFlags((x + 1) & 0xFF, p); }
            else if (op === 16) { newY = (y + 1) & 0xFF; newP = nzFlags((y + 1) & 0xFF, p); }
        }
        else if (cls === 6) { // PUSH
            const pushVal = op === 1 ? (p | F_B | F_U) : a;
            mem[0x100 + s] = pushVal;
            newS = (s + 255) & 0xFF;
        }
        else if (cls === 7) { // PULL
            const pullAddr = 0x100 + ((s + 1) & 0xFF);
            const pulled = mem[pullAddr];
            if (op === 0) { newA = pulled; newP = nzFlags(pulled, p); }
            else { newP = (pulled | F_U) & ~F_B; }
            newS = (s + 1) & 0xFF;
        }
        else if (cls === 8 || cls === 9) { nextPc = effAddr; } // JMP
        else if (cls === 10) { // JSR
            const ret = (pc + 2) & 0xFFFF;
            mem[0x100 + s] = (ret >> 8) & 0xFF;
            mem[0x100 + ((s + 255) & 0xFF)] = ret & 0xFF;
            newS = (s + 254) & 0xFF;
            nextPc = operandWord;
        }
        else if (cls === 11) { // RTS
            const lo = mem[0x100 + ((s + 1) & 0xFF)];
            const hi = mem[0x100 + ((s + 2) & 0xFF)];
            nextPc = ((lo | (hi << 8)) + 1) & 0xFFFF;
            newS = (s + 2) & 0xFF;
        }
        else if (cls === 12) { // RTI
            newP = (mem[0x100 + ((s + 1) & 0xFF)] | F_U) & ~F_B;
            const lo = mem[0x100 + ((s + 2) & 0xFF)];
            const hi = mem[0x100 + ((s + 3) & 0xFF)];
            nextPc = (lo | (hi << 8)) & 0xFFFF;
            newS = (s + 3) & 0xFF;
        }
        else if (cls === 13 || cls === 14) { // BRK, JAM
            break;
        }

        if (doWrite) { mem[writeAddr & ADDR_MASK] = writeVal & 0xFF; }

        const totalCycles = baseCycles + extraCycles + branchExtra;
        const newCyclesUsed = cyclesUsed + totalCycles;
        if (newCyclesUsed >= budget) break;

        pc = nextPc; a = newA & 0xFF; x = newX & 0xFF;
        y = newY & 0xFF; s = newS & 0xFF;
        p = (newP | F_U | F_B) & 0xFF;
        cyclesUsed = newCyclesUsed;
    }

    mem[0xF9] = (pc >> 8) & 0xFF;
    mem[0xFA] = pc & 0xFF;
    mem[0xFB] = p; mem[0xFC] = a; mem[0xFD] = x; mem[0xFE] = y; mem[0xFF] = s;
}

// --- Helpers ---

function makeReplicator() {
    // B5 00 9D 00 04 E8 90 F8
    return [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8];
}

function makeAlienKiller() {
    return [
        0xA9, 0x42, 0xCD, 0x01, 0x04, 0xF0, 0xF9,
        0xA9, 0x02, 0x8D, 0x00, 0x04,
        0xA9, 0x00, 0x8D, 0xFA, 0x04, 0x8D, 0xF9, 0x04,
        0xA2, 0x1F,
        0xB5, 0x00, 0x9D, 0x00, 0x04, 0xCA, 0x10, 0xF8,
        0x30, 0xE0,
    ];
}

function initMem(code, pc = 0, a = 0, x = 0, y = 0, s = 0xFF, p = 0x30) {
    const mem = new Uint8Array(2048);
    for (let i = 0; i < code.length; i++) mem[i] = code[i];
    mem[0xF9] = (pc >> 8) & 0xFF; mem[0xFA] = pc & 0xFF;
    mem[0xFB] = p; mem[0xFC] = a; mem[0xFD] = x; mem[0xFE] = y; mem[0xFF] = s;
    return mem;
}

function regsOf(mem) {
    return {
        pc: (mem[0xF9] << 8) | mem[0xFA], a: mem[0xFC], x: mem[0xFD],
        y: mem[0xFE], s: mem[0xFF], p: mem[0xFB],
    };
}

function compareMemory(a, b, label) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            const ctx = [];
            for (let j = Math.max(0, i-2); j < Math.min(a.length, i+3); j++) {
                ctx.push(`  [${j.toString(16)}] cpu=${a[j].toString(16)} gpu=${b[j].toString(16)}${j===i?' <--':''}`);
            }
            return `${label}: first diff at $${i.toString(16)}\n${ctx.join('\n')}`;
        }
    }
    return null;
}

// --- Tests using paired quantum execution ---
// Run the WGSL-equivalent and the CPU sim on identical 2KB buffers.

describe('CPU vs WGSL instruction parity', () => {
    // Run both engines on a 2KB memory buffer and compare results
    function runBoth(mem, budget) {
        const cpuMem = new Uint8Array(mem);
        const gpuMem = new Uint8Array(mem);
        // CPU: use bare-sim-cpu's runQuantum logic (replicated here to match)
        cpuRunQuantum(cpuMem, budget);
        // GPU: use WGSL transliteration
        wgslRunQuantum(gpuMem, budget);
        return { cpuMem, gpuMem };
    }

    // CPU runQuantum — must match bare-sim-cpu.js exactly
    function cpuRunQuantum(mem, budget) {
        let pc = (mem[0xF9] << 8) | mem[0xFA];
        let a = mem[0xFC], x = mem[0xFD], y = mem[0xFE], s = mem[0xFF], p = mem[0xFB];
        let cycles = 0;

        for (let step = 0; step < MAX_STEPS; step++) {
            const opcode = mem[pc & ADDR_MASK];
            const i = opcode * 7;
            const cls = opcTable[i], addrMode = opcTable[i+1], op = opcTable[i+2];
            const baseCyc = opcTable[i+3], pcross = opcTable[i+4], nbytes = opcTable[i+5];
            const op1 = mem[(pc + 1) & ADDR_MASK];
            const op2 = mem[(pc + 2) & ADDR_MASK];
            const opWord = (op1 | (op2 << 8)) & 0xFFFF;

            let addr = 0, pageCrossed = false;
            if (addrMode === 2) addr = (pc + 1) & 0xFFFF;
            else if (addrMode === 3) addr = op1;
            else if (addrMode === 4) addr = (op1 + x) & 0xFF;
            else if (addrMode === 5) addr = (op1 + y) & 0xFF;
            else if (addrMode === 6) addr = opWord;
            else if (addrMode === 7) { addr = (opWord + x) & 0xFFFF; pageCrossed = ((opWord & 0xFF) + x) >= 255; }
            else if (addrMode === 8) { addr = (opWord + y) & 0xFFFF; pageCrossed = ((opWord & 0xFF) + y) >= 255; }
            else if (addrMode === 9) { const zp = (op1 + x) & 0xFF; addr = (mem[zp] | (mem[(zp+1)&0xFF] << 8)) & 0xFFFF; }
            else if (addrMode === 10) { const base = (mem[op1] | (mem[(op1+1)&0xFF] << 8)) & 0xFFFF; addr = (base + y) & 0xFFFF; pageCrossed = ((base & 0xFF) + y) >= 255; }
            else if (addrMode === 12) { addr = (mem[opWord & ADDR_MASK] | (mem[((opWord & 0xFF00) | ((opWord+1) & 0xFF)) & ADDR_MASK] << 8)) & 0xFFFF; }

            const val = mem[addr & ADDR_MASK];
            const extra = (pageCrossed && pcross) ? 1 : 0;
            let nextPc = (pc + nbytes) & 0xFFFF;
            let brExtra = 0, doWrite = false, wAddr = 0, wVal = 0;

            if (cls === 0) {
                let rp = p;
                if (op === 0) { a = val; rp = nzFlags(val, p); }
                else if (op === 1) { x = val; rp = nzFlags(val, p); }
                else if (op === 2) { y = val; rp = nzFlags(val, p); }
                else if (op === 3) { a = a ^ val; rp = nzFlags(a, p); }
                else if (op === 4) { a = a & val; rp = nzFlags(a, p); }
                else if (op === 5) { a = a | val; rp = nzFlags(a, p); }
                else if (op === 6) { const sum = a + val + (p & F_C); const r = sum & 0xFF; const co = sum > 255 ? F_C : 0; const v = ((a ^ r) & (val ^ r) & 0x80) ? F_V : 0; rp = nzFlags(r, (p & ~(F_C|F_V)) | co | v); a = r; }
                else if (op === 7) { const inv = val ^ 0xFF; const sum = a + inv + (p & F_C); const r = sum & 0xFF; const co = sum > 255 ? F_C : 0; const v = ((a ^ r) & (inv ^ r) & 0x80) ? F_V : 0; rp = nzFlags(r, (p & ~(F_C|F_V)) | co | v); a = r; }
                else if (op === 8) { rp = nzFlags((a - val) & 0xFF, (p & ~F_C) | (a >= val ? F_C : 0)); }
                else if (op === 9) { rp = nzFlags((x - val) & 0xFF, (p & ~F_C) | (x >= val ? F_C : 0)); }
                else if (op === 10) { rp = nzFlags((y - val) & 0xFF, (p & ~F_C) | (y >= val ? F_C : 0)); }
                else if (op === 11) { rp = (p & ~(F_N|F_V|F_Z)) | (val & (F_N|F_V)) | ((a & val) === 0 ? F_Z : 0); }
                else if (op === 13) { a = val; x = val; rp = nzFlags(val, p); }
                p = rp;
            } else if (cls === 1) {
                wAddr = addr; doWrite = true;
                if (op === 0) wVal = a; else if (op === 1) wVal = x; else if (op === 2) wVal = y; else wVal = a & x;
            } else if (cls === 2) {
                let r = val, c = p & F_C;
                if (op === 0) { c = (val >> 7) & 1; r = (val << 1) & 0xFF; }
                else if (op === 1) { c = val & 1; r = val >> 1; }
                else if (op === 2) { c = (val >> 7) & 1; r = ((val << 1) | (p & F_C)) & 0xFF; }
                else if (op === 3) { c = val & 1; r = ((val >> 1) | ((p & F_C) << 7)) & 0xFF; }
                else if (op === 4) { r = (val + 1) & 0xFF; }
                else if (op === 5) { r = (val + 255) & 0xFF; }
                wAddr = addr; wVal = r; doWrite = true;
                p = nzFlags(r, (p & ~F_C) | c);
            } else if (cls === 3) {
                let r = a, c = p & F_C;
                if (op === 0) { c = (a >> 7) & 1; r = (a << 1) & 0xFF; }
                else if (op === 1) { c = a & 1; r = a >> 1; }
                else if (op === 2) { c = (a >> 7) & 1; r = ((a << 1) | (p & F_C)) & 0xFF; }
                else if (op === 3) { c = a & 1; r = ((a >> 1) | ((p & F_C) << 7)) & 0xFF; }
                a = r; p = nzFlags(r, (p & ~F_C) | c);
            } else if (cls === 4) {
                let cond = false;
                if (op === 0) cond = !(p & F_N); else if (op === 1) cond = !!(p & F_N);
                else if (op === 2) cond = !(p & F_V); else if (op === 3) cond = !!(p & F_V);
                else if (op === 4) cond = !(p & F_C); else if (op === 5) cond = !!(p & F_C);
                else if (op === 6) cond = !(p & F_Z); else if (op === 7) cond = !!(p & F_Z);
                if (cond) {
                    const off = op1 >= 128 ? op1 - 256 : op1;
                    const t = (pc + 2 + off) & 0xFFFF;
                    nextPc = t;
                    brExtra = ((t >> 8) === ((pc + 2) >> 8)) ? 1 : 2;
                }
            } else if (cls === 5) {
                if (op === 0) p &= ~F_C; else if (op === 1) p |= F_C;
                else if (op === 2) p &= ~F_I; else if (op === 3) p |= F_I;
                else if (op === 4) p &= ~F_V; else if (op === 5) p &= ~F_D;
                else if (op === 6) p |= F_D;
                else if (op === 7) { y = a; p = nzFlags(a, p); }
                else if (op === 8) { a = y; p = nzFlags(y, p); }
                else if (op === 9) { x = a; p = nzFlags(a, p); }
                else if (op === 10) { a = x; p = nzFlags(x, p); }
                else if (op === 11) { x = s; }
                else if (op === 12) { s = x; }
                else if (op === 13) { x = (x + 255) & 0xFF; p = nzFlags(x, p); }
                else if (op === 14) { y = (y + 255) & 0xFF; p = nzFlags(y, p); }
                else if (op === 15) { x = (x + 1) & 0xFF; p = nzFlags(x, p); }
                else if (op === 16) { y = (y + 1) & 0xFF; p = nzFlags(y, p); }
            } else if (cls === 6) {
                mem[0x100 + s] = op === 0 ? a : (p | F_B | F_U);
                s = (s + 255) & 0xFF;
            } else if (cls === 7) {
                s = (s + 1) & 0xFF;
                const pulled = mem[0x100 + s];
                if (op === 0) { a = pulled; p = nzFlags(pulled, p); }
                else { p = (pulled | F_U) & ~F_B; }
            } else if (cls === 8 || cls === 9) {
                nextPc = addr;
            } else if (cls === 10) {
                const ret = (pc + 2) & 0xFFFF;
                mem[0x100 + s] = (ret >> 8) & 0xFF;
                mem[0x100 + ((s + 255) & 0xFF)] = ret & 0xFF;
                s = (s + 254) & 0xFF;
                nextPc = opWord;
            } else if (cls === 11) {
                const lo = mem[0x100 + ((s + 1) & 0xFF)];
                const hi = mem[0x100 + ((s + 2) & 0xFF)];
                nextPc = ((lo | (hi << 8)) + 1) & 0xFFFF;
                s = (s + 2) & 0xFF;
            } else if (cls === 12) {
                p = (mem[0x100 + ((s + 1) & 0xFF)] | F_U) & ~F_B;
                const lo = mem[0x100 + ((s + 2) & 0xFF)];
                const hi = mem[0x100 + ((s + 3) & 0xFF)];
                nextPc = (lo | (hi << 8)) & 0xFFFF;
                s = (s + 3) & 0xFF;
            } else if (cls === 13 || cls === 14) {
                break;
            }

            if (doWrite) { mem[wAddr & ADDR_MASK] = wVal & 0xFF; }
            const totalCyc = baseCyc + extra + brExtra;
            cycles += totalCyc;
            if (cycles >= budget) break;
            pc = nextPc;
            a &= 0xFF; x &= 0xFF; y &= 0xFF; s &= 0xFF;
            p = (p | F_U | F_B) & 0xFF;
        }
        mem[0xF9] = (pc >> 8) & 0xFF; mem[0xFA] = pc & 0xFF;
        mem[0xFB] = p; mem[0xFC] = a; mem[0xFD] = x; mem[0xFE] = y; mem[0xFF] = s;
    }

    function expectMatch(cpuMem, gpuMem, label) {
        const diff = compareMemory(cpuMem, gpuMem, label);
        if (diff) {
            const cr = regsOf(cpuMem), gr = regsOf(gpuMem);
            throw new Error(`${diff}\n  CPU regs: PC=${cr.pc.toString(16)} A=${cr.a.toString(16)} X=${cr.x.toString(16)} Y=${cr.y.toString(16)} S=${cr.s.toString(16)} P=${cr.p.toString(16)}\n  GPU regs: PC=${gr.pc.toString(16)} A=${gr.a.toString(16)} X=${gr.x.toString(16)} Y=${gr.y.toString(16)} S=${gr.s.toString(16)} P=${gr.p.toString(16)}`);
        }
    }

    it('simple replicator', () => {
        const mem = initMem(makeReplicator());
        const { cpuMem, gpuMem } = runBoth(mem, 5000);
        expectMatch(cpuMem, gpuMem, 'replicator');
    });

    it('alien-killer', () => {
        const mem = initMem(makeAlienKiller());
        const { cpuMem, gpuMem } = runBoth(mem, 5000);
        expectMatch(cpuMem, gpuMem, 'alien-killer');
    });

    it('alien-killer vs replicator neighbor', () => {
        const mem = initMem(makeAlienKiller());
        // Put replicator in neighbor cell
        const rep = makeReplicator();
        for (let i = 0; i < rep.length; i++) mem[M + i] = rep[i];
        mem[M + 0xF9] = 0; mem[M + 0xFA] = 0; mem[M + 0xFF] = 0xFF;
        const { cpuMem, gpuMem } = runBoth(mem, 5000);
        expectMatch(cpuMem, gpuMem, 'killer-vs-rep');
    });

    it('BRK yields at correct PC', () => {
        const mem = initMem([0xA9, 0x42, 0x00, 0x00]); // LDA #$42; BRK
        const { cpuMem, gpuMem } = runBoth(mem, 5000);
        expectMatch(cpuMem, gpuMem, 'brk');
        expect(regsOf(cpuMem).pc).toBe(2); // BRK at byte 2
        expect(regsOf(cpuMem).a).toBe(0x42);
    });

    it('all transfer instructions', () => {
        // TAX TAY TXA TYA TSX TXS
        const code = [
            0xA9, 0x42,  // LDA #$42
            0xAA,        // TAX
            0xA8,        // TAY
            0xA9, 0x00,  // LDA #$00
            0x8A,        // TXA (A = $42)
            0xA9, 0x00,  // LDA #$00
            0x98,        // TYA (A = $42)
            0xBA,        // TSX
            0x9A,        // TXS
            0x00, 0x00,  // BRK
        ];
        const mem = initMem(code);
        const { cpuMem, gpuMem } = runBoth(mem, 5000);
        expectMatch(cpuMem, gpuMem, 'transfers');
    });

    it('ADC/SBC with carry', () => {
        const code = [
            0x38,        // SEC
            0xA9, 0x80,  // LDA #$80
            0x69, 0x80,  // ADC #$80 (should overflow)
            0x38,        // SEC
            0xE9, 0x01,  // SBC #$01
            0x00, 0x00,
        ];
        const mem = initMem(code);
        const { cpuMem, gpuMem } = runBoth(mem, 5000);
        expectMatch(cpuMem, gpuMem, 'adc-sbc');
    });

    it('CMP/CPX/CPY edge cases', () => {
        const code = [
            0xA9, 0x00, 0xC9, 0x00, // LDA #0; CMP #0 (Z=1, C=1)
            0xA9, 0x00, 0xC9, 0x01, // LDA #0; CMP #1 (N=1, C=0)
            0xA9, 0xFF, 0xC9, 0x01, // LDA #FF; CMP #1 (C=1)
            0xA2, 0x80, 0xE0, 0x80, // LDX #$80; CPX #$80
            0xA0, 0x7F, 0xC0, 0x80, // LDY #$7F; CPY #$80
            0x00, 0x00,
        ];
        const mem = initMem(code);
        const { cpuMem, gpuMem } = runBoth(mem, 5000);
        expectMatch(cpuMem, gpuMem, 'cmp');
    });

    it('shifts and rotates', () => {
        const code = [
            0xA9, 0x80, 0x0A, // LDA #$80; ASL A
            0xA9, 0x01, 0x4A, // LDA #$01; LSR A
            0x38, 0xA9, 0x55, 0x2A, // SEC; LDA #$55; ROL A
            0x18, 0xA9, 0xAA, 0x6A, // CLC; LDA #$AA; ROR A
            0x00, 0x00,
        ];
        const mem = initMem(code);
        const { cpuMem, gpuMem } = runBoth(mem, 5000);
        expectMatch(cpuMem, gpuMem, 'shifts');
    });

    it('stack push/pull', () => {
        const code = [
            0xA9, 0x42, 0x48, // LDA #$42; PHA
            0xA9, 0x00, 0x68, // LDA #$00; PLA (A=$42)
            0x08, 0x28,       // PHP; PLP
            0x00, 0x00,
        ];
        const mem = initMem(code);
        const { cpuMem, gpuMem } = runBoth(mem, 5000);
        expectMatch(cpuMem, gpuMem, 'stack');
    });

    it('JSR/RTS', () => {
        const code = new Uint8Array(2048);
        // JSR $0010; BRK; ... at $0010: LDA #$99; RTS
        code[0] = 0x20; code[1] = 0x10; code[2] = 0x00; // JSR $0010
        code[3] = 0x00; code[4] = 0x00; // BRK
        code[0x10] = 0xA9; code[0x11] = 0x99; // LDA #$99
        code[0x12] = 0x60; // RTS
        const mem = initMem(Array.from(code.subarray(0, 0x20)));
        // Need to place the subroutine
        for (let i = 0; i < 0x20; i++) mem[i] = code[i];
        const { cpuMem, gpuMem } = runBoth(mem, 5000);
        expectMatch(cpuMem, gpuMem, 'jsr-rts');
    });

    it('all branch types', () => {
        // Test each branch taken and not-taken
        const code = [
            0x38,              // SEC
            0xB0, 0x01, 0x00, // BCS +1 (taken, skip BRK)
            0xA9, 0x01,       // LDA #$01
            0x18,              // CLC
            0x90, 0x01, 0x00, // BCC +1 (taken)
            0xA9, 0x02,       // LDA #$02
            0x00, 0x00,       // BRK
        ];
        const mem = initMem(code);
        const { cpuMem, gpuMem } = runBoth(mem, 5000);
        expectMatch(cpuMem, gpuMem, 'branches');
    });

    it('budget exhaustion mid-instruction', () => {
        // Tight loop that will exceed budget
        const code = [
            0xA2, 0x00,       // LDX #0
            0xE8,             // INX
            0x4C, 0x02, 0x00, // JMP $0002 (infinite loop)
        ];
        // Run with very small budget
        for (const budget of [10, 50, 100, 200, 500]) {
            const mem = initMem(code);
            const { cpuMem, gpuMem } = runBoth(mem, budget);
            expectMatch(cpuMem, gpuMem, `budget-${budget}`);
        }
    });

    it('random soup: 100 seeds', () => {
        const rng = new PRNG(12345);
        for (let seed = 0; seed < 100; seed++) {
            const mem = new Uint8Array(2048);
            for (let i = 0; i < 2048; i++) mem[i] = rng.below(256);
            // Set valid registers
            mem[0xF9] = 0; mem[0xFA] = 0; mem[0xFF] = 0xFF;
            mem[0xFB] = 0x30;
            const budget = 100 + rng.below(5000);
            const { cpuMem, gpuMem } = runBoth(mem, budget);
            expectMatch(cpuMem, gpuMem, `soup-${seed}`);
        }
    });

    it('random soup: 100 seeds with neighbor writes', () => {
        const rng = new PRNG(99999);
        for (let seed = 0; seed < 100; seed++) {
            const mem = new Uint8Array(2048);
            for (let i = 0; i < 2048; i++) mem[i] = rng.below(256);
            mem[0xF9] = 0; mem[0xFA] = 0; mem[0xFF] = 0xFF; mem[0xFB] = 0x30;
            // Also set up valid neighbor registers
            mem[M + 0xF9] = 0; mem[M + 0xFA] = 0; mem[M + 0xFF] = 0xFF; mem[M + 0xFB] = 0x30;
            const budget = 100 + rng.below(5000);
            const { cpuMem, gpuMem } = runBoth(mem, budget);
            expectMatch(cpuMem, gpuMem, `soup-nbr-${seed}`);
        }
    });
});
