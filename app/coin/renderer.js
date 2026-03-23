/**
 * Canvas 2D renderer for 6502coin grid.
 * Each cell = colored square with 1px dark border for visual separation.
 * Activity shown via brightness boost.
 */

export class GridRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {number} boardSize - cells per side
   * @param {number} cellPx - pixels per cell
   */
  constructor(canvas, boardSize, cellPx = 10) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.boardSize = boardSize;
    this.cellPx = cellPx;

    canvas.width = boardSize * cellPx;
    canvas.height = boardSize * cellPx;

    // Pre-allocate ImageData for fast rendering
    this.imageData = this.ctx.createImageData(canvas.width, canvas.height);
    this.pixels = this.imageData.data;
  }

  /**
   * Render the full grid from engine cell data.
   * @param {Function} getCell - (x, y) => { rgb: [r,g,b], activity: 0-1 }
   */
  render(getCell) {
    const { boardSize, cellPx, pixels } = this;
    const w = boardSize * cellPx;

    for (let cy = 0; cy < boardSize; cy++) {
      for (let cx = 0; cx < boardSize; cx++) {
        const cell = getCell(cx, cy);
        const [r, g, b] = cell.rgb;

        // Boost brightness for active cells
        const boost = 1.0 + cell.activity * 0.5;
        const fr = Math.min(255, (r * boost) | 0);
        const fg = Math.min(255, (g * boost) | 0);
        const fb = Math.min(255, (b * boost) | 0);

        // Fill cellPx x cellPx block with 1px dark border
        const px0 = cx * cellPx;
        const py0 = cy * cellPx;

        for (let dy = 0; dy < cellPx; dy++) {
          const rowOffset = ((py0 + dy) * w + px0) * 4;
          const isBorderY = dy === 0;
          for (let dx = 0; dx < cellPx; dx++) {
            const idx = rowOffset + dx * 4;
            if (isBorderY || dx === 0) {
              // Dark grid line
              pixels[idx] = fr >> 2;
              pixels[idx + 1] = fg >> 2;
              pixels[idx + 2] = fb >> 2;
              pixels[idx + 3] = 255;
            } else {
              pixels[idx] = fr;
              pixels[idx + 1] = fg;
              pixels[idx + 2] = fb;
              pixels[idx + 3] = 255;
            }
          }
        }
      }
    }

    this.ctx.putImageData(this.imageData, 0, 0);
  }

  /**
   * Resize cell pixels (e.g. when window resizes).
   * @param {number} cellPx
   */
  resize(cellPx) {
    this.cellPx = cellPx;
    this.canvas.width = this.boardSize * cellPx;
    this.canvas.height = this.boardSize * cellPx;
    this.imageData = this.ctx.createImageData(this.canvas.width, this.canvas.height);
    this.pixels = this.imageData.data;
  }
}
