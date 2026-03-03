import { readCellRegisters, readCellMemory } from '../../engine/board.js';
import { hexByte, hexWord, flagsString } from '../../engine/format.js';
import { fgRGB, bgRGB, reset, bold, dim, moveTo, clear, hideCursor, showCursor, altScreen, mainScreen, clearLine } from './ansi.js';
import { renderBoard } from './render.js';

const HALF_BLOCK = '\u2580';

export class TuiApp {
    constructor(controller, visualizer) {
        this.controller = controller;
        this.visualizer = visualizer;
        this.B = controller.memory.B;

        // Viewport
        this.viewX = 0;
        this.viewY = 0;
        this.zoom = 1;

        // Cursor (selected cell)
        this.cursorI = 0;
        this.cursorJ = 0;

        // Run state
        this.running = false;
        this.speed = 1; // interrupts per frame
        this.totalInterrupts = 0;

        // Render throttle
        this.lastRender = 0;
        this.minRenderInterval = 100; // ~10fps

        this.quit = false;
    }

    start() {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf-8');
        process.stdout.write(altScreen + hideCursor + clear());

        process.stdin.on('data', (key) => this.handleInput(key));

        this.render();
        this.tick();
    }

    stop() {
        this.running = false;
        process.stdout.write(showCursor + mainScreen);
        process.stdin.setRawMode(false);
        process.stdin.pause();
    }

    handleInput(key) {
        switch (key) {
            case 'q': case '\x03': // q or Ctrl-C
                this.quit = true;
                this.stop();
                process.exit(0);
                break;
            case ' ':
                this.step();
                break;
            case 'r':
                this.running = true;
                break;
            case 'p':
                this.running = false;
                this.render();
                break;
            case '\x1b[A': // Up
                this.cursorI = (this.cursorI - 1 + this.B) % this.B;
                if (!this.running) this.render();
                break;
            case '\x1b[B': // Down
                this.cursorI = (this.cursorI + 1) % this.B;
                if (!this.running) this.render();
                break;
            case '\x1b[C': // Right
                this.cursorJ = (this.cursorJ + 1) % this.B;
                if (!this.running) this.render();
                break;
            case '\x1b[D': // Left
                this.cursorJ = (this.cursorJ - 1 + this.B) % this.B;
                if (!this.running) this.render();
                break;
            case '+': case '=':
                this.zoom = Math.min(this.zoom + 1, 4);
                if (!this.running) this.render();
                break;
            case '-':
                this.zoom = Math.max(this.zoom - 1, 1);
                if (!this.running) this.render();
                break;
            default:
                if (key >= '1' && key <= '9') {
                    this.speed = Math.pow(2, parseInt(key) - 1);
                    if (!this.running) this.render();
                }
                break;
        }
    }

    step() {
        this.controller.runToNextInterrupt();
        this.totalInterrupts++;
        this.render();
    }

    tick() {
        if (this.quit) return;

        if (this.running) {
            for (let i = 0; i < this.speed; i++) {
                this.controller.runToNextInterrupt();
                this.totalInterrupts++;
            }

            const now = Date.now();
            if (now - this.lastRender >= this.minRenderInterval) {
                this.render();
                this.lastRender = now;
            }
        }

        setImmediate(() => this.tick());
    }

    render() {
        const cols = process.stdout.columns || 80;
        const rows = process.stdout.rows || 24;

        // Layout: board on left, inspector on right, status bar at bottom
        const inspectorWidth = 30;
        const boardWidth = Math.min(cols - inspectorWidth - 3, this.B);
        const boardHeight = Math.min((rows - 3) * 2, this.B); // *2 because half-block
        const boardTermRows = Math.ceil(boardHeight / 2);

        let out = clear();

        // Render board
        out += renderBoard(this.visualizer, 1, 1, this.viewX, this.viewY, boardWidth, boardHeight);

        // Render cursor marker
        const cursorScreenX = ((this.cursorJ - this.viewX + this.B) % this.B);
        const cursorScreenY = ((this.cursorI - this.viewY + this.B) % this.B);
        if (cursorScreenX >= 0 && cursorScreenX < boardWidth && cursorScreenY >= 0 && cursorScreenY < boardHeight) {
            const termRow = 1 + Math.floor(cursorScreenY / 2);
            const termCol = 1 + cursorScreenX;
            out += moveTo(termRow, termCol) + fgRGB(255, 255, 255) + bold + 'X' + reset;
        }

        // Inspector panel
        const panelCol = boardWidth + 3;
        const regs = readCellRegisters(this.controller, this.cursorI, this.cursorJ);

        out += moveTo(1, panelCol) + bold + `Cell (${this.cursorI},${this.cursorJ})` + reset;
        out += moveTo(2, panelCol) + `A=${hexByte(regs.A)} X=${hexByte(regs.X)} Y=${hexByte(regs.Y)} S=${hexByte(regs.S)}`;
        out += moveTo(3, panelCol) + `PC=${hexWord(regs.PC)}`;
        out += moveTo(4, panelCol) + `P=${flagsString(regs.P)} (${hexByte(regs.P)})`;

        // Mini hex dump (first 64 bytes)
        const mem = readCellMemory(this.controller, this.cursorI, this.cursorJ);
        const hexRows = Math.min(8, rows - 7);
        for (let r = 0; r < hexRows; r++) {
            const offset = r * 16;
            const hex = [];
            for (let k = 0; k < 8 && offset + k < mem.length; k++) {
                hex.push(hexByte(mem[offset + k]));
            }
            out += moveTo(6 + r, panelCol) + dim + hexWord(offset) + reset + ' ' + hex.join(' ');
        }

        // Status bar
        const statusRow = rows;
        const status = this.running ? fgRGB(0, 255, 0) + 'RUNNING' + reset : dim + 'PAUSED' + reset;
        out += moveTo(statusRow, 1) + clearLine;
        out += `[spc]step [r]run [p]ause [q]uit  ${status}  Spd:${this.speed}  Int:${this.totalInterrupts}`;

        process.stdout.write(out);
    }
}
