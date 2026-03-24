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
        // Pagination state
        this._paginating = false;
        this._paginatedLines = [];
        this._paginatedPage = 0;
        this._paginatedTotal = 0;
        this._pageSize = 5; // will be recalculated on render
    }

    // Add text to output — starts pagination if text exceeds pane height
    print(text, forcePaginate) {
        const lines = text.split('\n');
        // Check if this output needs pagination (more lines than visible area)
        if (lines.length > this._pageSize && this._pageSize > 2) {
            this._startPagination(lines);
            return;
        }
        for (const line of lines) {
            this.outputLines.push(line);
        }
        while (this.outputLines.length > this.maxOutput) {
            this.outputLines.shift();
        }
    }

    // Start paginated display of long output
    _startPagination(lines) {
        this._paginating = true;
        this._paginatedLines = lines;
        this._paginatedPage = 0;
        this._paginatedTotal = Math.ceil(lines.length / Math.max(1, this._pageSize - 1)); // -1 for footer
    }

    // Get the current page of paginated output
    _getPaginatedOutput() {
        const linesPerPage = Math.max(1, this._pageSize - 1); // -1 for footer
        const start = this._paginatedPage * linesPerPage;
        const pageLines = this._paginatedLines.slice(start, start + linesPerPage);
        const footer = `Page ${this._paginatedPage + 1}/${this._paginatedTotal}  [n]ext [p]rev [s]top`;
        return [...pageLines, footer];
    }

    // Handle pagination key
    _handlePaginationKey(key) {
        if (key === 'n' || key === ' ' || key === '\x1b[B') {
            // Next page
            if (this._paginatedPage < this._paginatedTotal - 1) {
                this._paginatedPage++;
            }
            return true;
        }
        if (key === 'p' || key === '\x1b[A') {
            // Previous page
            if (this._paginatedPage > 0) {
                this._paginatedPage--;
            }
            return true;
        }
        if (key === 's' || key === 'q' || key === '\x1b') {
            // Stop pagination — dump remaining content into scrollback
            for (const line of this._paginatedLines) {
                this.outputLines.push(line);
            }
            while (this.outputLines.length > this.maxOutput) {
                this.outputLines.shift();
            }
            this._paginating = false;
            this._paginatedLines = [];
            return true;
        }
        // Any other key: stop pagination and don't consume the key
        for (const line of this._paginatedLines) {
            this.outputLines.push(line);
        }
        while (this.outputLines.length > this.maxOutput) {
            this.outputLines.shift();
        }
        this._paginating = false;
        this._paginatedLines = [];
        return false; // key not consumed
    }

    // Handle a keypress (when command pane has focus)
    handleKey(key) {
        // Intercept keys during pagination
        if (this._paginating) {
            const consumed = this._handlePaginationKey(key);
            if (consumed) return;
            // If not consumed, fall through to normal handling
        }

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

        // Update page size based on current pane dimensions
        const outputRows = rect.height - 1; // -1 for input line
        this._pageSize = outputRows;

        if (this._paginating) {
            // Show paginated content
            const pageLines = this._getPaginatedOutput();
            for (let i = 0; i < outputRows; i++) {
                out += moveTo(rect.row + i, rect.col);
                if (i < pageLines.length) {
                    const line = pageLines[i];
                    if (i === pageLines.length - 1) {
                        // Footer line: highlight it
                        out += fgRGB(100, 200, 255) + line.slice(0, rect.width) + reset;
                    } else {
                        out += dim + line.slice(0, rect.width) + reset;
                    }
                }
            }
        } else {
            // Normal scrollback display — fill from bottom up
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
        }

        // Input line
        const inputRow = rect.row + rect.height - 1;
        out += moveTo(inputRow, rect.col);
        if (this._paginating) {
            // During pagination, show a hint instead of prompt
            out += fgRGB(100, 200, 255) + 'n/p/s' + reset + dim + '> ' + reset;
        } else {
            const prompt = hasFocus ? fgRGB(100, 255, 100) + '> ' + reset : dim + '> ' + reset;
            const input = this.inputBuffer.slice(0, rect.width - 3);
            out += prompt + input;
        }

        // Cursor (when focused and not paginating, show a block cursor)
        if (hasFocus && !this._paginating) {
            const curCol = rect.col + 2 + this.cursorPos;
            if (curCol < rect.col + rect.width) {
                const ch = this.cursorPos < this.inputBuffer.length ? this.inputBuffer[this.cursorPos] : ' ';
                out += moveTo(inputRow, curCol) + `${ESC}7m` + ch + reset;
            }
        }

        return out;
    }
}
