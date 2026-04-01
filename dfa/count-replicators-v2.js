#!/usr/bin/env node
/**
 * Count viable replicator sequences of length L.
 *
 * Simplified DFA: 5 insert states (I0-I4), transitions between them
 * consume the match bytes (multi-byte transitions).
 *
 * I0 --[B5 00]--> I1 --[9D 00 04]--> I2 --[E8|CA]--> I3 --[90|50, offset]--> I4
 *
 * Each insert state can self-loop with safe bytes (1, 2, or 3 byte inserts).
 * I4 is uniform (trailing cargo, never executed).
 *
 * Multi-byte transitions: handled by splitting into sub-counts.
 * E.g., I0 --[B5 00]--> I1 means: at I0, emit B5 (1 byte), then 00 (1 byte),
 * arrive at I1. That's 2 bytes consumed.
 *
 * count[state][n] = number of sequences of length n from state to acceptance.
 */

// Safe insert opcodes (same as v1)
const SAFE_1BYTE = [
  0xEA, 0xC8, 0x88, 0xA8,  // NOP, INY, DEY, TAY
  0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA,  // undocumented NOPs
  0x18, 0x58, 0x78, 0xB8, 0xD8, 0xF8,  // CLC, CLI, SEI, CLV, CLD, SED
  0x48, 0x08,  // PHA, PHP
  0x9A,  // TXS
];
const N1 = SAFE_1BYTE.length;  // 19

const SAFE_2BYTE_PREFIXES = [0xA0, 0x80, 0x82, 0x89, 0xC2, 0xE2];  // LDY#, undoc NOPs
const N2 = SAFE_2BYTE_PREFIXES.length;  // 6

const SAFE_3BYTE_PREFIXES = [0x0C, 0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC];  // undoc abs NOPs
const N3 = SAFE_3BYTE_PREFIXES.length;  // 7

// States: I0, I0_2, I0_3a, I0_3b, I1, I1_2, I1_3a, I1_3b, I2, I2_2, I2_3a, I2_3b,
//         I3, I3_2, I3_3a, I3_3b, I4, DONE
// DONE is an absorbing accepting state (represents having emitted all match bytes + trailing cargo ends)

const STATES = [];
for (let k = 0; k <= 4; k++) {
  STATES.push(`I${k}`, `I${k}_2`, `I${k}_3a`, `I${k}_3b`);
}
const S = STATES.length;  // 20
const si = Object.fromEntries(STATES.map((s, i) => [s, i]));

// Accepting: I4 (can end the sequence at any point after the full match)
const ACCEPT = new Set([si['I4']]);

// Match transition byte counts
// I0 -> I1: emit B5 00 (2 bytes)
// I1 -> I2: emit 9D 00 04 (3 bytes)
// I2 -> I3: emit E8 or CA (1 byte, 2 choices)
// I3 -> I4: emit 90|50 + offset (2 bytes, 2 choices for the branch opcode)

function forward(maxL) {
  const count = Array.from({ length: S }, () => Array(maxL + 1).fill(0n));

  // Base case
  for (let s = 0; s < S; s++) {
    count[s][0] = ACCEPT.has(s) ? 1n : 0n;
  }

  for (let n = 1; n <= maxL; n++) {
    for (let s = 0; s < S; s++) {
      const name = STATES[s];
      let total = 0n;

      if (name.match(/^I\d$/) && !name.includes('_')) {
        const k = parseInt(name[1]);

        if (k === 4) {
          // I4: uniform trailing cargo (any byte, self-loop)
          total += 256n * count[si['I4']][n - 1];
        } else {
          // I0-I3: safe insert self-loops
          total += BigInt(N1) * count[si[name]][n - 1];       // 1-byte safe
          total += BigInt(N2) * count[si[name + '_2']][n - 1]; // 2-byte prefix
          total += BigInt(N3) * count[si[name + '_3a']][n - 1]; // 3-byte prefix

          // Match transition to next insert state
          if (k === 0 && n >= 2) {
            // I0 -> I1: emit B5 00 (2 bytes, 1 way)
            total += count[si['I1']][n - 2];
          } else if (k === 1 && n >= 3) {
            // I1 -> I2: emit 9D 00 04 (3 bytes, 1 way)
            total += count[si['I2']][n - 3];
          } else if (k === 2 && n >= 1) {
            // I2 -> I3: emit E8 or CA (1 byte, 2 ways)
            total += 2n * count[si['I3']][n - 1];
          } else if (k === 3 && n >= 2) {
            // I3 -> I4: emit 90|50 + offset (2 bytes, 2 branch opcodes × 1 offset)
            total += 2n * count[si['I4']][n - 2];
          }
        }

      } else if (name.endsWith('_2')) {
        // 2-byte insert: operand byte (256 choices), return to parent
        const parent = name.replace('_2', '');
        total += 256n * count[si[parent]][n - 1];

      } else if (name.endsWith('_3a')) {
        // 3-byte insert byte 2: any byte, go to _3b
        const next = name.replace('_3a', '_3b');
        total += 256n * count[si[next]][n - 1];

      } else if (name.endsWith('_3b')) {
        // 3-byte insert byte 3: any byte, return to parent
        const parent = name.replace('_3b', '');
        total += 256n * count[si[parent]][n - 1];
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

const maxL = parseInt(process.argv[2] || '256');
console.log(`Safe 1-byte: ${N1}, 2-byte prefixes: ${N2}, 3-byte prefixes: ${N3}`);
console.log(`Counting viable replicator sequences up to L=${maxL}\n`);

const count = forward(maxL);

console.log(' L | log2(count) | B_eff = 8L - log2(count) | mining (2^16 cells)');
console.log('---|-------------|-------------------------|--------------------');
for (const L of [8, 9, 10, 12, 16, 20, 24, 32, 48, 64, 96, 128, 192, 256]) {
  if (L > maxL) break;
  const c = count[si['I0']][L];
  const log2c = log2BigInt(c);
  const beff = 8 * L - log2c;
  const mining = beff - 16;
  console.log(`${String(L).padStart(3)} | ${log2c.toFixed(2).padStart(11)} | ${beff.toFixed(2).padStart(23)} | 2^${mining.toFixed(1)}`);
}

// Per-byte entropy gain from inserts
const safeOptions = N1 + N2 * 256 + N3 * 256 * 256;
console.log(`\nSafe options per insert position: ${safeOptions} (~${Math.log2(safeOptions).toFixed(2)} bits)`);
console.log(`Uniform bits per byte: 8.00`);
console.log(`Cost per safe-insert byte: ${(8 - Math.log2(safeOptions)).toFixed(2)} bits of B_eff`);
