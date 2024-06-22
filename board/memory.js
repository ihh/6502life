import MersenneTwister from 'mersennetwister';

// Create the neighborhood memory map and the lookup tables that live at 0xE000
const taxicab = (vec) => Math.abs(vec[0]) + Math.abs(vec[1]);
const maxDelta = (vec) => Math.max(Math.abs(vec[0]), Math.abs(vec[1]));
const posAngle = (angle) => angle < 0 ? angle + 2*Math.PI : angle;
const angle = (vec) => posAngle(Math.atan2(vec[0], vec[1]));  // By switching x and y in the args to atan2, N = (0,1) becomes angle zero, and we get NESW sorting

const coordRange = Array.from({length:7}).map((_,n) => n - 3);
// The following sort yields the spiraling order O,N,E,S,W,NE,SE...
const cellVec = coordRange
                    .reduce ((a,y) => a.concat(coordRange.map (x => [x,y])), [])
                    .sort ((a, b) => taxicab(a) - taxicab(b)
                                  || maxDelta(a) - maxDelta(b)
                                  || angle(a) - angle(b));

let cellIndex = coordRange.map(()=>coordRange.map(()=>null));
cellVec.forEach ((vec, idx) => cellIndex[vec[0]+3][vec[1]+3] = idx);
const lookupCellIndex = (vec) => cellIndex[(vec[0]+3+14)%7][(vec[1]+3+14)%7] | (maxDelta(vec) > 3 ? 128 : 0);
const xCoords = cellVec.map ((vec) => vec[0] + 3);
const yCoords = cellVec.map ((vec) => vec[1] + 3);

const rotate0 = (xy) => xy;
const rotate1 = (xy) => [xy[1],-xy[0]];
const rotate2 = (xy) => rotate1(rotate1(xy));
const rotate3 = (xy) => rotate1(rotate2(xy));
const rotations = [rotate0, rotate1, rotate2, rotate3];
const inverseRotations = [rotate0, rotate3, rotate2, rotate1];
const reflectX = (xy) => [xy[0],-xy[1]];
const reflectY = (xy) => rotate3(reflectX(rotate1(xy)));
const sumVec = (a, b) => a.map((ai,i) => ai + b[i]);
const translate = (xy1) => (xy2) => sumVec (xy1, xy2);
const makeTransformLookupTableRow = (f) => cellVec.map(f).map(lookupCellIndex);
const transformations = cellVec.map(translate).concat ([rotate1, rotate2, rotate3, reflectX, reflectY]);
const coordLookupTable = Array.from({length:64}).map((_,n) => (n % 8 == 7 || (n>>3) == 7) ? -1 : lookupCellIndex([(n%8)-3,(n>>3)-3]));
const transformLookupTable = transformations.map(makeTransformLookupTableRow).concat ([xCoords, yCoords, coordLookupTable]);
const rotationLookupTable = rotations.map(makeTransformLookupTableRow);
const inverseRotationLookupTable = inverseRotations.map(makeTransformLookupTableRow);

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
    get Nsquared() { return 49 }
    get log2M() { return 10 }  // = log_2(M)
    get sqrtM() { return 32 }  // = sqrt(M)
    get storageSize() { return this.B * this.B * this.M; }  // 64Mb
    get neighborhoodSize() { return this.N * this.N * this.M; }  // 49Kb
    get byteOffsetMask() { return this.M - 1 }  // 0x3FF

    get firstVectorAddr() { return 0x00F0 }
    get lastVectorAddr() { return 0x00F9 }
    get firstLookupTableAddr() { return 0xE000 }
    get lastLookupTableAddr() { return 0xEFFF }

    get state() { return { storage: new TextDecoder().decode(this.storage),
                            iOrig: this.iOrig,
                            jOrig: this.jOrig,
                            orientation: this.orientation,
                            nextCycles: this.nextCycles,
                            mt: this.mt.mt,
                            mti: this.mt.mti } }
    set state(s) {
        this.storage = new TextDecoder().encode(s.storage);
        this.iOrig = s.iOrig;
        this.jOrig = s.jOrig;
        this.orientation = s.orientation;
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
        this.resetUndoHistory();
    }

    resetUndoHistory() {
        this.undoHistory = {};
    }

    disableUndoHistory() {
        delete this.undoHistory;
    }

    ijToCellIndex (i, j) {
        return j + this.B * i;
    }

    ijbToByteIndex (i, j, b) {
        return this.M * this.ijToCellIndex(i,j) + b;
    }

    wrapCoord (k) { return (k + this.B) % this.B; }

    addrToCellCoords (addr) {
        const b = addr & this.byteOffsetMask;
        const [x, y] = cellVec[this.unrotate (addr >> this.log2M)]
        const i = this.wrapCoord (this.iOrig + x);
        const j = this.wrapCoord (this.jOrig + y);
        return [i, j, b];
    }

    addrToByteIndex (addr) {
        if (addr < 0 || addr >= this.neighborhoodSize)
            return -1;
        const [i, j, b] = this.addrToCellCoords (addr);
        return this.ijbToByteIndex (i, j, b);
    }

    addrIsInVectorRange (addr) {
        const b = addr & this.byteOffsetMask;
        return b >= this.firstVectorAddr && b <= this.lastVectorAddr;
    }

    valIsInVectorRange (val) {
        return ((val >> 2) & 0x3F) <= 48;
    }

    doRotateTopBits (addr, val) {
        return this.addrIsInVectorRange(addr) && this.valIsInVectorRange(val);
    }

    read (addr) {
        if (addr >= this.firstLookupTableAddr && addr <= this.lastLookupTableAddr) {
            const nRow = (addr - this.firstLookupTableAddr) >> 6;
            const nCol = addr & 63;
            if (nRow < transformLookupTable.length && nCol < transformLookupTable[nRow].length)
                return transformLookupTable[nRow][nCol] & 0xFF;
            return 0;
        }
        const idx = this.addrToByteIndex (addr);
        const val = idx < 0 ? 0 : this.getByte (idx);
        return this.doRotateTopBits(addr,val) ? this.rotateTopBits(val) : val;
    }

    write (addr, val) {
        const idx = this.addrToByteIndex (addr);
        if (idx >= 0)
            this.setByteWithUndo (idx, this.doRotateTopBits(addr,val) ? this.unrotateTopBits(val) : val);
    }

    rotate (n) {
        return rotationLookupTable[this.orientation][n];
    }

    unrotate (n) {
        return inverseRotationLookupTable[this.orientation][n];
    }

    rotateTopBits (val) {
        return (val & 3) | (this.rotate(val >> 2) << 2);
    }

    unrotateTopBits (val) {
        return (val & 3) | (this.unrotate(val >> 2) << 2);
    }

    sampleNextMove() {
        const rv1 = this.mt.int();  // new origin and orientation
        const rv2 = this.mt.int();  // transformed into the log part of the waiting time to the next interrupt
        const rv3 = this.mt.real();  // transformed into the fractional part of the waiting time to the next interrupt
        const rv4 = this.mt.int();  // stored in nextRnd, retrieved and written back to the board by the controller
        this.iOrig = rv1 & 0xFF;
        this.jOrig = (rv1 >> 8) & 0xFF;
        this.orientation = (rv1 >> 16) & 3;
        // These constants are tweaked to give an expected cycle count of mean 256*C, min 75*C, max 3136*C where C=cycleMultiplier
        // We want a change of being able to copy an entire 1k cell in an atomic operation, which takes ~19*1024 = 19456 cycles
        // So the longest cycle count between interrupts (3136*C) should be around 2x that: C = 2*19456/3136 ~= 12
        const halfLife = 177;  // (1-p)**halfLife ~= 0.5
        const cycleMultiplier = 16;  // so max time between interrupts is comfortably 2x atomic copy time
        let r = rv2;
        let nHalfLives = 0;
        while (nHalfLives < 32 && (r & 1)) {
            r = r >> 1;
            ++nHalfLives;
        }
        this.nextCycles = Math.ceil (cycleMultiplier * halfLife * (nHalfLives + rv3));
        this.nextRnd = rv4;
    }
};



export default BoardMemory;
