#!/usr/bin/env node
/**
 * Cross-validation script: runs the JS and Rust/WASM engines side-by-side
 * with the same seed and compares their state after each interrupt.
 */

import { BoardMemory } from '../board/memory.js';
import { BoardController } from '../board/controller.js';

// Load WASM (nodejs target)
const { WasmBoard } = await import('./pkg-node/board6502_wasm.js');

const BOARD_SIZE = 8;
const SEED = 42;
const NUM_INTERRUPTS = 500;

// --- Test 1: MT PRNG sequence ---
console.log('=== Test 1: Mersenne Twister PRNG ===');
{
  const jsMem = new BoardMemory(SEED, BOARD_SIZE);
  const wasmBoard = new WasmBoard(BOARD_SIZE, SEED);

  // The JS BoardMemory constructor calls sampleNextMove() which consumes 4 MT values.
  // The Rust BoardMemory::new() also calls sample_next_move() consuming 4 MT values.
  // So after construction, both MTs should be in the same state.
  // We can compare the resulting iOrig, jOrig, orientation, nextCycles.
  console.log(`  JS:   iOrig=${jsMem.iOrig}, jOrig=${jsMem.jOrig}, orientation=${jsMem.orientation}, nextCycles=${jsMem.nextCycles}`);
  // We can't directly read these from WASM, but we can compare storage after running.

  wasmBoard.free();
}
console.log('  (MT comparison is implicit in full-state comparison below)\n');

// --- Test 2: Initial state comparison ---
console.log('=== Test 2: Initial state (seed 42, size 8, no randomize) ===');
{
  const jsMem = new BoardMemory(SEED, BOARD_SIZE);
  const jsCtrl = new BoardController(jsMem);
  const wasmBoard = new WasmBoard(BOARD_SIZE, SEED);

  // Compare storage byte-by-byte
  let diffs = 0;
  const totalBytes = BOARD_SIZE * BOARD_SIZE * 1024;
  for (let i = 0; i < totalBytes; i++) {
    const jsVal = jsMem.storage[i];
    const wasmVal = wasmBoard.get_byte(i);
    if (jsVal !== wasmVal) {
      if (diffs < 10) {
        console.log(`  DIFF at byte ${i} (0x${i.toString(16)}): JS=${jsVal} WASM=${wasmVal}`);
      }
      diffs++;
    }
  }
  if (diffs === 0) {
    console.log('  PASS: Initial storage identical');
  } else {
    console.log(`  FAIL: ${diffs} byte differences in initial storage`);
  }

  wasmBoard.free();
}
console.log();

// --- Test 3: Run interrupts and compare ---
console.log(`=== Test 3: Run ${NUM_INTERRUPTS} interrupts and compare ===`);
{
  const jsMem = new BoardMemory(SEED, BOARD_SIZE);
  const jsCtrl = new BoardController(jsMem);
  const wasmBoard = new WasmBoard(BOARD_SIZE, SEED);

  let firstDiffInterrupt = -1;
  for (let intr = 0; intr < NUM_INTERRUPTS; intr++) {
    const jsResult = jsCtrl.runToNextInterrupt();
    const wasmSchedulerCycles = wasmBoard.run_to_next_interrupt();

    // Compare scheduler cycles
    if (jsResult.schedulerCycles !== wasmSchedulerCycles && firstDiffInterrupt < 0) {
      console.log(`  Scheduler cycles differ at interrupt ${intr}: JS=${jsResult.schedulerCycles} WASM=${wasmSchedulerCycles}`);
      firstDiffInterrupt = intr;
    }

    // Periodically compare full storage
    if (intr % 100 === 99 || intr === 0 || intr === NUM_INTERRUPTS - 1) {
      let diffs = 0;
      const totalBytes = BOARD_SIZE * BOARD_SIZE * 1024;
      let firstDiffAddr = -1;
      for (let i = 0; i < totalBytes; i++) {
        const jsVal = jsMem.storage[i];
        const wasmVal = wasmBoard.get_byte(i);
        if (jsVal !== wasmVal) {
          if (firstDiffAddr < 0) firstDiffAddr = i;
          diffs++;
        }
      }
      if (diffs > 0) {
        const cell = Math.floor(firstDiffAddr / 1024);
        const byteInCell = firstDiffAddr % 1024;
        console.log(`  Interrupt ${intr}: ${diffs} byte diffs (first at byte ${firstDiffAddr}, cell ${cell}, offset 0x${byteInCell.toString(16)}: JS=${jsMem.storage[firstDiffAddr]} WASM=${wasmBoard.get_byte(firstDiffAddr)})`);
        if (firstDiffInterrupt < 0) firstDiffInterrupt = intr;
      } else {
        console.log(`  Interrupt ${intr}: PASS (storage identical, totalCycles JS=${jsCtrl.totalCycles} WASM=${Number(wasmBoard.total_cycles())})`);
      }
    }
  }

  // Compare total cycles
  const jsCycles = jsCtrl.totalCycles;
  const wasmCycles = Number(wasmBoard.total_cycles());
  if (jsCycles === wasmCycles) {
    console.log(`  Total cycles match: ${jsCycles}`);
  } else {
    console.log(`  Total cycles DIFFER: JS=${jsCycles} WASM=${wasmCycles}`);
  }

  if (firstDiffInterrupt < 0) {
    console.log('  OVERALL: PASS');
  } else {
    console.log(`  OVERALL: FAIL (first difference at interrupt ${firstDiffInterrupt})`);
  }

  wasmBoard.free();
}
console.log();

// --- Test 4: Randomize then run ---
console.log(`=== Test 4: Randomize + run ${NUM_INTERRUPTS} interrupts ===`);
{
  const jsMem = new BoardMemory(SEED, BOARD_SIZE);
  const jsCtrl = new BoardController(jsMem);
  const wasmBoard = new WasmBoard(BOARD_SIZE, SEED);

  // JS randomize uses BoardMemory's MT
  jsCtrl.randomize(() => jsMem.mt.int());
  wasmBoard.randomize();

  // Compare storage after randomize
  let diffs = 0;
  const totalBytes = BOARD_SIZE * BOARD_SIZE * 1024;
  for (let i = 0; i < totalBytes; i++) {
    if (jsMem.storage[i] !== wasmBoard.get_byte(i)) diffs++;
  }
  console.log(`  After randomize: ${diffs === 0 ? 'PASS (identical)' : `FAIL (${diffs} diffs)`}`);

  if (diffs === 0) {
    // Run interrupts
    let firstDiffInterrupt = -1;
    for (let intr = 0; intr < NUM_INTERRUPTS; intr++) {
      jsCtrl.runToNextInterrupt();
      wasmBoard.run_to_next_interrupt();

      if (intr % 100 === 99 || intr === NUM_INTERRUPTS - 1) {
        let d = 0;
        for (let i = 0; i < totalBytes; i++) {
          if (jsMem.storage[i] !== wasmBoard.get_byte(i)) d++;
        }
        if (d > 0) {
          console.log(`  Interrupt ${intr}: ${d} byte diffs`);
          if (firstDiffInterrupt < 0) firstDiffInterrupt = intr;
        } else {
          console.log(`  Interrupt ${intr}: PASS`);
        }
      }
    }
    if (firstDiffInterrupt < 0) {
      console.log('  OVERALL: PASS');
    } else {
      console.log(`  OVERALL: FAIL (first difference at interrupt ${firstDiffInterrupt})`);
    }
  }

  wasmBoard.free();
}
console.log();

// --- Test 5: Detailed single-interrupt trace ---
console.log('=== Test 5: Single interrupt detail ===');
{
  const jsMem = new BoardMemory(SEED, BOARD_SIZE);
  const jsCtrl = new BoardController(jsMem);
  const wasmBoard = new WasmBoard(BOARD_SIZE, SEED);

  const jsResult = jsCtrl.runToNextInterrupt();
  const wasmSched = wasmBoard.run_to_next_interrupt();
  console.log(`  JS:   cpuCycles=${jsResult.cpuCycles}, schedulerCycles=${jsResult.schedulerCycles}, totalCycles=${jsCtrl.totalCycles}`);
  console.log(`  WASM: schedulerCycles=${wasmSched}, totalCycles=${Number(wasmBoard.total_cycles())}`);

  wasmBoard.free();
}

console.log('\nDone.');
