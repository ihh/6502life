/**
 * CPU fallback bare sim — same API as the WebGPU BareSim.
 * Pure JavaScript 6502 interpreter for non-GPU machines.
 */

import { buildOpcodeTable } from './opcode_table.js';

const ADDR_MASK = 0x7FF;
const MAX_STEPS = 350;
const F_C = 0x01, F_Z = 0x02, F_I = 0x04, F_D = 0x08;
const F_B = 0x10, F_U = 0x20, F_V = 0x40, F_N = 0x80;

const opcTable = buildOpcodeTable();

function nzFlags(val, p) {
    const z = (val & 0xFF) === 0 ? F_Z : 0;
    return (p & ~(F_N | F_Z)) | (val & F_N) | z;
}

function runQuantum(mem, budget, hasRegisterSave = true, writeLog = null, fetchLog = null) {
    let pc, a, x, y, s, p;
    if (hasRegisterSave) {
        pc = (mem[0xF9] << 8) | mem[0xFA];
        a = mem[0xFC]; x = mem[0xFD]; y = mem[0xFE]; s = mem[0xFF]; p = mem[0xFB];
    } else {
        pc = 0; a = 0; x = 0; y = 0; s = 0xFF; p = 0x30;
    }
    let cycles = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
        if (fetchLog) fetchLog[pc & ADDR_MASK]++;
        const opcode = mem[pc & ADDR_MASK];
        const i = opcode * 7;
        const cls = opcTable[i], addrMode = opcTable[i+1], op = opcTable[i+2];
        const baseCyc = opcTable[i+3], pcross = opcTable[i+4], nbytes = opcTable[i+5];

        const op1 = mem[(pc + 1) & ADDR_MASK];
        const op2 = mem[(pc + 2) & ADDR_MASK];
        const opWord = (op1 | (op2 << 8)) & 0xFFFF;

        // Resolve address
        let addr = 0, pageCrossed = false;
        switch (addrMode) {
            case 2: addr = (pc + 1) & 0xFFFF; break; // IMM
            case 3: addr = op1; break; // ZPG
            case 4: addr = (op1 + x) & 0xFF; break; // ZPX
            case 5: addr = (op1 + y) & 0xFF; break; // ZPY
            case 6: addr = opWord; break; // ABS
            case 7: addr = (opWord + x) & 0xFFFF; pageCrossed = ((opWord & 0xFF) + x) >= 255; break;
            case 8: addr = (opWord + y) & 0xFFFF; pageCrossed = ((opWord & 0xFF) + y) >= 255; break;
            case 9: { const zp = (op1 + x) & 0xFF; addr = (mem[zp] | (mem[(zp+1)&0xFF] << 8)) & 0xFFFF; break; }
            case 10: { const base = (mem[op1] | (mem[(op1+1)&0xFF] << 8)) & 0xFFFF; addr = (base + y) & 0xFFFF; pageCrossed = ((base & 0xFF) + y) >= 255; break; }
            case 12: { addr = (mem[opWord & ADDR_MASK] | (mem[((opWord & 0xFF00) | ((opWord+1) & 0xFF)) & ADDR_MASK] << 8)) & 0xFFFF; break; }
        }
        const val = mem[addr & ADDR_MASK];
        const extra = (pageCrossed && pcross) ? 1 : 0;
        let nextPc = (pc + nbytes) & 0xFFFF;
        let brExtra = 0, doWrite = false, wAddr = 0, wVal = 0;

        if (cls === 0) { // READ
            let rp = p;
            if (op === 0) { a = val; rp = nzFlags(val, p); }
            else if (op === 1) { x = val; rp = nzFlags(val, p); }
            else if (op === 2) { y = val; rp = nzFlags(val, p); }
            else if (op === 3) { a = a ^ val; rp = nzFlags(a, p); }
            else if (op === 4) { a = a & val; rp = nzFlags(a, p); }
            else if (op === 5) { a = a | val; rp = nzFlags(a, p); }
            else if (op === 6) { const sum = a + val + (p & F_C); a = sum & 0xFF; const co = sum > 255 ? F_C : 0; const v = ((a ^ (sum&0xFF)) & (val ^ (sum&0xFF)) & 0x80) ? F_V : 0; rp = nzFlags(sum & 0xFF, (p & ~(F_C|F_V)) | co | v); a = sum & 0xFF; }
            else if (op === 7) { const inv = val ^ 0xFF; const sum = a + inv + (p & F_C); const r = sum & 0xFF; const co = sum > 255 ? F_C : 0; const v = ((a ^ r) & (inv ^ r) & 0x80) ? F_V : 0; rp = nzFlags(r, (p & ~(F_C|F_V)) | co | v); a = r; }
            else if (op === 8) { rp = nzFlags((a - val) & 0xFF, (p & ~F_C) | (a >= val ? F_C : 0)); }
            else if (op === 9) { rp = nzFlags((x - val) & 0xFF, (p & ~F_C) | (x >= val ? F_C : 0)); }
            else if (op === 10) { rp = nzFlags((y - val) & 0xFF, (p & ~F_C) | (y >= val ? F_C : 0)); }
            else if (op === 11) { rp = (p & ~(F_N|F_V|F_Z)) | (val & (F_N|F_V)) | ((a & val) === 0 ? F_Z : 0); }
            else if (op === 13) { a = val; x = val; rp = nzFlags(val, p); }
            p = rp;
        } else if (cls === 1) { // STORE
            wAddr = addr; doWrite = true;
            if (op === 0) wVal = a; else if (op === 1) wVal = x; else if (op === 2) wVal = y; else wVal = a & x;
        } else if (cls === 2) { // RMW
            let r = val, c = p & F_C;
            if (op === 0) { c = (val >> 7) & 1; r = (val << 1) & 0xFF; }
            else if (op === 1) { c = val & 1; r = val >> 1; }
            else if (op === 2) { c = (val >> 7) & 1; r = ((val << 1) | (p & F_C)) & 0xFF; }
            else if (op === 3) { c = val & 1; r = ((val >> 1) | ((p & F_C) << 7)) & 0xFF; }
            else if (op === 4) { r = (val + 1) & 0xFF; }
            else if (op === 5) { r = (val + 255) & 0xFF; }
            wAddr = addr; wVal = r; doWrite = true;
            p = nzFlags(r, (p & ~F_C) | c);
        } else if (cls === 3) { // RMW_A
            let r = a, c = p & F_C;
            if (op === 0) { c = (a >> 7) & 1; r = (a << 1) & 0xFF; }
            else if (op === 1) { c = a & 1; r = a >> 1; }
            else if (op === 2) { c = (a >> 7) & 1; r = ((a << 1) | (p & F_C)) & 0xFF; }
            else if (op === 3) { c = a & 1; r = ((a >> 1) | ((p & F_C) << 7)) & 0xFF; }
            a = r; p = nzFlags(r, (p & ~F_C) | c);
        } else if (cls === 4) { // BRANCH
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
        } else if (cls === 5) { // IMPLIED
            if (op === 0) p &= ~F_C; else if (op === 1) p |= F_C;
            else if (op === 2) p &= ~F_I; else if (op === 3) p |= F_I;
            else if (op === 4) p &= ~F_V; else if (op === 5) p &= ~F_D;
            else if (op === 6) p |= F_D;
            else if (op === 7) { y = a; p = nzFlags(a, p); }
            else if (op === 8) { a = y; p = nzFlags(y, p); }
            else if (op === 9) { x = a; p = nzFlags(a, p); }
            else if (op === 10) { a = x; p = nzFlags(x, p); }
            else if (op === 11) { x = s; } // TSX no flags
            else if (op === 12) { s = x; }
            else if (op === 13) { x = (x + 255) & 0xFF; p = nzFlags(x, p); }
            else if (op === 14) { y = (y + 255) & 0xFF; p = nzFlags(y, p); }
            else if (op === 15) { x = (x + 1) & 0xFF; p = nzFlags(x, p); }
            else if (op === 16) { y = (y + 1) & 0xFF; p = nzFlags(y, p); }
        } else if (cls === 6) { // PUSH
            mem[0x100 + s] = op === 0 ? a : (p | F_B | F_U);
            s = (s + 255) & 0xFF;
        } else if (cls === 7) { // PULL
            s = (s + 1) & 0xFF;
            const pulled = mem[0x100 + s];
            if (op === 0) { a = pulled; p = nzFlags(pulled, p); }
            else { p = (pulled | F_U) & ~F_B; }
        } else if (cls === 8 || cls === 9) { // JMP
            nextPc = addr;
        } else if (cls === 10) { // JSR
            const ret = (pc + 2) & 0xFFFF;
            mem[0x100 + s] = (ret >> 8) & 0xFF;
            mem[0x100 + ((s + 255) & 0xFF)] = ret & 0xFF;
            s = (s + 254) & 0xFF;
            nextPc = opWord;
        } else if (cls === 11) { // RTS
            const lo = mem[0x100 + ((s + 1) & 0xFF)];
            const hi = mem[0x100 + ((s + 2) & 0xFF)];
            nextPc = ((lo | (hi << 8)) + 1) & 0xFFFF;
            s = (s + 2) & 0xFF;
        } else if (cls === 12) { // RTI
            p = (mem[0x100 + ((s + 1) & 0xFF)] | F_U) & ~F_B;
            const lo = mem[0x100 + ((s + 2) & 0xFF)];
            const hi = mem[0x100 + ((s + 3) & 0xFF)];
            nextPc = (lo | (hi << 8)) & 0xFFFF;
            s = (s + 3) & 0xFF;
        } else if (cls === 13 || cls === 14) { // BRK, JAM
            break;
        }

        if (doWrite) {
            const wa = wAddr & ADDR_MASK;
            mem[wa] = wVal & 0xFF;
            if (writeLog) writeLog[wa]++;
        }

        const totalCyc = baseCyc + extra + brExtra;
        cycles += totalCyc;
        if (cycles >= budget) break;
        pc = nextPc;
        a &= 0xFF; x &= 0xFF; y &= 0xFF; s &= 0xFF;
        p = (p | F_U | F_B) & 0xFF;
    }

    // Save registers (only if enabled)
    if (hasRegisterSave) {
        mem[0xF9] = (pc >> 8) & 0xFF;
        mem[0xFA] = pc & 0xFF;
        mem[0xFB] = p; mem[0xFC] = a; mem[0xFD] = x; mem[0xFE] = y; mem[0xFF] = s;
    }
}

export class BareSimCPU {
    constructor(B = 16, M = 1024, opts = {}) {
        this.B = B;
        this.M = M;
        this.storage = new Uint8Array(B * B * M);
        this.totalQuanta = 0;
        this.hasRegisterSave = opts.hasRegisterSave !== false;
        // Per-byte activity tracking (quantum number of last write/fetch)
        this.lastWrite = new Uint32Array(B * B * M);
        this.lastFetch = new Uint32Array(B * B * M);
    }

    static async create(B = 16, opts = {}) {
        return new BareSimCPU(B, 1024, opts);
    }

    writeCell(i, j, offset, data) {
        const base = (i * this.B + j) * this.M + offset;
        for (let k = 0; k < data.length; k++) this.storage[base + k] = data[k];
    }

    async runPass() {
        const B = this.B, M = this.M, N = (B * B) / 2;
        const rv = Math.random() * 8 | 0;
        const tiling = rv & 1, offI = (rv >> 1) & 1, offJ = (rv >> 2) & 1;
        const mem = new Uint8Array(2048);

        const pairs = [];
        if (tiling === 0) {
            for (let k = 0; k < B / 2; k++)
                for (let j = 0; j < B; j++) {
                    const role = Math.random() < 0.5 ? 0 : 1;
                    const i0 = (2*k + offI) % B, i1 = (2*k+1 + offI) % B, jj = (j + offJ) % B;
                    pairs.push(role === 0 ? [i0,jj,i1,jj] : [i1,jj,i0,jj]);
                }
        } else {
            for (let i = 0; i < B; i++)
                for (let k = 0; k < B / 2; k++) {
                    const role = Math.random() < 0.5 ? 0 : 1;
                    const ii = (i + offI) % B, j0 = (2*k + offJ) % B, j1 = (2*k+1 + offJ) % B;
                    pairs.push(role === 0 ? [ii,j0,ii,j1] : [ii,j1,ii,j0]);
                }
        }

        // Temporary per-quantum activity logs (2KB address space)
        const writeLog = new Uint16Array(2048);
        const fetchLog = new Uint16Array(2048);

        for (const [ci, cj, ni, nj] of pairs) {
            const cb = (ci * B + cj) * M, nb = (ni * B + nj) * M;
            mem.set(this.storage.subarray(cb, cb + M), 0);
            mem.set(this.storage.subarray(nb, nb + M), M);

            let r = Math.random() * 0x7FFFFFFF | 0, hl = 0;
            while (hl < 32 && (r & 1)) { r >>= 1; hl++; }
            const budget = Math.max(1, Math.ceil(16 * 177 * (hl + Math.random())));

            writeLog.fill(0);
            fetchLog.fill(0);
            runQuantum(mem, budget, this.hasRegisterSave, writeLog, fetchLog);

            this.storage.set(mem.subarray(0, M), cb);
            this.storage.set(mem.subarray(M, 2 * M), nb);

            // Map local activity to board-level tracking (exponential decay + add)
            const decay = 0.99;
            for (let k = 0; k < M; k++) {
                this.lastWrite[cb + k] = this.lastWrite[cb + k] * decay + writeLog[k];
                this.lastFetch[cb + k] = this.lastFetch[cb + k] * decay + fetchLog[k];
                this.lastWrite[nb + k] = this.lastWrite[nb + k] * decay + writeLog[M + k];
                this.lastFetch[nb + k] = this.lastFetch[nb + k] * decay + fetchLog[M + k];
            }
        }
        this.totalQuanta += N;
    }

    async census() {
        const B = this.B, M = this.M;
        let functional = 0;
        const loopSigs = {}, cellMap = new Uint8Array(B * B);
        const cellChars = new Uint8Array(B * B);
        for (let ci = 0; ci < B * B; ci++) {
            const base = ci * M, c = this.storage;
            if (c[base] === 0xB5 && c[base+2] === 0x9D && c[base+3] === 0x00 &&
                c[base+4] === 0x04 && (c[base+5] === 0xE8 || c[base+5] === 0xCA) &&
                [0xD0,0x90,0x50,0x10,0x30,0xB0,0x70].includes(c[base+6])) {
                functional++;
                cellMap[ci] = 1;
                const sig = Array.from(c.slice(base, base+8)).map(b => b.toString(16).padStart(2,'0')).join('');
                loopSigs[sig] = (loopSigs[sig] || 0) + 1;
            }
            // Hash non-volatile: page 0 ($00-$EF), page 2 ($200-$2FF), page 3 ($300-$3FF)
            // Skip $F0-$FF (registers) and $100-$1FF (stack)
            let h = 5381;
            for (let k = 0; k < 0xF0; k++) h = ((h * 33) ^ c[base + k]) >>> 0;
            for (let k = 0x200; k < 0x400; k++) h = ((h * 33) ^ c[base + k]) >>> 0;
            cellChars[ci] = 33 + (h % 94); // ASCII 33-126
        }
        return {
            functional, total: B * B,
            loopVariants: Object.keys(loopSigs).length,
            topLoops: Object.entries(loopSigs).sort((a, b) => b[1] - a[1]).slice(0, 5),
            cellMap, cellChars,
        };
    }

    getCellView(i, j) {
        const base = (i * this.B + j) * this.M;
        return {
            data: this.storage.slice(base, base + this.M),
            writes: this.lastWrite.slice(base, base + this.M),
            fetches: this.lastFetch.slice(base, base + this.M),
        };
    }

    destroy() {}
}
