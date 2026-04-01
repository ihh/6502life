#!/usr/bin/env node
/**
 * Count viable replicator probability under biased byte distributions.
 *
 * Instead of counting sequences (all equally likely), compute
 * P(replicator at a random cell) under the biased distribution.
 *
 * Uses the Forward algorithm with weighted transitions.
 */

// Default elevated bytes (30 bytes)
const ELEVATED = new Set([
    0x00, 0x04, 0x08, 0x18, 0x1A, 0x3A, 0x48, 0x50,
    0x58, 0x5A, 0x78, 0x7A, 0x88, 0x90, 0x99, 0x9A,
    0x9D, 0xA0, 0xA8, 0xB5, 0xB7, 0xB8, 0xC8, 0xCA,
    0xD8, 0xDA, 0xE8, 0xEA, 0xF8, 0xFA,
]);

// Safe single-byte inserts (subset of elevated that are safe between core ops)
const SAFE_1BYTE = [
    0xEA, 0xC8, 0x88, 0xA8, 0x18, 0x58, 0x78, 0xB8,
    0xD8, 0xF8, 0x48, 0x08, 0x9A,
    0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA,
];

const SAFE_2BYTE = [0xA0, 0x80, 0x82, 0x89, 0xC2, 0xE2];
const SAFE_3BYTE = [0x0C, 0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC];

function computeProbs(biasWeight) {
    const N1 = ELEVATED.size;
    const N0 = 256 - N1;
    const total = N1 * biasWeight + N0;
    const pElev = biasWeight / total;
    const pBg = 1 / total;

    function pByte(b) {
        return ELEVATED.has(b) ? pElev : pBg;
    }

    // Entropy
    let H = 0;
    for (let b = 0; b < 256; b++) {
        const p = pByte(b);
        if (p > 0) H -= p * Math.log2(p);
    }

    return { pByte, pElev, pBg, H, N1, N0 };
}

/**
 * Forward algorithm computing P(valid replicator of length L)
 * under the biased distribution.
 *
 * States: I0 I0_2 I0_3a I0_3b I1 ... I2 ... I3 I3_2 I3_3a I3_3b I4
 * Same as count-replicators-brk.js but with probabilities instead of counts.
 */
function forwardProb(maxL, biasWeight) {
    const { pByte } = computeProbs(biasWeight);

    // Precompute transition probabilities
    // Safe 1-byte insert: sum of p(b) for safe bytes
    const pSafe1 = SAFE_1BYTE.reduce((s, b) => s + pByte(b), 0);
    // Safe 2-byte prefix: sum of p(prefix), operand is any byte (prob 1 summed)
    const pSafe2Prefix = SAFE_2BYTE.reduce((s, b) => s + pByte(b), 0);
    // Safe 3-byte prefix
    const pSafe3Prefix = SAFE_3BYTE.reduce((s, b) => s + pByte(b), 0);

    // Core transition probabilities
    // I0 → I1: emit B5 00 — p(B5) × p(00)
    const pI0toI1 = pByte(0xB5) * pByte(0x00);
    // I1 → I2: emit 9D 00 04 — p(9D) × p(00) × p(04)
    const pI1toI2 = pByte(0x9D) * pByte(0x00) * pByte(0x04);
    // I2 → I3: emit E8|CA or C8|88 — p(E8)+p(CA)+p(C8)+p(88)
    const pI2toI3 = pByte(0xE8) + pByte(0xCA) + pByte(0xC8) + pByte(0x88);
    // I3 → I4: emit (90|50) + 00 (BRK) — (p(90)+p(50)) × p(00)
    const pI3toI4_brk = (pByte(0x90) + pByte(0x50)) * pByte(0x00);
    // Branch variant: (p(90)+p(50)) × p(offset) — offset is 1 specific byte
    // For simplicity, use BRK core only
    const pI3toI4 = pI3toI4_brk;

    // Also add LAX Y-indexed family to I0→I1
    // B7 00 (LAX zpy) has the same structure
    const pI0toI1_lax = pByte(0xB7) * pByte(0x00);
    // For LAX family, I1→I2 is 99 00 04 (STA abs,Y)
    const pI1toI2_lax = pByte(0x99) * pByte(0x00) * pByte(0x04);

    // States: I0 I0_2 I0_3a I0_3b I1 I1_2 I1_3a I1_3b I2 I2_2 I2_3a I2_3b I3 I3_2 I3_3a I3_3b I4
    const STATES = [];
    for (let k = 0; k <= 2; k++) STATES.push(`I${k}`, `I${k}_2`, `I${k}_3a`, `I${k}_3b`);
    STATES.push('I3', 'I3_2', 'I3_3a', 'I3_3b', 'I4');
    const S = STATES.length;
    const si = Object.fromEntries(STATES.map((s, i) => [s, i]));
    const ACCEPT = new Set([si['I4']]);

    // prob[s][n] = probability that a random sequence of length n
    // starting at state s reaches an accepting state
    const prob = Array.from({ length: S }, () => Array(maxL + 1).fill(0));

    for (let s = 0; s < S; s++) {
        prob[s][0] = ACCEPT.has(s) ? 1 : 0;
    }

    for (let n = 1; n <= maxL; n++) {
        for (let s = 0; s < S; s++) {
            const name = STATES[s];
            let total = 0;

            if (name === 'I4') {
                // Uniform cargo: P(any byte) = 1
                total += 1.0 * prob[si['I4']][n - 1];
            } else if (name.match(/^I\d$/) && !name.includes('_')) {
                const k = parseInt(name[1]);
                // Safe insert self-loops
                total += pSafe1 * prob[si[name]][n - 1];
                total += pSafe2Prefix * prob[si[name + '_2']][n - 1];
                total += pSafe3Prefix * prob[si[name + '_3a']][n - 1];

                // Advance to next match group
                if (k === 0 && n >= 2) {
                    // X-indexed: B5 00
                    total += pI0toI1 * prob[si['I1']][n - 2];
                    // Y-indexed: B7 00
                    total += pI0toI1_lax * prob[si['I1']][n - 2];
                } else if (k === 1 && n >= 3) {
                    // X-indexed: 9D 00 04
                    total += pI1toI2 * prob[si['I2']][n - 3];
                    // Y-indexed: 99 00 04
                    total += pI1toI2_lax * prob[si['I2']][n - 3];
                } else if (k === 2 && n >= 1) {
                    total += pI2toI3 * prob[si['I3']][n - 1];
                } else if (k === 3 && n >= 2) {
                    total += pI3toI4 * prob[si['I4']][n - 2];
                }
            } else if (name.endsWith('_2')) {
                // 2-byte operand: any byte, return to parent
                // P(any byte) = 1 (sum over all 256 values)
                const parent = name.replace('_2', '');
                total += 1.0 * prob[si[parent]][n - 1];
            } else if (name.endsWith('_3a')) {
                const next = name.replace('_3a', '_3b');
                total += 1.0 * prob[si[next]][n - 1];
            } else if (name.endsWith('_3b')) {
                const parent = name.replace('_3b', '');
                total += 1.0 * prob[si[parent]][n - 1];
            }

            prob[s][n] = total;
        }
    }
    return prob;
}

// ── Main ─────────────────────────────────────────────────────────────

const maxL = parseInt(process.argv[2] || '256');

console.log('Biased initialization: P(replicator) vs biasWeight\n');
console.log('Default elevated set: ' + ELEVATED.size + ' bytes');
console.log('');

const biasWeights = [1, 2, 4, 8, 16, 32, 64];

// Header
const header = 'biasW | H(bits) | ' +
    [8, 10, 12, 16, 32, 64, 128, 256].map(L => `L=${L}`).join(' | ');
console.log(header);
console.log('-'.repeat(header.length));

for (const bw of biasWeights) {
    const { H } = computeProbs(bw);
    const prob = forwardProb(maxL, bw);
    const initial = 0; // I0

    const cells = [];
    for (const L of [8, 10, 12, 16, 32, 64, 128, 256]) {
        if (L > maxL) { cells.push('     —'); continue; }
        const p = prob[initial][L];
        if (p === 0) { cells.push(' never'); continue; }
        const log2p = Math.log2(p);
        cells.push(`2^${log2p.toFixed(1)}`.padStart(6));
    }
    console.log(`${String(bw).padStart(5)} | ${H.toFixed(2).padStart(7)} | ${cells.join(' | ')}`);
}

// Mining time estimates
console.log('\n\nMining time estimates (64×64 board = 4096 cells, 5000 seeds/sec)\n');
console.log('biasW | P(any cell) L=256 | Seeds needed | Time');
console.log('------|-------------------|--------------|----------');

for (const bw of biasWeights) {
    const prob = forwardProb(256, bw);
    const pPerCell = prob[0][256];
    const pAnyCell = 1 - Math.pow(1 - pPerCell, 4096);
    const seedsNeeded = pAnyCell > 0 ? 1 / pAnyCell : Infinity;
    const seconds = seedsNeeded / 5000;
    let timeStr;
    if (seconds < 60) timeStr = `${seconds.toFixed(1)}s`;
    else if (seconds < 3600) timeStr = `${(seconds/60).toFixed(1)} min`;
    else if (seconds < 86400) timeStr = `${(seconds/3600).toFixed(1)} hours`;
    else if (seconds < 86400 * 365) timeStr = `${(seconds/86400).toFixed(1)} days`;
    else timeStr = `${(seconds/86400/365).toFixed(1)} years`;

    console.log(`${String(bw).padStart(5)} | ${pPerCell > 0 ? `2^${Math.log2(pPerCell).toFixed(1)}` : 'never'.padStart(17)} | ${seedsNeeded > 1e15 ? `2^${Math.log2(seedsNeeded).toFixed(1)}` : seedsNeeded.toFixed(0).padStart(12)} | ${timeStr}`);
}
