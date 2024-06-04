import MersenneTwister from 'mersennetwister';

class BoardMemory {
    constructor(seed = 42) {
        this.storage = new Uint8Array (this.storageSize);
        this.mt = new MersenneTwister (seed);
        this.sampleNextMove();
        this.resetUndoHistory();
    }

    get B() { return 256 }
    get M() { return 1024 }
    get N() { return 5 }
    get log2M() { return 10 }  // = log_2(M)
    get storageSize() { return this.B * this.B * this.M; }
    get neighborhoodSize() { return this.N * this.N * this.M; }
    get byteOffsetMask() { return this.M - 1 }

    getByte (idx) { return this.storage[idx]; }
    setByteWithoutUndo (idx, val) { this.storage[idx] = val & 0xFF; }
    setByteWithUndo (idx, val) {
        if (this.undoHistory && !(idx in this.undoHistory))
            this.undoHistory[idx] = this.getByte(idx);
        this.setByteWithoutUndo (idx, val);
    }

    undoWrites() {
        Object.keys(this.undoHistory).forEach ((idx) => this.setByteWithoutUndo (idx, this.undoHistory[idx]));
    }

    resetUndoHistory() {
        this.undoHistory = {};
    }

    disableUndoHistory() {
        delete this.undoHistory;
    }

    ijbToByteIndex (i, j, b) {
        return this.M * (j + this.B * i) + b;
    }

    wrapCoord (k) { return (k + this.B) % this.B; }

    addrToByteIndex (addr) {
        if (addr < 0 || addr >= this.neighborhoodSize)
            return -1;
        const b = addr & this.byteOffsetMask;
        const nbrIdx = addr >> this.log2M;
        const x = Math.floor (nbrIdx / this.N);
        const y = nbrIdx % this.N;
        return this.ijbToByteIndex (this.wrapCoord (this.iOrig + x),
                                    this.wrapCoord (this.jOrig + y),
                                    b);
    }

    read (addr) {
        const idx = this.addrToByteIndex (addr);
        return idx < 0 ? 0 : this.getByte (idx);
    }

    write (addr, val) {
        const idx = this.addrToByteIndex (addr);
        if (idx >= 0)
            this.setByteWithUndo (idx, val);
    }

    sampleNextMove() {
        const rv1 = this.mt.int();
        this.iOrig = rv1 & 0xFF;
        this.jOrig = (rv1 & 0xFF00) >> 8;
        this.nextCycles = 0;
        const rv2 = this.mt.int();
        while (this.nextCycles < 32 && (rv2 & (1 << this.nextCycles)))
            ++this.nextCycles;
        this.nextCycles = this.nextCycles << 8;
        let rv3 = rv1 >> 16;
        while ((this.nextCycles & 0xFF) < 0xFF && (rv3 & 0xFF) != 0) {
            if ((this.nextCycles & 3) == 1)
                rv3 = this.mt.int();
            else
                rv3 >>= 8;
            ++this.nextCycles;
        }
    }
};

export default BoardMemory;
