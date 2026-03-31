#!/usr/bin/env node
/**
 * Generate 6502 test vectors using Sfotty as the reference oracle.
 *
 * For each of the 151 official NMOS 6502 opcodes, generates test cases
 * with randomized initial states. Output matches the Tom Harte /
 * SingleStepTests format (https://github.com/SingleStepTests/65x02)
 * used by Sfotty's own test suite.
 *
 * Output: cpu/sfotty-test-cases.json
 */

import { Sfotty } from '@sfotty-pie/sfotty';
import { VANILLA_OPCODES } from '@sfotty-pie/opcodes';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Seeded PRNG (xorshift32) for reproducibility
let rngState = 0xDEADBEEF;
function rand() {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) & 0xFF;
}
function rand16() { return rand() | (rand() << 8); }

const OPCODE_INFO = {};
for (const op of VANILLA_OPCODES) {
  OPCODE_INFO[op.opcode] = { mnemonic: op.mnemonic, mode: op.mode };
}

const MODE_SIZES = {
  imp: 1, acc: 1, imm: 2, zpg: 2, zpx: 2, zpy: 2,
  abs: 3, abx: 3, aby: 3, ind: 3, inx: 2, iny: 2, rel: 2,
};

const TESTS_PER_OPCODE = 15;

/**
 * Run exactly one instruction through Sfotty, returning cycle-accurate results.
 */
function runOneInstruction(ram, initPC, initA, initX, initY, initS, initP, instrSize) {
  const busLog = [];

  const sfotty = new Sfotty({
    read(address) {
      const v = ram[address];
      busLog.push([address, v, 'read']);
      return v;
    },
    write(address, value) {
      busLog.push([address, value, 'write']);
      ram[address] = value;
    },
  });

  sfotty.resetPending = false;
  sfotty.PC = initPC;
  sfotty.A = initA;
  sfotty.X = initX;
  sfotty.Y = initY;
  sfotty.S = initS;
  sfotty.setP(initP);

  const snapshots = [];
  try {
    for (let i = 0; i < 9; i++) {
      sfotty.run();
      snapshots.push({
        PC: sfotty.PC,
        A: sfotty.A,
        X: sfotty.X,
        Y: sfotty.Y,
        S: sfotty.S,
        P: sfotty.getP(),
      });
      if (sfotty.crashed) return null;
    }
  } catch (e) {
    return null;
  }

  // Detect instruction cycle count N.
  // busLog[N] is the opcode fetch of the NEXT instruction (a NOP = 0xEA).
  // Since operand bytes are guaranteed non-0xEA, reading 0xEA confirms a NOP fetch.
  // For branches (instrSize=2, rel mode), taken branches have a dummy read at cycle 2
  // from the fallthrough address which also contains 0xEA. We handle this by requiring
  // that for a match at n=2, the next bus op (busLog[n+1]) must read from PC+1
  // (confirming we're actually executing the NOP, not doing a dummy read).
  let N = null;
  for (let n = 2; n <= 8; n++) {
    if (n >= busLog.length) break;
    if (busLog[n][2] === 'read' &&
        busLog[n][1] === 0xEA &&
        busLog[n][0] === snapshots[n - 1].PC) {
      // For n=2 with 2-byte instructions: verify this is a real opcode fetch
      // by checking that busLog[n+1] reads from PC+1 (NOP's 2nd cycle)
      if (n === 2 && instrSize === 2 && n + 1 < busLog.length) {
        const nextReadAddr = busLog[n + 1][0];
        const expectedNext = (snapshots[n - 1].PC + 1) & 0xFFFF;
        if (nextReadAddr !== expectedNext) continue; // false match (branch dummy read)
      }
      N = n;
      break;
    }
  }
  if (N === null) return null;

  return {
    finalPC: snapshots[N - 1].PC,
    finalA: snapshots[N].A,
    finalX: snapshots[N].X,
    finalY: snapshots[N].Y,
    finalS: snapshots[N].S,
    finalP: snapshots[N].P,
    cycles: busLog.slice(0, N),
    expectedCycles: N,
  };
}

function generateTestCase(opcode, index) {
  const info = OPCODE_INFO[opcode];
  if (!info) return null;
  const size = MODE_SIZES[info.mode] || 1;

  const initPC = 0x0200 + (rand() % 0xD0);
  const initA = rand();
  const initX = rand();
  const initY = rand();
  const initS = 0x80 + (rand() % 0x60);
  const initP = rand() & 0xCF | 0x20;

  // Fill with NOPs, then randomize key areas
  const ram = new Uint8Array(0x10000);
  ram.fill(0xEA);
  for (let i = 0; i < 256; i++) ram[i] = rand();
  for (let i = 0x0300; i < 0x0400; i++) ram[i] = rand();
  for (let i = 0x1000; i < 0x1100; i++) ram[i] = rand();
  for (let i = 0x100; i < 0x200; i++) ram[i] = rand();

  // Place opcode
  ram[initPC] = opcode;
  // Ensure operand bytes are never 0xEA (NOP) so cycle detection can distinguish
  // mid-instruction operand reads from next-instruction opcode fetches
  if (size >= 2) { let b = rand(); ram[(initPC + 1) & 0xFFFF] = b === 0xEA ? 0xEB : b; }
  if (size >= 3) { let b = rand(); ram[(initPC + 2) & 0xFFFF] = b === 0xEA ? 0xEB : b; }

  // NOPs after instruction
  for (let i = 0; i < 4; i++) ram[(initPC + size + i) & 0xFFFF] = 0xEA;
  // For branches: ensure offset != 1 (ambiguous with not-taken) and put NOPs at target
  if (info.mode === 'rel') {
    let offset = ram[(initPC + 1) & 0xFFFF];
    if (offset === 1) { offset = 2; ram[(initPC + 1) & 0xFFFF] = 2; }
    const signedOff = offset >= 128 ? offset - 256 : offset;
    const target = (initPC + 2 + signedOff) & 0xFFFF;
    for (let i = 0; i < 4; i++) ram[(target + i) & 0xFFFF] = 0xEA;
  }

  // BRK vector -> 0x0400 (NOP-filled)
  if (opcode === 0x00) {
    ram[0xFFFE] = 0x00; ram[0xFFFF] = 0x04;
    for (let i = 0x0400; i < 0x0410; i++) ram[i] = 0xEA;
  }
  // RTI: push P, PCL, PCH -> target 0x0500 (NOP-filled)
  if (info.mnemonic === 'RTI') {
    ram[0x100 + ((initS + 1) & 0xFF)] = 0x20;
    ram[0x100 + ((initS + 2) & 0xFF)] = 0x00;
    ram[0x100 + ((initS + 3) & 0xFF)] = 0x05;
    for (let i = 0x0500; i < 0x0510; i++) ram[i] = 0xEA;
  }
  // RTS: push PCH, PCL-1 -> target 0x0500 (NOP-filled, 0x04FF+1=0x0500)
  if (info.mnemonic === 'RTS') {
    ram[0x100 + ((initS + 1) & 0xFF)] = 0xFF;
    ram[0x100 + ((initS + 2) & 0xFF)] = 0x04;
    for (let i = 0x0500; i < 0x0510; i++) ram[i] = 0xEA;
  }

  // Snapshot ram before execution
  const ramBefore = new Uint8Array(ram);

  const result = runOneInstruction(ram, initPC, initA, initX, initY, initS, initP, size);
  if (!result) return null;

  // Build minimal memory map: only addresses accessed during the instruction
  const touchedAddrs = new Set();
  for (const [addr, , ] of result.cycles) {
    touchedAddrs.add(addr);
  }

  // Initial memory: only touched addresses
  const initMemory = {};
  for (const addr of touchedAddrs) {
    initMemory[addr] = ramBefore[addr];
  }

  // Final memory: only addresses that changed
  const finalMemory = {};
  for (const addr of touchedAddrs) {
    if (ram[addr] !== ramBefore[addr]) {
      finalMemory[addr] = ram[addr];
    }
  }

  return {
    name: `${info.mnemonic}_${info.mode}_${opcode.toString(16).padStart(2, '0')}_${index}`,
    setup: {
      PC: initPC,
      A: initA,
      X: initX,
      Y: initY,
      S: initS,
      P: initP,
      memory: initMemory,
    },
    expected: {
      PC: result.finalPC,
      A: result.finalA,
      X: result.finalX,
      Y: result.finalY,
      S: result.finalS,
      P: result.finalP | 0x30,
    },
    expectedCycles: result.expectedCycles,
    cycles: result.cycles,
    finalMemory: finalMemory,
  };
}

// Generate
const allTests = [];
const opcodes = VANILLA_OPCODES.map(o => o.opcode).sort((a, b) => a - b);

console.log(`Generating ${TESTS_PER_OPCODE} test cases for ${opcodes.length} opcodes...`);

let warnings = 0;
for (const opcode of opcodes) {
  const info = OPCODE_INFO[opcode];
  let generated = 0;
  let attempts = 0;
  while (generated < TESTS_PER_OPCODE && attempts < TESTS_PER_OPCODE * 5) {
    attempts++;
    const tc = generateTestCase(opcode, generated);
    if (tc) {
      allTests.push(tc);
      generated++;
    }
  }
  if (generated < TESTS_PER_OPCODE) {
    console.warn(`  Warning: ${generated}/${TESTS_PER_OPCODE} for 0x${opcode.toString(16).padStart(2, '0')} (${info.mnemonic} ${info.mode})`);
    warnings++;
  }
}

console.log(`Generated ${allTests.length} total test cases.`);
if (warnings) console.log(`${warnings} opcodes had fewer tests than requested.`);

const outPath = path.join(__dirname, 'sfotty-test-cases.json');
fs.writeFileSync(outPath, JSON.stringify(allTests, null, 2));
const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
console.log(`Written to ${outPath} (${sizeMB} MB)`);

// Summary
const byMnemonic = {};
for (const tc of allTests) {
  const mn = tc.name.split('_')[0];
  byMnemonic[mn] = (byMnemonic[mn] || 0) + 1;
}
console.log(`\nTests per mnemonic:`);
for (const [mn, count] of Object.entries(byMnemonic).sort()) {
  process.stdout.write(`  ${mn}: ${count}`);
}
console.log('');
