// Memory Map Pane — top-left
// Two view modes:
//   'cell' (default): hex dump of the focused cell's 1024 bytes
//   'neighborhood': 7x7 neighborhood grid (sextant characters, one char per byte)
//
// Press 'v' to toggle between modes.

import { moveTo, ESC, reset, dim, bold } from '../ansi.js';
import { byteToSextant, byteColor, BORDER_COLOR, CURSOR_COLOR_ON, CURSOR_COLOR_OFF, hsvToRGB,
         byteToAsciiChar, DEFAULT_ASCII_PALETTE } from './sextant.js';
import { hex16 } from './disassembler.js';
import { readCellRegisters } from '../../../engine/board.js';

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

// --- Hex dump formatting helpers ---
function hexByte(val) {
    return val.toString(16).toUpperCase().padStart(2, '0');
}

function hexAddr(val) {
    return val.toString(16).toUpperCase().padStart(3, '0');
}

// Foreground color for a byte value (same ranges as neighborhood view)
function byteFgColor(byte) {
    if (byte === 0x00) return [60, 60, 70];
    if (byte <= 0x1F) return [255, 80, 80];
    if (byte <= 0x7E) return [255, 255, 255];
    if (byte === 0x7F) return [255, 255, 0];
    if (byte <= 0x9F) return [220, 100, 255];
    if (byte <= 0xFE) return [80, 220, 255];
    return [255, 255, 100];
}

export class MemoryPane {
    constructor(memory, controller) {
        this.memory = memory;
        this.controller = controller;
        this.app = null; // set by TerminalApp after construction
        // The board cell whose 7x7 neighborhood we're displaying
        this.centerI = 0;
        this.centerJ = 0;
        // View mode: 'cell' (hex dump) or 'neighborhood' (7x7 grid)
        this.viewMode = 'cell';
        // --- Cell view state ---
        // Cursor offset within the 1024-byte cell (0-1023)
        this.cellCursorOffset = 0;
        // Scroll row for hex dump (each row = 16 bytes, 64 rows total)
        this.cellScrollRow = 0;
        // --- Neighborhood view state ---
        // Viewport in the 224x224 grid
        this.scrollX = 3 * 32; // start centered on the center cell (grid pos 3,3)
        this.scrollY = 3 * 32;
        // Cursor position in the grid
        this.cursorCol = 3 * 32;
        this.cursorRow = 3 * 32;
        // Flash state (250ms cursor blink)
        this.flashOn = true;
        this.lastFlash = 0;
        // Configurable palette
        this.palette = { ...DEFAULT_ASCII_PALETTE };
        // Cached PC grid positions (set of "col,row" strings for fast lookup)
        this._pcPositions = new Map(); // "col,row" → cellIdx
        this._pcDirty = true;
        // Last rendered cursor position (for partial redraw)
        this._lastCursorScreenCol = -1;
        this._lastCursorScreenRow = -1;
        this._lastRect = null;
        // Whether this pane is currently focused (set by app before render)
        this.focused = false;
    }

    get cursorAddr() {
        if (this.viewMode === 'cell') {
            // In cell mode, the "address" is the cell-local offset
            return this.cellCursorOffset;
        }
        return gridToAddr(this.cursorCol, this.cursorRow);
    }

    // Set which board cell is the center of the displayed neighborhood
    setCenter(i, j) {
        this.centerI = ((i % this.memory.B) + this.memory.B) % this.memory.B;
        this.centerJ = ((j % this.memory.B) + this.memory.B) % this.memory.B;
        this._pcDirty = true;
    }

    // Move the center cell (and keep cursor at same relative position within grid)
    moveCenter(di, dj) {
        const B = this.memory.B;
        this.centerI = (this.centerI + di + B) % B;
        this.centerJ = (this.centerJ + dj + B) % B;
        this._pcDirty = true;
    }

    // Move cursor by delta
    moveCursor(dx, dy) {
        if (this.viewMode === 'cell') {
            this.moveCellCursor(dx, dy);
        } else {
            this.cursorCol = Math.max(0, Math.min(223, this.cursorCol + dx));
            this.cursorRow = Math.max(0, Math.min(223, this.cursorRow + dy));
        }
    }

    // Move cursor in cell hex dump mode
    moveCellCursor(dx, dy) {
        // dx moves by byte, dy moves by row (16 bytes)
        let newOffset = this.cellCursorOffset + dx + dy * 16;
        newOffset = Math.max(0, Math.min(1023, newOffset));
        this.cellCursorOffset = newOffset;
    }

    // Jump cursor to a cell (by cell index in spiral order)
    jumpToCell(cellIdx) {
        if (this.viewMode === 'cell') {
            // In cell mode, jumping to cell doesn't really apply — stay at offset 0
            this.cellCursorOffset = 0;
            return;
        }
        if (cellIdx < 0 || cellIdx >= 49) return;
        const [gx, gy] = cellToGrid[cellIdx];
        this.cursorCol = gx * 32 + 16;
        this.cursorRow = gy * 32 + 16;
    }

    // Jump cursor to a specific address
    jumpToAddr(addr) {
        if (this.viewMode === 'cell') {
            // addr is memory-mapped; extract byte offset within cell
            const byteOff = addr & 0x3FF;
            this.cellCursorOffset = byteOff;
            return;
        }
        const pos = addrToGrid(addr);
        if (pos) {
            this.cursorCol = pos.col;
            this.cursorRow = pos.row;
        }
    }

    // Move the board-level cell focus (ctrl+arrows equivalent)
    // Moves the center cell, keeping cursor at same grid position
    moveCellFocus(dx, dy) {
        this.moveCenter(dx, dy);
    }

    // Toggle between cell and neighborhood view
    toggleViewMode() {
        if (this.viewMode === 'cell') {
            // Switching to neighborhood: sync neighborhood cursor to center cell at current offset
            const mappedAddr = (0 << 10) | (this.cellCursorOffset & 0x3FF);
            const pos = addrToGrid(mappedAddr);
            if (pos) {
                this.cursorCol = pos.col;
                this.cursorRow = pos.row;
            }
            this.viewMode = 'neighborhood';
        } else {
            // Switching to cell: sync cell cursor to current neighborhood cursor offset
            const addr = gridToAddr(this.cursorCol, this.cursorRow);
            if (addr >= 0) {
                this.cellCursorOffset = addr & 0x3FF;
            }
            this.viewMode = 'cell';
        }
    }

    // Ensure cursor is visible by scrolling viewport
    ensureCursorVisible(rect) {
        if (this.viewMode === 'cell') {
            this.ensureCellCursorVisible(rect);
            return;
        }
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

    // Ensure cursor row is visible in cell hex dump
    ensureCellCursorVisible(rect) {
        const cursorRow = Math.floor(this.cellCursorOffset / 16);
        // Reserve 1 line for header
        const visibleRows = rect.height - 1;
        if (visibleRows <= 0) return;
        if (cursorRow < this.cellScrollRow) {
            this.cellScrollRow = cursorRow;
        }
        if (cursorRow >= this.cellScrollRow + visibleRows) {
            this.cellScrollRow = cursorRow - visibleRows + 1;
        }
    }

    // Read a byte from storage for a given grid position
    // Maps grid → cell index → absolute board coords → storage byte
    readByteAt(gridCol, gridRow) {
        const addr = gridToAddr(gridCol, gridRow);
        if (addr < 0) return 0;
        const cellIdx = addr >> 10;
        const byteOff = addr & 0x3FF;
        const [dx, dy] = spiralVec[cellIdx];
        const B = this.memory.B;
        const i = (this.centerI + dx + B) % B;
        const j = (this.centerJ + dy + B) % B;
        const storageIdx = this.memory.ijbToByteIndex(i, j, byteOff);
        return this.memory.getByte(storageIdx);
    }

    // Read a byte from the focused cell at a given offset (0-1023)
    readCellByte(offset) {
        const storageIdx = this.memory.ijbToByteIndex(this.centerI, this.centerJ, offset);
        return this.memory.getByte(storageIdx);
    }

    // Get info about what the cursor is pointing at
    getCursorInfo() {
        if (this.viewMode === 'cell') {
            return this.getCellCursorInfo();
        }
        const addr = this.cursorAddr;
        const gx = Math.floor(this.cursorCol / 32);
        const gy = Math.floor(this.cursorRow / 32);
        const cellIdx = gridToCell[gy * 7 + gx];
        const byteOff = addr >= 0 ? addr & 0x3FF : -1;

        // Map cell index to absolute board coords using our center cell
        let boardI = -1, boardJ = -1;
        if (cellIdx >= 0) {
            const [dx, dy] = spiralVec[cellIdx];
            const B = this.memory.B;
            boardI = (this.centerI + dx + B) % B;
            boardJ = (this.centerJ + dy + B) % B;
        }

        return { addr, cellIdx, byteOff, boardI, boardJ, gx, gy };
    }

    // Get cursor info for cell view mode
    getCellCursorInfo() {
        const byteOff = this.cellCursorOffset;
        return {
            addr: byteOff, // cell-local offset
            cellIdx: 0, // center cell
            byteOff,
            boardI: this.centerI,
            boardJ: this.centerJ,
            gx: 3, gy: 3, // center of 7x7 grid
        };
    }

    // Compute scheduler mapping info for the byte under cursor
    // Returns { mapped: true, schedI, schedJ, mappedAddr } or { mapped: false }
    getSchedulerMapping() {
        const focusI = this.centerI;
        const focusJ = this.centerJ;
        const byteOff = this.viewMode === 'cell'
            ? this.cellCursorOffset
            : (this.cursorAddr >= 0 ? this.cursorAddr & 0x3FF : -1);

        if (byteOff < 0) return { mapped: false };

        const schedI = this.memory.iOrig;
        const schedJ = this.memory.jOrig;
        const B = this.memory.B;

        // Check if the focused cell is within the 7×7 neighborhood of the scheduler's cell
        const di = ((focusI - schedI + B + Math.floor(B / 2)) % B) - Math.floor(B / 2);
        const dj = ((focusJ - schedJ + B + Math.floor(B / 2)) % B) - Math.floor(B / 2);

        if (Math.abs(di) > 3 || Math.abs(dj) > 3) {
            return { mapped: false, schedI, schedJ };
        }

        // Find the cell index in the scheduler's neighborhood
        // spiralVec maps cell index → [dx, dy]
        let neighIdx = -1;
        for (let idx = 0; idx < 49; idx++) {
            const [sx, sy] = spiralVec[idx];
            if (sx === di && sy === dj) {
                neighIdx = idx;
                break;
            }
        }

        if (neighIdx < 0) return { mapped: false, schedI, schedJ };

        const mappedAddr = (neighIdx << 10) | byteOff;
        return { mapped: true, schedI, schedJ, mappedAddr };
    }

    // Mark PC positions as needing recomputation (call after stepping/running)
    invalidatePC() {
        this._pcDirty = true;
    }

    // Recompute the set of grid positions where each neighbor's PC points
    _refreshPCPositions() {
        this._pcPositions.clear();
        if (!this.controller) { this._pcDirty = false; return; }
        const B = this.memory.B;
        for (let cellIdx = 0; cellIdx < 49; cellIdx++) {
            const [dx, dy] = spiralVec[cellIdx];
            const i = (this.centerI + dx + B) % B;
            const j = (this.centerJ + dy + B) % B;
            const regs = readCellRegisters(this.controller, i, j);
            const pc = regs.PC;
            // PC is in the memory-mapped address space; convert to grid position
            // PC addresses are cell-local (0x000-0x3FF), within this cell's address range
            const addr = (cellIdx << 10) | (pc & 0x3FF);
            const pos = addrToGrid(addr);
            if (pos) {
                this._pcPositions.set(`${pos.col},${pos.row}`, cellIdx);
            }
        }
        this._pcDirty = false;
    }

    // Render a single cell at the given grid position, returning the ANSI string
    _renderCell(gridCol, gridRow, isCursor, flashOn) {
        const pal = this.palette;
        const fg = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
        const bg = (r, g, b) => `\x1b[48;2;${r};${g};${b}m`;

        if (gridRow < 0 || gridRow >= 224 || gridCol < 0 || gridCol >= 224) {
            return reset + ' ';
        }
        const addr = gridToAddr(gridCol, gridRow);
        if (addr < 0) return reset + ' ';

        const byte = this.readByteAt(gridCol, gridRow);
        const { char } = byteToAsciiChar(byte, pal);

        // Determine background color
        const isOnBorder = (gridCol % 32 === 31) || (gridRow % 32 === 31);
        const pcKey = `${gridCol},${gridRow}`;
        const pcCellIdx = this._pcPositions.get(pcKey);
        let bgColor;
        if (pcCellIdx !== undefined) {
            bgColor = pcCellIdx === 0 ? pal.bgCenterPC : pal.bgPC;
        } else if (isOnBorder) {
            bgColor = pal.bgBorder;
        } else if (this.focused) {
            bgColor = [20, 20, 40]; // dark blue tint for active pane
        } else {
            bgColor = pal.bgDefault;
        }

        // Determine foreground color by byte value range
        let effectiveFg;
        if (byte === 0x00) {
            effectiveFg = [60, 60, 70];       // dark grey — zero/empty
        } else if (byte <= 0x1F) {
            effectiveFg = [255, 80, 80];       // red — control chars, BRK operands
        } else if (byte <= 0x7E) {
            effectiveFg = [255, 255, 255];     // bright white — printable ASCII
        } else if (byte === 0x7F) {
            effectiveFg = [255, 255, 0];       // yellow — DEL
        } else if (byte <= 0x9F) {
            effectiveFg = [220, 100, 255];     // magenta — high control / undocumented opcodes
        } else if (byte <= 0xFE) {
            effectiveFg = [80, 220, 255];      // cyan — high printable / data
        } else {
            effectiveFg = [255, 255, 100];     // bright yellow — $FF sentinel
        }

        if (isCursor && flashOn) {
            // Use ANSI reverse video for full color inversion
            return fg(...effectiveFg) + bg(...bgColor) + '\x1b[7m' + char + reset;
        } else {
            return fg(...effectiveFg) + bg(...bgColor) + char + reset;
        }
    }

    // Render just the cursor cell (old and new positions) for flash updates
    renderCursorFlash(rect) {
        if (!this._lastRect) return '';

        const now = Date.now();
        const newFlash = (now - this.lastFlash > 250);
        if (!newFlash) return '';

        this.flashOn = !this.flashOn;
        this.lastFlash = now;

        if (this.viewMode === 'cell') {
            // For cell mode, we'd need a partial redraw of the hex dump cursor
            // For now, trigger a full render via needsRender
            return '';
        }

        let out = '';
        const cursorScreenCol = this.cursorCol - this.scrollX;
        const cursorScreenRow = this.cursorRow - this.scrollY;

        // Redraw current cursor position
        if (cursorScreenCol >= 0 && cursorScreenCol < rect.width &&
            cursorScreenRow >= 0 && cursorScreenRow < rect.height) {
            out += moveTo(rect.row + cursorScreenRow, rect.col + cursorScreenCol);
            out += this._renderCell(this.cursorCol, this.cursorRow, true, this.flashOn);
        }

        return out;
    }

    render(rect) {
        if (this.viewMode === 'cell') {
            return this.renderCellView(rect);
        }
        return this.renderNeighborhoodView(rect);
    }

    // Render the single-cell hex dump view
    renderCellView(rect) {
        const now = Date.now();
        if (now - this.lastFlash > 250) {
            this.flashOn = !this.flashOn;
            this.lastFlash = now;
        }

        this.ensureCellCursorVisible(rect);
        this._lastRect = rect;

        const fg = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
        const bg = (r, g, b) => `\x1b[48;2;${r};${g};${b}m`;
        const focusBg = this.focused ? bg(20, 20, 40) : bg(0, 0, 0);

        // Get PC for the focused cell
        let cellPC = -1;
        if (this.controller) {
            const regs = readCellRegisters(this.controller, this.centerI, this.centerJ);
            cellPC = regs.PC & 0x3FF;
        }

        let out = '';
        const visibleRows = rect.height;
        const BYTES_PER_ROW = 16;

        for (let screenRow = 0; screenRow < visibleRows; screenRow++) {
            out += moveTo(rect.row + screenRow, rect.col);
            const dataRow = this.cellScrollRow + screenRow;
            const rowAddr = dataRow * BYTES_PER_ROW;

            if (rowAddr >= 1024) {
                // Past end of cell data — blank line
                out += focusBg + ' '.repeat(Math.min(rect.width, 76)) + reset;
                continue;
            }

            // Address column: "$XXX: "
            out += focusBg + dim + '$' + hexAddr(rowAddr) + ': ' + reset;
            let col = 7; // characters used so far

            // Hex bytes (two groups of 8)
            for (let i = 0; i < BYTES_PER_ROW && col + 3 <= rect.width; i++) {
                const offset = rowAddr + i;
                if (offset >= 1024) {
                    out += focusBg + '   ' + reset;
                    col += 3;
                    if (i === 7 && col + 1 <= rect.width) { out += ' '; col++; }
                    continue;
                }
                const byte = this.readCellByte(offset);
                const isCursor = (offset === this.cellCursorOffset);
                const isPC = (offset === cellPC);
                const fgColor = byteFgColor(byte);

                let cellBg;
                if (isPC) {
                    cellBg = bg(0, 140, 140); // cyan for PC
                } else if (this.focused) {
                    cellBg = bg(20, 20, 40);
                } else {
                    cellBg = bg(0, 0, 0);
                }

                const hexStr = hexByte(byte);
                if (isCursor && this.flashOn) {
                    out += fg(...fgColor) + cellBg + '\x1b[7m' + hexStr + reset + focusBg + ' ';
                } else {
                    out += fg(...fgColor) + cellBg + hexStr + reset + focusBg + ' ';
                }
                col += 3;

                // Extra space between byte 7 and 8
                if (i === 7 && col + 1 <= rect.width) {
                    out += ' ';
                    col++;
                }
            }

            // ASCII sidebar (if room)
            if (col + 2 + BYTES_PER_ROW <= rect.width) {
                out += focusBg + dim + ' ' + reset + focusBg;
                col += 1;
                for (let i = 0; i < BYTES_PER_ROW; i++) {
                    const offset = rowAddr + i;
                    if (offset >= 1024) {
                        out += ' ';
                        col++;
                        continue;
                    }
                    const byte = this.readCellByte(offset);
                    const isCursor = (offset === this.cellCursorOffset);

                    // ASCII printable range
                    let ch;
                    if (byte >= 0x20 && byte <= 0x7E) {
                        ch = String.fromCharCode(byte);
                    } else if (byte === 0) {
                        ch = '.';
                    } else {
                        ch = '.';
                    }

                    const fgColor = byteFgColor(byte);
                    if (isCursor && this.flashOn) {
                        out += fg(...fgColor) + focusBg + '\x1b[7m' + ch + reset + focusBg;
                    } else {
                        out += fg(...fgColor) + focusBg + ch + reset + focusBg;
                    }
                    col++;
                }
            }

            // Fill remaining width
            if (col < rect.width) {
                out += focusBg + ' '.repeat(rect.width - col) + reset;
            }
        }

        return out;
    }

    // Render the neighborhood grid view (original behavior)
    renderNeighborhoodView(rect) {
        const now = Date.now();
        if (now - this.lastFlash > 250) {
            this.flashOn = !this.flashOn;
            this.lastFlash = now;
        }

        this.ensureCursorVisible(rect);
        this._lastRect = rect;

        // Refresh PC positions if needed
        if (this._pcDirty) this._refreshPCPositions();

        let out = '';

        for (let screenRow = 0; screenRow < rect.height; screenRow++) {
            out += moveTo(rect.row + screenRow, rect.col);
            const gridRow = this.scrollY + screenRow;

            for (let screenCol = 0; screenCol < rect.width; screenCol++) {
                const gridCol = this.scrollX + screenCol;
                const isCursor = (gridCol === this.cursorCol && gridRow === this.cursorRow);

                if (isCursor) {
                    this._lastCursorScreenCol = rect.col + screenCol;
                    this._lastCursorScreenRow = rect.row + screenRow;
                }

                out += this._renderCell(gridCol, gridRow, isCursor, this.flashOn);
            }
        }

        return out;
    }
}

export { addrToGrid, gridToAddr, cellToGrid, gridToCell, spiralVec };
