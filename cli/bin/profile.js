#!/usr/bin/env node

// profile.js — Measure where wall-clock time is spent in the 6502life simulation loop
//
// Instruments the hot path in runToNextInterrupt() by monkey-patching the
// controller and memory objects to accumulate timings for:
//   1. Sfotty CPU execution (sfotty.run() calls)
//   2. Memory read/write operations (BoardMemory.read/write)
//   3. Scheduler overhead (sampleNextMove, register save/restore, RNG write)
//   4. Write tracking (commitWrites, undoWrites, undoHistory bookkeeping)
//   5. BRK handling (swapCells, copyCellWithNoise)
//
// Usage:
//   node cli/bin/profile.js [--interrupts N] [--size N] [--seed N]

import { performance } from 'perf_hooks';
import { readFileSync } from 'fs';
import { createBoard, writeCellBytes, zeroCellMemory } from '../../engine/board.js';
import { assemble } from '../../engine/assembler.js';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse simple flags
const args = process.argv.slice(2);
function getArg(name, def) {
    const idx = args.indexOf('--' + name);
    if (idx >= 0 && idx + 1 < args.length) return parseInt(args[idx + 1]);
    return def;
}

const TARGET_INTERRUPTS = getArg('interrupts', 1_000_000);
const SIZE = getArg('size', 8);
const SEED = getArg('seed', 42);
const NO_SPREADER = args.includes('--no-spreader');

console.log(`Profiling: ${SIZE}x${SIZE} board, seed=${SEED}, ${TARGET_INTERRUPTS.toLocaleString()} interrupts${NO_SPREADER ? ' (no spreader)' : ' (with brk-spreader)'}`);
console.log();

// Create board and load brk-spreader into cell (0,0)
const { controller, memory } = createBoard(SIZE, SEED);
controller.randomize();

if (!NO_SPREADER) {
    const spreaderSource = readFileSync(join(__dirname, '..', '..', 'presets', 'brk-spreader.asm'), 'utf-8');
    const spreaderBytes = await assemble(spreaderSource);
    zeroCellMemory(controller, 0, 0);
    writeCellBytes(controller, 0, 0, 0, spreaderBytes);
    writeCellBytes(controller, 0, 0, 0x200, spreaderBytes);
}

// Accumulators (in nanoseconds via performance.now() * 1e6, but we'll use ms)
let tCpuRun = 0;         // sfotty.run() calls
let tMemRead = 0;        // memory.read() calls
let tMemWrite = 0;       // memory.write() calls
let tScheduler = 0;      // sampleNextMove + readRegisters + writeRng
let tSampleNextMove = 0; // sampleNextMove alone
let tReadRegs = 0;       // readRegisters alone
let tWriteRng = 0;       // writeRng alone
let tCommitWrites = 0;   // commitWrites
let tUndoWrites = 0;     // undoWrites + resetUndoHistory
let tBrk = 0;            // swapCells + copyCellWithNoise
let tBrkSwapOnly = 0;
let tBrkCopyOnly = 0;
let nCpuRun = 0;
let nMemRead = 0;
let nMemWrite = 0;
let nBrkSwap = 0;
let nBrkCopy = 0;
let nUndoWrites = 0;
let nCommitWrites = 0;

// Strategy: Rather than monkey-patching individual read/write calls (too much overhead
// for per-call timing), we'll instrument at the coarser granularity of the interrupt loop
// by reimplementing runToNextInterrupt with timing around each phase.

// Warm up the JIT
console.log('Warming up JIT...');
for (let i = 0; i < 10000; i++) {
    controller.runToNextInterrupt();
}

// Reset state for the actual measurement
controller.randomize();
if (!NO_SPREADER) {
    const spreaderSource2 = readFileSync(join(__dirname, '..', '..', 'presets', 'brk-spreader.asm'), 'utf-8');
    const spreaderBytes2 = await assemble(spreaderSource2);
    zeroCellMemory(controller, 0, 0);
    writeCellBytes(controller, 0, 0, 0, spreaderBytes2);
    writeCellBytes(controller, 0, 0, 0x200, spreaderBytes2);
}

// Approach: We'll run the full loop and time the overall,
// then run again with individual components stubbed/timed.
// But that's impractical for 1M interrupts.
//
// Instead: instrument via a custom version of runToNextInterrupt
// that times each phase inline.

const sfotty = controller.sfotty;
const mem = controller.memory;
const isValidOpcode = controller.isValidOpcode;

console.log('Running profiled simulation...');
const tTotal0 = performance.now();

let totalInterrupts = 0;

while (totalInterrupts < TARGET_INTERRUPTS) {
    // --- Per-interrupt timing ---
    let cpuCycles = 0;

    // Phase: scheduler (sampleNextMove was called at end of previous interrupt)
    const schedulerCycles = mem.nextCycles;

    // Phase: CPU execution loop
    const tCpu0 = performance.now();
    while (true) {
        const nextOpcode = mem.read(sfotty.PC);
        const isBRK = nextOpcode === 0;
        const isBadOpcode = !isValidOpcode[nextOpcode];
        const isSoftwareInterrupt = isBRK || isBadOpcode;
        let elapsedCycles = 0;
        let brkOperand = 0;
        if (isSoftwareInterrupt) {
            elapsedCycles = 7;
            if (isBRK) brkOperand = mem.read(sfotty.PC + 1);
            sfotty.PC = (sfotty.PC + 2) % 0x10000;
        } else {
            sfotty.run();
            elapsedCycles = sfotty.cycleCounter;
            nCpuRun++;
        }
        cpuCycles += elapsedCycles;
        controller.totalCycles += elapsedCycles;

        const isTimerInterrupt = cpuCycles >= schedulerCycles;
        if (isTimerInterrupt || isSoftwareInterrupt) {
            const tCpu1 = performance.now();
            tCpuRun += (tCpu1 - tCpu0);

            // Phase: undo or commit
            if (isTimerInterrupt && sfotty.I) {
                const tUndo0 = performance.now();
                mem.undoWrites();
                const tUndo1 = performance.now();
                tUndoWrites += (tUndo1 - tUndo0);
                nUndoWrites++;
            } else {
                const tCommit0 = performance.now();
                controller.commitWrites();
                const tCommit1 = performance.now();
                tCommitWrites += (tCommit1 - tCommit0);
                nCommitWrites++;

                if (isBRK) {
                    const operand = brkOperand;
                    const tBrk0 = performance.now();
                    if (operand >= 1 && operand <= 48) {
                        controller.commitMove(0, operand);
                        nBrkSwap++;
                        const tBrk1s = performance.now();
                        tBrkSwapOnly += (tBrk1s - tBrk0);
                    } else if (operand >= 49 && operand <= 96) {
                        const dest = operand - 48;
                        controller.copyCellWithNoise(dest);
                        controller.lastMoveTime[0] = controller.totalCycles;
                        controller.lastMoveTime[dest] = controller.totalCycles;
                        nBrkCopy++;
                        const tBrk1c = performance.now();
                        tBrkCopyOnly += (tBrk1c - tBrk0);
                    }
                    const tBrk1 = performance.now();
                    tBrk += (tBrk1 - tBrk0);
                }
                mem.resetUndoHistory();
            }

            // Phase: scheduler overhead (broken down)
            const tSched0 = performance.now();
            mem.sampleNextMove();
            const tSched1 = performance.now();
            controller.readRegisters();
            const tSched2 = performance.now();
            controller.writeRng();
            const tSched3 = performance.now();
            tSampleNextMove += (tSched1 - tSched0);
            tReadRegs += (tSched2 - tSched1);
            tWriteRng += (tSched3 - tSched2);
            tScheduler += (tSched3 - tSched0);

            break;
        }
    }
    totalInterrupts++;
}

const tTotal1 = performance.now();
const tTotal = tTotal1 - tTotal0;

// Also measure memory read/write cost in isolation
console.log('Measuring isolated memory read/write cost...');
const READ_ITERS = 10_000_000;
const tMemR0 = performance.now();
let sink = 0;
for (let i = 0; i < READ_ITERS; i++) {
    sink += mem.read(i & 0xBFFF);  // stay in RAM range
}
const tMemR1 = performance.now();
const tPerRead = (tMemR1 - tMemR0) / READ_ITERS;

const tMemW0 = performance.now();
for (let i = 0; i < READ_ITERS; i++) {
    mem.write(i & 0xBFFF, i & 0xFF);
}
const tMemW1 = performance.now();
const tPerWrite = (tMemW1 - tMemW0) / READ_ITERS;

// Derive per-sfotty.run() cost from the main loop measurement
const tPerRun = nCpuRun > 0 ? tCpuRun / nCpuRun : 0;

// Report
console.log();
console.log('='.repeat(70));
console.log('PROFILING RESULTS');
console.log('='.repeat(70));
console.log();
console.log(`Total wall time:     ${tTotal.toFixed(1)} ms`);
console.log(`Total interrupts:    ${totalInterrupts.toLocaleString()}`);
console.log(`Time per interrupt:  ${(tTotal / totalInterrupts * 1000).toFixed(2)} us`);
console.log(`sfotty.run() calls:  ${nCpuRun.toLocaleString()}`);
console.log(`BRK swaps:           ${nBrkSwap.toLocaleString()}`);
console.log(`BRK copies:          ${nBrkCopy.toLocaleString()}`);
console.log(`Commit writes:       ${nCommitWrites.toLocaleString()}`);
console.log(`Undo writes:         ${nUndoWrites.toLocaleString()}`);
console.log();

const tAccounted = tCpuRun + tScheduler + tCommitWrites + tUndoWrites + tBrk;
const tOther = tTotal - tAccounted;

function row(label, ms, extra) {
    const pct = (ms / tTotal * 100).toFixed(1);
    const msStr = ms.toFixed(1);
    const line = `  ${label.padEnd(30)} ${msStr.padStart(10)} ms  ${pct.padStart(6)}%`;
    console.log(extra ? line + '  ' + extra : line);
}

console.log('BREAKDOWN:');
console.log('-'.repeat(70));
row('CPU execution (sfotty.run)', tCpuRun, `(includes mem.read for opcode fetch + operands)`);
row('  Scheduler total', tScheduler);
row('    sampleNextMove', tSampleNextMove);
row('    readRegisters', tReadRegs);
row('    writeRng', tWriteRng);
row('Commit writes', tCommitWrites);
row('Undo writes', tUndoWrites);
row('  BRK total', tBrk);
row('    BRK swap (commitMove)', tBrkSwapOnly, `(${nBrkSwap.toLocaleString()} swaps)`);
row('    BRK copy (noisy)', tBrkCopyOnly, `(${nBrkCopy.toLocaleString()} copies)`);
row('Other / measurement overhead', tOther);
console.log('-'.repeat(70));
row('TOTAL', tTotal);

console.log();
console.log('ISOLATED MICRO-BENCHMARKS:');
console.log('-'.repeat(70));
console.log(`  memory.read()  : ${(tPerRead * 1000).toFixed(1)} ns/call  (${(1 / tPerRead).toFixed(1)} M calls/sec)`);
console.log(`  memory.write() : ${(tPerWrite * 1000).toFixed(1)} ns/call  (${(1 / tPerWrite).toFixed(1)} M calls/sec)`);
console.log(`  sfotty.run()   : ${(tPerRun * 1000).toFixed(1)} ns/call   (${(1 / tPerRun).toFixed(1)} M calls/sec)`);
console.log();

// Estimate: in the CPU loop, each instruction does 1 sfotty.run() which internally
// calls memory.read() multiple times (opcode fetch + operand fetch + data access).
// A typical instruction does 2-4 memory reads and 0-1 memory writes.
// So the CPU execution bucket includes both sfotty overhead and memory overhead.
const avgCpuCallsPerInterrupt = nCpuRun / totalInterrupts;
console.log('ANALYSIS:');
console.log('-'.repeat(70));
console.log(`  Avg sfotty.run() calls per interrupt: ${avgCpuCallsPerInterrupt.toFixed(1)}`);
console.log(`  Avg CPU time per interrupt: ${(tCpuRun / totalInterrupts * 1000).toFixed(2)} us`);
console.log(`  Avg scheduler time per interrupt: ${(tScheduler / totalInterrupts * 1000).toFixed(2)} us`);
console.log();

if (tCpuRun / tTotal > 0.30) {
    console.log('  CONCLUSION: CPU execution IS a significant bottleneck');
    console.log(`  (${(tCpuRun / tTotal * 100).toFixed(1)}% of wall time)`);
    console.log();
    console.log('  A WASM 6502 interpreter could potentially speed up the CPU phase.');
    console.log('  Estimated speedup factor: native C vs JS interpreter is typically 3-10x');
    console.log(`  Potential overall speedup: ${(tTotal / (tTotal - tCpuRun * 0.8)).toFixed(1)}x`);
    console.log('  (assuming WASM is 5x faster for the CPU portion)');
} else {
    console.log('  CONCLUSION: CPU execution is NOT the primary bottleneck');
    console.log(`  (only ${(tCpuRun / tTotal * 100).toFixed(1)}% of wall time)`);
    const maxBucket = [
        ['CPU execution', tCpuRun],
        ['Scheduler', tScheduler],
        ['Commit writes', tCommitWrites],
        ['Undo writes', tUndoWrites],
        ['BRK handling', tBrk],
        ['Other', tOther],
    ].sort((a, b) => b[1] - a[1]);
    console.log(`  Largest bucket: ${maxBucket[0][0]} (${(maxBucket[0][1] / tTotal * 100).toFixed(1)}%)`);
}

// Prevent dead-code elimination
if (sink === -1) console.log(sink);
