import { fgRGB, bgRGB, reset, moveTo } from './ansi.js';

// Render board as ANSI colored text using half-block characters.
// Each terminal cell packs 2 vertical pixels: FG = top pixel, BG = bottom pixel.

const HALF_BLOCK = '\u2580'; // ▀

function rgb32ToComponents(rgb32) {
    return {
        r: rgb32 & 0xFF,
        g: (rgb32 >> 8) & 0xFF,
        b: (rgb32 >> 16) & 0xFF,
    };
}

export function renderBoard(visualizer, startRow, startCol, viewX, viewY, viewW, viewH) {
    const B = visualizer.controller.memory.B;
    const lines = [];
    // Each terminal row displays 2 board rows
    const termRows = Math.ceil(viewH / 2);

    for (let tr = 0; tr < termRows; tr++) {
        let line = moveTo(startRow + tr, startCol);
        const topY = viewY + tr * 2;
        const botY = topY + 1;

        for (let x = 0; x < viewW; x++) {
            const bx = (viewX + x) % B;
            const topI = topY % B;
            const botI = botY % B;

            const topRGB = rgb32ToComponents(visualizer.getOverviewPixelRGB(topI, bx));
            const botRGB = (botY < viewY + viewH)
                ? rgb32ToComponents(visualizer.getOverviewPixelRGB(botI, bx))
                : { r: 0, g: 0, b: 0 };

            line += fgRGB(topRGB.r, topRGB.g, topRGB.b)
                  + bgRGB(botRGB.r, botRGB.g, botRGB.b)
                  + HALF_BLOCK;
        }
        line += reset;
        lines.push(line);
    }
    return lines.join('');
}
