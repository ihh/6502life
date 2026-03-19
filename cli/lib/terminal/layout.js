// Four-pane layout manager
//
// +---------------------------+-----------------+
// |                           |                 |
// |   Memory Map (top-left)   |  Disassembler   |
// |                           |  (right)        |
// |                           |                 |
// +---------------------------+-----------------+
// |   Command (bottom-left)   |  Minimap        |
// |                           |  (bottom-right) |
// +---------------------------+-----------------+

import { moveTo, ESC, reset, dim } from '../ansi.js';

// Box-drawing characters
const BOX = {
    h: '\u2500', v: '\u2502',
    tl: '\u250C', tr: '\u2510', bl: '\u2514', br: '\u2518',
    lj: '\u251C', rj: '\u2524', tj: '\u252C', bj: '\u2534',
    cross: '\u253C',
};

export class Layout {
    constructor() {
        this.recalculate();
    }

    recalculate() {
        this.termW = process.stdout.columns || 120;
        this.termH = process.stdout.rows || 40;

        // Right pane width (disasm + minimap): ~35% of width, min 34, max 50
        this.rightW = Math.max(34, Math.min(50, Math.floor(this.termW * 0.35)));
        // Left pane width
        this.leftW = this.termW - this.rightW - 1; // -1 for vertical divider

        // Bottom pane height: ~25% of height, min 6, max 14
        this.bottomH = Math.max(6, Math.min(14, Math.floor(this.termH * 0.25)));
        // Top pane height
        this.topH = this.termH - this.bottomH - 1; // -1 for horizontal divider

        // Pane rects (all 1-indexed for moveTo)
        this.memory = { row: 1, col: 1, width: this.leftW, height: this.topH };
        this.disasm = { row: 1, col: this.leftW + 2, width: this.rightW, height: this.topH };
        this.command = { row: this.topH + 2, col: 1, width: this.leftW, height: this.bottomH };
        this.minimap = { row: this.topH + 2, col: this.leftW + 2, width: this.rightW, height: this.bottomH };

        // Divider positions
        this.vDivCol = this.leftW + 1;
        this.hDivRow = this.topH + 1;
    }

    // Render the divider lines between panes
    renderDividers(activePane) {
        let out = '';
        const color = dim;

        // Horizontal divider
        out += color;
        out += moveTo(this.hDivRow, 1);
        for (let c = 1; c <= this.termW; c++) {
            if (c === this.vDivCol) {
                out += BOX.cross;
            } else {
                out += BOX.h;
            }
        }

        // Vertical divider
        for (let r = 1; r < this.hDivRow; r++) {
            out += moveTo(r, this.vDivCol) + BOX.v;
        }
        for (let r = this.hDivRow + 1; r <= this.termH; r++) {
            out += moveTo(r, this.vDivCol) + BOX.v;
        }

        out += reset;

        // Pane labels with focus indicators
        const panes = [
            { name: ' MEM ', rect: this.memory, id: 'memory' },
            { name: ' DASM ', rect: this.disasm, id: 'disasm' },
            { name: ' CMD ', rect: this.command, id: 'command' },
            { name: ' MAP ', rect: this.minimap, id: 'minimap' },
        ];

        for (const p of panes) {
            const isActive = (activePane === p.id);
            const label = isActive ? `${ESC}7m${p.name}${reset}` : `${dim}${p.name}${reset}`;
            if (p.rect.row === 1) {
                // Top panes: label on horizontal divider
                out += moveTo(this.hDivRow, p.rect.col + 1) + label;
            } else {
                // Bottom panes: label on horizontal divider
                out += moveTo(this.hDivRow, p.rect.col + 1) + label;
            }
        }

        return out;
    }
}

export { BOX };
