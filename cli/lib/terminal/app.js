// Main Terminal App — orchestrates four panes, input, simulation
// Claude Code-style 6502 debugger interface

import { clear, hideCursor, showCursor, altScreen, mainScreen, moveTo, reset, dim, bold, ESC } from '../ansi.js';
import { fgRGB } from '../ansi.js';
import { Layout } from './layout.js';
import { MemoryPane } from './pane-memory.js';
import { DisasmPane } from './pane-disasm.js';
import { CommandPane } from './pane-command.js';
import { MinimapPane } from './pane-minimap.js';
import { CommandExecutor } from './commands.js';
import { parseKey } from './input.js';
import { initDisassembler } from './disassembler.js';
import { spiralVec } from './pane-memory.js';

const PANES = ['memory', 'disasm', 'command', 'minimap'];

export class TerminalApp {
    constructor(controller, visualizer) {
        this.controller = controller;
        this.visualizer = visualizer;

        // Layout
        this.layout = new Layout();

        // Panes
        this.memoryPane = new MemoryPane(controller.memory, controller);
        this.disasmPane = new DisasmPane(controller);
        this.commandPane = new CommandPane();
        this.minimapPane = new MinimapPane(controller, visualizer);

        // Command executor
        this.executor = new CommandExecutor(this);
        this.commandPane.onCommand = (cmd) => this.executor.execute(cmd);

        // Focus
        this.activePane = 'command'; // start with command pane focused

        // Simulation state
        this.running = false;
        this.speed = 1;
        this.totalInterrupts = 0;

        // Render throttle
        this.lastRender = 0;
        this.minRenderInterval = 66; // ~15fps
        this.needsRender = true;

        this.quit = false;
    }

    async start() {
        await initDisassembler();

        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf-8');
        process.stdout.write(altScreen + hideCursor + clear());

        process.stdin.on('data', (data) => this.handleInput(data));
        process.stdout.on('resize', () => {
            this.layout.recalculate();
            this.needsRender = true;
        });

        // Welcome message
        this.commandPane.print('6502life debugger. Type "help" for commands.');
        this.commandPane.print(`Board: ${this.controller.memory.B}x${this.controller.memory.B}`);

        this.render();
        this.tick();
    }

    // Run in headless script mode: execute commands from an array, then exit
    async startScript(scriptLines) {
        await initDisassembler();

        // Ensure deterministic CPU state: Sfotty's constructor leaves
        // registers uninitialized and resetPending=true, which causes
        // non-deterministic behavior on the first run. Fix by setting
        // known initial state.
        const sfotty = this.controller.sfotty;
        sfotty.resetPending = false;
        sfotty.cycleCounter = 0;
        sfotty.operations = [() => sfotty.decode()];
        // Read registers from the current cell (as the controller does
        // after sampleNextMove in its constructor) to initialize the CPU
        // with the register save area values.
        this.controller.readRegisters();

        // Welcome message (for reproducibility of command pane output)
        this.commandPane.print('6502life debugger. Type "help" for commands.');
        this.commandPane.print(`Board: ${this.controller.memory.B}x${this.controller.memory.B}`);

        for (const rawLine of scriptLines) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue; // skip comments and empty lines

            // Handle 'wait N' — step N interrupts silently
            const waitMatch = line.match(/^wait\s+(\d+)$/i);
            if (waitMatch) {
                const n = parseInt(waitMatch[1]);
                for (let i = 0; i < n; i++) {
                    this.controller.runToNextInterrupt();
                    this.totalInterrupts++;
                }
                this.memoryPane.invalidatePC();
                continue;
            }

            // Handle 'dump' (no args) — dump to stdout
            if (line === 'dump') {
                const dumpText = this.executor.generateDump();
                process.stdout.write(dumpText);
                continue;
            }

            // Execute as a normal command
            this.commandPane.print(`> ${line}`);
            try {
                const result = this.executor.execute(line);
                if (result) this.commandPane.print(result);
                // Wait for async commands to complete
                if (result === null) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            } catch (e) {
                this.commandPane.print(`Error: ${e.message}`);
            }
        }
    }

    stop() {
        this.running = false;
        this.quit = true;
        process.stdout.write(showCursor + mainScreen);
        process.stdin.setRawMode(false);
        process.stdin.pause();
    }

    handleInput(data) {
        const key = parseKey(data);

        // Global keys (work regardless of focus)
        if (key.name === 'ctrl-c') {
            this.stop();
            process.exit(0);
            return;
        }

        if (key.name === 'tab') {
            const idx = PANES.indexOf(this.activePane);
            this.activePane = PANES[(idx + 1) % PANES.length];
            this.needsRender = true;
            return;
        }

        if (key.name === 'shift-tab') {
            const idx = PANES.indexOf(this.activePane);
            this.activePane = PANES[(idx - 1 + PANES.length) % PANES.length];
            this.needsRender = true;
            return;
        }

        // Dispatch to focused pane
        switch (this.activePane) {
            case 'memory':
                this.handleMemoryInput(key);
                break;
            case 'disasm':
                this.handleDisasmInput(key);
                break;
            case 'command':
                this.handleCommandInput(key, data);
                break;
            case 'minimap':
                this.handleMinimapInput(key);
                break;
        }

        this.needsRender = true;
    }

    handleMemoryInput(key) {
        if (key.name === 'arrow') {
            const step = key.shift ? 8 : 1;
            if (key.ctrl) {
                // Ctrl+arrow: move board cell focus (memory pane + disasm + minimap)
                const di = key.dir === 'down' ? 1 : key.dir === 'up' ? -1 : 0;
                const dj = key.dir === 'right' ? 1 : key.dir === 'left' ? -1 : 0;
                this.moveBoardFocus(di, dj);
            } else {
                const dx = key.dir === 'right' ? step : key.dir === 'left' ? -step : 0;
                const dy = key.dir === 'down' ? step : key.dir === 'up' ? -step : 0;
                this.memoryPane.moveCursor(dx, dy);
            }
            this.syncCursorToDisasm();
            return;
        }

        if (key.name === 'char') {
            switch (key.char) {
                case ' ':
                    this.toggleRun();
                    break;
                case 'n':
                    this.step();
                    break;
                case 'd':
                    this.disasmPane.toggleSync();
                    break;
            }
        }
    }

    handleDisasmInput(key) {
        if (key.name === 'arrow') {
            if (key.dir === 'up') {
                // Scroll disassembly up (decrease address)
                if (!this.disasmPane.syncToPC && this.disasmPane.disasmAddr > 0) {
                    this.disasmPane.disasmAddr = Math.max(0, this.disasmPane.disasmAddr - 1);
                }
            } else if (key.dir === 'down') {
                if (!this.disasmPane.syncToPC && this.disasmPane.disasmAddr < 0xFFFF) {
                    this.disasmPane.disasmAddr = Math.min(0xFFFF, this.disasmPane.disasmAddr + 1);
                }
            }
            return;
        }

        if (key.name === 'char') {
            switch (key.char) {
                case ' ':
                    this.toggleRun();
                    break;
                case 'n':
                    this.step();
                    break;
                case 'd':
                    this.disasmPane.toggleSync();
                    break;
            }
        }
    }

    handleCommandInput(key, rawData) {
        // Forward everything to the command pane
        this.commandPane.handleKey(rawData);
    }

    handleMinimapInput(key) {
        if (key.name === 'arrow') {
            // Arrow keys move the board cell focus — updates memory pane, disasm, and minimap
            const di = key.dir === 'down' ? 1 : key.dir === 'up' ? -1 : 0;
            const dj = key.dir === 'right' ? 1 : key.dir === 'left' ? -1 : 0;
            this.moveBoardFocus(di, dj);
            return;
        }

        if (key.name === 'char') {
            switch (key.char) {
                case 'm':
                    this.minimapPane.toggleMode();
                    break;
                case ' ':
                    this.toggleRun();
                    break;
                case 'n':
                    this.step();
                    break;
            }
        }
    }

    // Move which board cell all panes are focused on
    moveBoardFocus(di, dj) {
        const B = this.controller.memory.B;
        this.memoryPane.moveCenter(di, dj);
        const ci = this.memoryPane.centerI;
        const cj = this.memoryPane.centerJ;
        this.disasmPane.setCell(ci, cj);
        this.minimapPane.setHighlight(ci, cj);
    }

    // Keep disasm pane's cell in sync with memory cursor position
    syncCursorToDisasm() {
        const info = this.memoryPane.getCursorInfo();
        if (info.boardI >= 0 && info.boardJ >= 0) {
            this.disasmPane.setCell(info.boardI, info.boardJ);
            this.minimapPane.setHighlight(info.boardI, info.boardJ);
        }
    }

    toggleRun() {
        this.running = !this.running;
        this.needsRender = true;
    }

    step() {
        this.controller.runToNextInterrupt();
        this.totalInterrupts++;
        this.memoryPane.invalidatePC();
        this.needsRender = true;
    }

    tick() {
        if (this.quit) return;

        if (this.running) {
            for (let i = 0; i < this.speed; i++) {
                this.controller.runToNextInterrupt();
                this.totalInterrupts++;
            }
            this.memoryPane.invalidatePC();
            this.needsRender = true;
        }

        const now = Date.now();
        if (this.needsRender && (now - this.lastRender >= this.minRenderInterval)) {
            this.render();
            this.lastRender = now;
            this.needsRender = false;
        } else if (!this.needsRender) {
            // Cursor flash: partial redraw without full screen render
            const flashOut = this.memoryPane.renderCursorFlash(this.layout.memory);
            if (flashOut) process.stdout.write(flashOut);
        }

        setImmediate(() => this.tick());
    }

    renderIfPaused() {
        if (!this.running) {
            this.needsRender = true;
        }
    }

    render() {
        this.layout.recalculate();
        let out = '';

        // Clear screen for first render, otherwise just overwrite
        out += moveTo(1, 1);

        // Clear all lines
        for (let r = 1; r <= this.layout.termH; r++) {
            out += moveTo(r, 1) + ESC + '2K';
        }

        // Render each pane
        out += this.memoryPane.render(this.layout.memory);
        out += this.disasmPane.render(this.layout.disasm);
        out += this.commandPane.render(this.layout.command, this.activePane === 'command');
        out += this.minimapPane.render(this.layout.minimap);

        // Render dividers
        out += this.layout.renderDividers(this.activePane);

        // Status bar info overlaid on the horizontal divider
        out += this.renderStatusInfo();

        process.stdout.write(out);
    }

    renderStatusInfo() {
        let out = '';
        const row = this.layout.hDivRow;

        // Cursor info
        const info = this.memoryPane.getCursorInfo();
        const addrStr = info.addr >= 0
            ? `$${info.addr.toString(16).toUpperCase().padStart(4, '0')}`
            : '----';
        const byteStr = info.byteOff >= 0
            ? `$${info.byteOff.toString(16).toUpperCase().padStart(3, '0')}`
            : '---';
        const cellStr = info.boardI >= 0 ? `(${info.boardI},${info.boardJ})` : '---';
        const neighStr = info.cellIdx >= 0 ? `#${info.cellIdx}` : '-';

        // Byte value at cursor
        let valStr = '';
        if (info.addr >= 0) {
            const val = this.controller.memory.read(info.addr);
            valStr = `=$${val.toString(16).toUpperCase().padStart(2, '0')}`;
        }

        // Simulation status
        const status = this.running
            ? fgRGB(0, 255, 0) + bold + 'RUN' + reset
            : dim + 'PAU' + reset;

        const statusText = ` ${status} `
            + `${dim}addr:${reset}${addrStr}${valStr} `
            + `${dim}cell:${reset}${cellStr} `
            + `${dim}off:${reset}${byteStr} `
            + `${dim}n:${reset}${neighStr} `
            + `${dim}int:${reset}${this.totalInterrupts} `
            + `${dim}spd:${reset}${this.speed} `;

        out += moveTo(row, 1) + statusText;

        return out;
    }
}
