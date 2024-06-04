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
        this.cpuCycles = 0;
        this.schedulerCycles = 0;
        this.isValidOpcode = Array.from({length: 256 });
        VANILLA_OPCODES.forEach ((opcode) => this.isValidOpcode[opcode.opcode] = true);
    }

    get rngAddr() { return 0xFC }

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

    // The rng used by randomize is not the same one the board uses for scheduling
    // This is deliberate: we avoid perturbing the Board's rng as much as possible
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
        let cycles = 0;
        while (true) {
            const nextOp = this.nextOpcode();
            const isSoftwareInterrupt = nextOp == 0 || !this.isValidOpcode[nextOp];
            if (!isSoftwareInterrupt)
                this.sfotty.run();
            cycles += this.sfotty.cycleCounter;
            const isTimerInterrupt = cycles >= this.board.nextCycles;
            if (isSoftwareInterrupt || isTimerInterrupt) {
                this.cpuCycles += cycles;
                this.schedulerCycles += this.board.nextCycles;
                if (this.sfotty.I)
                    this.board.undoWrites();
                else {
                    this.pushIrq (isSoftwareInterrupt);
                    this.writeSAXY();
                }
                this.board.sampleNextMove();
                this.board.resetUndoHistory();
                this.readSAXY();
                this.clearPPC();
                this.writeRng();
                break;
            }
        }
    }

    setUpdater (clockSpeedMHz = 2, callbackRateHz = 100) {
        const targetCyclesPerCallback = 1e6 / clockSpeedMHz;
        let lastCycleMarker = this.schedulerCycles;
        return setInterval (() => {
            while (this.schedulerCycles < lastCycleMarker + targetCyclesPerCallback)
                this.runToNextInterrupt();
            lastCycleMarker += targetCyclesPerCallback;
        }, 1000 / callbackRateHz)
    }
};

export default BoardController;