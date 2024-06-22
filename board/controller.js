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
        this.totalCycles = 0;
        this.lastMoveTime = this.newCellArray(()=>0);
        this.lastWriteTime = this.newCellArray(()=>0);
        this.lastWriteTimeForByte = this.newCellArray(()=>this.newCellByteArray(()=>0));
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

    newCellArray(initializer) {
        const B = this.board.B;
        return Array.from({length:B*B}).map(initializer);
    }

    newCellByteArray(initializer) {
        const M = this.board.M;
        return Array.from({length:M}).map(initializer);
    }

    newSfotty() {
        this.sfotty = new Sfotty(this.memory);
    }

    nextOpcode() {
        return this.board.read (this.sfotty.PC);
    }

    nextOperandByte() {
        return this.board.read (this.sfotty.PC + 1);
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

    swapCells (i, j) {
        for (let k = 0; k < 4; ++k)
            this.swapPages (i*4 + k, j*4 + k)
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
            const nextOpcode = this.nextOpcode();
            const isBRK = nextOpcode == 0;
            const isBadOpcode = !this.isValidOpcode[nextOpcode];
            const isSoftwareInterrupt = isBRK || isBadOpcode;
            let elapsedCycles = 0;
            if (isSoftwareInterrupt) {
                elapsedCycles = 7;  // software interrupt (BRK) takes 7 cycles
                this.sfotty.PC = (this.sfotty.PC + 2) % 0x10000;
            } else {
                this.sfotty.run();
                elapsedCycles = this.sfotty.cycleCounter;
            }
            cpuCycles += elapsedCycles;
            this.board.totalCycles += elapsedCycles;
            const isTimerInterrupt = cpuCycles >= schedulerCycles;
            if (isTimerInterrupt || isSoftwareInterrupt) {
                if (isTimerInterrupt && this.sfotty.I)
                    this.board.undoWrites();
                else {
                    this.commitWrites();
                    if (isBRK) {  // BRK: bulk memory operations
                        // BRK 0..244: Swap 4-page blocks starting at addresses (op%49, op/49) << 10
                        // Note that opcodes { 0, 50, 100, 150, 200 } do nothing except yield control to the interrupt handler.
                        const operand = this.nextOperandByte();
                        const nDestCells = this.board.Nsquared;  // 49
                        const nSrcCells = 5;
                        if (operand > 0 && operand < nSrcCells*nDestCells)
                            this.commitMove (Math.floor(operand/nDestCells), operand % nDestCells);
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

    commitWrites() {
        this.writeRegisters();
        this.board.disableUndoHistory();
        Object.keys(this.board.undoHistory).forEach ((addr) => {
            const [i, j, b] = this.board.addrToCellCoords (addr);
            const cellIdx = this.board.ijToCellIndex (i, j);
            this.lastWriteTime[cellIdx] = this.totalCycles;
            this.lastWriteTimeForByte[cellIdx][b] = this.totalCycles;
        })
        
    }

    commitMove (src, dest) {
        if (src != dest)
            this.swapCells (src, dest);
        this.lastMoveTime[src] = this.totalCycles;
        this.lastMoveTime[dest] = this.totalCycles;
        // swap last write times for src and dest cells
        const t = this.lastWriteTime[src], tb = this.lastWriteTimeForByte[src];
        this.lastWriteTime[src] = this.lastWriteTime[dest];
        this.lastWriteTime[dest] = t;
        this.lastWriteTimeForByte[src] = this.lastWriteTimeForByte[dest];
        this.lastWriteTimeForByte[dest] = tb;
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
