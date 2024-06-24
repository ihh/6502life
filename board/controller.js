import { BoardMemory } from './memory.js';

import { Sfotty } from '@sfotty-pie/sfotty';
import { VANILLA_OPCODES } from "@sfotty-pie/opcodes";

// lookups for permutations and combinations
const concatLists = lists => lists.reduce((a,b)=>a.concat(b),[]);
const range = (A, B) => Array.from({length:B+1-A}).map((_,k)=>A+k);

// board controller
class BoardController {
    constructor (memory) {
        this.memory = memory || new BoardMemory();
        this.totalCycles = 0;
        this.lastMoveTime = this.newCellArray(()=>0);
        this.lastWriteTime = this.newCellArray(()=>0);
        this.lastWriteTimeForByte = this.newCellArray(()=>this.newCellByteArray(()=>0));
        this.newSfotty();
        this.readRegisters();
        this.writeRng();
        this.sfotty = new Sfotty(this.memory);
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
        return { memory: this.memory.state,
                 S: this.sfotty.S,
                 A: this.sfotty.A,
                 X: this.sfotty.X,
                 Y: this.sfotty.Y,
                 P: this.sfotty.P,
                 PC: this.sfotty.PC };
    }

    set state(s) {
        this.memory.state = s.memory;
        this.sfotty.S = s.S;
        this.sfotty.A = s.A;
        this.sfotty.X = s.X;
        this.sfotty.Y = s.Y;
        this.sfotty.P = s.P;
        this.sfotty.PC = s.PC;
    }

    newCellArray(initializer) {
        const B = this.memory.B;
        return Array.from({length:B*B}).map(initializer);
    }

    newCellByteArray(initializer) {
        const M = this.memory.M;
        return Array.from({length:M}).map(initializer);
    }

    newSfotty() {
        this.sfotty = new Sfotty(this.memory);
    }

    nextOpcode() {
        return this.memory.read (this.sfotty.PC);
    }

    nextOperandByte() {
        return this.memory.read (this.sfotty.PC + 1);
    }

    writeDword (addr, val) {
        this.memory.write (addr, (val >> 24) & 0xFF);
        this.memory.write (addr+1, (val >> 16) & 0xFF);
        this.memory.write (addr+2, (val >> 8) & 0xFF);
        this.memory.write (addr+3, val & 0xFF);
    }

    writeRegisters() {
        this.memory.write (this.regAddrPCHI, (this.sfotty.PC >> 8) & 0xFF);
        this.memory.write (this.regAddrPCLO, this.sfotty.PC & 0xFF);
        this.memory.write (this.regAddrP, this.sfotty.P);
        this.memory.write (this.regAddrA, this.sfotty.A);
        this.memory.write (this.regAddrX, this.sfotty.X);
        this.memory.write (this.regAddrY, this.sfotty.Y);
        this.memory.write (this.regAddrS, this.sfotty.S);
    }

    readRegisters() {
        this.sfotty.PC = (this.memory.read (this.regAddrPCHI) << 8) | this.memory.read (this.regAddrPCLO);
        this.sfotty.P = this.memory.read (this.regAddrP);
        this.sfotty.A = this.memory.read (this.regAddrA);
        this.sfotty.X = this.memory.read (this.regAddrX);
        this.sfotty.Y = this.memory.read (this.regAddrY);
        this.sfotty.S = this.memory.read (this.regAddrS);
    }

    writeRng() {
        this.writeDword (this.rngAddr, this.memory.nextRnd);
    }

    swapCells (i, j) {
        for (let k = 0; k < 4; ++k)
            this.swapPages (i*4 + k, j*4 + k)
    }

    swapPages (i, j) {
        const iAddr = i * 256, jAddr = j * 256;
        for (let b = 0; b < 256; ++b) {
            const iOld = this.memory.read(iAddr+b), jOld = this.memory.read(jAddr+b);
            this.memory.write (iAddr+b, jOld);
            this.memory.write (jAddr+b, iOld);
        }
    }

    // NB this randomize() function avoids updating the BoardMemory's RNG
    randomize(rng) {
        rng = rng || (() => Math.random() * 2**32);
        for (let idx = 0; idx < this.memory.storageSize; idx += 4) {
            const r = rng();
            this.memory.setByteWithoutUndo (idx, (r >> 24) & 0xFF);
            this.memory.setByteWithoutUndo (idx+1, (r >> 16) & 0xFF);
            this.memory.setByteWithoutUndo (idx+2, (r >> 8) & 0xFF);
            this.memory.setByteWithoutUndo (idx+3, r & 0xFF);
        }
        this.memory.resetUndoHistory();
        this.readRegisters();
        this.writeRng();
    }

    runToNextInterrupt() {
        let cpuCycles = 0;
        const schedulerCycles = this.memory.nextCycles;
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
            this.memory.totalCycles += elapsedCycles;
            // Was this an interrupt (timer or BRK)?
            const isTimerInterrupt = cpuCycles >= schedulerCycles;
            if (isTimerInterrupt || isSoftwareInterrupt) {
                // If I flag is set, revert all the states to before the interrupt.
                // Were this fictitious system being implemented as a filesystem, this would be where you'd discard the unsaved work.
                // If the implementation was sideways RAM, there would be a bulk copy operation here.
                // Since we have it all in memory, we actually preserve an undo history at the BoardMemory level,
                // and call its built-in undo here.
                if (isTimerInterrupt && this.sfotty.I)  // was this a masked interrupt?
                    this.memory.undoWrites();
                else {  // this was not a masked interrupt
                    // Notionally, this is where we write everything back to the filesystem, or discard the update.
                    // Since the filesystem is all in RAM, we 
                    this.commitWrites();  // does nothing to board, allows this controller object to update its last-modified times
                    if (isBRK) {
                        // BRK: software interrupt triggering fast memory swap
                        // Operand 0..244: Swap 4-page blocks starting at addresses (op%49, op/49) << 10
                        // Note that operands { 0, 50, 100, 150, 200 } do nothing except yield control to the interrupt handler.
                        const operand = this.nextOperandByte();
                        const nDestCells = this.memory.Nsquared;  // 49
                        const nSrcCells = 5;
                        if (operand > 0 && operand < nSrcCells * nDestCells)
                            this.commitMove (Math.floor(operand / nDestCells),
                                             operand % nDestCells);
                    }
                    this.memory.resetUndoHistory();
                }
                // Randomize
                this.memory.sampleNextMove();
                this.readRegisters();
                this.writeRng();
                break;
            }
        }
        return { cpuCycles, schedulerCycles }
    }

    commitWrites() {
        this.writeRegisters();
        this.memory.disableUndoHistory();
        Object.keys(this.memory.undoHistory).forEach ((addr) => {
            const [i, j, b] = this.memory.addrToCellCoords (addr);
            const cellIdx = this.memory.ijToCellIndex (i, j);
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

    makeUpdater (clockSpeedMHz = 2, callbackRateHz = 100) {
        const targetCyclesPerCallback = 1e6 / clockSpeedMHz;
        let totalSchedulerCycles = 0;
        const timerCallback = () => {
            while (totalSchedulerCycles < targetCyclesPerCallback) {
                const { schedulerCycles } = this.runToNextInterrupt();
                totalSchedulerCycles += schedulerCycles;
            }
            totalSchedulerCycles -= targetCyclesPerCallback;
        };
        const timerInterval = 1000 / callbackRateHz;
        return { timerCallback, timerInterval };
    }

    setUpdater (clockSpeedMHz = 2, callbackRateHz = 100) {
        const { timerCallback, timerInterval } = this.makeUpdater (clockSpeedMHz, callbackRateHz);
        return setInterval (timerCallback, timerInterval);
    }

    clearUpdater (updater) {
        clearInterval (updater)
    }
};

export { BoardController };
