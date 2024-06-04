import { Sfotty } from '@sfotty-pie/sfotty';
import MersenneTwister from 'mersennetwister';

class BoardMemory {
    constructor(seed = 42) {
        this.data = new UIntArray (this.storageSize);
        this.mt = new MersenneTwister (seed);
        this.sampleNextMove();
    }

    sampleNextMove() {
        const rv1 = this.mt.int();
        this.iOrig = rv1 & 0xFF;
        this.jOrig = (rv1 & 0xFF00) >> 8;
        this.cycles = 0;
        let rv2 = this.mt.int();
        while (this.cycles < 32 && (rv2 & (1 << this.cycles)))
            this.cycles += 256;
        let rv3 = rv1 >> 16;
        while ((this.cycles & 0xFF) < 0xFF && (rv3 & 0xFF == 0)) {
            if ((this.cycles & 3) == 2)
                rv3 = this.mt.int();
            else
                rv3 >>= 8;
            ++this.cycles;
        }
        this.nextSAXY = this.mt.int();
    }

    get B() { return 256 }
    get M() { return 1024 }
    get N() { return 5 }
    get log2M() { return 10 }  // = log_2(M)
    get storageSize() { return this.B * this.B * this.M; }
    get neighborhoodSize() { return this.N * this.N * this.M; }
    get cellOffsetMask() { return this.M - 1 }
    get HIMEM() { return this.neighborhoodSize - 1 }

    wrapCoord (i) { return (i + this.B) % this.B; }

    getCell (idx) { return this.data[idx]; }
    setCell (idx, val) { this.data[idx] = val & 0xFF; }

    ijbToCellIndex (i, j, b) {
        return this.M * (j + this.B * this.i) + b;
    }

    addrToCellIndex (addr) {
        if (addr < 0 || addr > this.HIMEM)
            return -1;
        const b = addr & this.cellOffsetMask;
        const nbrIdx = addr >> this.log2M;
        const x = Math.floor (nbrIdx / this.N);
        const y = nbrIdx % this.N;
        return this.ijbToCellIndex (this.wrapCoord (this.i + x),
                                    this.wrapCoord (this.j + y),
                                    b);
    }

    read (addr) {
        const idx = this.addrToCellIndex (addr);
        return idx < 0 ? 0 : this.getCell (idx);
    }

    write (addr, val) {
        const idx = this.addrToCellIndex (addr);
        if (idx >= 0)
            this.setCell (idx, val);
    }

    readNeighborhood() {
        return new Uint8Array (Array.from({length: this.HIMEM + 1})
                                    .map((_,addr) => this.read(addr)));
    }
    writeNeighborhood (snapshot) {
        snapshot.forEach ((val, addr) => this.write (addr, val));
    }
};

class BoardController {
    constructor (board) {
        this.board = board || new BoardMemory();
        this.resetSfotty()
        this.sfotty = new Sfotty(this.board);
        this.cycleCounter = 0;
    }

    resetSfotty() {
        this.sfotty = new Sfotty(this.memory);
    }

    get cyclesToNextInterrupt() {
        return this.board.cycles;
    }

    sampleNextMove() {
        this.board.sampleNextMove();
        this.undoSnapshot = this.board.readNeighborhood();
    }

    undo() {
        this.board.writeNeighborhood (this.undoSnapshot);
    }

    pushByte (val) {
        const S = this.sfotty.S;
        this.board.write (0x100 + S, val);
        this.sfotty.S = S - 1;
    }

    pushWord (val) {
        const hi = (val >> 8) & 0xFF, lo = val & 0xFF;
        this.push (hi);
        this.push (lo);
    }

    runToNextInterrupt() {
        while (true) {
            this.sfotty.run();
            if (this.sfotty.cycleCounter >= this.cyclesToNextInterrupt) {
                this.cycleCounter += this.cyclesToNextInterrupt;
                if (this.sfotty.I)
                    this.undo();
                else {
                    this.pushWord (sfotty.PC);
                    this.pushByte (sfotty.P);
                    this.board.write (0x0200, sfotty.S);
                    this.board.write (0x0201, sfotty.A);
                    this.board.write (0x0202, sfotty.X);
                    this.board.write (0x0203, sfotty.Y);
                }
                this.sfotty.S = (this.board.nextSAXY >> 24) & 0xFF;
                this.sfotty.A = (this.board.nextSAXY >> 16) & 0xFF;
                this.sfotty.X = (this.board.nextSAXY >> 8) & 0xFF;
                this.sfotty.Y = this.board.nextSAXY & 0xFF;
                this.sampleNextMove();
                this.sfotty.P = 0;
                this.sfotty.PC = 0;
                this.sfotty.cycleCounter = 0;
                break;
            }
        }
    }
};