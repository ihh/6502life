#!/usr/bin/env node
/**
 * Count viable replicator sequences with BRK-reset core.
 *
 * BRK-reset core (7 bytes): B5 00 9D 00 04 {E8|CA} 00
 *   LDA $00,X; STA $0400,X; INX|DEX; BRK
 *
 * DFA: I₀* [B5 00] I₁* [9D 00 04] I₂* [E8|CA] [00] I₃*
 *
 * I₃ is uniform cargo (never executed — BRK resets every quantum).
 * I₀-I₂ accept safe inserts only.
 *
 * We check the first `check_len` bytes of each cell (default 12).
 * The DFA accepts at I₃ (after the BRK byte).
 */

const SAFE_1BYTE = [
  0xEA, 0xC8, 0x88, 0xA8,  // NOP, INY, DEY, TAY
  0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA,  // undoc NOPs
  0x18, 0x58, 0x78, 0xB8, 0xD8, 0xF8,  // CLC, CLI, SEI, CLV, CLD, SED
  0x48, 0x08,  // PHA, PHP
  0x9A,  // TXS
];
const N1 = SAFE_1BYTE.length;

const SAFE_2BYTE = [0xA0, 0x80, 0x82, 0x89, 0xC2, 0xE2];
const N2 = SAFE_2BYTE.length;

const SAFE_3BYTE = [0x0C, 0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC];
const N3 = SAFE_3BYTE.length;

// States: I0 I0_2 I0_3a I0_3b I1 I1_2 I1_3a I1_3b I2 I2_2 I2_3a I2_3b I3
const STATES = [];
for (let k = 0; k <= 2; k++) {
  STATES.push(`I${k}`, `I${k}_2`, `I${k}_3a`, `I${k}_3b`);
}
STATES.push('I3');  // cargo (uniform, accepting)
const S = STATES.length;
const si = Object.fromEntries(STATES.map((s, i) => [s, i]));
const ACCEPT = new Set([si['I3']]);

function forward(maxL) {
  const count = Array.from({ length: S }, () => Array(maxL + 1).fill(0n));

  for (let s = 0; s < S; s++) {
    count[s][0] = ACCEPT.has(s) ? 1n : 0n;
  }

  for (let n = 1; n <= maxL; n++) {
    for (let s = 0; s < S; s++) {
      const name = STATES[s];
      let total = 0n;

      if (name === 'I3') {
        // Uniform cargo: any byte
        total += 256n * count[si['I3']][n - 1];

      } else if (name.match(/^I\d$/) && !name.includes('_')) {
        const k = parseInt(name[1]);
        // Safe insert self-loops
        total += BigInt(N1) * count[si[name]][n - 1];
        total += BigInt(N2) * count[si[name + '_2']][n - 1];
        total += BigInt(N3) * count[si[name + '_3a']][n - 1];

        // Advance to next match group
        if (k === 0 && n >= 2) {
          // I0 -> I1: emit B5 00 (2 bytes)
          total += count[si['I1']][n - 2];
        } else if (k === 1 && n >= 3) {
          // I1 -> I2: emit 9D 00 04 (3 bytes)
          total += count[si['I2']][n - 3];
        } else if (k === 2 && n >= 2) {
          // I2 -> I3: emit E8|CA then 00 (2 bytes, 2 choices for inc/dec)
          total += 2n * count[si['I3']][n - 2];
        }

      } else if (name.endsWith('_2')) {
        const parent = name.replace('_2', '');
        total += 256n * count[si[parent]][n - 1];

      } else if (name.endsWith('_3a')) {
        const next = name.replace('_3a', '_3b');
        total += 256n * count[si[next]][n - 1];

      } else if (name.endsWith('_3b')) {
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

const maxL = parseInt(process.argv[2] || '16');
const count = forward(maxL);

console.log(`BRK-reset replicator: B5 00 9D 00 04 {E8|CA} 00`);
console.log(`Safe inserts: ${N1} 1-byte, ${N2} 2-byte, ${N3} 3-byte prefixes\n`);

console.log(' L | count | log2 | B_eff | mining (2^16 cells) | mining (2^20 cells)');
console.log('---|-------|------|-------|---------------------|--------------------');
for (let L = 7; L <= maxL; L++) {
  const c = count[si['I0']][L];
  const log2c = log2BigInt(c);
  const beff = 8 * L - log2c;
  const m16 = beff - 16;
  const m20 = beff - 20;
  const cStr = c < 10000n ? String(c).padStart(8) : `~2^${log2c.toFixed(1)}`.padStart(8);
  console.log(`${String(L).padStart(3)} | ${cStr} | ${log2c.toFixed(1).padStart(4)} | ${beff.toFixed(1).padStart(5)} | 2^${m16.toFixed(1).padStart(5)} | 2^${m20.toFixed(1).padStart(5)}`);
}
