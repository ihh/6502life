import MersenneTwister from 'mersennetwister';

class BoardMemory {
    constructor(seed = 42) {
        this.data = new Uint8Array (this.storageSize);
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
    }

    get B() { return 256 }
    get M() { return 1024 }
    get N() { return 5 }
    get log2M() { return 10 }  // = log_2(M)
    get storageSize() { return this.B * this.B * this.M; }
    get neighborhoodSize() { return this.N * this.N * this.M; }
    get byteOffsetMask() { return this.M - 1 }
    get HIMEM() { return this.neighborhoodSize - 1 }

    wrapCoord (i) { return (i + this.B) % this.B; }

    getByte (idx) { return this.data[idx]; }
    setByte (idx, val) { this.data[idx] = val & 0xFF; }

    ijbToByteIndex (i, j, b) {
        return this.M * (j + this.B * this.i) + b;
    }

    addrToByteIndex (addr) {
        if (addr < 0 || addr > this.HIMEM)
            return -1;
        const b = addr & this.byteOffsetMask;
        const nbrIdx = addr >> this.log2M;
        const x = Math.floor (nbrIdx / this.N);
        const y = nbrIdx % this.N;
        return this.ijbToByteIndex (this.wrapCoord (this.i + x),
                                    this.wrapCoord (this.j + y),
                                    b);
    }

    read (addr) {
        const idx = this.addrToByteIndex (addr);
        return idx < 0 ? 0 : this.getByte (idx);
    }

    write (addr, val) {
        const idx = this.addrToByteIndex (addr);
        if (idx >= 0)
            this.setByte (idx, val);
    }

    readNeighborhood() {
        return new Uint8Array (Array.from({length: this.HIMEM + 1})
                                    .map((_,addr) => this.read(addr)));
    }
    writeNeighborhood (snapshot) {
        snapshot.forEach ((val, addr) => this.write (addr, val));
    }
};

export default BoardMemory;
