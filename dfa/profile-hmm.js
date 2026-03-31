/**
 * Profile HMM for replicator generation and scoring.
 *
 * Replaces the DFA/WFST approach (1050 product states, ~268K weights)
 * with a compact profile HMM (~18 states) that directly models the
 * structure of 6502 copy-loop replicators.
 *
 * Core replicator: LDA $0,X; STA $400,X; INX; BCC $0
 *                  B5 00 9D 00 04 E8 90 F8
 *
 * The HMM has 8 match states (one per core byte) and 9 insert states
 * (before/between/after match states). Insert emissions use a mixture
 * model with three paths (1-byte, 2-byte, 3-byte) and latent classes
 * within each multi-byte path.
 *
 * @module dfa/profile-hmm
 */

// ---- Constants ----

/** The 8 match-state emission constraints. */
const MATCH_EMISSIONS = [
    [0xB5],                                         // M1: LDA zpx
    [0x00],                                         // M2: zpx address
    [0x9D],                                         // M3: STA abs,X
    [0x00],                                         // M4: abs address low
    [0x04],                                         // M5: abs address high = page 4
    [0xE8, 0xCA],                                   // M6: INX or DEX
    [0x90, 0xD0, 0x10, 0x30, 0x50, 0x70, 0xB0],    // M7: branch opcodes
    null,                                           // M8: branch offset (deterministic)
];

/** Safe single-byte insert opcodes. */
const SAFE_SINGLE = [
    0xEA, // NOP
    0xD8, // CLD
    0xF8, // SED
    0xC8, // INY
    0x88, // DEY
    0xA8, // TAY
    0x98, // TYA
    0x18, // CLC
    0x38, // SEC
    0xB8, // CLV
    // Undocumented single-byte NOPs
    0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA,
];

/** Two-byte insert opcodes (opcode, then any operand byte). */
const SAFE_TWO_BYTE_PREFIXES = [
    0xA0, // LDY #imm
    0xA2, // LDX #imm
    0xE0, // CPX #imm
    0xC0, // CPY #imm
];

/** Risky single-byte inserts (lower prior weight). */
const RISKY_SINGLE = [
    0x85, // STA zpg — needs a sub-state for operand, skip for now
    0xAA, // TAX
    0x8A, // TXA
    0x48, // PHA
    0x68, // PLA
    0x08, // PHP
    0x28, // PLP
    0x9A, // TXS
    0xBA, // TSX
];

// ---- State indexing ----
// States:  I0, M1, I1, M2, I2, ..., M8, I8, END
//
// Layout:
//   I_k    = 2*k        (k = 0..8)    → 9 insert states
//   M_k    = 2*k - 1    (k = 1..8)    → 8 match states
//   END    = 17
//
// Total: 18 states

const NUM_INSERT = 9;   // I0..I8
const NUM_MATCH = 8;    // M1..M8
const NUM_STATES = NUM_INSERT + NUM_MATCH + 1; // 18
const END_STATE = NUM_STATES - 1; // 17

function insertIdx(k) { return 2 * k; }         // k = 0..8
function matchIdx(k) { return 2 * k - 1; }      // k = 1..8

// ---- logSumExp ----

function logSumExp(a, b) {
    if (a === -Infinity) return b;
    if (b === -Infinity) return a;
    const mx = Math.max(a, b);
    return mx + Math.log(Math.exp(a - mx) + Math.exp(b - mx));
}

// ---- InsertEmission class ----

/**
 * Mixture model for insert emissions.
 *
 * P(insert bytes) = alpha[0] * P1(b)                           -- 1-byte path
 *                 + alpha[1] * sum_k pi_k * P2k(b1) * P2k(b2)  -- 2-byte path
 *                 + alpha[2] * sum_k rho_k * P3k(b1) * P3k(b2) * P3k(b3) -- 3-byte path
 */
class InsertEmission {
    /**
     * @param {Object} [opts]
     * @param {number} [opts.N=3] - number of latent classes per multi-byte path
     * @param {number} [opts.safeSingleWeight=1.0]
     * @param {number} [opts.safeTwoByteWeight=0.8]
     * @param {number} [opts.riskySingleWeight=0.1]
     * @param {number} [opts.backgroundWeight=0.01]
     */
    constructor(opts = {}) {
        const N = opts.N ?? 3;
        this.N = N;

        const safeSingleW = opts.safeSingleWeight ?? 1.0;
        const safeTwoByteW = opts.safeTwoByteWeight ?? 0.8;
        const riskySingleW = opts.riskySingleWeight ?? 0.1;
        const backgroundW = opts.backgroundWeight ?? 0.01;

        // Path mixing weights alpha: [1-byte, 2-byte, 3-byte]
        this.logAlpha = new Float64Array(3);
        const alpha = [0.6, 0.3, 0.1];
        for (let i = 0; i < 3; i++) this.logAlpha[i] = Math.log(alpha[i]);

        // ---- 1-byte path: P1(b) ----
        // Same as the old insertLogProbs
        const safeSingleSet = new Set(SAFE_SINGLE);
        const safeTwoByteSet = new Set(SAFE_TWO_BYTE_PREFIXES);
        const riskySingleSet = new Set(RISKY_SINGLE);

        this.p1LogProbs = _buildDistribution(b => {
            if (safeSingleSet.has(b)) return safeSingleW;
            if (safeTwoByteSet.has(b)) return safeTwoByteW;
            if (riskySingleSet.has(b)) return riskySingleW;
            return backgroundW;
        });

        // ---- 2-byte path: N classes ----
        // Class 0: immediate load opcodes (A0, A2, E0, C0) + uniform operand
        // Class 1: zpg ops (85, A5, 24, etc.) + mild prior toward safe addresses
        // Class 2: undocumented 2-byte NOPs (80, 82, 89, C2, E2) + uniform operand
        this.logPi = new Float64Array(N); // log mixing weights
        const piWeights = new Float64Array(N).fill(1 / N);
        for (let k = 0; k < N; k++) this.logPi[k] = Math.log(piWeights[k]);

        // P2k[class][position] = Float64Array(256) of log-probs
        this.p2LogProbs = [];

        // Class 0: immediate loads
        const immLoadOpcodes = new Set([0xA0, 0xA2, 0xE0, 0xC0]);
        this.p2LogProbs.push([
            _buildDistribution(b => immLoadOpcodes.has(b) ? 5.0 : backgroundW),
            _buildDistribution(() => 1.0), // uniform operand
        ]);

        // Class 1: zero-page ops
        const zpgOpcodes = new Set([0x85, 0xA5, 0x24, 0x45, 0x65, 0x84, 0xA4, 0xC4, 0xE4, 0x05, 0x25]);
        this.p2LogProbs.push([
            _buildDistribution(b => zpgOpcodes.has(b) ? 3.0 : backgroundW),
            _buildDistribution(b => {
                // Mild prior toward low addresses (safe zero-page)
                if (b < 0x10) return 2.0;
                if (b < 0x80) return 1.0;
                return 0.5;
            }),
        ]);

        // Class 2: undocumented 2-byte NOPs
        const undoc2Opcodes = new Set([0x80, 0x82, 0x89, 0xC2, 0xE2]);
        this.p2LogProbs.push([
            _buildDistribution(b => undoc2Opcodes.has(b) ? 5.0 : backgroundW),
            _buildDistribution(() => 1.0), // uniform operand
        ]);

        // ---- 3-byte path: N classes ----
        this.logRho = new Float64Array(N);
        const rhoWeights = new Float64Array(N).fill(1 / N);
        for (let k = 0; k < N; k++) this.logRho[k] = Math.log(rhoWeights[k]);

        // P3k[class][position] = Float64Array(256) of log-probs
        this.p3LogProbs = [];

        // Class 0: absolute addressing loads (LDA abs = 0xAD, LDX abs = 0xAE, LDY abs = 0xAC)
        const absLoadOpcodes = new Set([0xAD, 0xAE, 0xAC]);
        this.p3LogProbs.push([
            _buildDistribution(b => absLoadOpcodes.has(b) ? 5.0 : backgroundW),
            _buildDistribution(() => 1.0), // addr low uniform
            _buildDistribution(() => 1.0), // addr high uniform
        ]);

        // Class 1: absolute addressing stores (STA abs = 0x8D, STX abs = 0x8E, STY abs = 0x8C)
        const absStoreOpcodes = new Set([0x8D, 0x8E, 0x8C]);
        this.p3LogProbs.push([
            _buildDistribution(b => absStoreOpcodes.has(b) ? 5.0 : backgroundW),
            _buildDistribution(() => 1.0), // addr low uniform
            _buildDistribution(b => {
                // Prefer low pages
                if (b < 0x08) return 2.0;
                return 0.5;
            }),
        ]);

        // Class 2: undocumented 3-byte NOPs (0C, 1C, 3C, 5C, 7C, DC, FC — unofficial)
        const undoc3Opcodes = new Set([0x0C, 0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC]);
        this.p3LogProbs.push([
            _buildDistribution(b => undoc3Opcodes.has(b) ? 5.0 : backgroundW),
            _buildDistribution(() => 1.0),
            _buildDistribution(() => 1.0),
        ]);

        // Precompute legacy insertLogProbs (for backward compat in tests):
        // This is just P1 — the 1-byte marginal
        this.insertLogProbs = this.p1LogProbs;
    }

    /**
     * Compute log P(these count bytes as one insert emission).
     * @param {Uint8Array} bytes - source array
     * @param {number} start - start index
     * @param {number} count - 1, 2, or 3
     * @returns {number} log probability
     */
    logProb(bytes, start, count) {
        if (count === 1) {
            const b = bytes[start];
            return this.logAlpha[0] + this.p1LogProbs[b];
        }
        if (count === 2) {
            const b1 = bytes[start], b2 = bytes[start + 1];
            let logSum = -Infinity;
            for (let k = 0; k < this.N; k++) {
                const lp = this.logPi[k] + this.p2LogProbs[k][0][b1] + this.p2LogProbs[k][1][b2];
                logSum = logSumExp(logSum, lp);
            }
            return this.logAlpha[1] + logSum;
        }
        if (count === 3) {
            const b1 = bytes[start], b2 = bytes[start + 1], b3 = bytes[start + 2];
            let logSum = -Infinity;
            for (let k = 0; k < this.N; k++) {
                const lp = this.logRho[k] + this.p3LogProbs[k][0][b1] + this.p3LogProbs[k][1][b2] + this.p3LogProbs[k][2][b3];
                logSum = logSumExp(logSum, lp);
            }
            return this.logAlpha[2] + logSum;
        }
        return -Infinity;
    }

    /**
     * Sample one insert emission (returns 1, 2, or 3 bytes).
     * @param {Object} rng - PRNG with .real() method
     * @returns {Uint8Array} sampled bytes
     */
    sample(rng) {
        // Pick path
        const pathR = rng.real();
        const a0 = Math.exp(this.logAlpha[0]);
        const a1 = Math.exp(this.logAlpha[1]);
        // const a2 = Math.exp(this.logAlpha[2]);

        if (pathR < a0) {
            // 1-byte path
            const b = _sampleFromLogDist(this.p1LogProbs, rng);
            return new Uint8Array([b]);
        } else if (pathR < a0 + a1) {
            // 2-byte path: pick class
            const k = _sampleCategorical(this.logPi, rng);
            const b1 = _sampleFromLogDist(this.p2LogProbs[k][0], rng);
            const b2 = _sampleFromLogDist(this.p2LogProbs[k][1], rng);
            return new Uint8Array([b1, b2]);
        } else {
            // 3-byte path: pick class
            const k = _sampleCategorical(this.logRho, rng);
            const b1 = _sampleFromLogDist(this.p3LogProbs[k][0], rng);
            const b2 = _sampleFromLogDist(this.p3LogProbs[k][1], rng);
            const b3 = _sampleFromLogDist(this.p3LogProbs[k][2], rng);
            return new Uint8Array([b1, b2, b3]);
        }
    }
}

/**
 * Build a normalized log-probability distribution over 256 bytes.
 * @param {Function} weightFn - (byte) => weight
 * @returns {Float64Array} log-probabilities (length 256)
 */
function _buildDistribution(weightFn) {
    const weights = new Float64Array(256);
    let total = 0;
    for (let b = 0; b < 256; b++) {
        weights[b] = weightFn(b);
        total += weights[b];
    }
    const logProbs = new Float64Array(256);
    for (let b = 0; b < 256; b++) {
        logProbs[b] = Math.log(weights[b] / total);
    }
    return logProbs;
}

/**
 * Sample from a log-probability distribution (Float64Array of length 256).
 */
function _sampleFromLogDist(logProbs, rng) {
    let r = rng.real();
    for (let b = 0; b < 256; b++) {
        r -= Math.exp(logProbs[b]);
        if (r <= 0) return b;
    }
    return 255;
}

/**
 * Sample a categorical index from log-weights.
 */
function _sampleCategorical(logWeights, rng) {
    let r = rng.real();
    for (let k = 0; k < logWeights.length; k++) {
        r -= Math.exp(logWeights[k]);
        if (r <= 0) return k;
    }
    return logWeights.length - 1;
}

// ---- ProfileHMM class ----

export class ProfileHMM {
    /**
     * @param {Object} [opts]
     * @param {number[]} [opts.delta] - self-loop probabilities for insert states (length 9)
     * @param {number} [opts.N=3] - number of latent classes per multi-byte path
     * @param {number} [opts.safeSingleWeight=1.0] - prior weight for safe single-byte inserts
     * @param {number} [opts.safeTwoByteWeight=0.8] - prior weight for safe two-byte inserts
     * @param {number} [opts.riskySingleWeight=0.1] - prior weight for risky single-byte inserts
     * @param {number} [opts.backgroundWeight=0.01] - prior weight for all other bytes
     */
    constructor(opts = {}) {
        // Insert state self-loop probabilities (delta_k)
        // Default: small probability of inserts
        this.delta = new Float64Array(opts.delta || [
            0.3, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.3,
        ]);

        // Match state emission distributions (log-probabilities)
        // M1-M7: uniform over allowed bytes; M8: deterministic (handled separately)
        this.matchLogProbs = [];
        for (let k = 0; k < 8; k++) {
            const allowed = MATCH_EMISSIONS[k];
            if (allowed === null) {
                // M8: deterministic, no emission distribution
                this.matchLogProbs.push(null);
            } else {
                const lp = Math.log(1 / allowed.length);
                const map = new Map();
                for (const b of allowed) map.set(b, lp);
                this.matchLogProbs.push(map);
            }
        }

        // Insert emission mixture model (shared across all insert states)
        this.insertEmission = new InsertEmission(opts);

        // Legacy: expose insertLogProbs for backward compatibility
        this.insertLogProbs = this.insertEmission.insertLogProbs;
    }

    /** Number of HMM states. */
    get numStates() { return NUM_STATES; }
}

// ---- Forward algorithm ----

/**
 * Compute log P(seq | HMM) using the forward algorithm.
 *
 * State semantics:
 * - I_k: insert state k, can self-loop (emit 1/2/3 insert bytes) or transition to M_{k+1}
 * - M_k: match state k, emits match byte then transitions to I_k
 * - END: absorbing end state
 *
 * @param {ProfileHMM} hmm
 * @param {Uint8Array} seq
 * @returns {number} log P(seq | HMM) (natural log)
 */
export function hmmForward(hmm, seq) {
    const L = seq.length;
    if (L < 8) return -Infinity;

    const NEG_INF = -Infinity;

    // Alpha table indexed by position: alpha[s] = log P(emit seq[0..pos-1], in state s at pos)
    // Use position-indexed approach: for each state, enumerate possible emissions
    // and advance position accordingly.

    // We need a 2D table: alpha[pos][state]
    const alpha = [];
    for (let t = 0; t <= L; t++) {
        alpha.push(new Float64Array(NUM_STATES).fill(NEG_INF));
    }

    // Initial: start in I_0 at position 0
    alpha[0][insertIdx(0)] = 0;

    for (let t = 0; t <= L; t++) {
        for (let s = 0; s < NUM_STATES; s++) {
            if (alpha[t][s] === NEG_INF) continue;
            const a = alpha[t][s];

            if (s === END_STATE) continue;

            // --- Insert state I_k ---
            if (s <= 16 && s % 2 === 0) {
                const k = s / 2;
                const logDelta = Math.log(hmm.delta[k]);

                // Option 1: emit 1 insert byte (stay in I_k)
                if (t < L) {
                    const lp = a + logDelta + hmm.insertEmission.logProb(seq, t, 1);
                    alpha[t + 1][s] = logSumExp(alpha[t + 1][s], lp);
                }

                // Option 2: emit 2 insert bytes (stay in I_k)
                if (t + 1 < L) {
                    const lp = a + logDelta + hmm.insertEmission.logProb(seq, t, 2);
                    alpha[t + 2][s] = logSumExp(alpha[t + 2][s], lp);
                }

                // Option 3: emit 3 insert bytes (stay in I_k)
                if (t + 2 < L) {
                    const lp = a + logDelta + hmm.insertEmission.logProb(seq, t, 3);
                    alpha[t + 3][s] = logSumExp(alpha[t + 3][s], lp);
                }

                // Option 4: transition to M_{k+1} (non-emitting from I_k, emitting in M_{k+1})
                if (k < 8 && t < L) {
                    const mk = k + 1;
                    const logTransit = Math.log(1 - hmm.delta[k]);
                    const matchLP = hmm.matchLogProbs[mk - 1];

                    if (mk === 8) {
                        // M8: accept any byte (offset constraint handled in hmmForwardExact)
                        const lp = a + logTransit;
                        // M8 emits byte, then goes to I8
                        alpha[t + 1][insertIdx(mk)] = logSumExp(alpha[t + 1][insertIdx(mk)], lp);
                    } else if (matchLP) {
                        const b = seq[t];
                        if (matchLP.has(b)) {
                            const lp = a + logTransit + matchLP.get(b);
                            // M_{k+1} -> I_{k+1}
                            alpha[t + 1][insertIdx(mk)] = logSumExp(alpha[t + 1][insertIdx(mk)], lp);
                        }
                    }
                }

                // Option 5: if k == 8, transition to END (non-emitting)
                if (k === 8) {
                    const logTransit = Math.log(1 - hmm.delta[k]);
                    alpha[t][END_STATE] = logSumExp(alpha[t][END_STATE], a + logTransit);
                }
            }
        }
    }

    return alpha[L][END_STATE];
}

/**
 * Compute log P(seq | HMM) with exact branch-offset constraint.
 *
 * @param {ProfileHMM} hmm
 * @param {Uint8Array} seq
 * @returns {number} log P(seq | HMM) (natural log)
 */
export function hmmForwardExact(hmm, seq) {
    const L = seq.length;
    if (L < 8) return -Infinity;

    // Find all possible M1 positions (where seq[t] == 0xB5)
    const m1Positions = [];
    for (let t = 0; t < L - 7; t++) {
        if (seq[t] === 0xB5) m1Positions.push(t);
    }
    if (m1Positions.length === 0) return -Infinity;

    // For each M1 position, run a constrained forward pass
    let totalLogProb = -Infinity;

    for (const m1Pos of m1Positions) {
        const logP = forwardWithM1(hmm, seq, m1Pos);
        totalLogProb = logSumExp(totalLogProb, logP);
    }

    return totalLogProb;
}

/**
 * Forward pass with M1 position fixed.
 * With M1 fixed, M8 position determines the branch offset.
 *
 * @param {ProfileHMM} hmm
 * @param {Uint8Array} seq
 * @param {number} m1Pos - position of M1 in the sequence
 * @returns {number} log P(seq | HMM, M1 at m1Pos)
 */
function forwardWithM1(hmm, seq, m1Pos) {
    const L = seq.length;

    // Phase 1: I0 emits positions 0..m1Pos-1
    let logPrefixProb = insertLogProb(hmm, 0, seq, 0, m1Pos);
    if (logPrefixProb === -Infinity) return -Infinity;

    // M1 at m1Pos: must be 0xB5
    if (seq[m1Pos] !== 0xB5) return -Infinity;
    // Transition I0 -> M1: prob (1 - delta_0)
    logPrefixProb += Math.log(1 - hmm.delta[0]);
    // M1 emission: log(1) = 0 (point mass)
    // M1 -> I1 (non-emitting)

    // Phase 2: Forward over I1 -> M2 -> I2 -> ... -> M8 -> I8
    // States in this sub-HMM: I_k for k=1..8
    // Index: k-1 (so I1=0, I2=1, ..., I8=7)
    const NSUB = 8; // I1..I8
    const subI = (k) => k - 1; // k=1..8 -> 0..7

    const pos0 = m1Pos + 1;
    const remaining = L - pos0;

    // alpha[t][s] where t is position offset from pos0, s is sub-state
    const alpha = [];
    for (let t = 0; t <= remaining; t++) {
        alpha.push(new Float64Array(NSUB).fill(-Infinity));
    }

    // Start at I1 at position pos0
    alpha[0][subI(1)] = logPrefixProb;

    for (let t = 0; t <= remaining; t++) {
        for (let s = 0; s < NSUB; s++) {
            if (alpha[t][s] === -Infinity) continue;
            const a = alpha[t][s];
            const k = s + 1; // insert state index (1..8)

            // Insert self-loop: emit 1, 2, or 3 bytes
            const logDelta = Math.log(hmm.delta[k]);
            const absPos = pos0 + t;

            if (t < remaining) {
                const lp = a + logDelta + hmm.insertEmission.logProb(seq, absPos, 1);
                alpha[t + 1][s] = logSumExp(alpha[t + 1][s], lp);
            }
            if (t + 1 < remaining) {
                const lp = a + logDelta + hmm.insertEmission.logProb(seq, absPos, 2);
                alpha[t + 2][s] = logSumExp(alpha[t + 2][s], lp);
            }
            if (t + 2 < remaining) {
                const lp = a + logDelta + hmm.insertEmission.logProb(seq, absPos, 3);
                alpha[t + 3][s] = logSumExp(alpha[t + 3][s], lp);
            }

            // Transition to M_{k+1} (if k < 8)
            if (k < 7 && t < remaining) {
                const mk1 = k + 1; // next match state
                const logTransit = Math.log(1 - hmm.delta[k]);
                const matchLP = hmm.matchLogProbs[mk1 - 1];
                const b = seq[absPos];
                if (matchLP && matchLP.has(b)) {
                    const lp = a + logTransit + matchLP.get(b);
                    // M_{k+1} -> I_{k+1}
                    alpha[t + 1][subI(k + 1)] = logSumExp(alpha[t + 1][subI(k + 1)], lp);
                }
            }

            // Handle I7 -> M8 transition (M8 = branch offset, deterministic)
            if (k === 7 && t < remaining) {
                const logTransit = Math.log(1 - hmm.delta[k]);
                const absT = pos0 + t;
                const expectedOffset = (-(absT - m1Pos + 1)) & 0xFF;
                if (seq[absT] === expectedOffset) {
                    const lp = a + logTransit;
                    alpha[t + 1][subI(8)] = logSumExp(alpha[t + 1][subI(8)], lp);
                }
            }
        }
    }

    // Terminal: I8 with prob (1 - delta_8)
    if (alpha[remaining][subI(8)] === -Infinity) return -Infinity;
    return alpha[remaining][subI(8)] + Math.log(1 - hmm.delta[8]);
}

/**
 * Compute log P of emitting `count` insert bytes from insert state k.
 *
 * This uses the mixture model: each "insert event" consumes 1, 2, or 3 bytes.
 * Multiple insert events are independent, each weighted by delta_k.
 *
 * We enumerate all ways to partition `count` bytes into events of size 1, 2, or 3.
 * For short counts this is tractable. For longer counts we use dynamic programming.
 *
 * @param {ProfileHMM} hmm
 * @param {number} k - insert state index (0..8)
 * @param {Uint8Array} seq
 * @param {number} start - start position in seq
 * @param {number} count - number of bytes to emit
 * @returns {number} log probability (natural log)
 */
function insertLogProb(hmm, k, seq, start, count) {
    if (count === 0) return 0; // log(1)

    const logDelta = Math.log(hmm.delta[k]);
    const ie = hmm.insertEmission;

    // DP: dp[i] = log P(emitting bytes start..start+i-1 as insert events)
    const dp = new Float64Array(count + 1).fill(-Infinity);
    dp[0] = 0;

    for (let i = 0; i < count; i++) {
        if (dp[i] === -Infinity) continue;

        // Try consuming 1 byte
        if (i + 1 <= count) {
            const lp = dp[i] + logDelta + ie.logProb(seq, start + i, 1);
            dp[i + 1] = logSumExp(dp[i + 1], lp);
        }

        // Try consuming 2 bytes
        if (i + 2 <= count) {
            const lp = dp[i] + logDelta + ie.logProb(seq, start + i, 2);
            dp[i + 2] = logSumExp(dp[i + 2], lp);
        }

        // Try consuming 3 bytes
        if (i + 3 <= count) {
            const lp = dp[i] + logDelta + ie.logProb(seq, start + i, 3);
            dp[i + 3] = logSumExp(dp[i + 3], lp);
        }
    }

    return dp[count];
}

// ---- Log-odds scorer ----

/**
 * Score a sequence using the Bayesian log-odds ratio.
 * score = log2 P(seq|HMM) + 8*L  (since P(seq|null) = 2^{-8L})
 *
 * @param {ProfileHMM} hmm
 * @param {Uint8Array} seq
 * @returns {number} log-odds score in bits
 */
export function hmmScore(hmm, seq) {
    const logP = hmmForwardExact(hmm, seq);
    if (logP === -Infinity) return -Infinity;
    // Convert from natural log to log2
    const log2P = logP / Math.LN2;
    return log2P + 8 * seq.length;
}

// ---- Sampler ----

/**
 * Sample a sequence of length L from the HMM.
 *
 * Strategy: first sample how many insert bytes go between each pair of
 * match states (geometric distribution), then fill in the bytes.
 *
 * @param {ProfileHMM} hmm
 * @param {number} L - target sequence length
 * @param {Object} rng - PRNG with .real() method
 * @returns {Uint8Array|null} sampled sequence, or null if impossible
 */
export function hmmSample(hmm, L, rng) {
    if (L < 8) return null;

    const insertSlots = L - 8; // total insert bytes needed
    if (insertSlots < 0) return null;

    // Sample insert counts for each slot (I0..I8)
    // Must sum to insertSlots
    const insertCounts = sampleInsertCounts(hmm, insertSlots, rng);
    if (!insertCounts) return null;

    // Build the sequence
    const result = new Uint8Array(L);
    let pos = 0;

    // I0 inserts
    pos = fillInsertBytes(hmm, result, pos, insertCounts[0], rng);

    // M1: 0xB5
    const m1Pos = pos;
    result[pos++] = 0xB5;

    // I1 inserts, M2, I2 inserts, M3, ...
    for (let k = 1; k < 8; k++) {
        // I_k inserts
        pos = fillInsertBytes(hmm, result, pos, insertCounts[k], rng);

        // M_{k+1}
        const mk = k + 1;
        if (mk <= 7) {
            const allowed = MATCH_EMISSIONS[mk - 1];
            result[pos++] = allowed[Math.floor(rng.real() * allowed.length)];
        } else {
            // M8: branch offset (deterministic)
            const offset = (-(pos - m1Pos + 1)) & 0xFF;
            result[pos++] = offset;
        }
    }

    // I8 inserts
    pos = fillInsertBytes(hmm, result, pos, insertCounts[8], rng);

    if (pos !== L) return null; // shouldn't happen

    return result;
}

/**
 * Sample insert byte counts for 9 slots summing to total.
 *
 * @param {ProfileHMM} hmm
 * @param {number} total - total insert bytes
 * @param {Object} rng
 * @returns {number[]|null} array of 9 counts
 */
function sampleInsertCounts(hmm, total, rng) {
    const counts = new Array(9).fill(0);
    let remaining = total;

    for (let k = 0; k < 9; k++) {
        const maxHere = remaining;

        if (maxHere === 0) {
            counts[k] = 0;
            continue;
        }

        const d = hmm.delta[k];
        if (d === 0) {
            counts[k] = 0;
            continue;
        }

        // Sample geometric
        let n = 0;
        while (n < maxHere && rng.real() < d) {
            n++;
        }

        counts[k] = n;
        remaining -= n;
    }

    // If we have remaining bytes, distribute them to the last slot
    if (remaining > 0) {
        counts[8] += remaining;
    }

    return counts;
}

/**
 * Fill insert bytes into the result array using the mixture model.
 * Returns the new position.
 */
function fillInsertBytes(hmm, result, pos, count, rng) {
    let emitted = 0;
    while (emitted < count) {
        const remaining = count - emitted;
        const emission = hmm.insertEmission.sample(rng);
        const len = emission.length;

        if (len <= remaining) {
            for (let i = 0; i < len; i++) {
                result[pos++] = emission[i];
            }
            emitted += len;
        } else {
            // Emission doesn't fit — fall back to single-byte samples
            const b = _sampleFromLogDist(hmm.insertEmission.p1LogProbs, rng);
            result[pos++] = b;
            emitted += 1;
        }
    }
    return pos;
}

// ---- Parameter estimation ----

/**
 * Update HMM parameters from labeled examples.
 *
 * Updates:
 * - delta_k (insert self-loop probabilities)
 *
 * @param {ProfileHMM} hmm
 * @param {{ bytes: Uint8Array, reward: number }[]} examples
 * @param {Object} [opts]
 * @param {number} [opts.alpha=0.1] - smoothing pseudocount
 */
export function hmmUpdateParams(hmm, examples, opts = {}) {
    const { alpha = 0.1 } = opts;

    // Count insert lengths for each slot across viable examples
    const insertCountSums = new Float64Array(9);
    const insertCountWeights = new Float64Array(9);

    for (const ex of examples) {
        const alignment = viterbiAlignment(hmm, ex.bytes);
        if (!alignment) continue;

        const weight = ex.reward;

        for (let k = 0; k < 9; k++) {
            const n = alignment.insertCounts[k];
            insertCountSums[k] += n * weight;
            insertCountWeights[k] += weight;
        }
    }

    // Update delta_k: delta = E[n] / (E[n] + 1) where E[n] is expected insert count
    for (let k = 0; k < 9; k++) {
        if (insertCountWeights[k] === 0) continue;
        const meanN = insertCountSums[k] / insertCountWeights[k];
        const smoothedMean = (meanN + alpha) / (1 + 2 * alpha);
        hmm.delta[k] = Math.max(0.01, Math.min(0.95, smoothedMean / (smoothedMean + 1)));
    }
}

/**
 * Find the best alignment (Viterbi) of a sequence to the HMM.
 * Returns the insert counts for each slot.
 *
 * @param {ProfileHMM} hmm
 * @param {Uint8Array} seq
 * @returns {{ insertCounts: number[], m1Pos: number, logProb: number, matchPositions: number[] }|null}
 */
export function viterbiAlignment(hmm, seq) {
    const L = seq.length;
    if (L < 8) return null;

    // Find all possible M1 positions
    const m1Positions = [];
    for (let t = 0; t < L - 7; t++) {
        if (seq[t] === 0xB5) m1Positions.push(t);
    }
    if (m1Positions.length === 0) return null;

    let bestAlignment = null;
    let bestLogProb = -Infinity;

    for (const m1Pos of m1Positions) {
        const result = viterbiWithM1(hmm, seq, m1Pos);
        if (result && result.logProb > bestLogProb) {
            bestLogProb = result.logProb;
            bestAlignment = result;
        }
    }

    return bestAlignment;
}

/**
 * Viterbi alignment with M1 position fixed.
 */
function viterbiWithM1(hmm, seq, m1Pos) {
    const L = seq.length;

    // Check M1
    if (seq[m1Pos] !== 0xB5) return null;

    // Find match positions greedily: M2..M7 must match, M8 must have correct offset
    const matchPositions = [m1Pos]; // M1
    const insertCounts = [m1Pos]; // I0 has m1Pos insert bytes before it

    // Verify I0 inserts are valid
    const i0LogP = insertLogProb(hmm, 0, seq, 0, m1Pos);
    if (i0LogP === -Infinity) return null;

    // Build candidate positions for M2..M8
    const matchCandidates = [];
    for (let mk = 2; mk <= 8; mk++) {
        const allowed = MATCH_EMISSIONS[mk - 1];
        const candidates = [];
        const startSearch = matchPositions[matchPositions.length - 1] + 1;

        if (allowed === null) {
            for (let t = startSearch; t < L; t++) {
                candidates.push(t);
            }
        } else {
            for (let t = startSearch; t < L; t++) {
                if (allowed.includes(seq[t])) candidates.push(t);
            }
        }
        matchCandidates.push(candidates);
    }

    // Use recursive search with pruning
    const bestResult = findBestMatchPositions(hmm, seq, m1Pos, matchPositions, matchCandidates, 0, L);
    return bestResult;
}

/**
 * Recursively find the best match positions for M2..M8.
 */
function findBestMatchPositions(hmm, seq, m1Pos, matchPositions, matchCandidates, depth, L) {
    if (depth === 7) {
        // All M2..M8 positioned. Compute full log-probability.
        return computeAlignmentLogProb(hmm, seq, m1Pos, matchPositions, L);
    }

    const candidates = matchCandidates[depth];
    const prevPos = matchPositions[matchPositions.length - 1];
    let bestResult = null;
    let bestLogProb = -Infinity;

    for (const cand of candidates) {
        if (cand <= prevPos) continue;
        const remainingMatches = 7 - depth - 1;
        if (L - cand - 1 < remainingMatches) continue;

        // For M8 (depth == 6), check offset constraint
        if (depth === 6) {
            const expectedOffset = (-(cand - m1Pos + 1)) & 0xFF;
            if (seq[cand] !== expectedOffset) continue;
        }

        matchPositions.push(cand);
        const result = findBestMatchPositions(hmm, seq, m1Pos, matchPositions, matchCandidates, depth + 1, L);
        if (result && result.logProb > bestLogProb) {
            bestLogProb = result.logProb;
            bestResult = result;
        }
        matchPositions.pop();
    }

    return bestResult;
}

/**
 * Compute log-probability for a fully specified alignment.
 */
function computeAlignmentLogProb(hmm, seq, m1Pos, matchPositions, L) {
    let logP = 0;

    // I0: positions 0..m1Pos-1
    const i0Len = m1Pos;
    logP += insertLogProb(hmm, 0, seq, 0, i0Len);
    if (logP === -Infinity) return null;
    logP += Math.log(1 - hmm.delta[0]); // transition out of I0

    const insertCounts = [i0Len];

    // For each M_k (k=1..8), add match emission + I_k inserts
    for (let k = 1; k <= 8; k++) {
        const mkPos = matchPositions[k - 1];
        const nextPos = k < 8 ? matchPositions[k] : L;

        // Match emission log-prob
        if (k < 8) {
            const matchLP = hmm.matchLogProbs[k - 1];
            if (matchLP) {
                const b = seq[mkPos];
                if (!matchLP.has(b)) return null;
                logP += matchLP.get(b);
            }
        }

        // I_k inserts
        let iStart, iLen;
        if (k < 8) {
            iStart = mkPos + 1;
            iLen = matchPositions[k] - mkPos - 1;
        } else {
            iStart = mkPos + 1;
            iLen = L - mkPos - 1;
        }
        insertCounts.push(iLen);

        if (iLen > 0) {
            logP += insertLogProb(hmm, k, seq, iStart, iLen);
            if (logP === -Infinity) return null;
        }
        logP += Math.log(1 - hmm.delta[k]); // transition out of I_k
    }

    return { insertCounts, m1Pos, logProb: logP, matchPositions: [...matchPositions] };
}

// ---- Importance sampling ----

/**
 * Importance sampling estimate of P(viable | length L).
 *
 * @param {ProfileHMM} hmm
 * @param {number} L - sequence length
 * @param {number} N - number of samples
 * @param {Function} simulateFn - async (Uint8Array) => { copied, spread }
 * @param {Object} rng - PRNG with .real()
 * @returns {Promise<Object>}
 */
export async function hmmImportanceSampling(hmm, L, N, simulateFn, rng) {
    const logUniform = -L * 8 * Math.LN2;

    let sumIW = 0;
    let sumIW2 = 0;
    let nViable = 0;
    let nSampled = 0;

    for (let i = 0; i < N; i++) {
        const bytes = hmmSample(hmm, L, rng);
        if (!bytes) continue;
        nSampled++;

        const sim = await simulateFn(bytes);
        const viable = sim.copied ? 1 : 0;
        nViable += viable;

        const logQ = hmmForwardExact(hmm, bytes);
        if (logQ === -Infinity) continue;

        const logIW = logUniform - logQ;
        const iw = Math.exp(logIW);

        sumIW += viable * iw;
        sumIW2 += iw * iw;
    }

    const pViableIS = nSampled > 0 ? sumIW / nSampled : 0;
    const beffIS = pViableIS > 0 ? -Math.log2(pViableIS) : Infinity;

    const viableRate = nSampled > 0 ? nViable / nSampled : 0;

    const ess = sumIW2 > 0 ? (sumIW * sumIW) / sumIW2 : 0;

    return {
        pViableIS,
        beffIS,
        nSampled,
        nViable,
        viableRate,
        ess: Math.min(N, ess),
    };
}

// ---- Exports for testing ----

export {
    InsertEmission,
    MATCH_EMISSIONS, SAFE_SINGLE, SAFE_TWO_BYTE_PREFIXES, RISKY_SINGLE,
    insertLogProb, logSumExp,
    NUM_STATES, END_STATE,
    insertIdx, matchIdx,
    forwardWithM1,
};
