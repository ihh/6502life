// Command parser and executor for the debugger CLI
// This is the brain of the bottom-left command pane

import { readCellRegisters, readCellMemory, writeCellBytes } from '../../../engine/board.js';
import { assemble } from '../../../engine/assembler.js';
import { hexByte, hexWord } from '../../../engine/format.js';
import { disassembleRangeSync, hex, hex16 } from './disassembler.js';
import { listPresets, getPreset } from './presets.js';
import { readFileSync, writeFileSync } from 'fs';
import { hashHex } from '../probe/fingerprint.js';
import { byteToAsciiChar, DEFAULT_ASCII_PALETTE } from './sextant.js';
import { spiralVec, cellToGrid, gridToCell, gridToAddr } from './pane-memory.js';


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
                    writeCellBytes(this.controller, ci, cj, 0x200, bytes);
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
                    writeCellBytes(this.controller, ci, cj, 0x200, bytes);
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
                    writeCellBytes(this.controller, ci, cj, 0x200, bytes);
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

            // --- Probe/tracking commands (work with or without socket) ---
            case 'fingerprint': case 'fp': {
                const tracker = this.getTracker();
                if (!tracker) return 'Probe not active. Start with --listen';
                let i, j;
                if (args[0] && args[0].includes(',')) {
                    [i, j] = args[0].split(',').map(Number);
                } else {
                    i = this.app.disasmPane.cellI;
                    j = this.app.disasmPane.cellJ;
                }
                const fp = tracker.fingerprintCell(i, j);
                return `Cell (${i},${j}): hash=${hashHex(fp.hash)} minhash=[${Array.from(fp.minhash).slice(0,4).map(h => (h>>>0).toString(16)).join(',')}...]`;
            }

            case 'tag': {
                const tracker = this.getTracker();
                if (!tracker) return 'Probe not active. Start with --listen';
                let i, j, tag;
                if (args[0] && args[0].includes(',')) {
                    [i, j] = args[0].split(',').map(Number);
                    tag = args[1];
                } else {
                    i = this.app.disasmPane.cellI;
                    j = this.app.disasmPane.cellJ;
                    tag = args[0];
                }
                if (!tag) return 'Usage: tag [i,j] <name>';
                tracker.addTag(i, j, tag);
                return `Tagged (${i},${j}) as "${tag}"`;
            }

            case 'untag': {
                const tracker = this.getTracker();
                if (!tracker) return 'Probe not active. Start with --listen';
                let i, j, tag;
                if (args[0] && args[0].includes(',')) {
                    [i, j] = args[0].split(',').map(Number);
                    tag = args[1];
                } else {
                    i = this.app.disasmPane.cellI;
                    j = this.app.disasmPane.cellJ;
                    tag = args[0];
                }
                if (!tag) return 'Usage: untag [i,j] <name>';
                tracker.removeTag(i, j, tag);
                return `Untagged (${i},${j}) "${tag}"`;
            }

            case 'tags': {
                const tracker = this.getTracker();
                if (!tracker) return 'Probe not active. Start with --listen';
                if (args[0]) {
                    // Find cells with tag
                    const cells = tracker.findByTag(args[0]);
                    if (cells.length === 0) return `No cells tagged "${args[0]}"`;
                    return `"${args[0]}": ${cells.map(c => `(${c[0]},${c[1]})`).join(' ')}`;
                }
                const i = this.app.disasmPane.cellI;
                const j = this.app.disasmPane.cellJ;
                const t = tracker.getTags(i, j);
                return t.length > 0 ? `(${i},${j}) tags: ${t.join(', ')}` : `(${i},${j}) has no tags`;
            }

            case 'track': {
                const tracker = this.getTracker();
                if (!tracker) return 'Probe not active. Start with --listen';
                let i, j;
                if (args[0] && args[0].includes(',')) {
                    [i, j] = args[0].split(',').map(Number);
                } else {
                    i = this.app.disasmPane.cellI;
                    j = this.app.disasmPane.cellJ;
                }
                tracker.trackCell(i, j);
                return `Tracking lineage of (${i},${j})`;
            }

            case 'untrack': {
                const tracker = this.getTracker();
                if (!tracker) return 'Probe not active. Start with --listen';
                let i, j;
                if (args[0] && args[0].includes(',')) {
                    [i, j] = args[0].split(',').map(Number);
                } else {
                    i = this.app.disasmPane.cellI;
                    j = this.app.disasmPane.cellJ;
                }
                tracker.untrackCell(i, j);
                return `Stopped tracking (${i},${j})`;
            }

            case 'diff': {
                const tracker = this.getTracker();
                if (!tracker) return 'Probe not active. Start with --listen';
                if (!args[0] || !args[1]) return 'Usage: diff i1,j1 i2,j2';
                const [i1, j1] = args[0].split(',').map(Number);
                const [i2, j2] = args[1].split(',').map(Number);
                const result = tracker.diffCells(i1, j1, i2, j2);
                if (result.identical) return `(${i1},${j1}) and (${i2},${j2}) are identical (sim=${result.similarity})`;
                return `(${i1},${j1}) vs (${i2},${j2}): ${result.numChanges} bytes differ, sim=${result.similarity}`;
            }

            case 'census': {
                const tracker = this.getTracker();
                if (!tracker) return 'Probe not active. Start with --listen';
                const c = tracker.computeCensus();
                const topEntries = Object.entries(c.top).slice(0, 8);
                let out = `Cells: ${c.totalCells}, Active: ${c.active}, Unique: ${c.uniqueFingerprints}`;
                if (topEntries.length > 0) {
                    out += '\nTop fingerprints:';
                    for (const [hash, count] of topEntries) {
                        out += `\n  ${hash}: ${count}`;
                    }
                }
                const tagEntries = Object.entries(c.tags);
                if (tagEntries.length > 0) {
                    out += '\nTags: ' + tagEntries.map(([t, n]) => `${t}(${n})`).join(' ');
                }
                return out;
            }

            case 'screen-dump': case 'dump': {
                const dumpText = this.generateDump();
                if (args[0]) {
                    writeFileSync(args[0], dumpText);
                    return `Screen dump saved to ${args[0]}`;
                }
                // Store for script mode to pick up
                this._lastDump = dumpText;
                return 'Screen dump generated (use "dump <file>" to save to file)';
            }

            case 'help': case '?':
                return HELP_TEXT;

            default:
                return `Unknown command: ${cmd}. Type "help" for commands.`;
        }
    }

    // Generate a plain-text screen dump of all four panes
    generateDump() {
        const lines = [];
        const B = this.memory.B;
        const ci = this.app.disasmPane.cellI;
        const cj = this.app.disasmPane.cellJ;

        // --- Status line ---
        lines.push(`=== 6502life screen dump ===`);
        lines.push(`Board: ${B}x${B}  Interrupts: ${this.app.totalInterrupts}  ${this.app.running ? 'RUNNING' : 'PAUSED'}`);
        lines.push(`Focus cell: (${ci},${cj})  Speed: ${this.app.speed}`);
        lines.push('');

        // --- Disassembler pane ---
        lines.push(`--- DISASM: Cell (${ci},${cj}) ---`);
        const regs = readCellRegisters(this.controller, ci, cj);
        lines.push(`A=${hex(regs.A)} X=${hex(regs.X)} Y=${hex(regs.Y)} S=${hex(regs.S)} PC=${hex16(regs.PC)} P=${hex(regs.P)}`);
        const flags = [];
        if (regs.P & 0x80) flags.push('N'); else flags.push('n');
        if (regs.P & 0x40) flags.push('V'); else flags.push('v');
        flags.push('-');
        if (regs.P & 0x10) flags.push('B'); else flags.push('b');
        if (regs.P & 0x08) flags.push('D'); else flags.push('d');
        if (regs.P & 0x04) flags.push('I'); else flags.push('i');
        if (regs.P & 0x02) flags.push('Z'); else flags.push('z');
        if (regs.P & 0x01) flags.push('C'); else flags.push('c');
        lines.push(`Flags: ${flags.join('')}`);

        // Disassemble 24 lines from PC
        const readFn = (addr) => this.memory.read(addr);
        const instrs = disassembleRangeSync(readFn, regs.PC, 24);
        for (const instr of instrs) {
            const marker = instr.addr === regs.PC ? '>' : ' ';
            const addrStr = hex16(instr.addr);
            const bytesStr = instr.bytes.map(hex).join(' ').padEnd(8);
            const operand = instr.operand ? ` ${instr.operand}` : '';
            lines.push(`${marker} $${addrStr}  ${bytesStr}  ${instr.mnemonic}${operand}`);
        }
        lines.push('');

        // --- Memory pane: hex dump of center cell ---
        lines.push(`--- MEMORY: Cell (${ci},${cj}) hex dump ---`);
        const cellMem = readCellMemory(this.controller, ci, cj);
        for (let row = 0; row < 32; row++) {
            const off = row * 32;
            let hexPart = '';
            let ascPart = '';
            for (let col = 0; col < 32; col++) {
                const b = cellMem[off + col];
                hexPart += hex(b) + ' ';
                ascPart += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.';
            }
            lines.push(`$${hex16(off)}  ${hexPart} ${ascPart}`);
        }
        lines.push('');

        // --- Minimap: simple text overview ---
        lines.push(`--- MINIMAP: ${B}x${B} board activity ---`);
        // Show which cells have non-zero content
        const activeCells = [];
        for (let i = 0; i < B; i++) {
            for (let j = 0; j < B; j++) {
                const mem = readCellMemory(this.controller, i, j);
                let nonZero = 0;
                for (let b = 0; b < 1024; b++) {
                    if (mem[b] !== 0) nonZero++;
                }
                if (nonZero > 0) {
                    activeCells.push(`(${i},${j}):${nonZero}`);
                }
            }
        }
        lines.push(`Active cells: ${activeCells.length}/${B * B}`);
        if (activeCells.length <= 64) {
            lines.push(activeCells.join(' '));
        } else {
            lines.push(activeCells.slice(0, 32).join(' '));
            lines.push(`  ... and ${activeCells.length - 32} more`);
        }
        lines.push('');

        // --- Command pane output ---
        lines.push(`--- COMMAND OUTPUT ---`);
        for (const line of this.app.commandPane.outputLines) {
            lines.push(line);
        }

        return lines.join('\n') + '\n';
    }

    getTracker() {
        return this.app.probeServer?.tracker || null;
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
  dump [FILE]       Plain-text screen dump (all panes)

Probe (requires --listen):
  fp [I,J]          MinHash fingerprint of cell
  tag [I,J] NAME    Tag cell with a name
  untag [I,J] NAME  Remove tag
  tags [NAME]       List tags on cell or find by tag
  track [I,J]       Track cell lineage (copy detection)
  untrack [I,J]     Stop tracking
  diff I,J I,J      Diff two cells
  census            Board-wide fingerprint census

  help              Show this help`;
