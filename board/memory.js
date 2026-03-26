import MersenneTwister from 'mersennetwister';
import { range, concatLists } from './util.js';

// Create the neighborhood memory map and the lookup tables that live at 0xE000
const taxicab = (vec) => Math.abs(vec[0]) + Math.abs(vec[1]);
const maxDelta = (vec) => Math.max(Math.abs(vec[0]), Math.abs(vec[1]));
const posAngle = (angle) => angle < 0 ? angle + 2*Math.PI : angle;
const angle = (vec) => posAngle(Math.atan2(vec[0], vec[1]));  // By switching x and y in the args to atan2, N = (0,1) becomes angle zero, and we get NESW sorting

const coordRange = Array.from({length:7}).map((_,n) => n - 3);
// The following sort yields the spiraling order O,N,E,S,W,NE,SE...
const spiralSortedCellVec = coordRange
                    .reduce ((a,y) => a.concat(coordRange.map (x => [x,y])), [])
                    .sort ((a, b) => taxicab(a) - taxicab(b)
                                  || maxDelta(a) - maxDelta(b)
                                  || angle(a) - angle(b));

let tmpCellIndex = coordRange.map(()=>coordRange.map(()=>null));
spiralSortedCellVec.forEach ((vec, idx) => tmpCellIndex[vec[0]+3][vec[1]+3] = idx);
const cellIndex = tmpCellIndex;
const lookupCellIndex = (vec) => cellIndex[(vec[0]+3+14)%7][(vec[1]+3+14)%7] | (maxDelta(vec) > 3 ? 128 : 0);
const xCoords = spiralSortedCellVec.map ((vec) => vec[0] + 3);
const yCoords = spiralSortedCellVec.map ((vec) => vec[1] + 3);

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
const makeTransformLookupTableRow = (f) => spiralSortedCellVec.map(f).map(lookupCellIndex);
const rotationLookupTable = rotations.map(makeTransformLookupTableRow);
const inverseRotationLookupTable = inverseRotations.map(makeTransformLookupTableRow);
const transformations = spiralSortedCellVec.map(translate).concat ([rotate1, rotate2, rotate3, reflectX, reflectY]);
const coordLookupTable = Array.from({length:64}).map((_,n) => (n % 8 == 7 || (n>>3) == 7) ? -1 : lookupCellIndex([(n%8)-3,(n>>3)-3]));
const transformLookupTable = transformations.map(makeTransformLookupTableRow).concat ([xCoords, yCoords, coordLookupTable]);

// Truly random access memory: the hookup to the larger storage is randomly translated and oriented,
// with connectivity persisting only until the next interrupt, at which a single undo is performed if
// and only if the software interrupt flag (I) is set at the time of the interrupt.
class BoardMemory {
    // Number of mapped cells for each neighborhood dimension
    static MAPPED_CELLS = { 2: 2, 3: 9, 5: 25, 7: 49 };

    constructor(seed = 42, boardSize = 256) {
        this._B = boardSize;
        this._N = 7;  // neighborhood dimension (2, 3, 5, or 7)
        this.storage = new Uint8Array (this.storageSize);
        this.mt = new MersenneTwister (seed);
        // Scheduler mode: 'random' (default) or 'checkerboard'
        this.schedulerMode = 'random';
        this._checkerboardIndex = 0;
        this._checkerboardPass = 0;
        this._checkerboardCells = null;  // lazily built
        this.sampleNextMove();
        this.resetUndoHistory();
        // Feature flags (set by controller from boardParams)
        this.orientedRegistersEnabled = true;
        this.lookupTablesEnabled = true;
    }

    get B() { return this._B }  // cells per dimension (X,Y)
    get M() { return 1024 }  // memory in bytes per cell
    get N() { return this._N }  // memory-mapped neighborhood dimension (2, 3, 5, or 7)
    get Nsquared() { return BoardMemory.MAPPED_CELLS[this._N] || 49 }  // mapped cell count
    get log2M() { return 10 }  // = log_2(M)
    get sqrtM() { return 32 }  // = sqrt(M)
    get storageSize() { return this.B * this.B * this.M; }  // 64Mb
    get neighborhoodSize() { return this.Nsquared * this.M; }  // mapped bytes
    get byteOffsetMask() { return this.M - 1 }  // 0x3FF

    // 1. Memory map - RAM
    // A. Used by OS, 0xF0 - 0xFF.
    // Rotated vectors. These are unmapped/mapped by the memory manager at each random orientation.
    get firstVectorAddr() { return 0x00F0 }
    get lastVectorAddr() { return 0x00F9 }  // note PCHI (0xf9) is a rotating address; its top bits are auto-rotated by the scheduler, allowing execution of code in neighboring cells

    // Controller-reserved vectors. Used to store registers between updates, and random numbers during updates
    get firstControllerAddr() { return 0x00FA }
    get lastControllerAddr() { return 0x00FF }

    // B. Reserved for visualizer, 0x3C0-0x3FF.
    // Conventionally, the upper 64 bytes are for visualization
    // The program is free to ignore these, they will not disrupt program flow
    // Debuggers should not rely on them!

    // 16x16 monochrome bitmap (32 bytes)
    get bitmapPixelsPerSide() { return 16 }  // bits per dimension (X,Y)
    get bitmapBytes() { return this.bitmapPixelsPerSide * this.bitmapPixelsPerSide / 8 }  // 32 bytes
    get bitmapAddr() { return 0x03C0 }       // 32-byte monochrome bitmap (1 bit/pixel)

    // Display name (28 bytes)
    get displayNameBytes() { return 28 }
    get displayNameAddr() { return 0x03E0 }

    // 0x03FC-0x03FE: reserved
    // Hue byte
    get hueAddr() { return 0x03FF }          // 1 byte: hue (0-255 maps to 0-360° HSV)

    // 2. Memory map - ROM
    // Lookup tables for common symmetry operations
    get firstLookupTableAddr() { return 0xE000 }
    get lastLookupTableAddr() { return 0xEFFF }

    // Full serialization & deserialization.
    // Storage is serialized as an array of byte values (not UTF-8 text,
    // which is lossy for arbitrary binary data — bytes 0x80-0xBF without
    // valid multi-byte leaders get replaced with U+FFFD on round-trip).
    get state() { return { storage: Array.from(this.storage),
                            iOrig: this.iOrig,
                            jOrig: this.jOrig,
                            orientation: this.orientation,
                            nextCycles: this.nextCycles,
                            mt: this.mt.mt,
                            mti: this.mt.mti,
                            schedulerMode: this.schedulerMode,
                            _checkerboardIndex: this._checkerboardIndex,
                            _checkerboardPass: this._checkerboardPass } }
    set state(s) {
        this.storage = new Uint8Array(Array.isArray(s.storage) ? s.storage : new TextEncoder().encode(s.storage));
        this.iOrig = s.iOrig;
        this.jOrig = s.jOrig;
        this.orientation = s.orientation;
        this.nextCycles = s.nextCycles;
        this.mt.mt = s.mt;
        this.mt.mti = s.mti;
        if (s.schedulerMode !== undefined) this.schedulerMode = s.schedulerMode;
        if (s._checkerboardIndex !== undefined) this._checkerboardIndex = s._checkerboardIndex;
        if (s._checkerboardPass !== undefined) this._checkerboardPass = s._checkerboardPass;
        if (this.schedulerMode === 'checkerboard') this._buildCheckerboardCells();
    }

    // Convert a neighborhood cell index (0-48) to a storage byte offset.
    // This is the base index into storage[] for that cell's first byte.
    // Precomputes the full address translation (spiral lookup, rotation,
    // coordinate wrapping) so callers can access storage[] directly.
    neighborCellStorageBase (neighIdx) {
        const [x, y] = spiralSortedCellVec[this.unrotate(neighIdx)];
        const i = this.wrapCoord (this.iOrig + x);
        const j = this.wrapCoord (this.jOrig + y);
        return this.M * this.ijToCellIndex(i, j);
    }

    // Accessors
    getByte (idx) { return this.storage[idx]; }
    setByteWithoutUndo (idx, val) { this.storage[idx] = val & 0xFF; }
    setByteWithUndo (idx, val) {
        if (this.undoHistory && !(idx in this.undoHistory))
            this.undoHistory[idx] = this.getByte(idx);
        this.setByteWithoutUndo (idx, val);
    }

    undoWrites() {
        Object.keys(this.undoHistory).forEach ((addr) => this.setByteWithoutUndo (parseInt(addr), this.undoHistory[addr]));
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

    ijbFromByteIndex (byteIdx) {
        const b = byteIdx % this.M;
        const ij = Math.floor (byteIdx / this.M);
        const j = ij % this.B;
        const i = Math.floor (ij / this.B);
        return [i, j, b];
    }

    wrapCoord (k) { return (k + this.B) % this.B; }

    addrToCellCoords (addr) {
        const b = addr & this.byteOffsetMask;
        const [x, y] = spiralSortedCellVec[this.unrotate (addr >> this.log2M)];
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
        return this.orientedRegistersEnabled && this.addrIsInVectorRange(addr) && this.valIsInVectorRange(val);
    }

    read (addr) {
        if (this.lookupTablesEnabled && addr >= this.firstLookupTableAddr && addr <= this.lastLookupTableAddr) {
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

    // rotation helpers
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

    // Build the checkerboard cell lists for the current board size.
    _buildCheckerboardCells() {
        const B = this.B;
        this._checkerboardCells = [[], []];  // [pass0 (even), pass1 (odd)]
        for (let i = 0; i < B; i++) {
            for (let j = 0; j < B; j++) {
                this._checkerboardCells[(i + j) % 2].push([i, j]);
            }
        }
    }

    // Sample the Poisson timer duration from the MT RNG.
    _sampleTimerAndRnd() {
        const rv2 = this.mt.int();  // log part of waiting time
        const rv3 = this.mt.real();  // fractional part of waiting time
        const rv4 = this.mt.int();  // stored in nextRnd
        const halfLife = 177;
        const cycleMultiplier = 16;
        let r = rv2;
        let nHalfLives = 0;
        while (nHalfLives < 32 && (r & 1)) {
            r = r >> 1;
            ++nHalfLives;
        }
        this.nextCycles = Math.ceil(cycleMultiplier * halfLife * (nHalfLives + rv3));
        this.nextRnd = rv4;
    }

    // randomly sample next move
    sampleNextMove() {
        if (this.schedulerMode === 'checkerboard') {
            // Checkerboard mode: deterministic cell order, random orientation and timer
            if (!this._checkerboardCells) this._buildCheckerboardCells();
            const pass = this._checkerboardPass;
            const idx = this._checkerboardIndex;
            const cell = this._checkerboardCells[pass][idx];
            this.iOrig = cell[0];
            this.jOrig = cell[1];
            // Still consume rv1 from MT to keep RNG consumption consistent
            const rv1 = this.mt.int();
            this.orientation = (rv1 >> 16) & 3;
            this._sampleTimerAndRnd();
            // Advance index
            this._checkerboardIndex++;
            if (this._checkerboardIndex >= this._checkerboardCells[pass].length) {
                this._checkerboardIndex = 0;
                this._checkerboardPass = 1 - this._checkerboardPass;
            }
        } else {
            // Random mode: original behavior
            const rv1 = this.mt.int();  // new origin and orientation
            this.iOrig = rv1 % this.B;
            this.jOrig = ((rv1 >> 8) & 0xFFFF) % this.B;
            this.orientation = (rv1 >> 16) & 3;
            this._sampleTimerAndRnd();
        }
    }
};


export { BoardMemory, cellIndex };
