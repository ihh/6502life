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
    get rngAddr() { return 0xFC }  // 0xFC..0xFF = random number generator
    get regAddrPCHI() { return 0xF9 }  // 0xF9 = PC(HI)
    get regAddrPCLO() { return 0xFA }  // 0xFA = PC(LO)
    get regAddrP() { return 0xFB }  // 0xFB = P
    get regAddrA() { return 0xFC }  // 0xFC = A
    get regAddrX() { return 0xFD }  // 0xFD = X
    get regAddrY() { return 0xFE }  // 0xFE = Y
    get regAddrS() { return 0xFF }  // 0xFF = S

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
        this.board.write (this.regAddrPCHI, (this.sfotty.PC >> 8) & 0xFF);
        this.board.write (this.regAddrPCLO, this.sfotty.PC & 0xFF);
        this.board.write (this.regAddrP, this.sfotty.P);
        this.board.write (this.regAddrA, this.sfotty.A);
        this.board.write (this.regAddrX, this.sfotty.X);
        this.board.write (this.regAddrY, this.sfotty.Y);
        this.board.write (this.regAddrS, this.sfotty.S);
    }

    readRegisters() {
        this.sfotty.PC = (this.board.read (this.regAddrPCHI) << 8) | this.board.read (this.regAddrPCLO);
        this.sfotty.P = this.board.read (this.regAddrP);
        this.sfotty.A = this.board.read (this.regAddrA);
        this.sfotty.X = this.board.read (this.regAddrX);
        this.sfotty.Y = this.board.read (this.regAddrY);
        this.sfotty.S = this.board.read (this.regAddrS);
    }

    writeRng() {
        this.writeDword (this.rngAddr, this.board.nextRnd);
    }

    swapPages (i, j) {
        const iAddr = i * 256, jAddr = j * 256;
        for (let b = 0; b < 256; ++b) {
            const iOld = this.board.read(iAddr+b), jOld = this.board.read(jAddr+b);
            this.board.write (iAddr+b, jOld);
            this.board.write (jAddr+b, iOld);
        }
    }

    // copyPage: copy a random 50% of the bits of a page
    copyPage (i, j) {
        const iAddr = i * 256, jAddr = j * 256;
        for (let q = 0; q < 256; q += 4) {
            let mask = this.board.mt.int();
            for (let b = q; b < q + 4; ++b) {
                const copyMask = mask & 0xFF, resetMask = copyMask ^ 0xFF;
                this.board.write (jAddr+b, (this.board.read(jAddr+b) & resetMask) | (this.board.read(iAddr+b) & copyMask));
            }
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
                        // A=0: SWAP4. swap 4-page blocks at X<<2, Y<<2
                        // A=1: SWAP1. swap 1-page blocks at X, Y
                        // A=2: COPY1. copy random 50% of bits from X to Y
                        // Subroutine providing baseline cycle measurement for page copy:
                        // .C: PHP              1 (bytes), 3 (cycles)
                        //     PHA              1, 3
                        //     STX SRC          3, 4
                        //     STY DEST         3, 4
                        //     LDY #0           2, 2
                        //     STY SRC+1        3, 4
                        //     STY DEST+1       3, 4
                        //     LDY #32          2, 2
                        // .L: LDA (SRC),Y      3, 5 * 256 (reps)
                        //     STA (DEST),Y     3, 6 * 256
                        //     DEY              1, 2 * 256
                        //     BMI L            2, 3 * 256
                        //     LDY DEST         3, 4
                        //     PLA              1, 4
                        //     PLP              1, 4
                        //     RTS              1, 6
                        // Total program size: 1+1+3+3+2+3+3+2+3+3+1+2+3+1*3 = 33 bytes
                        // Total T0 = 3+3+4+4+2+4+4+(5+6+2+3)*33+4+4+4+6 = 570 cycles (4138 for 256-byte program)

                        // We can model COPY1 (crudely) as a binary symmetric channel with bit-flip probability 0.25
                        // This has capacity 1-H(0.25) ~= 0.189
                        //
                        // Binary symmetric channel BSC(P) with bit-flip probability P
                        // has capacity C(P) = 1-H(P) = 1 - P*lg(P) - (1-P)*lg(1-P)
                        // Time to send L bits error-free over channel with capacity C is T0 = L/C
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
                        else if (A == 2 && X < 49*4 && Y < 49*4)
                            this.copyPage (X, Y);
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

    clearUpdater (updater) {
        clearInterval (updater)
    }
};

export default BoardController;
