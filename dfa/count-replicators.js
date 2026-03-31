#!/usr/bin/env node
/**
 * Count viable replicator sequences of length L using a DFA.
 *
 * The DFA models: I₀* M₁ M₂ I₁* M₃ M₄ M₅ I₂* M₆ I₃* M₇ M₈ I₄*
 *
 * Where:
 *   M₁ = B5 (LDA zpx)
 *   M₂ = 00 (zpx addr)
 *   M₃ = 9D (STA abs,X)
 *   M₄ = 00 (abs addr lo)
 *   M₅ = 04 (abs addr hi = page 4)
 *   M₆ = E8 (INX) or CA (DEX)
 *   M₇ = 90 (BCC) or 50 (BVC)
 *   M₈ = branch offset (deterministic from M₁ position and current position)
 *   I₀..I₄ = safe insert bytes (provably harmless)
 *
 * Safe inserts are bytes that don't affect the copy loop's correctness:
 * - They don't write to the zero page (where the copy loop lives)
 * - They don't clobber A (used by LDA/STA) or X (loop counter)
 * - They don't set the carry flag (BCC depends on C=0)
 * - They don't set the overflow flag (BVC depends on V=0)
 *
 * For each position, the safe set differs slightly because of multi-byte
 * opcodes (a 2-byte insert consumes the next byte as an operand).
 */

// ── Safe byte classification ─────────────────────────────────────────

// Single-byte opcodes that are definitely safe everywhere:
// - Don't write to memory
// - Don't modify A or X
// - Don't modify C or V flags
const SAFE_1BYTE_EVERYWHERE = [
  0xEA, // NOP
  0xC8, // INY
  0x88, // DEY
  0xA8, // TAY (clobbers Y, not A/X; leaves flags alone except N/Z)
  0x98, // TYA — UNSAFE, clobbers A!
  // Undocumented single-byte NOPs
  0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA,
];

// Flag ops: some are safe, some aren't
// CLC (0x18) — clears carry. Safe for BCC (carry already clear in the loop)
// SEC (0x38) — UNSAFE: sets carry, BCC would not be taken
// CLI (0x58) — safe (interrupt flag doesn't affect copy)
// SEI (0x78) — safe
// CLV (0xB8) — safe (clears overflow, BVC still works since V was clear)
// CLD (0xD8) — safe (decimal flag doesn't affect copy loop)
// SED (0xF8) — RISKY: sets decimal mode, ADC/SBC behave differently.
//               But the copy loop doesn't use ADC/SBC, so technically safe.

const SAFE_FLAG_OPS = [
  0x18, // CLC — safe (C stays clear)
  0x58, // CLI — safe
  0x78, // SEI — safe
  0xB8, // CLV — safe (V stays clear)
  0xD8, // CLD — safe
  0xF8, // SED — safe (no ADC/SBC in copy loop)
];

// UNSAFE flag ops:
// 0x38 SEC — sets carry, breaks BCC
// (Note: if we use BVC instead of BCC, then SEC is safe and CLV becomes important)

// Stack ops that don't clobber A/X:
// PHA (0x48) — pushes A to stack. A unchanged. Safe if stack doesn't overflow.
// PHP (0x08) — pushes P to stack. Safe.
// But PLA (0x68) — UNSAFE: pops into A, clobbering it.
// PLP (0x28) — UNSAFE: pops into P, potentially setting C or V.

const SAFE_STACK_OPS = [
  0x48, // PHA — safe (A unchanged, just pushes)
  0x08, // PHP — safe (P unchanged, just pushes)
];

// TAX (0xAA) — UNSAFE: clobbers X (the loop counter)
// TXA (0x8A) — UNSAFE: clobbers A
// TSX (0xBA) — UNSAFE: clobbers X
// TXS (0x9A) — sets stack pointer. Risky but doesn't clobber A/X/flags.
//              Could cause stack corruption but copy loop doesn't use stack.
//              Let's call it safe.
const SAFE_TRANSFER_OPS = [
  0x9A, // TXS — safe-ish (sets S, doesn't affect A/X/flags)
];

// All safe single-byte opcodes
const SAFE_1BYTE = [
  ...SAFE_1BYTE_EVERYWHERE.filter(b => b !== 0x98), // remove TYA
  ...SAFE_FLAG_OPS,
  ...SAFE_STACK_OPS,
  ...SAFE_TRANSFER_OPS,
];

// 2-byte opcodes where the operand is consumed and doesn't matter:
// LDY #imm (0xA0) — loads Y, doesn't affect A/X/C/V. Safe. 256 operands.
// CPY #imm (0xC0) — compares Y, affects N/Z/C but NOT V.
//                    UNSAFE if using BCC (sets C based on comparison)
// CPX #imm (0xE0) — UNSAFE: affects C
// LDA #imm (0xA9) — UNSAFE: clobbers A
// LDX #imm (0xA2) — UNSAFE: clobbers X
// Undocumented 2-byte NOPs: 80, 82, 89, C2, E2 — skip one byte, safe.

const SAFE_2BYTE_PREFIXES = [
  0xA0, // LDY #imm — safe (256 operands, all safe)
  // Undocumented 2-byte NOPs
  0x80, 0x82, 0x89, 0xC2, 0xE2,
];

// 3-byte undocumented NOPs: 0C (abs), 1C/3C/5C/7C/DC/FC (abs,X)
// These read from memory but don't write. Safe.
const SAFE_3BYTE_PREFIXES = [
  0x0C, // NOP abs — safe (reads but doesn't write or modify regs)
  0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC, // NOP abs,X — safe
];

// ── DFA states ───────────────────────────────────────────────────────
//
// States track position in the match pattern:
//   I0: before M1 (accepting inserts)
//   M1: expecting B5
//   M2: expecting 00 (after B5)
//   I1: between M2 and M3
//   M3: expecting 9D
//   M4: expecting 00 (after 9D)
//   M5: expecting 04 (after 00)
//   I2: between M5 and M6
//   M6: expecting E8 or CA
//   I3: between M6 and M7
//   M7: expecting 90 or 50
//   M8: expecting correct branch offset
//   I4: after M8 (trailing inserts, accepting)
//
// Sub-states for 2-byte inserts: Ix_2 (consumed prefix, expecting operand)
// Sub-states for 3-byte inserts: Ix_3a, Ix_3b

const STATES = [
  'I0', 'I0_2', 'I0_3a', 'I0_3b',
  'M1',  // B5
  'M2',  // 00
  'I1', 'I1_2', 'I1_3a', 'I1_3b',
  'M3',  // 9D
  'M4',  // 00
  'M5',  // 04
  'I2', 'I2_2', 'I2_3a', 'I2_3b',
  'M6',  // E8 or CA
  'I3', 'I3_2', 'I3_3a', 'I3_3b',
  'M7',  // 90 or 50
  'M8',  // offset (depends on position)
  'I4', 'I4_2', 'I4_3a', 'I4_3b',
];
const S = STATES.length; // 25
const stateIdx = Object.fromEntries(STATES.map((s, i) => [s, i]));

// Which states are accepting (valid end of sequence)?
// I4 and its sub-states are NOT accepting (must finish the insert).
// Only I4 itself is accepting (after completing any multi-byte insert).
// Also M8 should transition to I4, so after the offset, I4 is accepting.
// Actually: any state after M8 is accepting. I4 is accepting. I4_2, I4_3a, I4_3b are NOT
// (they're mid-insert).
// Also: do we want to require the full match? Yes. So only I4 is accepting.
// But we could also accept at M8 (offset is the last match byte) — I4 is optional trailing.
// Let's make I4 accepting (and M8 transitions to I4 after emitting the offset).

const ACCEPT = new Set([stateIdx['I4']]);

// ── Build transition count table ─────────────────────────────────────
//
// For each length L, we want count[state][L] = number of byte sequences
// of length L starting from state that end in an accepting state.
//
// But we need to handle the M8 offset constraint specially: the offset
// byte depends on the DISTANCE from M1 to M8. Since M1 can be at any
// position, the offset varies.
//
// Approach: track the position of M1 as part of the state.
// Extended state = (DFA_state, m1_position).
// When we enter M1, we record the current position as m1_position.
// When we reach M8, the expected offset = (m1_position - current_position - 1) & 0xFF.
// If the offset falls in 0x00-0xFF (which it always does), there's exactly 1 valid byte.
//
// Actually simpler: at M8, there is ALWAYS exactly 1 valid byte (the correct offset).
// So the branching factor at M8 is always 1 regardless of m1_position.
// We don't need to track m1_position! The count at M8 is just 1 × count[I4][remaining-1].

// So: the Forward algorithm doesn't need m1_position. At each state, the
// number of valid bytes is:
//   I0, I1, I2, I3, I4: |SAFE_1BYTE| + |SAFE_2BYTE| + |SAFE_3BYTE| (for self-loops)
//     plus the match byte(s) to advance
//   M1: 1 (must be B5)
//   M2: 1 (must be 00)
//   M3: 1 (must be 9D)
//   M4: 1 (must be 00)
//   M5: 1 (must be 04)
//   M6: 2 (E8 or CA)
//   M7: 2 (90 or 50)
//   M8: 1 (the correct offset)
//   I*_2: 256 (any operand byte for 2-byte insert)
//   I*_3a: 256 (any byte for position 2 of 3-byte insert)
//   I*_3b: 256 (any byte for position 3 of 3-byte insert)

function countInsertOptions() {
  // From an insert state Ik:
  // Option 1: emit a safe 1-byte opcode, stay in Ik
  const n1 = SAFE_1BYTE.length;
  // Option 2: emit a safe 2-byte prefix, go to Ik_2
  const n2 = SAFE_2BYTE_PREFIXES.length;
  // Option 3: emit a safe 3-byte prefix, go to Ik_3a
  const n3 = SAFE_3BYTE_PREFIXES.length;
  return { n1, n2, n3, total: n1 + n2 + n3 };
}

// ── Forward algorithm ────────────────────────────────────────────────
//
// count[s][n] = number of sequences of length n that start in state s
// and end in an accepting state.
//
// Base case: count[s][0] = 1 if s is accepting, else 0.
// Recurrence: count[s][n] = sum over valid bytes b of count[next(s,b)][n-1]

function forward(maxL) {
  const ins = countInsertOptions();
  console.log(`Safe 1-byte: ${ins.n1}, 2-byte prefixes: ${ins.n2}, 3-byte prefixes: ${ins.n3}`);
  console.log(`Safe 1-byte opcodes: ${SAFE_1BYTE.map(b => b.toString(16).padStart(2,'0')).join(' ')}`);

  // Use BigInt for exact counts
  const count = Array.from({ length: S }, () => Array(maxL + 1).fill(0n));

  // Base case
  for (let s = 0; s < S; s++) {
    count[s][0] = ACCEPT.has(s) ? 1n : 0n;
  }

  // Fill
  for (let n = 1; n <= maxL; n++) {
    for (let s = 0; s < S; s++) {
      const name = STATES[s];
      let total = 0n;

      if (name.startsWith('I') && !name.includes('_')) {
        // Insert state: can emit safe bytes (self-loop) or advance to next match
        const k = parseInt(name[1]);
        const base = stateIdx[name];
        const sub2 = stateIdx[name + '_2'];
        const sub3a = stateIdx[name + '_3a'];

        if (k === 4) {
          // I4: trailing cargo — FULLY UNIFORM (never executed).
          // Any byte is safe. No multi-byte sub-states needed.
          total += 256n * count[base][n - 1];
        } else {
          // I0-I3: safe inserts only
          // Self-loop: safe 1-byte (stay in Ik)
          total += BigInt(ins.n1) * count[base][n - 1];
          // Self-loop: safe 2-byte prefix (go to Ik_2)
          total += BigInt(ins.n2) * count[sub2][n - 1];
          // Self-loop: safe 3-byte prefix (go to Ik_3a)
          total += BigInt(ins.n3) * count[sub3a][n - 1];
        }

        // Advance to next match state
        if (k === 0) {
          // I0 -> M1 (B5): 1 valid byte
          total += count[stateIdx['M1']][n - 1];
        } else if (k === 1) {
          // I1 -> M3 (9D): 1 valid byte
          total += count[stateIdx['M3']][n - 1];
        } else if (k === 2) {
          // I2 -> M6 (E8 or CA): 2 valid bytes
          total += 2n * count[stateIdx['M6']][n - 1];
        } else if (k === 3) {
          // I3 -> M7 (90 or 50): 2 valid bytes
          total += 2n * count[stateIdx['M7']][n - 1];
        }
        // I4: no next match state (it's the tail). Just self-loops.

      } else if (name.endsWith('_2')) {
        // 2-byte insert sub-state: any operand byte -> back to parent Ik
        const parent = stateIdx[name.replace('_2', '')];
        total += 256n * count[parent][n - 1];

      } else if (name.endsWith('_3a')) {
        // 3-byte insert sub-state (byte 2): any byte -> Ik_3b
        const sub3b = stateIdx[name.replace('_3a', '_3b')];
        total += 256n * count[sub3b][n - 1];

      } else if (name.endsWith('_3b')) {
        // 3-byte insert sub-state (byte 3): any byte -> back to parent Ik
        const parent = stateIdx[name.replace('_3b', '')];
        total += 256n * count[parent][n - 1];

      } else if (name === 'M1') {
        // After B5, must emit 00 -> M2
        total += count[stateIdx['M2']][n - 1];

      } else if (name === 'M2') {
        // After 00 (addr), go to I1
        total += count[stateIdx['I1']][n - 1];

      } else if (name === 'M3') {
        // After 9D, must emit 00 -> M4
        total += count[stateIdx['M4']][n - 1];

      } else if (name === 'M4') {
        // After 00, must emit 04 -> M5
        total += count[stateIdx['M5']][n - 1];

      } else if (name === 'M5') {
        // After 04, go to I2
        total += count[stateIdx['I2']][n - 1];

      } else if (name === 'M6') {
        // After E8/CA, go to I3
        total += count[stateIdx['I3']][n - 1];

      } else if (name === 'M7') {
        // After 90/50, must emit correct offset -> M8
        // Exactly 1 valid offset byte
        total += count[stateIdx['M8']][n - 1];

      } else if (name === 'M8') {
        // After offset, go to I4
        total += count[stateIdx['I4']][n - 1];
      }

      count[s][n] = total;
    }
  }

  return count;
}

function log2BigInt(n) {
  if (n <= 0n) return -Infinity;
  const s = n.toString(2);
  const bitLen = s.length;
  if (bitLen <= 52) return Math.log2(Number(n));
  const top = Number(BigInt('0b' + s.substring(0, 52)));
  return (bitLen - 52) + Math.log2(top);
}

// ── Main ─────────────────────────────────────────────────────────────

const maxL = parseInt(process.argv[2] || '32');
console.log(`Counting viable replicator sequences up to L=${maxL}\n`);

const count = forward(maxL);
const initial = stateIdx['I0'];

console.log('\n L | count | log2(count) | B_eff = 8L - log2(count)');
console.log('---|-------|-------------|------------------------');
for (let L = 8; L <= maxL; L++) {
  const c = count[initial][L];
  const log2c = log2BigInt(c);
  const beff = 8 * L - log2c;
  const countStr = c < 1000000n ? c.toString() : `~2^${log2c.toFixed(1)}`;
  console.log(`${String(L).padStart(3)} | ${countStr.padStart(20)} | ${log2c.toFixed(2).padStart(11)} | ${beff.toFixed(2)}`);
}

// Also show the per-insert-byte entropy
const ins = countInsertOptions();
const bitsPerInsert = Math.log2(ins.n1 + ins.n2 * 256 + ins.n3 * 256 * 256);
console.log(`\nEffective bits per insert position: ~${bitsPerInsert.toFixed(2)}`);
console.log(`(${ins.n1} 1-byte + ${ins.n2}×256 2-byte + ${ins.n3}×256² 3-byte options)`);
