import MersenneTwister from 'mersennetwister';

const cellDir = ['O',  // origin
                 'N','E','S','W',  // 1..4
                 'NE','SE','SW','NW',  // 5..8
                 'NN','EE','SS','WW',  // 9..12
                 'NNE','ENE','ESE','SSE','SSW','WSW','WNW','NNW',  // 13..20
                 'NNEE','SSEE','SSWW','NNWW',  // 21..24
                 'NNN','EEE','SSS','WWW',  // 25..27
                 'NNNE','NEEE','SEEE','SSSE','SSSW','SWWW','NWWW','NNNW',  // 28..35
                 'NNNEE','NNEEE','SSEEE','SSSEE','SSSWW','SSWWW','NNWWW','NNNWW',  // 36..43
                 'NNNEEE','SSSEEE','SSSWWW','NNNWWW'];  // 44..48

const compassVec = { 'O': [0,0], 'N': [0,+1], 'E': [+1,0], 'S': [0,-1], 'W': [-1,0] }
const sumVec = (a, b) => a.map((ai,i) => ai + b[i]);
const cellVec = cellDir.map ((dir) => dir.split('').map((d)=>compassVec[d]).reduce(sumVec));

class BoardMemory {
    constructor(seed = 42) {
        this.storage = new Uint8Array (this.storageSize);
        this.mt = new MersenneTwister (seed);
        this.sampleNextMove();
        this.resetUndoHistory();
    }

    get B() { return 256 }
    get M() { return 1024 }
    get N() { return 7 }
    get log2M() { return 10 }  // = log_2(M)
    get storageSize() { return this.B * this.B * this.M; }
    get neighborhoodSize() { return this.N * this.N * this.M; }
    get byteOffsetMask() { return this.M - 1 }

    get state() { return { storage: new TextDecoder().decode(this.storage),
                            iOrig: this.iOrig,
                            jOrig: this.jOrig,
                            nextCycles: this.nextCycles,
                            mt: this.mt.mt,
                            mti: this.mt.mti } }
    set state(s) {
        this.storage = new TextDecoder().encode(s.storage);
        this.iOrig = s.iOrig;
        this.jOrig = s.jOrig;
        this.nextCycles = s.nextCycles;
        this.mt.mt = s.mt;
        this.mt.mti = s.mti;
    }    

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
        const [x, y] = cellVec[nbrIdx];
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
        const rv2 = this.mt.int();
        this.iOrig = rv1 & 0xFF;
        this.jOrig = (rv1 >> 8) & 0xFF;
        // These constants are tweaked to give an expected cycle count of mean 256*C, min 75*C, max 3136*C where C=cycleMultiplier
        // We want a change of being able to copy an entire 1k cell in an atomic operation, which takes ~19*1024 = 19456 cycles
        // So the longest cycle count between interrupts (3136*C) should be around 2x that: C = 2*19456/3136 ~= 12
        const expectedLife = 256;  // 1/(1-p) = 256
        const halfLife = 180;  // (1-p)**halfLife ~= 0.5
        const quarterLife = 76;  // (1-p)**quarterLife ~= 0.75
        const maxHalfLives = 16;
        const cycleMultiplier = 16;  // so max time between interrupts is comfortably 2x atomic copy time
        let r = rv1 >> 16;
        let nHalfLives = 0;
        while (nHalfLives < maxHalfLives && (r & 1)) {
            r = r >> 1;
            ++nHalfLives;
        }
        this.nextCycles = cycleMultiplier * (halfLife * nHalfLives + (nHalfLives == maxHalfLives ? expectedLife : quarterLife));
        this.nextRnd = rv2;
    }
};



export default BoardMemory;
