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

        // ANSI color constants for focus indication
        const activeBorder = '\x1b[1;36m';   // bright cyan
        const inactiveBorder = '\x1b[2;37m'; // dim grey
        const activeTitle = '\x1b[1;33m';    // bright yellow bold
        const inactiveTitle = '\x1b[2;37m';  // dim grey

        // Determine which panes are active (for border coloring)
        // Left border segments: top-left (memory) and bottom-left (command)
        // Right border segments: top-right (disasm) and bottom-right (minimap)
        const topLeftActive = activePane === 'memory';
        const topRightActive = activePane === 'disasm';
        const botLeftActive = activePane === 'command';
        const botRightActive = activePane === 'minimap';

        // Horizontal divider — color each segment by adjacent pane focus
        out += moveTo(this.hDivRow, 1);
        // Left segment (between memory above, command below)
        const leftHActive = topLeftActive || botLeftActive;
        out += (leftHActive ? activeBorder : inactiveBorder);
        for (let c = 1; c < this.vDivCol; c++) {
            out += BOX.h;
        }
        // Cross
        out += (leftHActive || topRightActive || botRightActive ? activeBorder : inactiveBorder);
        out += BOX.cross;
        // Right segment (between disasm above, minimap below)
        const rightHActive = topRightActive || botRightActive;
        out += (rightHActive ? activeBorder : inactiveBorder);
        for (let c = this.vDivCol + 1; c <= this.termW; c++) {
            out += BOX.h;
        }
        out += reset;

        // Vertical divider — top segment (between memory and disasm)
        const topVActive = topLeftActive || topRightActive;
        out += (topVActive ? activeBorder : inactiveBorder);
        for (let r = 1; r < this.hDivRow; r++) {
            out += moveTo(r, this.vDivCol) + BOX.v;
        }
        out += reset;

        // Vertical divider — bottom segment (between command and minimap)
        const botVActive = botLeftActive || botRightActive;
        out += (botVActive ? activeBorder : inactiveBorder);
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
            const label = isActive
                ? `${activeTitle}${ESC}7m${p.name}${reset}`
                : `${inactiveTitle}${p.name}${reset}`;
            out += moveTo(this.hDivRow, p.rect.col + 1) + label;
        }

        return out;
    }
}

export { BOX };
