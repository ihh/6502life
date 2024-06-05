import BoardMemory from './memory.js';

import { Sfotty } from '@sfotty-pie/sfotty';
import { VANILLA_OPCODES } from "@sfotty-pie/opcodes";

// lookups for permutations and combinations
const removeNth = (list, n) => list.slice(0,n).concat(list.slice(n+1,list.length));
const getPermutations = (list) => list.length===0 ? [[]] : list.reduce((r,e,n) => r.concat(getPermutations(removeNth(list,n)).map((p)=>[e].concat(p))), []);
const getCombinations = (list, k) => k===0 ? [[]] : list.length < k ? [] : list.reduce((r,e,n) => r.concat(getCombinations(list.slice(n+1),k-1).map((c)=>[e].concat(c))), []);

const combos4C2 = getCombinations ([0,1,2,3], 2);  // 6
const combos4C3 = getCombinations ([0,1,2,3], 3);  // 4
const combos4C4 = getCombinations ([0,1,2,3], 4);  // 1
const perms2 = getPermutations([0,1]);     // 2
const perms3 = getPermutations([0,1,2]);   // 6
const perms4 = getPermutations([0,1,2,3]); // 24

const permute = (list, perm) => perm.map ((n) => list[n]);

// board controller
class BoardController {
    constructor (board) {
        this.board = board || new BoardMemory();
        this.newSfotty();
        this.readRegisters();
        this.writeRng();
        this.sfotty = new Sfotty(this.board);
        this.isValidOpcode = Array.from({length: 256 });
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
        const PC = this.board.unrotatePC (this.sfotty.PC);
        this.board.write (this.regAddr, this.sfotty.A);
        this.board.write (this.regAddr+1, this.sfotty.X);
        this.board.write (this.regAddr+2, this.sfotty.Y);
        this.board.write (this.regAddr+3, PC >> 8);
        this.board.write (this.regAddr+4, PC & 8);
        this.board.write (this.regAddr+5, this.sfotty.P);
        this.board.write (this.regAddr+6, this.sfotty.S);
    }

    readRegisters() {
        this.sfotty.A = this.board.read (this.regAddr);
        this.sfotty.X = this.board.read (this.regAddr+1);
        this.sfotty.Y = this.board.read (this.regAddr+2);
        this.sfotty.PC = this.board.rotatePC ((this.board.read (this.regAddr+3) << 8) | this.board.read (this.regAddr+4));
        this.sfotty.P = this.board.read (this.regAddr+5);
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
                        const { A, X, Y } = this.sfotty;
                        const swap1 = 1,
                              swap2 = swap1 + 16,  // 24
                              swap3 = swap2 + 72,  // 89
                              swap4 = swap3 + 96,  // 185
                              swap5 = swap4 + 24;  // 210
                        if (A >= swap1 && A < swap5) {
                            let valid = X < 49 && Y < 49;
                            let xPages, yPages;
                            if (A >= swap1 && A < swap2) {  //  1 -> 1, 4*4=16 options
                                const op = A - swap1;
                                xPages = [op >> 2];
                                yPages = [op & 3];
                            } else if (A >= swap2 && A < swap3) {  //  2 -> 2, 6*6*2=72 options
                                const op = A - swap2;
                                const xCombo = op % 6, yCombo = Math.floor(op / 6) % 6, yPerm = Math.floor(op / 36);
                                xPages = combos4C2[xCombo];
                                yPages = permute (combos4C2[yCombo], perms2[yPerm]);
                            } else if (A >= swap3 && A < swap4) {  //  3 -> 3, 4*4*6=96 options
                                const op = A - swap3;
                                const xCombo = op % 4, yCombo = Math.floor(op / 4) % 4, yPerm = Math.floor(op / 16);
                                xPages = combos4C3[xCombo];
                                yPages = permute (combos4C3[yCombo], perms3[yPerm]);
                            } else if (A >= swap4 && A < swap5) {  // 4 -> 4, 24 options
                                const op = A - swap4;
                                xPages = combos4C4[0];
                                yPages = permute (combos4C4[0], perms4[op]);
                            }
                            if (X == Y) {
                                const hasOverlap = xPages.filter(p=>yPages.includes(p));
                                const exactMatch = xPages.filter((p,n)=>yPages[n]==p);
                                valid = valid && (exactMatch || !hasOverlap);
                            }
                            if (valid)
                                xPages.forEach ((xPage, n) => this.swapPages(X*4+xPage,Y*4+yPages[n]));
                        }
                    }
                }
                this.board.sampleNextMove();
                this.board.resetUndoHistory();
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
