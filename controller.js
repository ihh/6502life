import BoardMemory from './memory.js';

import { Sfotty } from '@sfotty-pie/sfotty';
import { VANILLA_OPCODES } from "@sfotty-pie/opcodes";

class BoardController {
    constructor (board) {
        this.board = board || new BoardMemory();
        this.newSfotty();
        this.readSAXY();
        this.clearPPC();
        this.writeRng();
        this.sfotty = new Sfotty(this.board);
        this.isValidOpcode = Array.from({length: 256 });
        VANILLA_OPCODES.forEach ((opcode) => this.isValidOpcode[opcode.opcode] = true);
    }

    get rngAddr() { return 0xFC }

    get state() {
        return { board: this.board.state,
                 S: this.sfotty.S,
                 A: this.sfotty.A,
                 X: this.sfotty.X,
                 Y: this.sfotty.Y,
                 P: this.sfotty.P,
                 PC: this.sfotty.PC };
    }

    set state(s) {
        this.board.state = s.state;
        this.sfotty.S = s.S;
        this.sfotty.A = s.A;
        this.sfotty.X = s.X;
        this.sfotty.Y = s.Y;
        this.sfotty.P = s.P;
        this.sfotty.PC = s.PC;
    }

    newSfotty() {
        this.sfotty = new Sfotty(this.memory);
    }

    nextOpcode() {
        return this.board.read (this.sfotty.PC);
    }

    nextOperand() {
        return this.board.read (this.sfotty.PC + 1);
    }

    pushByte (val) {
        const S = this.sfotty.S;
        this.board.write (0x100 + S, val);
        this.sfotty.S = S - 1 & 0xFF;
    }

    pushWord (val) {
        const hi = (val >> 8) & 0xFF, lo = val & 0xFF;
        this.pushByte (hi);
        this.pushByte (lo);
    }

    writeDword (addr, val) {
        this.board.write (addr, (val >> 24) & 0xFF);
        this.board.write (addr+1, (val >> 16) & 0xFF);
        this.board.write (addr+2, (val >> 8) & 0xFF);
        this.board.write (addr+3, val & 0xFF);
    }

    pushIrq (setBflag) {
        this.pushWord (this.sfotty.PC | (setBflag ? (1 << 4) : 0));
        this.pushByte (this.sfotty.P);

    }

    writeSAXY() {
        this.board.write (this.rngAddr, this.sfotty.S);
        this.board.write (this.rngAddr+1, this.sfotty.A);
        this.board.write (this.rngAddr+2, this.sfotty.X);
        this.board.write (this.rngAddr+3, this.sfotty.Y);
    }

    readSAXY() {
        this.sfotty.S = this.board.read (this.rngAddr);
        this.sfotty.A = this.board.read (this.rngAddr+1);
        this.sfotty.X = this.board.read (this.rngAddr+2);
        this.sfotty.Y = this.board.read (this.rngAddr+3);
    }

    writeRng() {
        this.writeDword (this.rngAddr, this.board.nextRnd);
    }

    clearPPC() {
        this.sfotty.P = 0;
        this.sfotty.PC = 0;
    }

    swapCells (i, j) {
        const iAddr = i * this.board.M, jAddr = j * this.board.M;
        for (let b = 0; b < this.board.M; ++b) {
            const iOld = this.board.read(iAddr+b), jOld = this.board.read(jAddr+b);
            this.board.write (iAddr+b, jOld);
            this.board.write (jAddr+b, iOld);
        }
    }

    copyCell (src, dest) {
        const srcAddr = src * this.board.M, destAddr = dest * this.board.M;
        for (let b = 0; b < this.board.M; ++b)
            this.board.write (destAddr+b, this.board.read(srcAddr+b));
    }

    zeroCell (i) {
        const iAddr = i * this.board.M;
        for (let b = 0; b < this.board.M; ++b)
            this.board.write (iAddr+b, 0);
    }

    // NB this randomize() function avoids updating the Board's RNG
    randomize(rng) {
        rng = rng || (() => Math.random() * 2**32);
        for (let idx = 0; idx < this.board.storageSize; idx += 4) {
            const r = rng();
            this.board.setByteWithoutUndo (idx, (r >> 24) & 0xFF);
            this.board.setByteWithoutUndo (idx+1, (r >> 16) & 0xFF);
            this.board.setByteWithoutUndo (idx+2, (r >> 8) & 0xFF);
            this.board.setByteWithoutUndo (idx+3, r & 0xFF);
        }
        this.board.resetUndoHistory();
        this.readSAXY();
        this.clearPPC();
        this.writeRng();
    }

    runToNextInterrupt() {
        let cpuCycles = 0;
        const schedulerCycles = this.board.nextCycles;
        while (true) {
            const nextOp = this.nextOpcode();
            const isBRK = nextOp == 0;
            const isBadOpcode = !this.isValidOpcode[nextOp];
            const isSoftwareInterrupt = isBRK || isBadOpcode;
            if (isSoftwareInterrupt) {
                cpuCycles += 7;  // software interrupt (BRK) takes 7 cycles
            } else {
                this.sfotty.run();
                cpuCycles += this.sfotty.cycleCounter;
            }
            const isTimerInterrupt = cpuCycles >= schedulerCycles;
            if (isTimerInterrupt || isSoftwareInterrupt) {
                if (isTimerInterrupt && this.sfotty.I)
                    this.board.undoWrites();
                else {
                    this.board.disableUndoHistory();
                    this.pushIrq (isSoftwareInterrupt);
                    this.writeSAXY();
                    if (isBRK && this.nextOperand() == 1) {  // BRK: bulk memory operations
                        const { A, X, Y } = this.sfotty;
                        const xValid = X < 49, yValid = Y < 49;
                        switch (A) {
                            case 1:  // kill X
                                if (xValid) this.zeroCell(X);
                                break;
                            case 2:  // kill X, Y
                                if (xValid) this.zeroCell(X);
                                if (yValid) this.zeroCell(Y);
                                break;
                            case 3:  // kill 0, X, Y
                                this.zeroCell(0);
                                if (xValid) this.zeroCell(X);
                                if (yValid) this.zeroCell(Y);
                                break;
                            case 4:  // copy X to Y
                                if (xValid && yValid) this.copyCell(X,Y);
                                break;
                            case 5:  // copy 0 to X and Y
                                if (xValid) this.copyCell(0,X);
                                if (yValid) this.copyCell(0,Y);
                                break;
                            case 6:  // swap X and Y
                                if (xValid && yValid) this.swapCells(X,Y);
                                break;
                            case 7:  // cyclic permutation of 0, X, and Y
                                if (xValid && yValid) {
                                    this.swapCells(0,Y);
                                    this.swapCells(X,Y);
                                }
                                break;
                            default:
                                break;
                        }
                    }
                }
                this.board.sampleNextMove();
                this.board.resetUndoHistory();
                this.readSAXY();
                this.clearPPC();
                this.writeRng();
                break;
            }
        }
        return { cpuCycles, schedulerCycles }
    }

    setUpdater (clockSpeedMHz = 2, callbackRateHz = 100) {
        const targetCyclesPerCallback = 1e6 / clockSpeedMHz;
        let totalSchedulerCycles = 0;
        return setInterval (() => {
            while (totalSchedulerCycles < targetCyclesPerCallback) {
                const { schedulerCycles } = this.runToNextInterrupt();
                totalSchedulerCycles += schedulerCycles;
            }
            totalSchedulerCycles -= targetCyclesPerCallback;
        }, 1000 / callbackRateHz)
    }
};

export default BoardController;
