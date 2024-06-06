import BoardMemory from './memory.js';

import { Sfotty } from '@sfotty-pie/sfotty';
import { VANILLA_OPCODES } from "@sfotty-pie/opcodes";

// lookups for permutations and combinations
const concatLists = lists => lists.reduce((a,b)=>a.concat(b),[]);
const range = (A, B) => Array.from({length:B+1-A}).map((_,k)=>A+k);

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

    // Zero-page register store. Where the state of the processor is cached on interrupt
    get firstRegAddr() { return 0xF9 }
    get rngAddr() { return this.firstRegAddr }  // 0xF9 = RNG
    get regAddrA() { return this.firstRegAddr }  // 0xF9 = A
    get regAddrX() { return this.firstRegAddr+1 }  // 0xFA = X
    get regAddrY() { return this.firstRegAddr+2 }  // 0xFB = Y
    get regAddrPCHI() { return this.firstRegAddr+3 }  // 0xFC = PC(HI)
    get regAddrPCLO() { return this.firstRegAddr+4 }  // 0xFD = PC(LO)
    get regAddrP() { return this.firstRegAddr+5 }  // 0xFE = P
    get regAddrS() { return this.firstRegAddr+6 }  // 0xFF = S

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
        this.board.write (this.regAddrA, this.sfotty.A);
        this.board.write (this.regAddrX, this.sfotty.X);
        this.board.write (this.regAddrY, this.sfotty.Y);
        this.board.write (this.regAddrPCHI, PC >> 8);
        this.board.write (this.regAddrPCLO, PC & 0xFF);
        this.board.write (this.regAddrP, this.sfotty.P);
        this.board.write (this.regAddrS, this.sfotty.S);
    }

    readRegisters() {
        this.sfotty.P = this.board.read (this.firstRegAddr+5);
        const D = (this.sfotty.P >> 3) & 1;
        if (this.sfotty.D)
            this.board.orientation = 0;
        this.sfotty.A = this.board.read (this.regAddrA);
        this.sfotty.X = this.board.read (this.regAddrX);
        this.sfotty.Y = this.board.read (this.regAddrY);
        this.sfotty.PC = this.board.rotatePC ((this.board.read (this.regAddrPCHI) << 8) | this.board.read (this.regAddrPCLO));
        this.sfotty.S = this.board.read (this.regAddrS);
    }

    writeRng() {
        this.writeDword (this.firstRegAddr, this.board.nextRnd);
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
                        // A=0: swap 4-page blocks at X<<2, Y<<2
                        // A=1: swap 1-page blocks at X, Y
                        // Subroutine providing baseline cycle measurement for page copy:
                        // .C: PHP              1 (bytes), 3 (cycles)
                        //     PHA              1, 3
                        //     STX SRC          3, 4
                        //     STY DEST         3, 4
                        //     LDY #0           2, 2
                        //     STY SRC+1        3, 4
                        //     STY DEST+1       3, 4
                        // .L: LDA (SRC),Y      3, 5 * 256 (reps)
                        //     STA (DEST),Y     3, 6 * 256
                        //     DEY              1, 2 * 256
                        //     BNE L            2, 3 * 256
                        //     LDY DEST         3, 4
                        //     PLA              1, 4
                        //     PLP              1, 4
                        //     RTS              1, 6
                        // Total program size: 1+1+3+3+2+3*4+1+2+3+1*3 = 31 bytes
                        // Total T = 3+3+4+4+2+4+4+(5+6+2+3)*256+4+4+4+6 = 4138 cycles
                        // Binary symmetric channel BSC(P) with bit-flip probability P
                        // has capacity C(P) = 1-H(P) = 1 - P*lg(P) - (1-P)*lg(1-P)
                        // Time to send L bits error-free over channel with capacity C is T0 = L/C = 4138
                        // Thus, we can imagine T=L/(1-H(P)) for some P.
                        // If we do not use an error-correcting code, but just use the raw channel, time should be T1 = L < T0.
                        // Thus T1/T0 = 1 - H(P)
                        //       H(P) = 1 - T1/T0
                        //          P = invH(1 - T1/T0)
                        // We can approximate invH(Q) = (1-sqrt(1-Q^(4/3)))/2
                        // thus P = sqrt(1 - (T1/T0)^(4/3))
                        if (A == 0 && X < 49 && Y < 49)
                            for (let page = 0; page < 4; ++page)
                                this.swapPages (X*4 + page, Y*4 + page);
                        else if (A == 1 && X < 49*4 && Y < 49*4)
                            this.swapPages (X, Y);
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
