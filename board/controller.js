import { BoardMemory } from './memory.js';

import { Sfotty } from '@sfotty-pie/sfotty';
import { VANILLA_OPCODES } from "@sfotty-pie/opcodes";

// board controller
class BoardController {
    constructor (memory, noiseParams) {
        this.memory = memory || new BoardMemory();
        this.totalCycles = 0;
        this.lastMoveTime = this.newCellArray(()=>0);
        this.lastWriteTime = this.newCellArray(()=>0);
        this.lastWriteTimeForByte = this.newCellArray(()=>this.newCellByteArray(()=>0));
        this.noiseParams = Object.assign({
            pBitNoise: 1 / 2048,  // ~1 bit error per 256-byte page copied
        }, noiseParams);
        // Hook for BRK copy/swap events. Called with (type, src, dest) where
        // type is 'swap' or 'copy', src/dest are neighborhood cell indices.
        this.onBrkEvent = null;
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
                 PC: this.sfotty.PC,
                 noiseParams: Object.assign({}, this.noiseParams) };
    }

    set state(s) {
        this.memory.state = s.memory;
        this.sfotty.S = s.S;
        this.sfotty.A = s.A;
        this.sfotty.X = s.X;
        this.sfotty.Y = s.Y;
        this.sfotty.P = s.P;
        this.sfotty.PC = s.PC;
        if (s.noiseParams)
            Object.assign(this.noiseParams, s.noiseParams);
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
        // Suppress Sfotty's "The 6502 CPU crashed" console.error.
        // In 6502life, undocumented opcodes are expected (random cell content)
        // and handled by the controller as BRK 0. Sfotty's decode() prints
        // this message before we can intercept it, so we patch decode.
        const origDecode = this.sfotty.decode.bind(this.sfotty);
        this.sfotty.decode = () => {
            const saved = console.error;
            console.error = () => {};
            origDecode();
            console.error = saved;
        };
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
        // Write directly to storage, bypassing address translation.
        // Register offsets are in the origin cell (neighborhood cell 0).
        const base = this.memory.neighborCellStorageBase(0);
        const s = this.memory.storage;
        s[base + this.regAddrPCHI] = (this.sfotty.PC >> 8) & 0xFF;
        s[base + this.regAddrPCLO] = this.sfotty.PC & 0xFF;
        s[base + this.regAddrP] = this.sfotty.P;
        s[base + this.regAddrA] = this.sfotty.A;
        s[base + this.regAddrX] = this.sfotty.X;
        s[base + this.regAddrY] = this.sfotty.Y;
        s[base + this.regAddrS] = this.sfotty.S;
    }

    readRegisters() {
        const base = this.memory.neighborCellStorageBase(0);
        const s = this.memory.storage;
        this.sfotty.PC = (s[base + this.regAddrPCHI] << 8) | s[base + this.regAddrPCLO];
        this.sfotty.P = s[base + this.regAddrP];
        this.sfotty.A = s[base + this.regAddrA];
        this.sfotty.X = s[base + this.regAddrX];
        this.sfotty.Y = s[base + this.regAddrY];
        this.sfotty.S = s[base + this.regAddrS];
    }

    writeRng() {
        const base = this.memory.neighborCellStorageBase(0);
        const s = this.memory.storage;
        const rnd = this.memory.nextRnd;
        s[base + this.rngAddr] = (rnd >> 24) & 0xFF;
        s[base + this.rngAddr + 1] = (rnd >> 16) & 0xFF;
        s[base + this.rngAddr + 2] = (rnd >> 8) & 0xFF;
        s[base + this.rngAddr + 3] = rnd & 0xFF;
    }

    swapCells (i, j) {
        // Compute storage bases once, then swap directly on storage[]
        // bypassing address translation entirely.
        const mem = this.memory;
        const iBase = mem.neighborCellStorageBase(i);
        const jBase = mem.neighborCellStorageBase(j);
        const storage = mem.storage;
        const M = mem.M;
        for (let b = 0; b < M; ++b) {
            const tmp = storage[iBase + b];
            storage[iBase + b] = storage[jBase + b];
            storage[jBase + b] = tmp;
        }
    }

    copyCellWithNoise (dest) {
        const mem = this.memory;
        const mt = mem.mt;
        const eps = this.noiseParams.pBitNoise;
        const storage = mem.storage;
        const srcBase = mem.neighborCellStorageBase(0);  // origin cell
        const dstBase = mem.neighborCellStorageBase(dest);
        const M = mem.M;
        if (eps === 0) {
            // Perfect copy — direct storage memcpy
            for (let b = 0; b < M; ++b) {
                storage[dstBase + b] = storage[srcBase + b];
            }
        } else {
            for (let b = 0; b < M; ++b) {
                const srcByte = storage[srcBase + b];
                const rndByte = mt.int() & 0xFF;
                let noiseBits = 0;
                for (let bit = 0; bit < 8; ++bit) {
                    if (mt.real() < eps)
                        noiseBits |= (1 << bit);
                }
                storage[dstBase + b] = (rndByte & noiseBits) | (srcByte & ~noiseBits);
            }
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
            // Only check for BRK/bad opcode at instruction boundaries
            // (cycleCounter === 0), not mid-instruction where PC points
            // at operand bytes that could be misidentified as bad opcodes.
            let isSoftwareInterrupt = false;
            let isBRK = false;
            let brkOperand = 0;
            let elapsedCycles = 0;
            if (this.sfotty.cycleCounter === 0) {
                const nextOpcode = this.nextOpcode();
                isBRK = nextOpcode == 0;
                const isBadOpcode = !this.isValidOpcode[nextOpcode];
                isSoftwareInterrupt = isBRK || isBadOpcode;
            }
            if (isSoftwareInterrupt) {
                // BRK takes 7 cycles on the real NMOS 6502: 2 to fetch
                // opcode + operand, 3 to push PC and P to stack, 2 to
                // read the IRQ vector. We use the same 7-cycle cost for
                // bad (undocumented) opcodes, treating them as BRK 0.
                elapsedCycles = 7;
                if (isBRK) brkOperand = this.nextOperandByte();
                this.sfotty.PC = (isBRK && brkOperand === 0) ? 0 : (this.sfotty.PC + 2) % 0x10000;
            } else {
                // Each sfotty.run() call is one CPU cycle.
                this.sfotty.run();
                elapsedCycles = 1;
            }
            cpuCycles += elapsedCycles;
            this.totalCycles += elapsedCycles;
            // Was this an interrupt (timer or BRK)?
            const isTimerInterrupt = cpuCycles >= schedulerCycles;
            if (isTimerInterrupt || isSoftwareInterrupt) {
                // If I flag is set, revert all the states to before the interrupt.
                // Were this fictitious system being implemented as a filesystem, this would be where you'd discard the unsaved work.
                // If the implementation was sideways RAM, there would be a bulk copy operation here.
                // Since we have it all in memory, we actually preserve an undo history at the BoardMemory level,
                // and call its built-in undo here.
                // Interrupt model:
                // Pre-emptive scheduling is conceptually IRQ (maskable by SEI)
                // followed by NMI (unmaskable context switch). Memory writeback
                // happens between the IRQ and NMI if the I flag allows it.
                if (isTimerInterrupt && this.sfotty.I)  // masked interrupt (I set)?
                    this.memory.undoWrites();            // revert all writes (atomic abort)
                else {
                    if (isBRK) {
                        // BRK copy/swap happens BEFORE registers are saved,
                        // so the child inherits the pre-BRK register state
                        // stored at $F9-$FF from the previous scheduling.
                        const operand = brkOperand;
                        const nDestCells = this.memory.Nsquared;  // 49
                        const nSrcCells = 5;
                        if (operand > 0 && operand < nSrcCells * nDestCells) {
                            const src = Math.floor(operand / nDestCells);
                            const dest = operand % nDestCells;
                            this.commitMove (src, dest);
                            if (this.onBrkEvent) this.onBrkEvent('swap', src, dest);
                        } else if (operand >= 245 && operand <= 252) {
                            const dest = operand - 244;
                            this.copyCellWithNoise (dest);
                            this.lastMoveTime[0] = this.totalCycles;
                            this.lastMoveTime[dest] = this.totalCycles;
                            if (this.onBrkEvent) this.onBrkEvent('copy', 0, dest);
                        }
                    }
                    this.commitWrites();
                    // B flag (bit 4 of P at $FB): set for BRK, clear for timer.
                    // Follows 6502 convention: BRK/PHP set B; IRQ/NMI clear B.
                    // Written directly to storage after commitWrites/writeRegisters,
                    // because Sfotty doesn't track B as a real CPU flag.
                    // This enables fork detection: after BRK copy, the child
                    // inherits B=clear (pre-BRK state), while the parent gets
                    // B=set (written here after the copy).
                    {
                        const base = this.memory.neighborCellStorageBase(0);
                        const pAddr = base + this.regAddrP;
                        if (isSoftwareInterrupt) {
                            this.memory.storage[pAddr] |= 0x10;   // set B
                        } else {
                            this.memory.storage[pAddr] &= ~0x10;  // clear B
                        }
                    }
                    this.memory.resetUndoHistory();
                }
                // Randomize: pick next cell, load its state
                this.memory.sampleNextMove();
                this.readRegisters();
                this.writeRng();
                // Reset Sfotty internal state for the new cell.
                // crashed: a previous cell's undocumented opcode sets this
                // cycleCounter/operations: stale decode state from prior cell
                this.sfotty.crashed = false;
                this.sfotty.cycleCounter = 0;
                this.sfotty.operations = [() => this.sfotty.decode()];
                break;
            }
        }
        return { cpuCycles, schedulerCycles }
    }

    commitWrites() {
        Object.keys(this.memory.undoHistory).forEach ((addr) => {
            const [i, j, b] = this.memory.ijbFromByteIndex (parseInt(addr));
            const cellIdx = this.memory.ijToCellIndex (i, j);
            this.lastWriteTime[cellIdx] = this.totalCycles;
            this.lastWriteTimeForByte[cellIdx][b] = this.totalCycles;
        })
        this.memory.disableUndoHistory();        
        this.writeRegisters();
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
