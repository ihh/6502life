// Minimap Pane — bottom-right
// Shows board overview with half-block rendering
// Arrow keys here move the board cell focus

import { moveTo, reset, dim, bold } from '../ansi.js';
import { fgRGB, bgRGB } from '../ansi.js';

const HALF_BLOCK = '\u2580';

// Unpack RGB32 (r | g<<8 | b<<16) to [r, g, b]
function unpackRGB(rgb32) {
    return [rgb32 & 0xFF, (rgb32 >> 8) & 0xFF, (rgb32 >> 16) & 0xFF];
}

export class MinimapPane {
    constructor(controller, visualizer) {
        this.controller = controller;
        this.visualizer = visualizer;
        this.B = controller.memory.B;
        // View mode: 'local' (16x16 around origin) or 'global' (entire board)
        this.mode = 'local';
        // Highlight cell
        this.highlightI = 0;
        this.highlightJ = 0;
    }

    setHighlight(i, j) {
        this.highlightI = i;
        this.highlightJ = j;
    }

    toggleMode() {
        this.mode = this.mode === 'local' ? 'global' : 'local';
    }

    render(rect) {
        let out = '';
        // Reserve 1 row for mode label
        const drawH = rect.height - 1;
        const drawW = rect.width;
        if (drawH <= 0 || drawW <= 0) return '';

        const label = this.mode === 'local'
            ? `${dim}LOCAL 16x16${reset}  ${dim}[m]ode${reset}`
            : `${dim}GLOBAL ${this.B}x${this.B}${reset}  ${dim}[m]ode${reset}`;
        out += moveTo(rect.row, rect.col) + label;

        if (this.mode === 'local') {
            out += this.renderLocal(rect, drawH, drawW);
        } else {
            out += this.renderGlobal(rect, drawH, drawW);
        }
        return out;
    }

    renderLocal(rect, drawH, drawW) {
        let out = '';
        const mem = this.controller.memory;
        const centerI = mem.iOrig;
        const centerJ = mem.jOrig;

        // Show 16x16 neighborhood (or smaller if pane is small)
        const viewCellsW = Math.min(16, drawW);
        const viewCellsH = Math.min(16, drawH * 2); // half-block = 2 rows per char
        const startI = centerI - Math.floor(viewCellsH / 2);
        const startJ = centerJ - Math.floor(viewCellsW / 2);

        for (let termRow = 0; termRow < Math.ceil(viewCellsH / 2) && termRow < drawH; termRow++) {
            out += moveTo(rect.row + 1 + termRow, rect.col);
            for (let termCol = 0; termCol < viewCellsW && termCol < drawW; termCol++) {
                const topI = (startI + termRow * 2 + this.B) % this.B;
                const topJ = (startJ + termCol + this.B) % this.B;
                const botI = (startI + termRow * 2 + 1 + this.B) % this.B;
                const botJ = topJ;

                const topRGB = unpackRGB(this.visualizer.getOverviewPixelRGB(topI, topJ));
                const botRGB = unpackRGB(this.visualizer.getOverviewPixelRGB(botI, botJ));

                const isHighlightTop = (topI === this.highlightI && topJ === this.highlightJ);
                const isHighlightBot = (botI === this.highlightI && botJ === this.highlightJ);
                const isOriginTop = (topI === centerI && topJ === centerJ);
                const isOriginBot = (botI === centerI && botJ === centerJ);

                let fg, bg;
                const isHighlight = isHighlightTop || isHighlightBot;
                if (isHighlightTop) {
                    fg = fgRGB(255, 255, 0);
                } else if (isOriginTop) {
                    fg = fgRGB(255, 100, 100);
                } else {
                    // Brighten active cells
                    fg = fgRGB(
                        Math.min(255, Math.round(topRGB[0] * 1.3)),
                        Math.min(255, Math.round(topRGB[1] * 1.3)),
                        Math.min(255, Math.round(topRGB[2] * 1.3))
                    );
                }
                if (isHighlightBot) {
                    bg = bgRGB(255, 255, 0);
                } else if (isOriginBot) {
                    bg = bgRGB(255, 100, 100);
                } else {
                    bg = bgRGB(
                        Math.min(255, Math.round(botRGB[0] * 1.3)),
                        Math.min(255, Math.round(botRGB[1] * 1.3)),
                        Math.min(255, Math.round(botRGB[2] * 1.3))
                    );
                }

                // Use reverse video on highlight cell for cursor inversion
                if (isHighlight) {
                    out += fg + bg + '\x1b[7m' + HALF_BLOCK + reset;
                } else {
                    out += fg + bg + HALF_BLOCK + reset;
                }
            }
        }
        return out;
    }

    renderGlobal(rect, drawH, drawW) {
        let out = '';
        // Scale board to fit pane
        const cellsH = drawH * 2; // half-block
        const cellsW = drawW;
        const scaleI = this.B / cellsH;
        const scaleJ = this.B / cellsW;

        for (let termRow = 0; termRow < drawH; termRow++) {
            out += moveTo(rect.row + 1 + termRow, rect.col);
            for (let termCol = 0; termCol < drawW; termCol++) {
                const topI = Math.floor(termRow * 2 * scaleI) % this.B;
                const topJ = Math.floor(termCol * scaleJ) % this.B;
                const botI = Math.floor((termRow * 2 + 1) * scaleI) % this.B;
                const botJ = topJ;

                const topRGB = unpackRGB(this.visualizer.getOverviewPixelRGB(topI, topJ));
                const botRGB = unpackRGB(this.visualizer.getOverviewPixelRGB(botI, botJ));

                const isHL = (topI === this.highlightI && topJ === this.highlightJ) ||
                             (botI === this.highlightI && botJ === this.highlightJ);

                if (isHL) {
                    // Use reverse video for cursor inversion on highlighted cell
                    out += fgRGB(255, 255, 0) + bgRGB(255, 255, 0) + '\x1b[7m' + HALF_BLOCK + reset;
                } else {
                    out += fgRGB(
                        Math.min(255, Math.round(topRGB[0] * 1.3)),
                        Math.min(255, Math.round(topRGB[1] * 1.3)),
                        Math.min(255, Math.round(topRGB[2] * 1.3))
                    );
                    out += bgRGB(
                        Math.min(255, Math.round(botRGB[0] * 1.3)),
                        Math.min(255, Math.round(botRGB[1] * 1.3)),
                        Math.min(255, Math.round(botRGB[2] * 1.3))
                    );
                    out += HALF_BLOCK + reset;
                }
            }
        }
        return out;
    }
}
