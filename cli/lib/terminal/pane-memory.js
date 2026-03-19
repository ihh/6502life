// Memory Map Pane — top-left
// Shows the 7x7 neighborhood memory map as sextant characters
// Each terminal char = 1 byte address
// Each cell = 32x32 terminal chars (1024 bytes in row-major order)
// 7x7 cells laid out in spiral order → 224x224 total grid

import { moveTo, ESC, reset, dim, bold } from '../ansi.js';
import { byteToSextant, byteColor, BORDER_COLOR, CURSOR_COLOR_ON, CURSOR_COLOR_OFF, hsvToRGB } from './sextant.js';
import { hex16 } from './disassembler.js';

// Build the spiral layout: map (gridX, gridY) → cell index for the 7x7 neighborhood
// Using the same spiral order as memory.js
const coordRange = [-3, -2, -1, 0, 1, 2, 3];
const taxicab = (v) => Math.abs(v[0]) + Math.abs(v[1]);
const maxDelta = (v) => Math.max(Math.abs(v[0]), Math.abs(v[1]));
const posAngle = (a) => a < 0 ? a + 2 * Math.PI : a;
const angle = (v) => posAngle(Math.atan2(v[0], v[1]));

const spiralVec = [];
for (const y of coordRange) {
    for (const x of coordRange) {
        spiralVec.push([x, y]);
    }
}
spiralVec.sort((a, b) => taxicab(a) - taxicab(b) || maxDelta(a) - maxDelta(b) || angle(a) - angle(b));

// Map from cell index → (gridX, gridY) offset in the 7x7 grid
// gridX, gridY range from 0-6 (adding 3 to the spiral offset)
const cellToGrid = spiralVec.map(([x, y]) => [x + 3, y + 3]);

// Map from (gridX, gridY) → cell index
const gridToCell = new Array(7 * 7).fill(-1);
cellToGrid.forEach(([gx, gy], idx) => {
    gridToCell[gy * 7 + gx] = idx;
});

// Convert a byte address in the memory-mapped space to (termCol, termRow) in the 224x224 grid
// Address format: top 6 bits = cell index, bottom 10 bits = byte offset
// Within a cell: byte offset → (byteX, byteY) in 32x32 row-major
function addrToGrid(addr) {
    if (addr < 0 || addr >= 49 * 1024) return null;
    const cellIdx = addr >> 10;
    const byteOff = addr & 0x3FF;
    const [gx, gy] = cellToGrid[cellIdx];
    const byteX = byteOff % 32;
    const byteY = Math.floor(byteOff / 32);
    return {
        col: gx * 32 + byteX,
        row: gy * 32 + byteY,
        cellIdx,
        gx, gy,
        byteX, byteY,
    };
}

// Convert (termCol, termRow) in the 224x224 grid to memory-mapped address
function gridToAddr(col, row) {
    if (col < 0 || col >= 224 || row < 0 || row >= 224) return -1;
    const gx = Math.floor(col / 32);
    const gy = Math.floor(row / 32);
    const cellIdx = gridToCell[gy * 7 + gx];
    if (cellIdx < 0) return -1;
    const byteX = col % 32;
    const byteY = row % 32;
    const byteOff = byteY * 32 + byteX;
    return (cellIdx << 10) | byteOff;
}

export class MemoryPane {
    constructor(memory) {
        this.memory = memory;
        // Viewport in the 224x224 grid
        this.scrollX = 3 * 32; // start centered on origin cell (grid pos 3,3)
        this.scrollY = 3 * 32;
        // Cursor position in the grid
        this.cursorCol = 3 * 32;
        this.cursorRow = 3 * 32;
        // Flash state
        this.flashOn = true;
        this.lastFlash = 0;
    }

    get cursorAddr() {
        return gridToAddr(this.cursorCol, this.cursorRow);
    }

    // Move cursor by delta
    moveCursor(dx, dy) {
        this.cursorCol = Math.max(0, Math.min(223, this.cursorCol + dx));
        this.cursorRow = Math.max(0, Math.min(223, this.cursorRow + dy));
    }

    // Jump cursor to a cell (by cell index in spiral order)
    jumpToCell(cellIdx) {
        if (cellIdx < 0 || cellIdx >= 49) return;
        const [gx, gy] = cellToGrid[cellIdx];
        this.cursorCol = gx * 32 + 16;
        this.cursorRow = gy * 32 + 16;
    }

    // Jump cursor to a specific address
    jumpToAddr(addr) {
        const pos = addrToGrid(addr);
        if (pos) {
            this.cursorCol = pos.col;
            this.cursorRow = pos.row;
        }
    }

    // Move the board-level cell focus (ctrl+arrows equivalent)
    // This changes which board cell's VM we're inspecting
    moveCellFocus(dx, dy) {
        const gx = Math.floor(this.cursorCol / 32);
        const gy = Math.floor(this.cursorRow / 32);
        const newGx = Math.max(0, Math.min(6, gx + dx));
        const newGy = Math.max(0, Math.min(6, gy + dy));
        this.cursorCol = newGx * 32 + (this.cursorCol % 32);
        this.cursorRow = newGy * 32 + (this.cursorRow % 32);
    }

    // Ensure cursor is visible by scrolling viewport
    ensureCursorVisible(rect) {
        const margin = 4;
        if (this.cursorCol < this.scrollX + margin) {
            this.scrollX = Math.max(0, this.cursorCol - margin);
        }
        if (this.cursorCol >= this.scrollX + rect.width - margin) {
            this.scrollX = Math.min(224 - rect.width, this.cursorCol - rect.width + margin + 1);
        }
        if (this.cursorRow < this.scrollY + margin) {
            this.scrollY = Math.max(0, this.cursorRow - margin);
        }
        if (this.cursorRow >= this.scrollY + rect.height - margin) {
            this.scrollY = Math.min(224 - rect.height, this.cursorRow - rect.height + margin + 1);
        }
    }

    // Get info about what the cursor is pointing at
    getCursorInfo() {
        const addr = this.cursorAddr;
        const gx = Math.floor(this.cursorCol / 32);
        const gy = Math.floor(this.cursorRow / 32);
        const cellIdx = gridToCell[gy * 7 + gx];
        const byteOff = addr >= 0 ? addr & 0x3FF : -1;

        // Map cell index to absolute board coords
        let boardI = -1, boardJ = -1;
        if (cellIdx >= 0) {
            const [dx, dy] = spiralVec[cellIdx];
            boardI = (this.memory.iOrig + dx + this.memory.B) % this.memory.B;
            boardJ = (this.memory.jOrig + dy + this.memory.B) % this.memory.B;
        }

        return { addr, cellIdx, byteOff, boardI, boardJ, gx, gy };
    }

    render(rect) {
        const now = Date.now();
        if (now - this.lastFlash > 400) {
            this.flashOn = !this.flashOn;
            this.lastFlash = now;
        }

        this.ensureCursorVisible(rect);

        let out = '';
        const { fgRGB, bgRGB } = getColorFns();

        for (let screenRow = 0; screenRow < rect.height; screenRow++) {
            out += moveTo(rect.row + screenRow, rect.col);
            const gridRow = this.scrollY + screenRow;

            for (let screenCol = 0; screenCol < rect.width; screenCol++) {
                const gridCol = this.scrollX + screenCol;

                if (gridRow < 0 || gridRow >= 224 || gridCol < 0 || gridCol >= 224) {
                    out += ' ';
                    continue;
                }

                const addr = gridToAddr(gridCol, gridRow);
                const isCursor = (gridCol === this.cursorCol && gridRow === this.cursorRow);
                const isOnCellBorderX = (gridCol % 32 === 31);
                const isOnCellBorderY = (gridRow % 32 === 31);

                if (addr < 0) {
                    out += ' ';
                    continue;
                }

                const byte = this.memory.read(addr);
                const ch = byteToSextant(byte);
                const [cr, cg, cb] = byteColor(byte);

                if (isCursor && this.flashOn) {
                    out += fgRGB(0, 0, 0) + bgRGB(255, 255, 0) + ch + reset;
                } else if (isOnCellBorderX || isOnCellBorderY) {
                    out += fgRGB(cr, cg, cb) + bgRGB(...BORDER_COLOR) + ch + reset;
                } else {
                    out += fgRGB(cr, cg, cb) + ch + reset;
                }
            }
        }

        return out;
    }
}

function getColorFns() {
    return {
        fgRGB: (r, g, b) => `\x1b[38;2;${r};${g};${b}m`,
        bgRGB: (r, g, b) => `\x1b[48;2;${r};${g};${b}m`,
    };
}

export { addrToGrid, gridToAddr, cellToGrid, gridToCell, spiralVec };
