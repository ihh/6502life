import { BoardMemory } from './memory.js';

import { Sfotty } from '@sfotty-pie/sfotty';
import { VANILLA_OPCODES } from "@sfotty-pie/opcodes";

// Undocumented opcode classification table.
// Each entry: { type, bytes, cycles }
// type: 'stable' = faithful emulation, 'jam' = halt, 'nop' = no effect, 'unstable' = no effect
// For stable opcodes, the mnemonic and mode are also provided.
const UNDOCUMENTED_OPCODES = (() => {
    const table = {};

    // --- JAM/HLT opcodes (freeze the CPU) ---
    for (const opc of [0x02,0x12,0x22,0x32,0x42,0x52,0x62,0x72,0x92,0xB2,0xD2,0xF2]) {
        table[opc] = { type: 'jam', bytes: 1, cycles: 2 };
    }

    // --- Stable opcodes ---
    // LAX (LDA + LDX): load A and X from memory
    const laxModes = {
        0xA3: 'inx', 0xA7: 'zpg', 0xAB: 'imm', 0xAF: 'abs',
        0xB3: 'iny', 0xB7: 'zpy', 0xBF: 'aby'
    };
    for (const [opc, mode] of Object.entries(laxModes)) {
        table[parseInt(opc)] = { type: 'stable', mnemonic: 'LAX', mode };
    }

    // SAX (store A & X)
    const saxModes = { 0x83: 'inx', 0x87: 'zpg', 0x8F: 'abs', 0x97: 'zpy' };
    for (const [opc, mode] of Object.entries(saxModes)) {
        table[parseInt(opc)] = { type: 'stable', mnemonic: 'SAX', mode };
    }

    // DCP (DEC + CMP)
    const dcpModes = {
        0xC3: 'inx', 0xC7: 'zpg', 0xCF: 'abs', 0xD3: 'iny',
        0xD7: 'zpx', 0xDB: 'aby', 0xDF: 'abx'
    };
    for (const [opc, mode] of Object.entries(dcpModes)) {
        table[parseInt(opc)] = { type: 'stable', mnemonic: 'DCP', mode };
    }

    // ISC/ISB (INC + SBC)
    const iscModes = {
        0xE3: 'inx', 0xE7: 'zpg', 0xEF: 'abs', 0xF3: 'iny',
        0xF7: 'zpx', 0xFB: 'aby', 0xFF: 'abx'
    };
    for (const [opc, mode] of Object.entries(iscModes)) {
        table[parseInt(opc)] = { type: 'stable', mnemonic: 'ISC', mode };
    }

    // SLO (ASL + ORA)
    const sloModes = {
        0x03: 'inx', 0x07: 'zpg', 0x0F: 'abs', 0x13: 'iny',
        0x17: 'zpx', 0x1B: 'aby', 0x1F: 'abx'
    };
    for (const [opc, mode] of Object.entries(sloModes)) {
        table[parseInt(opc)] = { type: 'stable', mnemonic: 'SLO', mode };
    }

    // RLA (ROL + AND)
    const rlaModes = {
        0x23: 'inx', 0x27: 'zpg', 0x2F: 'abs', 0x33: 'iny',
        0x37: 'zpx', 0x3B: 'aby', 0x3F: 'abx'
    };
    for (const [opc, mode] of Object.entries(rlaModes)) {
        table[parseInt(opc)] = { type: 'stable', mnemonic: 'RLA', mode };
    }

    // SRE (LSR + EOR)
    const sreModes = {
        0x43: 'inx', 0x47: 'zpg', 0x4F: 'abs', 0x53: 'iny',
        0x57: 'zpx', 0x5B: 'aby', 0x5F: 'abx'
    };
    for (const [opc, mode] of Object.entries(sreModes)) {
        table[parseInt(opc)] = { type: 'stable', mnemonic: 'SRE', mode };
    }

    // RRA (ROR + ADC)
    const rraModes = {
        0x63: 'inx', 0x67: 'zpg', 0x6F: 'abs', 0x73: 'iny',
        0x77: 'zpx', 0x7B: 'aby', 0x7F: 'abx'
    };
    for (const [opc, mode] of Object.entries(rraModes)) {
        table[parseInt(opc)] = { type: 'stable', mnemonic: 'RRA', mode };
    }

    // ANC (AND immediate, copy bit 7 to carry)
    table[0x0B] = { type: 'stable', mnemonic: 'ANC', mode: 'imm' };
    table[0x2B] = { type: 'stable', mnemonic: 'ANC', mode: 'imm' };

    // ALR/ASR (AND immediate, then LSR A)
    table[0x4B] = { type: 'stable', mnemonic: 'ALR', mode: 'imm' };

    // ARR (AND immediate, then ROR A with special flag handling)
    table[0x6B] = { type: 'stable', mnemonic: 'ARR', mode: 'imm' };

    // AXS/SBX (AND X with A, subtract immediate without borrow, store in X)
    table[0xCB] = { type: 'stable', mnemonic: 'AXS', mode: 'imm' };

    // Undocumented SBC immediate (duplicate of $E9)
    table[0xEB] = { type: 'stable', mnemonic: 'SBC', mode: 'imm' };

    // --- Unstable opcodes (NOP with correct byte/cycle count) ---
    // XAA/ANE
    table[0x8B] = { type: 'unstable', bytes: 2, cycles: 2 };
    // AHX/SHA
    table[0x93] = { type: 'unstable', bytes: 2, cycles: 6 };
    table[0x9F] = { type: 'unstable', bytes: 3, cycles: 5 };
    // TAS/SHS
    table[0x9B] = { type: 'unstable', bytes: 3, cycles: 5 };
    // SHY/SYA
    table[0x9C] = { type: 'unstable', bytes: 3, cycles: 5 };
    // SHX/SXA
    table[0x9E] = { type: 'unstable', bytes: 3, cycles: 5 };
    // LAS
    table[0xBB] = { type: 'unstable', bytes: 3, cycles: 4 };

    // --- Undocumented NOPs (various byte/cycle counts) ---
    // 1-byte, 2-cycle NOPs (implied)
    for (const opc of [0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA]) {
        table[opc] = { type: 'nop', bytes: 1, cycles: 2 };
    }
    // 2-byte, 2-cycle NOPs (immediate)
    for (const opc of [0x80, 0x82, 0x89, 0xC2, 0xE2]) {
        table[opc] = { type: 'nop', bytes: 2, cycles: 2 };
    }
    // 2-byte, 3-cycle NOPs (zero page)
    for (const opc of [0x04, 0x44, 0x64]) {
        table[opc] = { type: 'nop', bytes: 2, cycles: 3 };
    }
    // 2-byte, 4-cycle NOPs (zero page,X)
    for (const opc of [0x14, 0x34, 0x54, 0x74, 0xD4, 0xF4]) {
        table[opc] = { type: 'nop', bytes: 2, cycles: 4 };
    }
    // 3-byte, 4-cycle NOPs (absolute)
    table[0x0C] = { type: 'nop', bytes: 3, cycles: 4 };
    // 3-byte, 4-5 cycle NOPs (absolute,X — page cross adds 1 cycle)
    for (const opc of [0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC]) {
        table[opc] = { type: 'nop', bytes: 3, cycles: 4, pageCross: true };
    }

    return table;
})();

// board controller
class BoardController {
    constructor (memory, boardParams) {
        this.memory = memory || new BoardMemory();
        this.totalCycles = 0;
        this.lastMoveTime = this.newCellArray(()=>0);
        this.lastWriteTime = this.newCellArray(()=>0);
        this.lastWriteTimeForByte = this.newCellArray(()=>this.newCellByteArray(()=>0));
        // Per-cell halted state (JAM opcode freezes the cell)
        this.halted = this.newCellArray(() => false);
        // Per-cell lastWriter: wallet ID of the board that last wrote to this cell.
        // NOT in cell memory — programs cannot read or tamper with it.
        this.lastWriter = this.newCellArray(() => '');
        // Board owner wallet ID — callers set this to their wallet ID.
        this.boardOwner = '';
        // Board hyperparameters
        this.boardParams = Object.assign({
            pBitNoise: 1 / 2048,     // per-bit noise on BRK noisy copy
            pBrkFailure: 0,          // probability BRK copy/swap silently fails
            magnetosensing: false,   // write orientation to $FA if true
            implementsMove: true,    // BRK 1-244 swap operations
            implementsCopy: true,    // BRK 245-252 noisy copy
            implementsSync: false,   // BRK 253 sync interrupt request
            implementsAsync: false,  // BRK 254 async interrupt request
        }, boardParams);
        // Backward compatibility: accept noiseParams as alias for boardParams
        this.noiseParams = this.boardParams;
        // Per-cell requested interrupt time (for sync/async)
        this.nextRequestedInterrupt = this.newCellArray(() => Infinity);
        // Hook for BRK copy/swap events
        this.onBrkEvent = null;
        this.newSfotty();
        this.readRegisters();
        this.writeRng();
    }

    // Zero-page register store. Where the state of the processor is cached on interrupt
    get rngAddr() { return 0xFC }  // 0xFC..0xFF = random number generator
    get regAddrPCHI() { return 0xF9 }  // 0xF9 = PC(HI). Note this is one of the ten registers that rotate with cell orientation, so it can be used to execute code in neighboring cells in spite of the random rotation at each update.
    get regAddrPCLO() { return 0xFA }  // 0xFA = PC(LO)
    get regAddrP() { return 0xFB }  // 0xFB = P
    get regAddrA() { return 0xFC }  // 0xFC = A
    get regAddrX() { return 0xFD }  // 0xFD = X
    get regAddrY() { return 0xFE }  // 0xFE = Y
    get regAddrS() { return 0xFF }  // 0xFF = S

    get state() {
        return { memory: this.memory.state,
                 S: this.sfotty.S,
                 A: this.sfotty.A,
                 X: this.sfotty.X,
                 Y: this.sfotty.Y,
                 P: this.sfotty.P,
                 PC: this.sfotty.PC,
                 boardParams: Object.assign({}, this.boardParams),
                 totalCycles: this.totalCycles,
                 lastWriteTime: this.lastWriteTime,
                 lastMoveTime: this.lastMoveTime,
                 nextRequestedInterrupt: this.nextRequestedInterrupt,
                 halted: this.halted,
                 lastWriter: this.lastWriter,
                 boardOwner: this.boardOwner };
    }

    set state(s) {
        this.memory.state = s.memory;
        this.sfotty.S = s.S;
        this.sfotty.A = s.A;
        this.sfotty.X = s.X;
        this.sfotty.Y = s.Y;
        this.sfotty.P = s.P;
        this.sfotty.PC = s.PC;
        if (s.boardParams)
            Object.assign(this.boardParams, s.boardParams);
        else if (s.noiseParams)
            Object.assign(this.boardParams, s.noiseParams);
        if (s.totalCycles !== undefined)
            this.totalCycles = s.totalCycles;
        if (s.lastWriteTime)
            this.lastWriteTime = s.lastWriteTime;
        if (s.lastMoveTime)
            this.lastMoveTime = s.lastMoveTime;
        if (s.nextRequestedInterrupt)
            this.nextRequestedInterrupt = s.nextRequestedInterrupt;
        if (s.halted)
            this.halted = s.halted;
        if (s.lastWriter)
            this.lastWriter = s.lastWriter;
        if (s.boardOwner !== undefined)
            this.boardOwner = s.boardOwner;
    }

    newCellArray(initializer) {
        const B = this.memory.B;
        return Array.from({length:B*B}).map(initializer);
    }

    newCellByteArray(initializer) {
        const M = this.memory.M;
        return Array.from({length:M}).map(initializer);
    }

    newSfotty() {
        this.sfotty = new Sfotty(this.memory);
        // Disable Sfotty's reset sequence — the controller manages CPU state directly.
        this.sfotty.resetPending = false;
        this.sfotty._decodedBRK = false;
        this.sfotty._brkPC = 0;
        // Monkey-patch Sfotty to handle undocumented opcodes instead of crashing.
        // The original decode() checks this.opcodes[opcode] and sets crashed=true
        // if undefined. We intercept at that point and handle the opcode ourselves.
        const sfotty = this.sfotty;
        const origDecode = sfotty.decode.bind(sfotty);
        const controller = this;

        sfotty.decode = function() {
            if (sfotty.crashed) return;
            if (sfotty.resetPending) {
                // Let the original handle reset
                const saved = console.error;
                console.error = () => {};
                origDecode();
                console.error = saved;
                return;
            }
            if (sfotty.nmi) {
                const saved = console.error;
                console.error = () => {};
                origDecode();
                console.error = saved;
                return;
            }

            // Peek at the opcode to check if it's undocumented or BRK
            const opcode = sfotty.memory.read(sfotty.PC, true);

            // Signal BRK to the controller BEFORE Sfotty processes it.
            // The controller checks this flag after each run() call.
            if (opcode === 0x00) {
                sfotty._decodedBRK = true;
                sfotty._brkPC = sfotty.PC;
            }

            const undoc = UNDOCUMENTED_OPCODES[opcode];

            if (!undoc) {
                // Documented opcode — let original handle it (suppress crash msgs)
                const saved = console.error;
                console.error = () => {};
                origDecode();
                console.error = saved;
                return;
            }

            // Undocumented opcode — handle it ourselves
            // Advance PC past the opcode (matching Sfotty's behavior)
            sfotty.cycleCounter = 0;
            sfotty.PC = sfotty.PC + 1 & 65535;

            if (undoc.type === 'jam') {
                // JAM/HLT: halt the cell. Set halted flag via controller.
                // We use a special flag on the sfotty instance.
                sfotty.halted = true;
                // Set up a 1-cycle no-op + decode that does nothing
                sfotty.operations = [
                    () => sfotty.memory.read(sfotty.PC),
                    () => sfotty.decode()
                ];
                return;
            }

            if (undoc.type === 'nop' || undoc.type === 'unstable') {
                // NOP-like: advance PC past operand bytes, consume correct cycles
                const extraBytes = undoc.bytes - 1; // bytes beyond the opcode itself
                controller._setupNopOperations(sfotty, extraBytes, undoc.cycles, undoc.pageCross);
                return;
            }

            // Stable opcodes
            if (undoc.type === 'stable') {
                controller._setupStableOpcode(sfotty, undoc, opcode);
                return;
            }
        };
    }

    // Set up Sfotty operations array for a NOP-like opcode
    _setupNopOperations(sfotty, extraBytes, totalCycles, pageCross) {
        // Build operations array.
        // Total cycles includes the decode cycle at the end.
        // The operations array length = totalCycles - 1 (operations) + 1 (decode)
        // For a 2-byte, 2-cycle NOP: read operand+advance PC, then decode
        // For a 2-byte, 3-cycle NOP (zpg): read operand+advance, dummy read, decode
        // For a 2-byte, 4-cycle NOP (zpx): read operand+advance, dummy, dummy, decode
        // For a 3-byte, 4-cycle NOP (abs): read lo+advance, read hi+advance, dummy, decode
        // For a 3-byte, 4/5-cycle NOP (abx, page cross): read lo, read hi, check page cross, [extra], decode
        const ops = [];

        if (extraBytes === 0) {
            // 1-byte, 2-cycle NOP (implied)
            ops.push(() => sfotty.memory.read(sfotty.PC));
            ops.push(() => sfotty.decode());
        } else if (extraBytes === 1 && totalCycles === 2) {
            // 2-byte, 2-cycle NOP (immediate): read operand, advance PC, decode
            ops.push(() => {
                sfotty.memory.read(sfotty.PC);
                sfotty.PC = sfotty.PC + 1 & 65535;
            });
            ops.push(() => sfotty.decode());
        } else if (extraBytes === 1 && totalCycles === 3) {
            // 2-byte, 3-cycle NOP (zpg): read operand+advance, read zpg addr, decode
            ops.push(() => {
                sfotty.tmp = sfotty.memory.read(sfotty.PC);
                sfotty.PC = sfotty.PC + 1 & 65535;
            });
            ops.push(() => sfotty.memory.read(sfotty.tmp));
            ops.push(() => sfotty.decode());
        } else if (extraBytes === 1 && totalCycles === 4) {
            // 2-byte, 4-cycle NOP (zpx): read operand+advance, dummy read, read zpx addr, decode
            ops.push(() => {
                sfotty.tmp = sfotty.memory.read(sfotty.PC);
                sfotty.PC = sfotty.PC + 1 & 65535;
            });
            ops.push(() => sfotty.memory.read(sfotty.tmp));
            ops.push(() => sfotty.memory.read(sfotty.tmp + sfotty.X & 255));
            ops.push(() => sfotty.decode());
        } else if (extraBytes === 1 && totalCycles === 6) {
            // 2-byte, 6-cycle NOP (e.g. AHX/SHA indirect,Y = $93)
            ops.push(() => {
                sfotty.tmp = sfotty.memory.read(sfotty.PC);
                sfotty.PC = sfotty.PC + 1 & 65535;
            });
            ops.push(() => sfotty.memory.read(sfotty.tmp));
            ops.push(() => sfotty.memory.read(sfotty.tmp));
            ops.push(() => sfotty.memory.read(sfotty.tmp));
            ops.push(() => sfotty.memory.read(sfotty.tmp));
            ops.push(() => sfotty.decode());
        } else if (extraBytes === 2 && totalCycles === 4 && !pageCross) {
            // 3-byte, 4-cycle NOP (abs)
            ops.push(() => {
                sfotty.tmp = sfotty.memory.read(sfotty.PC);
                sfotty.PC = sfotty.PC + 1 & 65535;
            });
            ops.push(() => {
                sfotty.tmp += sfotty.memory.read(sfotty.PC) * 256;
                sfotty.PC = sfotty.PC + 1 & 65535;
            });
            ops.push(() => sfotty.memory.read(sfotty.tmp));
            ops.push(() => sfotty.decode());
        } else if (extraBytes === 2 && pageCross) {
            // 3-byte, 4-5 cycle NOP (abx, page cross possible)
            ops.push(() => {
                sfotty.tmp = sfotty.memory.read(sfotty.PC);
                sfotty.PC = sfotty.PC + 1 & 65535;
            });
            ops.push(() => {
                sfotty.tmp += sfotty.memory.read(sfotty.PC) * 256;
                sfotty.PC = sfotty.PC + 1 & 65535;
            });
            ops.push(() => {
                let lo = sfotty.tmp & 255;
                const hi = sfotty.tmp & 65280;
                lo += sfotty.X;
                if (lo < 255) {
                    sfotty.memory.read(sfotty.tmp + sfotty.X);
                    sfotty.cycleCounter++;
                } else {
                    sfotty.memory.read(hi | lo & 255);
                }
            });
            ops.push(() => sfotty.memory.read(sfotty.tmp + sfotty.X));
            ops.push(() => sfotty.decode());
        } else if (extraBytes === 2 && totalCycles === 5) {
            // 3-byte, 5-cycle NOP (e.g. TAS, SHY, SHX, AHX abs,Y)
            ops.push(() => {
                sfotty.tmp = sfotty.memory.read(sfotty.PC);
                sfotty.PC = sfotty.PC + 1 & 65535;
            });
            ops.push(() => {
                sfotty.tmp += sfotty.memory.read(sfotty.PC) * 256;
                sfotty.PC = sfotty.PC + 1 & 65535;
            });
            ops.push(() => {
                let lo = sfotty.tmp & 255;
                const hi = sfotty.tmp & 65280;
                lo += sfotty.Y;
                sfotty.memory.read(hi | lo & 255);
            });
            ops.push(() => sfotty.memory.read(sfotty.tmp + sfotty.Y));
            ops.push(() => sfotty.decode());
        } else {
            // Fallback: just consume the right number of cycles
            for (let i = 0; i < extraBytes; i++) {
                ops.push(() => {
                    sfotty.memory.read(sfotty.PC);
                    sfotty.PC = sfotty.PC + 1 & 65535;
                });
            }
            const dummyCycles = totalCycles - 1 - extraBytes;
            for (let i = 0; i < dummyCycles; i++) {
                ops.push(() => sfotty.memory.read(sfotty.PC));
            }
            ops.push(() => sfotty.decode());
        }

        sfotty.operations = ops;
    }

    // Set up Sfotty operations for stable undocumented opcodes
    _setupStableOpcode(sfotty, undoc, opcode) {
        const { mnemonic, mode } = undoc;

        // Define the combined operation functions
        switch (mnemonic) {
            case 'LAX': {
                // LDA + LDX: load both A and X from memory, set N/Z
                const exec = () => {
                    sfotty.A = sfotty.tmp;
                    sfotty.X = sfotty.tmp;
                    sfotty.Z = !sfotty.tmp;
                    sfotty.N = sfotty.tmp >= 128;
                };
                this._setupReadOps(sfotty, mode, exec);
                break;
            }
            case 'SAX': {
                // Store A & X to memory
                const storeVal = () => sfotty.A & sfotty.X;
                this._setupStoreOps(sfotty, mode, storeVal);
                break;
            }
            case 'DCP': {
                // DEC + CMP: decrement memory, then compare result with A
                const rmwOp = () => {
                    // DEC
                    sfotty.tmp2 = sfotty.tmp2 - 1 & 255;
                    // CMP
                    const inv = sfotty.tmp2 ^ 255;
                    const diff = sfotty.A + inv + 1;
                    sfotty.C = diff > 255;
                    const result = diff & 255;
                    sfotty.Z = !result;
                    sfotty.N = result >= 128;
                    return sfotty.tmp2;
                };
                this._setupRmwOps(sfotty, mode, rmwOp);
                break;
            }
            case 'ISC': {
                // INC + SBC: increment memory, then subtract result from A
                const rmwOp = () => {
                    // INC
                    sfotty.tmp2 = sfotty.tmp2 + 1 & 255;
                    // SBC (reuse Sfotty's SBC logic via tmp)
                    const val = sfotty.tmp2;
                    if (sfotty.D) {
                        const c = +sfotty.C;
                        const diff = sfotty.A + (~val & 255) + c;
                        let al = (sfotty.A & 15) - (val & 15) - c;
                        if ((al & 255) > 127) al -= 6;
                        let ah = (sfotty.A >> 4) - (val >> 4) - +((al & 255) > 127);
                        sfotty.V = !!((sfotty.A ^ val) & (sfotty.A ^ diff) & 128);
                        sfotty.C = diff > 255;
                        if (ah & 128) ah -= 6;
                        sfotty.tmp = sfotty.A = ah << 4 | al & 15;
                        sfotty.Z = !sfotty.tmp;
                        sfotty.N = sfotty.tmp >= 128;
                    } else {
                        sfotty.tmp = val ^ 255;
                        const carry7 = (sfotty.A & 127) + (sfotty.tmp & 127) + +sfotty.C;
                        const result = carry7 + (sfotty.A & 128) + (sfotty.tmp & 128);
                        sfotty.N = !!(result & 128);
                        sfotty.C = result >= 256;
                        sfotty.Z = !(result & 255);
                        sfotty.V = !!((result >> 2 ^ carry7 >> 1) & 64);
                        sfotty.A = result & 255;
                    }
                    return sfotty.tmp2;
                };
                this._setupRmwOps(sfotty, mode, rmwOp);
                break;
            }
            case 'SLO': {
                // ASL + ORA: shift left memory, then OR result with A
                const rmwOp = () => {
                    // ASL
                    sfotty.C = !!(sfotty.tmp2 & 128);
                    sfotty.tmp2 = sfotty.tmp2 << 1 & 255;
                    // ORA
                    sfotty.tmp = sfotty.A |= sfotty.tmp2;
                    sfotty.Z = !sfotty.tmp;
                    sfotty.N = sfotty.tmp >= 128;
                    return sfotty.tmp2;
                };
                this._setupRmwOps(sfotty, mode, rmwOp);
                break;
            }
            case 'RLA': {
                // ROL + AND: rotate left memory, then AND result with A
                const rmwOp = () => {
                    // ROL
                    let r = sfotty.tmp2 << 1;
                    r |= +sfotty.C;
                    sfotty.C = r > 255;
                    sfotty.tmp2 = r & 255;
                    // AND
                    sfotty.tmp = sfotty.A &= sfotty.tmp2;
                    sfotty.Z = !sfotty.tmp;
                    sfotty.N = sfotty.tmp >= 128;
                    return sfotty.tmp2;
                };
                this._setupRmwOps(sfotty, mode, rmwOp);
                break;
            }
            case 'SRE': {
                // LSR + EOR: shift right memory, then XOR result with A
                const rmwOp = () => {
                    // LSR
                    sfotty.C = !!(sfotty.tmp2 & 1);
                    sfotty.tmp2 = sfotty.tmp2 >> 1;
                    // EOR
                    sfotty.tmp = sfotty.A ^= sfotty.tmp2;
                    sfotty.Z = !sfotty.tmp;
                    sfotty.N = sfotty.tmp >= 128;
                    return sfotty.tmp2;
                };
                this._setupRmwOps(sfotty, mode, rmwOp);
                break;
            }
            case 'RRA': {
                // ROR + ADC: rotate right memory, then add result to A
                const rmwOp = () => {
                    // ROR
                    const r = sfotty.tmp2 | (sfotty.C ? 256 : 0);
                    sfotty.C = !!(sfotty.tmp2 & 1);
                    sfotty.tmp2 = r >> 1;
                    // ADC
                    const val = sfotty.tmp2;
                    if (sfotty.D) {
                        let al = (sfotty.A & 15) + (val & 15) + +sfotty.C;
                        if (al > 9) al += 6;
                        let ah = (sfotty.A >> 4) + (val >> 4) + +(al > 15);
                        sfotty.V = !!(~(sfotty.A ^ val) & (sfotty.A ^ ah << 4) & 128);
                        if (ah > 9) ah += 6;
                        sfotty.C = ah > 15;
                        sfotty.tmp = sfotty.A = ah << 4 | al & 15;
                        sfotty.Z = !sfotty.tmp;
                        sfotty.N = sfotty.tmp >= 128;
                    } else {
                        const sum = sfotty.A + val + +sfotty.C;
                        sfotty.V = !!(~(sfotty.A ^ val) & (sfotty.A ^ sum) & 128);
                        sfotty.C = sum > 255;
                        sfotty.tmp = sfotty.A = sum & 255;
                        sfotty.Z = !sfotty.tmp;
                        sfotty.N = sfotty.tmp >= 128;
                    }
                    return sfotty.tmp2;
                };
                this._setupRmwOps(sfotty, mode, rmwOp);
                break;
            }
            case 'ANC': {
                // AND immediate, copy bit 7 to carry
                const exec = () => {
                    sfotty.tmp = sfotty.A &= sfotty.tmp;
                    sfotty.Z = !sfotty.tmp;
                    sfotty.N = sfotty.tmp >= 128;
                    sfotty.C = !!(sfotty.A & 128);
                };
                this._setupReadOps(sfotty, 'imm', exec);
                break;
            }
            case 'ALR': {
                // AND immediate, then LSR A
                const exec = () => {
                    sfotty.A &= sfotty.tmp;
                    sfotty.C = !!(sfotty.A & 1);
                    sfotty.A = sfotty.A >> 1;
                    sfotty.Z = !sfotty.A;
                    sfotty.N = sfotty.A >= 128;
                };
                this._setupReadOps(sfotty, 'imm', exec);
                break;
            }
            case 'ARR': {
                // AND immediate, then ROR A with special flag handling
                const exec = () => {
                    sfotty.A &= sfotty.tmp;
                    const r = sfotty.A | (sfotty.C ? 256 : 0);
                    sfotty.A = r >> 1;
                    sfotty.Z = !sfotty.A;
                    sfotty.N = sfotty.A >= 128;
                    sfotty.C = !!(sfotty.A & 0x40);
                    sfotty.V = !!((sfotty.A & 0x40) ^ ((sfotty.A & 0x20) << 1));
                };
                this._setupReadOps(sfotty, 'imm', exec);
                break;
            }
            case 'AXS': {
                // AND X with A, subtract immediate without borrow, store in X
                const exec = () => {
                    const val = (sfotty.A & sfotty.X) - sfotty.tmp;
                    sfotty.C = val >= 0;
                    sfotty.X = val & 255;
                    sfotty.Z = !sfotty.X;
                    sfotty.N = sfotty.X >= 128;
                };
                this._setupReadOps(sfotty, 'imm', exec);
                break;
            }
            case 'SBC': {
                // Undocumented SBC immediate (duplicate of $E9)
                const exec = () => {
                    const val = sfotty.tmp;
                    if (sfotty.D) {
                        const c = +sfotty.C;
                        const diff = sfotty.A + (~val & 255) + c;
                        let al = (sfotty.A & 15) - (val & 15) - c;
                        if ((al & 255) > 127) al -= 6;
                        let ah = (sfotty.A >> 4) - (val >> 4) - +((al & 255) > 127);
                        sfotty.V = !!((sfotty.A ^ val) & (sfotty.A ^ diff) & 128);
                        sfotty.C = diff > 255;
                        if (ah & 128) ah -= 6;
                        sfotty.tmp = sfotty.A = ah << 4 | al & 15;
                        sfotty.Z = !sfotty.tmp;
                        sfotty.N = sfotty.tmp >= 128;
                    } else {
                        sfotty.tmp ^= 255;
                        const carry7 = (sfotty.A & 127) + (sfotty.tmp & 127) + +sfotty.C;
                        const result = carry7 + (sfotty.A & 128) + (sfotty.tmp & 128);
                        sfotty.N = !!(result & 128);
                        sfotty.C = result >= 256;
                        sfotty.Z = !(result & 255);
                        sfotty.V = !!((result >> 2 ^ carry7 >> 1) & 64);
                        sfotty.A = result & 255;
                    }
                };
                this._setupReadOps(sfotty, 'imm', exec);
                break;
            }
        }
    }

    // Set up read-mode operations for an undocumented opcode
    // exec() is called with sfotty.tmp holding the read value
    _setupReadOps(sfotty, mode, exec) {
        switch (mode) {
            case 'imm':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => { exec(); sfotty.decode(); }
                ];
                break;
            case 'zpg':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => sfotty.tmp = sfotty.memory.read(sfotty.tmp),
                    () => { exec(); sfotty.decode(); }
                ];
                break;
            case 'abs':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => {
                        sfotty.tmp += sfotty.memory.read(sfotty.PC) * 256;
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => sfotty.tmp = sfotty.memory.read(sfotty.tmp),
                    () => { exec(); sfotty.decode(); }
                ];
                break;
            case 'zpx':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => sfotty.memory.read(sfotty.tmp),
                    () => sfotty.tmp = sfotty.memory.read(sfotty.tmp + sfotty.X & 255),
                    () => { exec(); sfotty.decode(); }
                ];
                break;
            case 'zpy':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => sfotty.memory.read(sfotty.tmp),
                    () => sfotty.tmp = sfotty.memory.read(sfotty.tmp + sfotty.Y & 255),
                    () => { exec(); sfotty.decode(); }
                ];
                break;
            case 'abx':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => {
                        sfotty.tmp += sfotty.memory.read(sfotty.PC) * 256;
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => {
                        let lo = sfotty.tmp & 255;
                        const hi = sfotty.tmp & 65280;
                        lo += sfotty.X;
                        if (lo < 255) {
                            sfotty.tmp = sfotty.memory.read(sfotty.tmp + sfotty.X);
                            sfotty.cycleCounter++;
                        } else {
                            sfotty.memory.read(hi | lo & 255);
                        }
                    },
                    () => sfotty.tmp = sfotty.memory.read(sfotty.tmp + sfotty.X),
                    () => { exec(); sfotty.decode(); }
                ];
                break;
            case 'aby':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => {
                        sfotty.tmp += sfotty.memory.read(sfotty.PC) * 256;
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => {
                        let lo = sfotty.tmp & 255;
                        const hi = sfotty.tmp & 65280;
                        lo += sfotty.Y;
                        if (lo < 255) {
                            sfotty.tmp = sfotty.memory.read(sfotty.tmp + sfotty.Y);
                            sfotty.cycleCounter++;
                        } else {
                            sfotty.memory.read(hi | lo & 255);
                        }
                    },
                    () => sfotty.tmp = sfotty.memory.read(sfotty.tmp + sfotty.Y),
                    () => { exec(); sfotty.decode(); }
                ];
                break;
            case 'inx':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => {
                        sfotty.memory.read(sfotty.tmp);
                        sfotty.tmp2 = sfotty.tmp + sfotty.X & 255;
                    },
                    () => sfotty.tmp = sfotty.memory.read(sfotty.tmp2++ & 255),
                    () => sfotty.tmp += sfotty.memory.read(sfotty.tmp2 & 255) * 256,
                    () => sfotty.tmp = sfotty.memory.read(sfotty.tmp),
                    () => { exec(); sfotty.decode(); }
                ];
                break;
            case 'iny':
                sfotty.operations = [
                    () => {
                        sfotty.tmp2 = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.tmp2);
                        sfotty.tmp2 = sfotty.tmp2 + 1 & 65535;
                    },
                    () => sfotty.tmp += sfotty.memory.read(sfotty.tmp2 & 255) * 256,
                    () => {
                        let lo = sfotty.tmp & 255;
                        const hi = sfotty.tmp & 65280;
                        lo += sfotty.Y;
                        if (lo < 255) {
                            sfotty.tmp = sfotty.memory.read(sfotty.tmp + sfotty.Y);
                            sfotty.cycleCounter++;
                        } else {
                            sfotty.memory.read(hi | lo & 255);
                        }
                    },
                    () => sfotty.tmp = sfotty.memory.read(sfotty.tmp + sfotty.Y),
                    () => { exec(); sfotty.decode(); }
                ];
                break;
        }
    }

    // Set up store-mode operations for SAX
    _setupStoreOps(sfotty, mode, storeVal) {
        const writeOp = () => sfotty.memory.write(sfotty.tmp, storeVal());
        switch (mode) {
            case 'zpg':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    writeOp,
                    () => sfotty.decode()
                ];
                break;
            case 'abs':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => {
                        sfotty.tmp += sfotty.memory.read(sfotty.PC) * 256;
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    writeOp,
                    () => sfotty.decode()
                ];
                break;
            case 'zpy':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC) + sfotty.Y & 255;
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    writeOp,
                    () => sfotty.decode()
                ];
                break;
            case 'inx':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => {
                        sfotty.memory.read(sfotty.tmp);
                        sfotty.tmp2 = sfotty.tmp + sfotty.X;
                    },
                    () => sfotty.tmp = sfotty.memory.read(sfotty.tmp2++ & 255),
                    () => sfotty.tmp += sfotty.memory.read(sfotty.tmp2 & 255) * 256,
                    writeOp,
                    () => sfotty.decode()
                ];
                break;
        }
    }

    // Set up RMW-mode operations for DCP, ISC, SLO, RLA, SRE, RRA
    // rmwOp: function that modifies sfotty.tmp2 in place and returns the new value
    _setupRmwOps(sfotty, mode, rmwOp) {
        const rmwExec = () => {
            sfotty.memory.write(sfotty.tmp, sfotty.tmp2);  // write back original
            const r = rmwOp();
            // N/Z are set by the rmwOp itself for combined ops
        };
        const writeBack = () => sfotty.memory.write(sfotty.tmp, sfotty.tmp2);

        switch (mode) {
            case 'zpg':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => sfotty.tmp2 = sfotty.memory.read(sfotty.tmp),
                    rmwExec,
                    writeBack,
                    () => sfotty.decode()
                ];
                break;
            case 'abs':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => {
                        sfotty.tmp += sfotty.memory.read(sfotty.PC) * 256;
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => sfotty.tmp2 = sfotty.memory.read(sfotty.tmp),
                    rmwExec,
                    writeBack,
                    () => sfotty.decode()
                ];
                break;
            case 'zpx':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => sfotty.memory.read(sfotty.tmp),
                    () => {
                        sfotty.tmp = sfotty.tmp + sfotty.X & 255;
                        sfotty.tmp2 = sfotty.memory.read(sfotty.tmp);
                    },
                    rmwExec,
                    writeBack,
                    () => sfotty.decode()
                ];
                break;
            case 'abx':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => {
                        sfotty.tmp += sfotty.memory.read(sfotty.PC) * 256;
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => {
                        let lo = sfotty.tmp & 255;
                        const hi = sfotty.tmp & 65280;
                        lo += sfotty.X;
                        sfotty.memory.read(hi | lo & 255);
                        sfotty.tmp += sfotty.X;
                    },
                    () => sfotty.tmp2 = sfotty.memory.read(sfotty.tmp),
                    rmwExec,
                    writeBack,
                    () => sfotty.decode()
                ];
                break;
            case 'aby':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => {
                        sfotty.tmp += sfotty.memory.read(sfotty.PC) * 256;
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => {
                        let lo = sfotty.tmp & 255;
                        const hi = sfotty.tmp & 65280;
                        lo += sfotty.Y;
                        sfotty.memory.read(hi | lo & 255);
                        sfotty.tmp += sfotty.Y;
                    },
                    () => sfotty.tmp2 = sfotty.memory.read(sfotty.tmp),
                    rmwExec,
                    writeBack,
                    () => sfotty.decode()
                ];
                break;
            case 'inx':
                sfotty.operations = [
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => {
                        sfotty.memory.read(sfotty.tmp);
                        sfotty.tmp2 = sfotty.tmp + sfotty.X & 255;
                    },
                    () => sfotty.tmp = sfotty.memory.read(sfotty.tmp2++ & 255),
                    () => sfotty.tmp += sfotty.memory.read(sfotty.tmp2 & 255) * 256,
                    () => sfotty.tmp2 = sfotty.memory.read(sfotty.tmp),
                    rmwExec,
                    writeBack,
                    () => sfotty.decode()
                ];
                break;
            case 'iny':
                sfotty.operations = [
                    () => {
                        sfotty.tmp2 = sfotty.memory.read(sfotty.PC);
                        sfotty.PC = sfotty.PC + 1 & 65535;
                    },
                    () => {
                        sfotty.tmp = sfotty.memory.read(sfotty.tmp2);
                        sfotty.tmp2 = sfotty.tmp2 + 1 & 65535;
                    },
                    () => sfotty.tmp += sfotty.memory.read(sfotty.tmp2 & 255) * 256,
                    () => {
                        let lo = sfotty.tmp & 255;
                        const hi = sfotty.tmp & 65280;
                        lo += sfotty.Y;
                        sfotty.memory.read(hi | lo & 255);
                        sfotty.tmp = sfotty.tmp + sfotty.Y;
                    },
                    () => sfotty.tmp2 = sfotty.memory.read(sfotty.tmp),
                    rmwExec,
                    writeBack,
                    () => sfotty.decode()
                ];
                break;
        }
    }

    nextOpcode() {
        return this.memory.read (this.sfotty.PC);
    }

    nextOperandByte() {
        return this.memory.read (this.sfotty.PC + 1);
    }

    writeDword (addr, val) {
        this.memory.write (addr, (val >> 24) & 0xFF);
        this.memory.write (addr+1, (val >> 16) & 0xFF);
        this.memory.write (addr+2, (val >> 8) & 0xFF);
        this.memory.write (addr+3, val & 0xFF);
    }

    writeRegisters() {
        // Write directly to storage, bypassing address translation.
        // Register offsets are in the origin cell (neighborhood cell 0).
        const base = this.memory.neighborCellStorageBase(0);
        const s = this.memory.storage;
        s[base + this.regAddrPCHI] = (this.sfotty.PC >> 8) & 0xFF;
        s[base + this.regAddrPCLO] = this.sfotty.PC & 0xFF;
        s[base + this.regAddrP] = this.sfotty.P;
        s[base + this.regAddrA] = this.sfotty.A;
        s[base + this.regAddrX] = this.sfotty.X;
        s[base + this.regAddrY] = this.sfotty.Y;
        s[base + this.regAddrS] = this.sfotty.S;
    }

    readRegisters() {
        const base = this.memory.neighborCellStorageBase(0);
        const s = this.memory.storage;
        this.sfotty.PC = (s[base + this.regAddrPCHI] << 8) | s[base + this.regAddrPCLO];
        this.sfotty.P = s[base + this.regAddrP];
        this.sfotty.A = s[base + this.regAddrA];
        this.sfotty.X = s[base + this.regAddrX];
        this.sfotty.Y = s[base + this.regAddrY];
        this.sfotty.S = s[base + this.regAddrS];
    }

    writeRng() {
        const base = this.memory.neighborCellStorageBase(0);
        const s = this.memory.storage;
        const rnd = this.memory.nextRnd;
        s[base + this.rngAddr] = (rnd >> 24) & 0xFF;
        s[base + this.rngAddr + 1] = (rnd >> 16) & 0xFF;
        s[base + this.rngAddr + 2] = (rnd >> 8) & 0xFF;
        s[base + this.rngAddr + 3] = rnd & 0xFF;
    }

    swapCells (i, j) {
        // Compute storage bases once, then swap directly on storage[]
        // bypassing address translation entirely.
        const mem = this.memory;
        const iBase = mem.neighborCellStorageBase(i);
        const jBase = mem.neighborCellStorageBase(j);
        const storage = mem.storage;
        const M = mem.M;
        for (let b = 0; b < M; ++b) {
            const tmp = storage[iBase + b];
            storage[iBase + b] = storage[jBase + b];
            storage[jBase + b] = tmp;
        }
        // Swap lastWriter along with cell content
        const iCellIdx = Math.floor(iBase / M);
        const jCellIdx = Math.floor(jBase / M);
        const tmpWriter = this.lastWriter[iCellIdx];
        this.lastWriter[iCellIdx] = this.lastWriter[jCellIdx];
        this.lastWriter[jCellIdx] = tmpWriter;
    }

    copyCellWithNoise (dest) {
        const mem = this.memory;
        const mt = mem.mt;
        const eps = this.noiseParams.pBitNoise;
        const storage = mem.storage;
        const srcBase = mem.neighborCellStorageBase(0);  // origin cell
        const dstBase = mem.neighborCellStorageBase(dest);
        const M = mem.M;
        let perfect = true;
        if (eps === 0) {
            // Perfect copy — direct storage memcpy
            for (let b = 0; b < M; ++b) {
                storage[dstBase + b] = storage[srcBase + b];
            }
        } else {
            for (let b = 0; b < M; ++b) {
                const srcByte = storage[srcBase + b];
                const rndByte = mt.int() & 0xFF;
                let noiseBits = 0;
                for (let bit = 0; bit < 8; ++bit) {
                    if (mt.real() < eps)
                        noiseBits |= (1 << bit);
                }
                if (noiseBits !== 0) perfect = false;
                storage[dstBase + b] = (rndByte & noiseBits) | (srcByte & ~noiseBits);
            }
        }
        // Update lastWriter: perfect copy preserves provenance, imperfect clears it
        const srcCellIdx = Math.floor(srcBase / M);
        const dstCellIdx = Math.floor(dstBase / M);
        if (perfect) {
            this.lastWriter[dstCellIdx] = this.lastWriter[srcCellIdx];
        } else {
            this.lastWriter[dstCellIdx] = '';
        }
    }

    // NB this randomize() function avoids updating the BoardMemory's RNG
    randomize(rng) {
        rng = rng || (() => Math.random() * 2**32);
        for (let idx = 0; idx < this.memory.storageSize; idx += 4) {
            const r = rng();
            this.memory.setByteWithoutUndo (idx, (r >> 24) & 0xFF);
            this.memory.setByteWithoutUndo (idx+1, (r >> 16) & 0xFF);
            this.memory.setByteWithoutUndo (idx+2, (r >> 8) & 0xFF);
            this.memory.setByteWithoutUndo (idx+3, r & 0xFF);
        }
        this.memory.resetUndoHistory();
        this.readRegisters();
        this.writeRng();
    }

    runToNextInterrupt() {
        let cpuCycles = 0;
        const schedulerCycles = this.memory.nextCycles;
        const cellIdx = this.memory.ijToCellIndex(this.memory.iOrig, this.memory.jOrig);

        // If the cell is halted, skip execution entirely (like crashed but persistent)
        if (this.halted[cellIdx]) {
            cpuCycles = schedulerCycles;
            this.totalCycles += cpuCycles;
            // Still need to schedule next cell
            this.memory.sampleNextMove();
            if (this.boardParams.implementsSync || this.boardParams.implementsAsync) {
                this._checkPendingInterrupts();
            }
            this.readRegisters();
            this.writeRng();
            {
                const base = this.memory.neighborCellStorageBase(0);
                this.memory.storage[base + 0xFA] = this.boardParams.magnetosensing
                    ? (this.memory.orientation << 2)
                    : 0;
            }
            this.sfotty.crashed = false;
            this.sfotty.halted = false;
            this.sfotty.resetPending = false;
            this.sfotty._decodedBRK = false;
            this.sfotty.cycleCounter = 0;
            this.sfotty.operations = [() => this.sfotty.decode()];
            return { cpuCycles, schedulerCycles };
        }

        while (true) {
            let isSoftwareInterrupt = false;
            let isBRK = false;
            let brkOperand = 0;
            let elapsedCycles = 0;

            // Check if decode() just identified a BRK opcode.
            // The patched decode sets _decodedBRK when it sees opcode 0x00.
            // We intercept BRK here to handle copy/swap operations before
            // register save, matching the old controller behavior.
            if (this.sfotty._decodedBRK) {
                this.sfotty._decodedBRK = false;
                const brkPC = this.sfotty._brkPC;
                isBRK = true;
                isSoftwareInterrupt = true;
                brkOperand = this.memory.read(brkPC + 1);
                // BRK decode already advanced PC past opcode; set PC past operand
                this.sfotty.PC = (brkOperand === 0) ? 0 : (brkPC + 2) % 0x10000;
                // BRK is 7 cycles total. The decode that identified it was already
                // counted as 1 cycle by the sfotty.run() call. Add 6 more.
                elapsedCycles = 6;
            }

            if (isSoftwareInterrupt) {
                // BRK takes 7 cycles. elapsedCycles already set above.
            } else {
                // Each sfotty.run() call is one CPU cycle.
                this.sfotty.run();
                elapsedCycles = 1;
                // Check if a JAM opcode was encountered
                if (this.sfotty.halted) {
                    this.sfotty.halted = false;
                    this.halted[cellIdx] = true;
                    // Treat as timer interrupt — just skip to next cell
                    cpuCycles += elapsedCycles;
                    this.totalCycles += elapsedCycles;
                    this.memory.resetUndoHistory();
                    this.memory.sampleNextMove();
                    if (this.boardParams.implementsSync || this.boardParams.implementsAsync) {
                        this._checkPendingInterrupts();
                    }
                    this.readRegisters();
                    this.writeRng();
                    {
                        const base = this.memory.neighborCellStorageBase(0);
                        this.memory.storage[base + 0xFA] = this.boardParams.magnetosensing
                            ? (this.memory.orientation << 2)
                            : 0;
                    }
                    this.sfotty.crashed = false;
                    this.sfotty.halted = false;
                    this.sfotty.resetPending = false;
                    this.sfotty.cycleCounter = 0;
                    this.sfotty.operations = [() => this.sfotty.decode()];
                    return { cpuCycles, schedulerCycles };
                }
            }
            cpuCycles += elapsedCycles;
            this.totalCycles += elapsedCycles;
            // Was this an interrupt (timer or BRK)?
            const isTimerInterrupt = cpuCycles >= schedulerCycles;
            if (isTimerInterrupt || isSoftwareInterrupt) {
                // If I flag is set, revert all the states to before the interrupt.
                // Were this fictitious system being implemented as a filesystem, this would be where you'd discard the unsaved work.
                // If the implementation was sideways RAM, there would be a bulk copy operation here.
                // Since we have it all in memory, we actually preserve an undo history at the BoardMemory level,
                // and call its built-in undo here.
                // Interrupt model:
                // Pre-emptive scheduling is conceptually IRQ (maskable by SEI)
                // followed by NMI (unmaskable context switch). Memory writeback
                // happens between the IRQ and NMI if the I flag allows it.
                if (isTimerInterrupt && this.sfotty.I)  // masked interrupt (I set)?
                    this.memory.undoWrites();            // revert all writes (atomic abort)
                else {
                    if (isBRK) {
                        // BRK copy/swap happens BEFORE registers are saved,
                        // so the child inherits the pre-BRK register state
                        // stored at $F9-$FF from the previous scheduling.
                        const operand = brkOperand;
                        const nDestCells = this.memory.Nsquared;  // 49
                        const nSrcCells = 5;
                        // pBrkFailure: probability the copy/swap silently fails
                        // (no effect, no noise). Creates selective pressure for
                        // multi-copy strategies and error correction.
                        const bp = this.boardParams;
                        const brkFails = bp.pBrkFailure > 0
                            && this.memory.mt.real() < bp.pBrkFailure;
                        if (!brkFails) {
                            if (operand > 0 && operand < nSrcCells * nDestCells && bp.implementsMove) {
                                const src = Math.floor(operand / nDestCells);
                                const dest = operand % nDestCells;
                                this.commitMove (src, dest);
                                if (this.onBrkEvent) this.onBrkEvent('swap', src, dest);
                            } else if (operand >= 245 && operand <= 252 && bp.implementsCopy) {
                                const dest = operand - 244;
                                this.copyCellWithNoise (dest);
                                // Update move times using board cell indices (not neighborhood indices)
                                const originCellIdx = this.memory.ijToCellIndex(this.memory.iOrig, this.memory.jOrig);
                                this.lastMoveTime[originCellIdx] = this.totalCycles;
                                const [di, dj] = this.memory.addrToCellCoords(dest * this.memory.M);
                                const destCellIdx = this.memory.ijToCellIndex(di, dj);
                                this.lastMoveTime[destCellIdx] = this.totalCycles;
                                if (this.onBrkEvent) this.onBrkEvent('copy', 0, dest);
                            } else if (operand === 253 && bp.implementsSync) {
                                // Sync interrupt request: X,Y = LSB,MSB of period.
                                // Round down to nearest absolute multiple of period.
                                const period = this.sfotty.X | (this.sfotty.Y << 8);
                                if (period > 0) {
                                    const nextTime = (Math.floor(this.totalCycles / period) + 1) * period;
                                    const cellIdx = this.memory.ijToCellIndex(this.memory.iOrig, this.memory.jOrig);
                                    this.nextRequestedInterrupt[cellIdx] = nextTime;
                                }
                            } else if (operand === 254 && bp.implementsAsync) {
                                // Async interrupt request: X,Y = LSB,MSB of delay.
                                const delay = this.sfotty.X | (this.sfotty.Y << 8);
                                if (delay > 0) {
                                    const cellIdx = this.memory.ijToCellIndex(this.memory.iOrig, this.memory.jOrig);
                                    this.nextRequestedInterrupt[cellIdx] = this.totalCycles + delay;
                                }
                            }
                            // Operand 255 or unimplemented: just yield (no operation)
                        }
                    }
                    this.commitWrites();
                    // B flag (bit 4 of P at $FB): set for BRK, clear for timer.
                    // Follows 6502 convention: BRK/PHP set B; IRQ/NMI clear B.
                    // Written directly to storage after commitWrites/writeRegisters,
                    // because Sfotty doesn't track B as a real CPU flag.
                    // This enables fork detection: after BRK copy, the child
                    // inherits B=clear (pre-BRK state), while the parent gets
                    // B=set (written here after the copy).
                    {
                        const base = this.memory.neighborCellStorageBase(0);
                        const pAddr = base + this.regAddrP;
                        if (isSoftwareInterrupt) {
                            this.memory.storage[pAddr] |= 0x10;   // set B
                        } else {
                            this.memory.storage[pAddr] &= ~0x10;  // clear B
                        }
                    }
                    this.memory.resetUndoHistory();
                }
                // Randomize: pick next cell, load its state.
                // sampleNextMove picks a random cell, orientation, and timer.
                this.memory.sampleNextMove();
                // Check for pending sync/async interrupt requests.
                if (this.boardParams.implementsSync || this.boardParams.implementsAsync) {
                    this._checkPendingInterrupts();
                }
                this.readRegisters();
                this.writeRng();
                // Magnetosensing: write orientation to $FA (PCLO register area)
                // shifted left 2 bits to match oriented register format.
                // Programs can read $FA to detect their absolute orientation.
                {
                    const base = this.memory.neighborCellStorageBase(0);
                    this.memory.storage[base + 0xFA] = this.boardParams.magnetosensing
                        ? (this.memory.orientation << 2)
                        : 0;
                }
                // Reset Sfotty internal state for the new cell.
                this.sfotty.crashed = false;
                this.sfotty.halted = false;
                this.sfotty.resetPending = false;
                this.sfotty.cycleCounter = 0;
                this.sfotty.operations = [() => this.sfotty.decode()];
                break;
            }
        }
        return { cpuCycles, schedulerCycles }
    }

    _checkPendingInterrupts() {
        const B = this.memory.B;
        const now = this.totalCycles;
        const candidates = [];
        for (let idx = 0; idx < B * B; idx++) {
            if (this.nextRequestedInterrupt[idx] <= now) {
                candidates.push(idx);
            }
        }
        if (candidates.length > 0) {
            // Pick randomly among eligible cells
            const pick = candidates[this.memory.mt.int() % candidates.length];
            const i = Math.floor(pick / B);
            const j = pick % B;
            this.memory.iOrig = i;
            this.memory.jOrig = j;
            // Orientation is still random (from sampleNextMove)
            // Clear the pending interrupt
            this.nextRequestedInterrupt[pick] = Infinity;
        }
    }

    commitWrites() {
        const writtenCells = new Set();
        Object.keys(this.memory.undoHistory).forEach ((addr) => {
            const [i, j, b] = this.memory.ijbFromByteIndex (parseInt(addr));
            const cellIdx = this.memory.ijToCellIndex (i, j);
            this.lastWriteTime[cellIdx] = this.totalCycles;
            this.lastWriteTimeForByte[cellIdx][b] = this.totalCycles;
            writtenCells.add(cellIdx);
        })
        // Set lastWriter for any written-to cell to the board owner
        if (this.boardOwner) {
            for (const cellIdx of writtenCells) {
                this.lastWriter[cellIdx] = this.boardOwner;
            }
        }
        this.memory.disableUndoHistory();
        this.writeRegisters();
    }

    commitMove (src, dest) {
        if (src != dest)
            this.swapCells (src, dest);  // swapCells already swaps lastWriter
        this.lastMoveTime[src] = this.totalCycles;
        this.lastMoveTime[dest] = this.totalCycles;
        // swap last write times for src and dest cells
        const t = this.lastWriteTime[src], tb = this.lastWriteTimeForByte[src];
        this.lastWriteTime[src] = this.lastWriteTime[dest];
        this.lastWriteTime[dest] = t;
        this.lastWriteTimeForByte[src] = this.lastWriteTimeForByte[dest];
        this.lastWriteTimeForByte[dest] = tb;
    }

    makeUpdater (clockSpeedMHz = 2, callbackRateHz = 100) {
        const targetCyclesPerCallback = 1e6 / clockSpeedMHz;
        let totalSchedulerCycles = 0;
        const timerCallback = () => {
            while (totalSchedulerCycles < targetCyclesPerCallback) {
                const { schedulerCycles } = this.runToNextInterrupt();
                totalSchedulerCycles += schedulerCycles;
            }
            totalSchedulerCycles -= targetCyclesPerCallback;
        };
        const timerInterval = 1000 / callbackRateHz;
        return { timerCallback, timerInterval };
    }

    setUpdater (clockSpeedMHz = 2, callbackRateHz = 100) {
        const { timerCallback, timerInterval } = this.makeUpdater (clockSpeedMHz, callbackRateHz);
        return setInterval (timerCallback, timerInterval);
    }

    clearUpdater (updater) {
        clearInterval (updater)
    }
};

export { BoardController, UNDOCUMENTED_OPCODES };
