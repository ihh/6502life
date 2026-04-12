/**
 * K-mer soup: primordial soup generator using weighted 1/2/3-byte k-mers.
 *
 * Instead of IID weighted bytes (Turtle's Tiers), cells are filled by
 * repeatedly drawing from a weighted set of 1-, 2-, and 3-byte k-mers.
 * This is equivalent to an order-2 Markov model and keeps randomly-
 * generated assembly code instruction-frame-aware: opcodes and their
 * operands are emitted as coherent units.
 *
 * All 256 single bytes appear as 1-mers with a small base weight,
 * so the model can (however improbably) generate any byte sequence.
 *
 * Usage:
 *   import { buildKmerLUT, kmerFill, KMER_TABLE } from './kmer-soup.js';
 *   const lut = buildKmerLUT();          // once at startup
 *   kmerFill(lut, rawBytes, out, 249);   // fill 249 bytes from PRNG
 */

// ---------------------------------------------------------------------------
// K-mer table definition
// ---------------------------------------------------------------------------
// Each entry: [weight, ...bytes]
// Organised by role so weights are easy to audit and tune.

const KMER_DEFS = [];

// ---- 1. Background: every single byte, base weight 1 ---------------------
// Ensures any byte sequence is reachable.  Specific bytes are boosted below.
for (let b = 0; b < 256; b++) KMER_DEFS.push([1, b]);

// Helper: add a k-mer (or increase weight of an existing 1-mer)
function kmer(w, ...bytes) { KMER_DEFS.push([w, ...bytes]); }
// Helper: boost weight of a single-byte 1-mer already in the table
function boost(byte, extraWeight) { KMER_DEFS[byte][0] += extraWeight; }

// ---- 2. Important 1-byte instructions (implied/accumulator) ---------------

// BRK — triggers copy/swap/reset, most important single opcode
boost(0x00, 150);
// Loop counters — core of every replicator
boost(0xCA, 100);   // DEX
boost(0xE8, 30);    // INX
boost(0x88, 5);     // DEY
boost(0xC8, 3);     // INY
// NOPs — benign padding that preserves frame alignment
boost(0xEA, 8);     // NOP
// Register transfers
boost(0xAA, 3);     // TAX
boost(0xA8, 3);     // TAY
boost(0x8A, 2);     // TXA
boost(0x98, 2);     // TYA
// Flag operations relevant to replicator control flow
boost(0x18, 2);     // CLC  (BCC becomes unconditional branch)
boost(0x38, 2);     // SEC  (BCS becomes unconditional branch)
boost(0x58, 2);     // CLI
boost(0x78, 2);     // SEI  (atomic writes)

// ---- 3. Two-byte instructions (opcode + 1 operand byte) ------------------

// --- Loads from zero page (replicator read side) ---
// LDA $00,X — the canonical replicator read
kmer(80, 0xB5, 0x00);
// LAX $00,Y — undocumented but used by Y-indexed replicators
kmer(25, 0xB7, 0x00);
// LDA $nn (zero page, various useful addresses)
kmer(6, 0xA5, 0x00);
kmer(3, 0xA5, 0xF0);   // oriented register area

// --- Stores to zero page ---
kmer(4, 0x85, 0x00);   // STA $00
kmer(3, 0x95, 0x00);   // STA $00,X

// --- Immediate loads (register init) ---
kmer(10, 0xA9, 0x00);  // LDA #$00
kmer(8, 0xA9, 0xFF);   // LDA #$FF
kmer(12, 0xA2, 0xFF);  // LDX #$FF   (counter init: start at top)
kmer(8, 0xA2, 0x00);   // LDX #$00   (counter init: start at bottom)
kmer(5, 0xA2, 0xEF);   // LDX #$EF   (zero-page size minus regs)
kmer(5, 0xA0, 0xFF);   // LDY #$FF
kmer(4, 0xA0, 0x00);   // LDY #$00

// --- Compares (loop termination) ---
kmer(3, 0xE0, 0x00);   // CPX #$00
kmer(3, 0xC0, 0x00);   // CPY #$00
kmer(2, 0xC9, 0x00);   // CMP #$00

// --- Branches with replicator-useful offsets ---
// BNE (most common loop branch)
kmer(15, 0xD0, 0xFA);  // BNE -6   (canonical 6-byte copy core)
kmer(10, 0xD0, 0xF8);  // BNE -8   (8-byte loop body)
kmer(6, 0xD0, 0xFC);   // BNE -4
kmer(4, 0xD0, 0xF6);   // BNE -10
kmer(3, 0xD0, 0xFE);   // BNE -2
// BCC (unsigned loop)
kmer(12, 0x90, 0xFA);  // BCC -6
kmer(8, 0x90, 0xF8);   // BCC -8
kmer(5, 0x90, 0xFC);   // BCC -4
kmer(3, 0x90, 0xF6);   // BCC -10
// BVC (overflow-based loop, seen in miner patterns)
kmer(5, 0x50, 0xFA);   // BVC -6
kmer(3, 0x50, 0xF8);   // BVC -8
// BEQ / BCS (less common but useful)
kmer(3, 0xF0, 0xFA);   // BEQ -6
kmer(3, 0xB0, 0xFA);   // BCS -6
// Small forward branches (skip past noise)
kmer(2, 0xD0, 0x02);   // BNE +2
kmer(2, 0xD0, 0x04);   // BNE +4
kmer(2, 0x90, 0x02);   // BCC +2

// --- BRK with useful operands ---
// BRK is 1-byte in terms of opcode, but the next byte is the operand
// that selects the operation.  Emitting as 2-mers keeps them coherent.
kmer(10, 0x00, 0x00);  // BRK 0   (reset: yield PC to 0)
kmer(20, 0x00, 0x31);  // BRK 49  (copy cell 0→1, the neighbor)
kmer(8, 0x00, 0x32);   // BRK 50  (copy cell 0→2)
kmer(5, 0x00, 0x01);   // BRK 1   (swap cell 0↔1)
kmer(3, 0x00, 0x02);   // BRK 2   (swap cell 0↔2)

// --- Zero-page NOPs (harmless 2-byte padding, preserves frame) ---
kmer(3, 0x04, 0x00);   // NOP $00  (undocumented 2-byte NOP)
kmer(2, 0x44, 0x00);   // NOP $00
kmer(2, 0x64, 0x00);   // NOP $00

// --- Indirect indexed (useful for computed copy) ---
kmer(3, 0xB1, 0x00);   // LDA ($00),Y
kmer(2, 0x91, 0x00);   // STA ($00),Y
kmer(2, 0xA1, 0x00);   // LDA ($00,X)
kmer(2, 0x81, 0x00);   // STA ($00,X)

// ---- 4. Three-byte instructions (opcode + 2 operand bytes) ---------------

// --- Stores to neighbor (the copy write side) ---
// STA $0400,X — canonical replicator write
kmer(80, 0x9D, 0x00, 0x04);
// STA $0400,Y — Y-indexed variant
kmer(25, 0x99, 0x00, 0x04);
// STA $03FF,X / STA $03FF,Y — end-of-self variants
kmer(10, 0x9D, 0xFF, 0x03);
kmer(5, 0x99, 0xFF, 0x03);

// --- Loads from neighbor ---
kmer(5, 0xBD, 0x00, 0x04);   // LDA $0400,X
kmer(3, 0xB9, 0x00, 0x04);   // LDA $0400,Y

// --- Stores to self (absolute indexed) ---
kmer(4, 0x9D, 0x00, 0x00);   // STA $0000,X
kmer(3, 0x99, 0x00, 0x00);   // STA $0000,Y

// --- Loads from self (absolute indexed) ---
kmer(3, 0xBD, 0x00, 0x00);   // LDA $0000,X
kmer(2, 0xB9, 0x00, 0x00);   // LDA $0000,Y

// --- Jumps ---
kmer(8, 0x4C, 0x00, 0x00);   // JMP $0000  (restart from top)
kmer(3, 0x20, 0x00, 0x00);   // JSR $0000
kmer(2, 0x4C, 0x00, 0x02);   // JMP $0200  (jump to code area)

// --- Absolute NOPs (harmless 3-byte padding) ---
kmer(2, 0x0C, 0x00, 0x00);   // NOP $0000 (undocumented)

// --- ROM lookup table reads (useful for vector/rotation) ---
kmer(2, 0xBD, 0x00, 0xE0);   // LDA $E000,X  (ROM tables)
kmer(2, 0xB9, 0x00, 0xE0);   // LDA $E000,Y

// ---------------------------------------------------------------------------
// Build flat arrays from KMER_DEFS
// ---------------------------------------------------------------------------

/** Total number of k-mers in the table */
const N_KMERS = KMER_DEFS.length;

/** Weights: Float64Array(N_KMERS) */
const KMER_WEIGHTS = new Float64Array(N_KMERS);
/** Byte data: array of Uint8Array, indexed by k-mer id */
const KMER_BYTES = new Array(N_KMERS);

for (let i = 0; i < N_KMERS; i++) {
    const def = KMER_DEFS[i];
    KMER_WEIGHTS[i] = def[0];
    KMER_BYTES[i] = new Uint8Array(def.slice(1));
}

// ---------------------------------------------------------------------------
// Exposed table (read-only view for inspection / tuning tools)
// ---------------------------------------------------------------------------

/**
 * The full k-mer table.  Each entry: { weight, bytes: Uint8Array }.
 * Entries 0-255 are the 256 base single-byte k-mers; the rest are
 * multi-byte instruction k-mers.  Mutating this after buildKmerLUT()
 * has no effect on the LUT already built.
 */
export const KMER_TABLE = Object.freeze(
    KMER_DEFS.map(def => Object.freeze({
        weight: def[0],
        bytes:  new Uint8Array(def.slice(1)),
    }))
);

/** Number of k-mers */
export { N_KMERS };

// ---------------------------------------------------------------------------
// LUT builder
// ---------------------------------------------------------------------------

/**
 * Build a 65536-entry lookup table mapping a 16-bit random value to a k-mer
 * index.  Returns { lut: Uint16Array(65536), bytes: Uint8Array[] }.
 *
 * The LUT encodes the CDF so that P(selecting k-mer i) ∝ weight[i].
 */
export function buildKmerLUT() {
    const total = KMER_WEIGHTS.reduce((a, b) => a + b, 0);
    // CDF
    const cdf = new Float64Array(N_KMERS);
    let cum = 0;
    for (let i = 0; i < N_KMERS; i++) { cum += KMER_WEIGHTS[i] / total; cdf[i] = cum; }
    cdf[N_KMERS - 1] = 1.0; // clamp rounding

    // Invert CDF into a 65536-entry LUT
    const lut = new Uint16Array(65536);
    let ki = 0;
    for (let r = 0; r < 65536; r++) {
        const u = (r + 0.5) / 65536;
        while (ki < N_KMERS - 1 && cdf[ki] < u) ki++;
        lut[r] = ki;
    }

    return { lut, bytes: KMER_BYTES };
}

// ---------------------------------------------------------------------------
// Fill routine
// ---------------------------------------------------------------------------

/**
 * Fill `out[0..len-1]` by drawing k-mers using raw PRNG bytes.
 *
 * @param {{ lut: Uint16Array, bytes: Uint8Array[] }} kmerLUT
 *     The precomputed LUT from buildKmerLUT().
 * @param {Uint8Array} raw
 *     PRNG bytes; at least `2 * len` bytes recommended (worst case:
 *     all 1-mers → one 16-bit draw per output byte).
 * @param {Uint8Array} out
 *     Destination buffer.
 * @param {number} len
 *     Number of bytes to produce.
 * @returns {number} Number of raw PRNG bytes consumed.
 */
export function kmerFill(kmerLUT, raw, out, len) {
    const { lut, bytes } = kmerLUT;
    let pos = 0, ri = 0;
    while (pos < len) {
        const r = raw[ri] | (raw[ri + 1] << 8);
        ri += 2;
        const kmer = bytes[lut[r]];
        for (let k = 0; k < kmer.length && pos < len; k++) {
            out[pos++] = kmer[k];
        }
    }
    return ri;
}

// ---------------------------------------------------------------------------
// GPU buffer builder
// ---------------------------------------------------------------------------

/**
 * Build packed GPU-ready buffers for the k-mer LUT + byte table.
 *
 * Returns:
 *   lutPacked   — Uint32Array(16384): 65536 u16 LUT entries packed as u32
 *   kmerData    — Uint32Array(N):     packed k-mer records, 1 u32 each:
 *                 bits [1:0]  = length - 1  (0=1byte, 1=2byte, 2=3byte)
 *                 bits [9:2]  = byte 0
 *                 bits [17:10]= byte 1  (if length >= 2, else 0)
 *                 bits [25:18]= byte 2  (if length == 3, else 0)
 *   nKmers      — number of k-mers
 */
export function buildKmerGPUBuffers() {
    const cpuLUT = buildKmerLUT();

    // Pack LUT: two u16 per u32
    const lutPacked = new Uint32Array(32768);
    for (let i = 0; i < 65536; i += 2) {
        lutPacked[i >> 1] = cpuLUT.lut[i] | (cpuLUT.lut[i + 1] << 16);
    }

    // Pack k-mer data: 1 u32 per k-mer
    const kmerData = new Uint32Array(N_KMERS);
    for (let i = 0; i < N_KMERS; i++) {
        const b = KMER_BYTES[i];
        let word = (b.length - 1);          // bits [1:0]
        word |= (b[0] << 2);               // bits [9:2]
        if (b.length >= 2) word |= (b[1] << 10);  // bits [17:10]
        if (b.length >= 3) word |= (b[2] << 18);  // bits [25:18]
        kmerData[i] = word;
    }

    return { lutPacked, kmerData, nKmers: N_KMERS };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Return summary statistics about the k-mer table.
 * Useful for tuning: shows per-byte marginal probability for each opcode
 * and the expected instruction-alignment rate.
 */
export function kmerStats() {
    const total = KMER_WEIGHTS.reduce((a, b) => a + b, 0);
    let totalLen = 0;
    const byteFreq = new Float64Array(256);

    for (let i = 0; i < N_KMERS; i++) {
        const p = KMER_WEIGHTS[i] / total;
        const b = KMER_BYTES[i];
        totalLen += p * b.length;
        for (let k = 0; k < b.length; k++) byteFreq[b[k]] += p;
    }

    // Normalise by expected bytes per draw to get per-position marginal
    for (let b = 0; b < 256; b++) byteFreq[b] /= totalLen;

    // Fraction of draws that are multi-byte (instruction-coherent)
    let multiByteWeight = 0;
    for (let i = 0; i < N_KMERS; i++) {
        if (KMER_BYTES[i].length > 1) multiByteWeight += KMER_WEIGHTS[i];
    }
    const coherentFraction = multiByteWeight / total;

    return {
        nKmers: N_KMERS,
        totalWeight: total,
        meanBytesPerDraw: totalLen,
        coherentFraction,
        byteFreq,     // marginal P(byte at random position)
    };
}
