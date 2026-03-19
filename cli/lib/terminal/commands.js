// Command parser and executor for the debugger CLI
// This is the brain of the bottom-left command pane

import { readCellRegisters, readCellMemory, writeCellBytes } from '../../../engine/board.js';
import { assemble } from '../../../engine/assembler.js';
import { hexByte, hexWord } from '../../../engine/format.js';
import { hex, hex16 } from './disassembler.js';
import { listPresets, getPreset } from './presets.js';
import { readFileSync, writeFileSync } from 'fs';

export class CommandExecutor {
    constructor(app) {
        this.app = app;
    }

    get controller() { return this.app.controller; }
    get memory() { return this.app.controller.memory; }

    execute(input) {
        const parts = input.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);

        switch (cmd) {
            // --- Simulation control ---
            case 'r': case 'run': case 'start':
                this.app.running = true;
                return 'Running...';

            case 'p': case 'pause': case 'stop':
                this.app.running = false;
                return 'Paused.';

            case 's': case 'step': {
                const n = parseInt(args[0]) || 1;
                for (let i = 0; i < n; i++) {
                    this.controller.runToNextInterrupt();
                    this.app.totalInterrupts++;
                }
                return `Stepped ${n} interrupt${n > 1 ? 's' : ''}. Total: ${this.app.totalInterrupts}`;
            }

            case 'speed': {
                const n = parseInt(args[0]);
                if (isNaN(n) || n < 1) return 'Usage: speed <1-512>';
                this.app.speed = n;
                return `Speed: ${n} interrupts/frame`;
            }

            // --- Navigation ---
            case 'goto': case 'g': {
                const addr = parseAddr(args[0]);
                if (addr === null) return 'Usage: goto <addr>';
                this.app.memoryPane.jumpToAddr(addr);
                return `Cursor → $${hex16(addr)}`;
            }

            case 'cell': case 'c': {
                if (!args[0]) return 'Usage: cell <i>,<j> or cell <i> <j>';
                let i, j;
                if (args[0].includes(',')) {
                    [i, j] = args[0].split(',').map(Number);
                } else {
                    i = parseInt(args[0]);
                    j = parseInt(args[1]);
                }
                if (isNaN(i) || isNaN(j)) return 'Usage: cell <i>,<j>';
                this.app.memoryPane.setCenter(i, j);
                this.app.disasmPane.setCell(i, j);
                this.app.minimapPane.setHighlight(i, j);
                return `Inspecting cell (${i},${j})`;
            }

            // --- Inspection ---
            case 'regs': case 'reg': {
                const regs = readCellRegisters(this.controller, this.app.disasmPane.cellI, this.app.disasmPane.cellJ);
                return `A=${hex(regs.A)} X=${hex(regs.X)} Y=${hex(regs.Y)} S=${hex(regs.S)}\nPC=${hex16(regs.PC)} P=${hexByte(regs.P)}`;
            }

            case 'peek': case 'x': {
                const addr = parseAddr(args[0]);
                if (addr === null) return 'Usage: peek <addr>';
                const n = parseInt(args[1]) || 1;
                let out = '';
                for (let i = 0; i < n; i++) {
                    const a = (addr + i) & 0xFFFF;
                    const v = this.memory.read(a);
                    out += `$${hex16(a)}: $${hex(v)} (${v})\n`;
                }
                return out.trimEnd();
            }

            case 'poke': {
                const addr = parseAddr(args[0]);
                const val = parseAddr(args[1]);
                if (addr === null || val === null) return 'Usage: poke <addr> <val>';
                this.memory.write(addr, val & 0xFF);
                return `$${hex16(addr)} ← $${hex(val & 0xFF)}`;
            }

            case 'dump': case 'hexdump': case 'hd': {
                const addr = parseAddr(args[0]) || 0;
                const n = parseInt(args[1]) || 64;
                return hexDump(this.memory, addr, n);
            }

            case 'stack': {
                const regs = readCellRegisters(this.controller, this.app.disasmPane.cellI, this.app.disasmPane.cellJ);
                const sp = regs.S;
                let out = `SP=$${hex(sp)}`;
                const count = Math.min(16, 0xFF - sp);
                for (let i = 1; i <= count; i++) {
                    const addr = 0x100 + ((sp + i) & 0xFF);
                    const v = this.memory.read(addr);
                    out += `\n $${hex16(addr)}: $${hex(v)}`;
                }
                return out;
            }

            // --- Disassembler control ---
            case 'disasm': case 'dis': case 'd': {
                if (args[0] === 'sync' || !args[0]) {
                    this.app.disasmPane.sync();
                    return 'Disassembler synced to PC';
                }
                const addr = parseAddr(args[0]);
                if (addr === null) return 'Usage: disasm <addr|sync>';
                this.app.disasmPane.gotoAddr(addr);
                return `Disassembler → $${hex16(addr)}`;
            }

            case 'sync':
                this.app.disasmPane.sync();
                return 'Disassembler synced to PC';

            // --- Assembly ---
            case 'asm': {
                if (!args.length) return 'Usage: asm <source...>';
                const source = args.join(' ').replace(/;/g, '\n');
                return this.asyncCmd(async () => {
                    const bytes = await assemble(source);
                    const ci = this.app.disasmPane.cellI;
                    const cj = this.app.disasmPane.cellJ;
                    writeCellBytes(this.controller, ci, cj, 0, bytes);
                    return `Assembled ${bytes.length} bytes into (${ci},${cj})`;
                });
            }

            case 'load': {
                if (!args[0]) return 'Usage: load <file.asm>';
                return this.asyncCmd(async () => {
                    const source = readFileSync(args[0], 'utf-8');
                    const bytes = await assemble(source);
                    const ci = this.app.disasmPane.cellI;
                    const cj = this.app.disasmPane.cellJ;
                    writeCellBytes(this.controller, ci, cj, 0, bytes);
                    return `Loaded ${args[0]}: ${bytes.length} bytes into (${ci},${cj})`;
                });
            }

            // --- Presets ---
            case 'preset': {
                if (!args[0]) return 'Usage: preset <name>. Try: presets';
                const p = getPreset(args[0]);
                if (!p) return `Unknown preset "${args[0]}". Try: presets`;
                return this.asyncCmd(async () => {
                    const bytes = await assemble(p.source);
                    const ci = this.app.disasmPane.cellI;
                    const cj = this.app.disasmPane.cellJ;
                    writeCellBytes(this.controller, ci, cj, 0, bytes);
                    return `Loaded preset "${p.name}" (${bytes.length} bytes) into (${ci},${cj})`;
                });
            }

            case 'presets': {
                const list = listPresets();
                return list.map(p => `  ${p.key.padEnd(12)} ${p.desc}`).join('\n');
            }

            // --- State ---
            case 'save': {
                if (!args[0]) return 'Usage: save <file.json>';
                const state = this.controller.state;
                writeFileSync(args[0], JSON.stringify(state));
                return `Saved state to ${args[0]}`;
            }

            case 'load-state': {
                if (!args[0]) return 'Usage: load-state <file.json>';
                const state = JSON.parse(readFileSync(args[0], 'utf-8'));
                this.controller.state = state;
                return `Loaded state from ${args[0]}`;
            }

            case 'randomize': case 'rand':
                this.controller.randomize();
                return 'Board randomized';

            case 'zero':
                if (args[0] === 'all') {
                    const B = this.memory.B;
                    for (let i = 0; i < B; i++)
                        for (let j = 0; j < B; j++)
                            for (let b = 0; b < 1024; b++)
                                this.memory.setByteWithoutUndo(this.memory.ijbToByteIndex(i, j, b), 0);
                    return 'Zeroed all cells';
                } else {
                    const ci = this.app.disasmPane.cellI;
                    const cj = this.app.disasmPane.cellJ;
                    const base = this.memory.ijbToByteIndex(ci, cj, 0);
                    for (let b = 0; b < 1024; b++)
                        this.memory.setByteWithoutUndo(base + b, 0);
                    return `Zeroed cell (${ci},${cj})`;
                }

            // --- Info ---
            case 'origin': case 'orig':
                return `Origin: (${this.memory.iOrig},${this.memory.jOrig}) orient=${this.memory.orientation}`;

            case 'info': case 'status': {
                const mem = this.memory;
                return [
                    `Board: ${mem.B}x${mem.B} (${mem.B * mem.B} cells)`,
                    `Origin: (${mem.iOrig},${mem.jOrig}) orient=${mem.orientation}`,
                    `Interrupts: ${this.app.totalInterrupts}`,
                    `Speed: ${this.app.speed} int/frame`,
                    `${this.app.running ? 'RUNNING' : 'PAUSED'}`,
                ].join('\n');
            }

            case 'help': case '?':
                return HELP_TEXT;

            default:
                return `Unknown command: ${cmd}. Type "help" for commands.`;
        }
    }

    // Handle async commands (assembly, file loading)
    asyncCmd(fn) {
        fn().then(result => {
            this.app.commandPane.print(result);
            this.app.renderIfPaused();
        }).catch(e => {
            this.app.commandPane.print(`Error: ${e.message}`);
            this.app.renderIfPaused();
        });
        return null; // result will be printed async
    }
}

function parseAddr(str) {
    if (!str) return null;
    str = str.replace(/^\$/, '');
    if (str.startsWith('0x') || str.startsWith('0X')) str = str.slice(2);
    const v = parseInt(str, 16);
    return isNaN(v) ? null : v & 0xFFFF;
}

function hexDump(memory, startAddr, count) {
    let out = '';
    for (let i = 0; i < count; i += 16) {
        const addr = (startAddr + i) & 0xFFFF;
        let hex = '';
        let ascii = '';
        for (let j = 0; j < 16 && i + j < count; j++) {
            const a = (addr + j) & 0xFFFF;
            const v = memory.read(a);
            hex += hexByte(v) + ' ';
            ascii += (v >= 0x20 && v < 0x7F) ? String.fromCharCode(v) : '.';
        }
        out += `$${hexWord(addr)}  ${hex.padEnd(48)} ${ascii}\n`;
    }
    return out.trimEnd();
}

const HELP_TEXT = `Debugger commands:
  r, run            Start simulation
  p, pause          Pause simulation
  s, step [N]       Step N interrupts (default 1)
  speed N           Set speed (interrupts/frame)

  goto ADDR         Move memory cursor to address
  cell I,J          Inspect board cell (I,J)
  regs              Show current cell registers
  peek ADDR [N]     Show N bytes at address
  poke ADDR VAL     Write byte to address
  dump ADDR [N]     Hex dump N bytes (default 64)
  stack             Show stack contents

  d, disasm ADDR    Point disassembler at address
  sync              Re-sync disassembler to PC

  asm SOURCE        Assemble and load (use ; for newlines)
  load FILE         Load assembly file into current cell
  preset NAME       Load a preset program
  presets           List available presets

  save FILE         Save board state to JSON
  load-state FILE   Load board state from JSON
  randomize         Fill board with random data
  zero [all]        Zero current cell (or all cells)

  origin            Show current origin and orientation
  info              Show board status
  help              Show this help`;
