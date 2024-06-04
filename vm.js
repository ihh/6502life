import { Sfotty } from '@sfotty-pie/sfotty';
import MersenneTwister from 'mersennetwister';

class BoardMemory {
    constructor(seed = 42) {
        this.data = new UIntArray (this.B * this.B * this.M);
        this.mt = new MersenneTwister (seed);
        this.randomizeCell();
    }

    randomizeCell() {
        const rv1 = mt.int();
        this.iOrig = rv1 & 0xFF;
        this.jOrig = (rv1 & 0xFF00) >> 8;
        this.cycles = 0;
        let rv2 = mt.int();
        while (this.cycles < 32 && (rv2 & (1 << this.cycles)))
            this.cycles += 256;
        let rv3 = rv1 >> 16;
        while ((this.cycles & 0xFF) < 0xFF && (rv3 & 0xFF == 0)) {
            if ((this.cycles & 3) == 2)
                rv3 = mt.int();
            else
                rv3 >>= 8;
            ++this.cycles;
        }
    }

    get B() { return 256 }
    get M() { return 1024 }
    get HIMEM() { return 0x63FF }

    wrapCoord (i) { return (i + this.B) % this.B; }

    getCell (idx) { return this.data[idx]; }
    setCell (idx, val) { this.data[idx] = val; }

    ijbToCellIndex (i, j, b) {
        return this.M * (j + this.B * this.i) + b;
    }

    addrToCellIndex (addr) {
        if (addr < 0 || addr > this.HIMEM)
            return -1;
        const b = addr & 0x3FF;
        const nbrIdx = addr >> 10;
        const x = Math.floor (nbrIdx / 5);
        const y = nbrIdx % 5;
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

    readNeighborhood() { return new Uint8Array (Array.from({length: this.HIMEM + 1}).map((_,addr) => this.read(addr))) }
    writeNeighborhood (snapshot) { snapshot.forEach ((val, addr) => this.write (addr, val)) }
};

class BoardController {
    
};