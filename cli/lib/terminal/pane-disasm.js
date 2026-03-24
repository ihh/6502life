// Disassembler Pane — right side
// Shows registers + disassembly, optionally sync'd to PC

import { moveTo, ESC, reset, dim, bold } from '../ansi.js';
import { fgRGB, bgRGB } from '../ansi.js';
import { disassembleRangeSync, formatInstruction, hex, hex16 } from './disassembler.js';
import { readCellRegisters } from '../../../engine/board.js';

export class DisasmPane {
    constructor(controller) {
        this.controller = controller;
        this.memory = controller.memory;
        this.app = null; // set by TerminalApp after construction
        // Current board cell being inspected
        this.cellI = 0;
        this.cellJ = 0;
        // Disassembly start address (null = sync to PC)
        this.disasmAddr = null;
        this.syncToPC = true;
        // Scroll offset (lines from top)
        this.scrollOffset = 0;
        // Whether this pane is currently focused (set by app before render)
        this.focused = false;
        // The current display start address (for sync back to memory pane)
        this.currentDisplayAddr = 0;
    }

    // Point disassembler at a specific address (detach from PC)
    gotoAddr(addr) {
        this.disasmAddr = addr & 0xFFFF;
        this.syncToPC = false;
    }

    // Re-sync to PC
    sync() {
        this.syncToPC = true;
        this.disasmAddr = null;
    }

    // Toggle sync
    toggleSync() {
        if (this.syncToPC) {
            // Detach: freeze at current PC
            const regs = readCellRegisters(this.controller, this.cellI, this.cellJ);
            this.disasmAddr = regs.PC;
            this.syncToPC = false;
        } else {
            this.sync();
        }
    }

    // Set which cell we're inspecting
    setCell(i, j) {
        this.cellI = i;
        this.cellJ = j;
    }

    render(rect) {
        const regs = readCellRegisters(this.controller, this.cellI, this.cellJ);
        let out = '';
        const paneBg = this.focused ? bgRGB(20, 20, 40) : '';
        const padLine = (lineOut) => {
            if (!paneBg) return lineOut;
            const visible = stripAnsi(lineOut).length;
            return paneBg + lineOut + ' '.repeat(Math.max(0, rect.width - visible)) + reset;
        };

        // --- Registers ---
        const row0 = rect.row;
        out += moveTo(row0, rect.col);
        out += padLine(bold + `Cell (${this.cellI},${this.cellJ})` + reset);

        out += moveTo(row0 + 1, rect.col);
        let regLine = `A=${fgRGB(180,220,255)}${hex(regs.A)}${reset} `;
        regLine += `X=${fgRGB(180,255,180)}${hex(regs.X)}${reset} `;
        regLine += `Y=${fgRGB(255,200,180)}${hex(regs.Y)}${reset} `;
        regLine += `S=${fgRGB(200,200,200)}${hex(regs.S)}${reset}`;
        out += padLine(regLine);

        out += moveTo(row0 + 2, rect.col);
        let pcLine = `PC=${fgRGB(255,255,100)}${hex16(regs.PC)}${reset}  `;
        pcLine += `P=${flagsColored(regs.P)}`;
        out += padLine(pcLine);

        // Sync indicator
        out += moveTo(row0 + 3, rect.col);
        if (this.syncToPC) {
            out += padLine(fgRGB(100, 255, 100) + 'SYNC' + reset + dim + ' [d]etach' + reset);
        } else {
            out += padLine(fgRGB(255, 180, 100) + 'FREE' + reset + dim + ` @$${hex16(this.disasmAddr)} [d]sync` + reset);
        }

        // --- Separator ---
        const sepRow = row0 + 4;
        out += moveTo(sepRow, rect.col);
        out += padLine(dim + '\u2500'.repeat(Math.min(rect.width, 40)) + reset);

        // --- Disassembly ---
        const startAddr = this.syncToPC ? regs.PC : (this.disasmAddr || 0);
        this.currentDisplayAddr = startAddr;
        const asmLines = rect.height - 6;
        if (asmLines <= 0) return out;

        // Read function: reads from the currently focused cell's address space
        const mem = this.memory;
        const readFn = (addr) => mem.read(addr);

        const instructions = disassembleRangeSync(readFn, startAddr, Math.max(1, asmLines));

        // Determine which line is "current" for the highlight cursor
        // When synced to PC, highlight the PC line; when free, highlight the first line
        const highlightAddr = this.syncToPC ? regs.PC : (this.disasmAddr || 0);

        for (let i = 0; i < instructions.length && i < asmLines; i++) {
            const instr = instructions[i];
            const lineRow = sepRow + 1 + i;
            if (lineRow > rect.row + rect.height - 1) break;

            out += moveTo(lineRow, rect.col);

            const isPC = (instr.addr === regs.PC);
            const isCurrentLine = (instr.addr === highlightAddr);
            const marker = isPC ? fgRGB(255, 255, 0) + '\u25b6' + reset : ' ';

            // Address
            const addrStr = hex16(instr.addr);
            // Bytes
            const bytesStr = instr.bytes.map(hex).join(' ').padEnd(8);
            // Mnemonic + operand — color by instruction type
            const mnem = instr.mnemonic;
            const operand = instr.operand || '';

            // Color mnemonics by category
            let mnemColor;
            if (['JMP','JSR','RTS','RTI','BCC','BCS','BEQ','BNE','BMI','BPL','BVC','BVS','BRK'].includes(mnem)) {
                mnemColor = fgRGB(255, 180, 80); // orange for flow control
            } else if (['LDA','LDX','LDY','STA','STX','STY'].includes(mnem)) {
                mnemColor = fgRGB(100, 220, 255); // cyan for load/store
            } else if (['NOP'].includes(mnem)) {
                mnemColor = fgRGB(100, 100, 100); // dim for NOP
            } else {
                mnemColor = fgRGB(255, 255, 255); // white for others
            }

            // Truncate to fit pane width
            let line = `${marker}${dim}$${addrStr}${reset} ${fgRGB(120,120,160)}${bytesStr}${reset} `;
            line += `${mnemColor}${bold}${mnem}${reset}`;
            if (operand) line += ` ${fgRGB(200,200,255)}${operand}${reset}`;

            // Apply reverse video to the current/PC line for cursor visibility
            if (isCurrentLine) {
                // Pad to fill the pane width and apply reverse video background
                out += bgRGB(30, 30, 60) + line + ' '.repeat(Math.max(0, rect.width - stripAnsi(line).length)) + reset;
            } else {
                out += padLine(line);
            }
        }

        return out;
    }
}

// Strip ANSI escape sequences to get visible character count
function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// Color the P register flags
function flagsColored(p) {
    const flags = [
        { bit: 0x80, name: 'N', color: [255, 100, 100] },
        { bit: 0x40, name: 'V', color: [255, 180, 100] },
        { bit: 0x20, name: '-', color: [80, 80, 80] },
        { bit: 0x10, name: 'B', color: [200, 200, 100] },
        { bit: 0x08, name: 'D', color: [100, 200, 255] },
        { bit: 0x04, name: 'I', color: [255, 100, 255] },
        { bit: 0x02, name: 'Z', color: [100, 255, 100] },
        { bit: 0x01, name: 'C', color: [200, 200, 200] },
    ];

    let out = '';
    for (const f of flags) {
        if (f.name === '-') {
            out += dim + '-' + reset;
        } else if (p & f.bit) {
            out += fgRGB(...f.color) + bold + f.name + reset;
        } else {
            out += dim + f.name.toLowerCase() + reset;
        }
    }
    return out;
}
