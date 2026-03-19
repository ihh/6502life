// Command Pane — bottom-left
// CLI input with command history and output scrollback

import { moveTo, ESC, reset, dim, bold } from '../ansi.js';
import { fgRGB } from '../ansi.js';

export class CommandPane {
    constructor() {
        this.inputBuffer = '';
        this.cursorPos = 0;
        this.history = [];
        this.historyIndex = -1;
        this.outputLines = [];
        this.maxOutput = 200;
        // Callback for command execution
        this.onCommand = null;
    }

    // Add text to output
    print(text) {
        const lines = text.split('\n');
        for (const line of lines) {
            this.outputLines.push(line);
        }
        while (this.outputLines.length > this.maxOutput) {
            this.outputLines.shift();
        }
    }

    // Handle a keypress (when command pane has focus)
    handleKey(key) {
        if (key === '\r' || key === '\n') {
            // Execute command
            const cmd = this.inputBuffer.trim();
            if (cmd) {
                this.history.push(cmd);
                this.print(`> ${cmd}`);
                if (this.onCommand) {
                    try {
                        const result = this.onCommand(cmd);
                        if (result) this.print(result);
                    } catch (e) {
                        this.print(`Error: ${e.message}`);
                    }
                }
            }
            this.inputBuffer = '';
            this.cursorPos = 0;
            this.historyIndex = -1;
            return;
        }

        if (key === '\x7f' || key === '\b') {
            // Backspace
            if (this.cursorPos > 0) {
                this.inputBuffer = this.inputBuffer.slice(0, this.cursorPos - 1) + this.inputBuffer.slice(this.cursorPos);
                this.cursorPos--;
            }
            return;
        }

        if (key === '\x1b[A') {
            // Up arrow — history
            if (this.history.length > 0) {
                if (this.historyIndex < 0) this.historyIndex = this.history.length;
                this.historyIndex = Math.max(0, this.historyIndex - 1);
                this.inputBuffer = this.history[this.historyIndex];
                this.cursorPos = this.inputBuffer.length;
            }
            return;
        }

        if (key === '\x1b[B') {
            // Down arrow — history
            if (this.historyIndex >= 0) {
                this.historyIndex++;
                if (this.historyIndex >= this.history.length) {
                    this.historyIndex = -1;
                    this.inputBuffer = '';
                } else {
                    this.inputBuffer = this.history[this.historyIndex];
                }
                this.cursorPos = this.inputBuffer.length;
            }
            return;
        }

        if (key === '\x1b[D') {
            // Left
            this.cursorPos = Math.max(0, this.cursorPos - 1);
            return;
        }

        if (key === '\x1b[C') {
            // Right
            this.cursorPos = Math.min(this.inputBuffer.length, this.cursorPos + 1);
            return;
        }

        if (key === '\x01') {
            // Ctrl-A: start of line
            this.cursorPos = 0;
            return;
        }

        if (key === '\x05') {
            // Ctrl-E: end of line
            this.cursorPos = this.inputBuffer.length;
            return;
        }

        if (key === '\x0b') {
            // Ctrl-K: kill to end of line
            this.inputBuffer = this.inputBuffer.slice(0, this.cursorPos);
            return;
        }

        if (key === '\x15') {
            // Ctrl-U: kill whole line
            this.inputBuffer = '';
            this.cursorPos = 0;
            return;
        }

        // Regular character
        if (key.length === 1 && key >= ' ') {
            this.inputBuffer = this.inputBuffer.slice(0, this.cursorPos) + key + this.inputBuffer.slice(this.cursorPos);
            this.cursorPos++;
        }
    }

    render(rect, hasFocus) {
        let out = '';

        // Output area (scrollback) — fill from bottom up
        const outputRows = rect.height - 1; // -1 for input line
        const startLine = Math.max(0, this.outputLines.length - outputRows);

        for (let i = 0; i < outputRows; i++) {
            out += moveTo(rect.row + i, rect.col);
            const lineIdx = startLine + i;
            if (lineIdx < this.outputLines.length) {
                const line = this.outputLines[lineIdx];
                out += dim + line.slice(0, rect.width) + reset;
            } else {
                out += ' '.repeat(Math.min(rect.width, 1));
            }
        }

        // Input line
        const inputRow = rect.row + rect.height - 1;
        out += moveTo(inputRow, rect.col);
        const prompt = hasFocus ? fgRGB(100, 255, 100) + '> ' + reset : dim + '> ' + reset;
        const input = this.inputBuffer.slice(0, rect.width - 3);
        out += prompt + input;

        // Cursor (when focused, show a block cursor)
        if (hasFocus) {
            const curCol = rect.col + 2 + this.cursorPos;
            if (curCol < rect.col + rect.width) {
                const ch = this.cursorPos < this.inputBuffer.length ? this.inputBuffer[this.cursorPos] : ' ';
                out += moveTo(inputRow, curCol) + `${ESC}7m` + ch + reset;
            }
        }

        return out;
    }
}
