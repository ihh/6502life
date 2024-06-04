import BoardMemory from './memory.js';

import { Sfotty } from '@sfotty-pie/sfotty';

class BoardController {
    constructor (board) {
        this.board = board || new BoardMemory();
        this.resetSfotty();
        this.readSAXY();
        this.writeRng();
        this.sfotty = new Sfotty(this.board);
        this.cycleCounter = 0;
    }

    get rngAddr() { return 0xFC }

    get cyclesToNextInterrupt() {
        return this.board.cycles;
    }

    resetSfotty() {
        this.sfotty = new Sfotty(this.memory);
    }

    pushByte (val) {
        const S = this.sfotty.S;
        this.board.write (0x100 + S, val);
        this.sfotty.S = S - 1;
    }

    pushWord16 (val) {
        const hi = (val >> 8) & 0xFF, lo = val & 0xFF;
        this.push (hi);
        this.push (lo);
    }

    writeDWord32 (addr, val) {
        this.board.write (addr, (val >> 24) & 0xFF);
        this.board.write (addr+1, (val >> 16) & 0xFF);
        this.board.write (addr+2, (val >> 8) & 0xFF);
        this.board.write (addr+3, val & 0xFF);
    }

    pushIrq() {
        this.pushWord16 (sfotty.PC);
        this.pushByte (sfotty.P);

    }

    writeSAXY() {
        this.board.write (this.rngAddr, sfotty.S);
        this.board.write (this.rngAddr+1, sfotty.A);
        this.board.write (this.rngAddr+2, sfotty.X);
        this.board.write (this.rngAddr+3, sfotty.Y);
    }

    readSAXY() {
        this.sfotty.S = this.board.read (this.rngAddr);
        this.sfotty.A = this.board.read (this.rngAddr+1);
        this.sfotty.X = this.board.read (this.rngAddr+2);
        this.sfotty.Y = this.board.read (this.rngAddr+3);
    }

    writeRng() {
        this.board.writeDword32 (this.rngAddr, this.board.nextRnd);
    }

    reset() {
        this.sfotty.P = 0;
        this.sfotty.PC = 0;
        this.sfotty.cycleCounter = 0;
    }

    moveAndTakeSnapshot() {
        this.board.sampleNextMove();
        this.snapshot = this.board.readNeighborhood();
    }

    restoreSnapshot() {
        this.board.writeNeighborhood (this.snapshot);
    }

    runToNextInterrupt() {
        while (true) {
            this.sfotty.run();
            if (this.sfotty.cycleCounter >= this.cyclesToNextInterrupt) {
                this.cycleCounter += this.cyclesToNextInterrupt;
                if (this.sfotty.I)
                    this.restoreSnapshot();
                else {
                    this.pushIrq();
                    this.writeSAXY();
                }
                this.moveAndTakeSnapshot();
                this.readSAXY();
                this.writeRng();
                break;
            }
        }
    }
};

export default BoardController;