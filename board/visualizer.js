import { BoardController } from './controller.js';

const HSVtoRGBobj = (h, s, v) => {
    let r, g, b, i, f, p, q, t;
    i = Math.floor(h * 6);
    f = h * 6 - i;
    p = v * (1 - s);
    q = v * (1 - f * s);
    t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: r = v, g = t, b = p; break;
        case 1: r = q, g = v, b = p; break;
        case 2: r = p, g = v, b = t; break;
        case 3: r = p, g = q, b = v; break;
        case 4: r = t, g = p, b = v; break;
        case 5: r = v, g = p, b = q; break;
    }
    return {
        r: Math.round(r * 255),
        g: Math.round(g * 255),
        b: Math.round(b * 255)
    };
};

const HSVtoRGB32 = (h, s, v) => {
    const rgb = HSVtoRGBobj(h,s,v);
    return rgb.r | (rgb.g << 8) | (rgb.b << 16);
};

const range = (N) => Array.from({length:N}).map((_,n)=>n);


class BoardVisualizer {
    constructor (controller) {
        this.controller = controller || new BoardController();
        this.overviewConfig = { hue: 1/3,
                                saturation: { moveDecay: 10, writeDecay: 100, writeProportion: .4 },
                                value: { moveDecay: 10, writeDecay: 1, writeProportion: .8} };
        this.detailConfig = { saturation: { moveDecay: 10, writeDecay: 100, writeProportion: .4 },
                              value: { moveDecay: 10, writeDecay: 1, writeProportion: .8} };
    }

    weightedExponential (config, timeSinceLastWrite, timeSinceLastMove) {
        const w = config.writeProportion;
        const tw = timeSinceLastWrite * config.writeDecay;
        const tm = timeSinceLastMove * config.moveDecay;
        return w * Math.exp(-tw) + (1-w) * Math.exp(-tm);
    }

    interleaveZeroBits (x) {
        return ((x & 16) << 4) | ((x & 8) << 3) | ((x & 4) << 2) | ((x & 2) << 1) | (x & 1);
    }

    // 0 <= i,j < 256 = B
    getOverviewPixelRGB (i, j) {
        const cellIdx = this.controller.memory.ijToCellIndex(i,j);
        const currentTime = this.controller.totalCycles;
        const timeSinceLastMove = currentTime - this.controller.lastMoveTime[cellIdx];
        const timeSinceLastWrite = currentTime - this.controller.lastWriteTime[cellIdx];
        const h = this.overviewHue;
        const s = this.weightedExponential (this.overviewConfig.saturation, timeSinceLastWrite, timeSinceLastMove);
        const v = this.weightedExponential (this.overviewConfig.value, timeSinceLastWrite, timeSinceLastMove);
        return HSVtoRGB32(h,s,v);
    }

    // Get the full overview, B*B pixels
    getOverviewPixelBuffer() {
        const size =  this.controller.memory.B;
        let buffer = new Uint8ClampedArray(size*size*4);
        for (let x = 0; x < size; x++)
            for (let y = 0; y < size; y++) {
                const pos = (y*size + x) * 4;
                const rgb32 = this.getOverviewPixelRGB(x,y);
                buffer[pos] = rgb32 & 0xFF;
                buffer[pos+1] = (rgb32 >> 8) & 0xFF;
                buffer[pos+2] = (rgb32 >> 16) & 0xFF;
                buffer[pos+3] = 255;
            }
        return buffer;
    }

    // Get name of cell
    getCellName (i, j) {
        const nameLen = this.controller.memory.displayNameBytes;
        const nameAddr = this.controller.memory.displayNameAddr;
        const cellNameAddr = this.controller.memory.ijbToByteIndex(i,j,nameAddr);
        const cellNameBytes = Array.from({length:nameLen}).map((_,n)=>this.controller.memory.storage[cellNameAddr+n]);
        const cellNameChars = cellNameBytes.map((c) => c > 31 && c < 127 ? String.fromCharCode(c) : '').join('');
        return cellNameChars;
    }

    getCellNameArray (xStart, yStart, xCells, yCells) {
        const size = this.controller.memory.B;
        return range(xCells).map((x)=>range(yCells).map((y)=>this.getCellName((xStart+x)%size,(yStart+y)%size)));
    }

    // Get pixel from byte-level detail view, B*B*M pixels
    // 0 <= x,y < 8192 = B*sqrtM
    getDetailPixelRGB (x, y) {
        const i = x >> 5;  // 5 = this.controller.memory.log2M / 2
        const j = y >> 5;
        const bx = x % 32;  // 32 = this.controller.memory.sqrtM
        const by = y % 32;
        return this.getDetailPixelRGBForCell(i,j,bx,by);
    }

    interleaveBits (bx, by) {
        return (this.interleaveZeroBits(by) << 1) | this.interleaveZeroBits(bx);
    }

    getDetailPixelRGBForCell (i, j, bx, by) {
        const b = this.interleaveBits(bx,by);
        const cellIdx = this.controller.memory.ijToCellIndex(i,j);
        const byteIdx = this.controller.memory.ijbToByteIndex(i,j,b);
        const currentTime = this.controller.totalCycles;
        const timeSinceLastMove = currentTime - this.controller.memory.lastMoveTime[cellIdx];
        const timeSinceLastWrite = currentTime - this.controller.memory.lastWriteTimeForByte[byteIdx];
        const h = this.controller.memory.getByte(byteIdx) / 256;
        const s = this.weightedExponential (this.detailConfig.saturation, timeSinceLastWrite, timeSinceLastMove);
        const v = this.weightedExponential (this.detailConfig.value, timeSinceLastWrite, timeSinceLastMove);
        return HSVtoRGB32(h,s,v);
    }

    getDetailPixelBufferRect (xStart, yStart, xPixels, yPixels) {
        let buffer = new Uint8ClampedArray(xPixels*yPixels*4);
        for (let x = 0; x < xPixels; x++)
            for (let y = 0; y < yPixels; y++) {
                const pos = (y*xPixels + x) * 4;
                const rgb32 = this.getOverviewPixelRGB(xStart+x,yStart+y);
                buffer[pos] = rgb32 & 0xFF;
                buffer[pos+1] = (rgb32 >> 8) & 0xFF;
                buffer[pos+2] = (rgb32 >> 16) & 0xFF;
                buffer[pos+3] = 255;
            }
        return buffer;
    }

    getDetailPixelBuffer (xStart, yStart, xCells, yCells) {
        const sqrtM = this.controller.memory.sqrtM;
        return this.getDetailPixelBufferRect (xStart * sqrtM, yStart * sqrtM, xCells * sqrtM, yCells * sqrtM);
    }
};

export { BoardVisualizer };