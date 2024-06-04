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
            const isSoftwareInterrupt = nextOp == 0 || !this.isValidOpcode[nextOp];
            if (isSoftwareInterrupt) {
                cpuCycles += 7;  // software interrupt (BRK) takes 7 cycles
            } else {
                this.sfotty.run();
                cpuCycles += this.sfotty.cycleCounter;
            }
            const isTimerInterrupt = cpuCycles >= schedulerCycles;
            if (isTimerInterrupt) {
                if (this.sfotty.I)
                    this.board.undoWrites();
                else {
                    this.pushIrq(false);
                    this.writeSAXY();
                }
                this.board.sampleNextMove();
                this.board.resetUndoHistory();
                this.readSAXY();
                this.clearPPC();
                this.writeRng();
                break;
            } else if (isSoftwareInterrupt) {
                this.pushIrq(true);
                this.clearPPC();
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
