import BoardController from './controller.js';

const HSVtoRGB = (h, s, v) => {
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
    getOverviewRGB (i, j) {
        const cellIdx = this.controller.board.ijToCellIndex(i,j);
        const currentTime = this.controller.totalCycles;
        const timeSinceLastMove = currentTime - this.controller.board.lastMoveTime[cellIdx];
        const timeSinceLastWrite = currentTime - this.controller.board.lastWriteTime[cellIdx];
        const h = this.overviewHue;
        const s = this.weightedExponential (this.overviewConfig.saturation, timeSinceLastWrite, timeSinceLastMove);
        const v = this.weightedExponential (this.overviewConfig.value, timeSinceLastWrite, timeSinceLastMove);
        return HSVtoRGB(h,s,v);
    }

    // 0 <= x,y < 8192 = B*sqrtM
    getDetailRGB (x, y) {
        const i = x >> 5;
        const j = y >> 5;
        const bx = x % 32;
        const by = y % 32;
        const b = (this.interleaveZeroBits(by) << 1) | this.interleaveZeroBits(bx);
        const cellIdx = this.controller.board.ijToCellIndex(i,j);
        const byteIdx = this.controller.board.ijbToByteIndex(i,j,b);
        const currentTime = this.controller.totalCycles;
        const timeSinceLastMove = currentTime - this.controller.board.lastMoveTime[cellIdx];
        const timeSinceLastWrite = currentTime - this.controller.board.lastWriteTimeForByte[byteIdx];
        const h = this.controller.board.getByte(byteIdx) / 256;
        const s = this.weightedExponential (this.detailConfig.saturation, timeSinceLastWrite, timeSinceLastMove);
        const v = this.weightedExponential (this.detailConfig.value, timeSinceLastWrite, timeSinceLastMove);
        return HSVtoRGB(h,s,v);
    }

};
