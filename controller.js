import BoardMemory from './memory.js';

import { Sfotty } from '@sfotty-pie/sfotty';
import { VANILLA_OPCODES } from "@sfotty-pie/opcodes";

// lookups for permutations and combinations
const concatLists = lists => lists.reduce((a,b)=>a.concat(b),[]);
const range = (A, B) => Array.from({length:B+1-A}).map((_,k)=>A+k);

const pagesFor0 = [[]];
const pagesForN = N => pagesFor0.concat (concatLists (range(1,N).map(len=>range(0,N-len).map(start=>[range(start,start+len-1)]))));
const pagesFor4 = pagesForN(4);

const pagesDump = pages => pages.map((p,n)=>n+': ('+p.join(',')+')').join("\n");
// console.log (pagesDump(pagesFor4))

// board controller
class BoardController {
    constructor (board) {
        this.board = board || new BoardMemory();
        this.newSfotty();
        this.readRegisters();
        this.writeRng();
        this.sfotty = new Sfotty(this.board);
        this.isValidOpcode = Array.from({length: 256});
        VANILLA_OPCODES.forEach ((opcode) => this.isValidOpcode[opcode.opcode] = true);
    }

    get regAddr() { return 0xF9 }

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

    writeDword (addr, val) {
        this.board.write (addr, (val >> 24) & 0xFF);
        this.board.write (addr+1, (val >> 16) & 0xFF);
        this.board.write (addr+2, (val >> 8) & 0xFF);
        this.board.write (addr+3, val & 0xFF);
    }

    writeRegisters() {
        const PC = this.board.unrotatePC (this.sfotty.PC & 0xFFFF);
        this.board.write (this.regAddr, this.sfotty.A);
        this.board.write (this.regAddr+1, this.sfotty.X);
        this.board.write (this.regAddr+2, this.sfotty.Y);
        this.board.write (this.regAddr+3, PC >> 8);
        this.board.write (this.regAddr+4, PC & 8);
        this.board.write (this.regAddr+5, this.sfotty.P);
        this.board.write (this.regAddr+6, this.sfotty.S);
    }

    readRegisters() {
        this.sfotty.P = this.board.read (this.regAddr+5);
        const D = (this.sfotty.P >> 3) & 1;
        if (this.sfotty.D)
            this.board.orientation = 0;
        this.sfotty.A = this.board.read (this.regAddr);
        this.sfotty.X = this.board.read (this.regAddr+1);
        this.sfotty.Y = this.board.read (this.regAddr+2);
        this.sfotty.PC = this.board.rotatePC ((this.board.read (this.regAddr+3) << 8) | this.board.read (this.regAddr+4));
        this.sfotty.S = this.board.read (this.regAddr+6);
    }

    writeRng() {
        this.writeDword (this.regAddr+3, this.board.nextRnd);
    }

    swapPages (i, j) {
        const iAddr = i * 256, jAddr = j * 256;
        for (let b = 0; b < 256; ++b) {
            const iOld = this.board.read(iAddr+b), jOld = this.board.read(jAddr+b);
            this.board.write (iAddr+b, jOld);
            this.board.write (jAddr+b, iOld);
        }
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
        this.readRegisters();
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
                this.sfotty.PC = (this.sfotty.PC + 2) % 0x10000;
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
                    this.writeRegisters();
                    if (isBRK) {  // BRK: bulk memory operations
                        const A = this.sfotty.A & 0xFF;
                        const X = this.sfotty.X & 0xFF;
                        const Y = this.sfotty.Y & 0xFF;
                        if (X < 49 && Y < 49) {
                            if (A < pagesFor4.length)
                                pagesFor4[A].forEach (page => this.swapPages (X*4 + page, Y*4 + page));
                        }
                    }
                    this.board.resetUndoHistory();
                }
                this.board.sampleNextMove();
                this.readRegisters();
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
