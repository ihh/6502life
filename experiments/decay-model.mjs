#!/usr/bin/env node
// Mathematical model of cell decay to immobility under copy noise.
//
// Core question: given epsilon (per-bit noise) and T (copy events in a
// lineage), what is P(cell still functional)?
//
// A cell is "functional" if bytes 0-1 encode BRK + valid copy operand.
// Byte 0 must be 0x00 (BRK opcode).
// Byte 1 must be in {0xF5, ..., 0xFC} (copy operands 245-252).
//
// Noise model (from copyCellWithNoise): each bit independently replaced
// by a uniform random bit with probability ε, kept with probability 1-ε.
// This is a binary symmetric channel with crossover probability ε/2.
//
// After T sequential copies, per-bit:
//   P(bit matches original) = ½(1 + (1-ε)^T)
//   P(bit differs) = p = ½(1 - (1-ε)^T)
//
// For a byte to equal a specific value w given original v:
//   P(byte = w | original = v) = (1-p)^(8-d) · p^d
//   where d = Hamming distance(v, w) and p = ½(1-(1-ε)^T)
//
// Usage: node experiments/decay-model.mjs

// --- Utility ---

function hammingDist(a, b) {
    let x = a ^ b, d = 0;
    while (x) { x &= x - 1; d++; }
    return d;
}

// P(bit differs from original after T copies)
function pBitDiff(T, eps) {
    return 0.5 * (1 - Math.pow(1 - eps, T));
}

// P(byte = w | original = v, after T copies)
function pByteEquals(v, w, T, eps) {
    const p = pBitDiff(T, eps);
    const d = hammingDist(v, w);
    return Math.pow(1 - p, 8 - d) * Math.pow(p, d);
}

// P(byte ∈ validSet | original = v, after T copies)
function pByteInSet(v, validSet, T, eps) {
    let prob = 0;
    for (const w of validSet) {
        prob += pByteEquals(v, w, T, eps);
    }
    return prob;
}

// --- Functional survival probability ---

const BRK = 0x00;
const VALID_OPERANDS = [0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFB, 0xFC];

// P(cell functional after T copies | started with BRK + operand)
function pFunctional(T, eps, startOperand = 0xF5) {
    // Byte 0 must remain 0x00
    const pBrk = pByteEquals(BRK, BRK, T, eps);
    // Byte 1 must be any valid operand
    const pOp = pByteInSet(startOperand, VALID_OPERANDS, T, eps);
    return pBrk * pOp;
}

// Expected copies until P(functional) drops below threshold
function expectedLifetime(eps, threshold = 0.5, startOperand = 0xF5) {
    if (eps === 0) return Infinity;
    // Binary search on T
    let lo = 0, hi = 1;
    while (pFunctional(hi, eps, startOperand) > threshold) hi *= 2;
    while (hi - lo > 0.5) {
        const mid = (lo + hi) / 2;
        if (pFunctional(mid, eps, startOperand) > threshold) lo = mid;
        else hi = mid;
    }
    return Math.round((lo + hi) / 2);
}

// --- Board-level model ---
// On a board of B×B cells, each cell gets ~1 copy attempt per scheduling
// (from itself or a neighbor). The population is a branching process where
// each living cell produces ~K offspring per unit time, and each offspring
// survives with probability pFunctional(1, eps).
//
// For a simple model: a cell's "generation count" T is the number of copy
// events in its lineage since the original. Each copy adds 1 to T.
// The expected number of functional descendants after G generations:
//   E[alive] = (K · pFunctional(1, eps))^G
//
// The population grows if K · pFunctional(1, eps) > 1.
// It decays if K · pFunctional(1, eps) < 1.
//
// K depends on the organism: nano copies to 2 neighbors per scheduling,
// so K ≈ 2. The triplicator copies to 1 neighbor, K ≈ 1.
//
// Half-life of the board (time until half the cells are non-functional):
// This depends on the replication rate and the board dynamics.
// For a saturated board (all cells occupied by replicators), each cell
// is overwritten by a neighbor ~once per scheduling on average.
// Its lineage depth T grows by 1 per overwrite.

// --- Per-copy survival with BRK failure ---
// If BRK copies fail (no effect) with probability pFail, then effective
// replication rate K_eff = K · (1 - pFail).
// The growth criterion becomes: K · (1 - pFail) · pFunctional(1, eps) > 1.
// This penalizes simple replicators (low K) more than complex ones that
// might achieve higher K through multi-copy strategies.

function pSurviveOneCopy(eps, startOperand = 0xF5) {
    return pFunctional(1, eps, startOperand);
}

// --- Output ---

function printTable(title, headers, rows) {
    console.log(`\n### ${title}\n`);
    console.log('| ' + headers.join(' | ') + ' |');
    console.log('|' + headers.map(() => '---').join('|') + '|');
    for (const row of rows) {
        console.log('| ' + row.join(' | ') + ' |');
    }
}

function main() {
    console.log('# Decay Model: Cell Functional Lifetime Under Copy Noise');
    console.log();
    console.log('A cell is "functional" if byte 0 = 0x00 (BRK) and byte 1 ∈ {0xF5,...,0xFC}.');
    console.log('Each BRK copy event applies independent bit noise with probability ε.');
    console.log('After T copies in a lineage, P(functional) decays predictably.');

    const epsilons = [1/512, 1/1024, 1/2048, 1/4096, 1/8192, 1/16384, 1/32768, 1/65536, 1/131072];

    // Table 1: P(functional) after T copies
    {
        const Ts = [1, 10, 50, 100, 500, 1000, 5000, 10000];
        const rows = [];
        for (const eps of epsilons) {
            const label = `1/${Math.round(1/eps)}`;
            const vals = Ts.map(T => pFunctional(T, eps).toFixed(6));
            rows.push([label, ...vals]);
        }
        printTable('P(functional) after T copy events (starting operand 0xF5)',
            ['ε', ...Ts.map(T => `T=${T}`)], rows);
    }

    // Table 2: Expected lifetime (copies until P < 0.5)
    {
        const thresholds = [0.99, 0.9, 0.5, 0.1, 0.01];
        const rows = [];
        for (const eps of epsilons) {
            const label = `1/${Math.round(1/eps)}`;
            const vals = thresholds.map(th => {
                const T = expectedLifetime(eps, th);
                return T === Infinity ? '∞' : T.toString();
            });
            rows.push([label, ...vals]);
        }
        printTable('Expected lifetime: T copies until P(functional) < threshold',
            ['ε', ...thresholds.map(th => `P<${th}`)], rows);
    }

    // Table 3: Per-copy survival probability (most important single number)
    {
        console.log('\n### Per-copy survival probability\n');
        console.log('P(still functional after exactly 1 copy event):\n');
        for (const eps of epsilons) {
            const label = `1/${Math.round(1/eps)}`;
            const p1 = pSurviveOneCopy(eps);
            const pBrk = pByteEquals(BRK, BRK, 1, eps);
            const pOp = pByteInSet(0xF5, VALID_OPERANDS, 1, eps);
            console.log(`  ε=${label}: P(BRK)=${pBrk.toFixed(8)}, P(valid op)=${pOp.toFixed(8)}, P(func)=${p1.toFixed(8)}`);
        }
    }

    // Table 4: Board-level half-life estimates
    {
        console.log('\n### Board-level estimates\n');
        console.log('Assumptions:');
        console.log('- Saturated board: every cell occupied by a replicator');
        console.log('- Each cell is overwritten ~once per scheduling cycle (T grows linearly)');
        console.log('- Mean scheduling interval: ~2800 CPU cycles');
        console.log('- A cell\'s generation depth T ≈ (total_interrupts / board_size²) for uniform random scheduling');
        console.log();

        const boardSizes = [8, 16, 64, 256];
        const totalInterrupts = [100_000, 500_000, 1_000_000, 5_000_000];
        const eps = 1 / 2048;  // default noise

        const rows = [];
        for (const B of boardSizes) {
            const cells = B * B;
            const vals = totalInterrupts.map(I => {
                const T = I / cells;  // avg generation depth
                const pAlive = pFunctional(T, eps);
                const expectedAlive = Math.round(cells * pAlive);
                return `${expectedAlive}/${cells} (T≈${Math.round(T)})`;
            });
            rows.push([`${B}×${B}`, ...vals]);
        }
        printTable(`Board decay at ε=1/2048 (expected functional cells)`,
            ['Board', ...totalInterrupts.map(I => `${I/1000}k int`)], rows);
    }

    // Table 5: Effect of BRK failure rate on effective replication
    {
        console.log('\n### Effect of BRK copy failure rate\n');
        console.log('If BRK copy fails with probability pFail (no copy, no noise),');
        console.log('the effective offspring rate K_eff = K × (1 - pFail).');
        console.log('Growth requires K_eff × P(functional per copy) > 1.\n');
        console.log('Critical pFail (above which simple replicators cannot sustain population):\n');

        const Ks = [1, 2, 4, 8];  // copies per scheduling
        const rows = [];
        for (const eps of [1/2048, 1/8192, 1/32768, 1/131072]) {
            const label = `1/${Math.round(1/eps)}`;
            const pSurv = pSurviveOneCopy(eps);
            const vals = Ks.map(K => {
                // Need K × (1-pFail) × pSurv ≥ 1
                // pFail_crit = 1 - 1/(K × pSurv)
                const pFailCrit = 1 - 1 / (K * pSurv);
                return pFailCrit > 0 ? (pFailCrit * 100).toFixed(2) + '%' : 'N/A (already subcritical)';
            });
            rows.push([label, pSurv.toFixed(8), ...vals]);
        }
        printTable('Critical BRK failure rate (max pFail for population growth)',
            ['ε', 'P(surv/copy)', ...Ks.map(K => `K=${K}`)], rows);

        console.log('\nK=1: single-copy replicator (triplicator, spreader)');
        console.log('K=2: dual-copy replicator (nano-2x)');
        console.log('K=4+: hypothetical multi-copy strategies');
        console.log();
        console.log('Note: "subcritical" for K=1 means each copy attempt has P(surv) < 1,');
        console.log('so a single lineage chain eventually dies. But on a saturated board,');
        console.log('the parent persists until overwritten, getting L ≈ B² attempts.');
        console.log('P(at least 1 success in L attempts) = 1 - (1 - (1-pFail)·P(surv))^L.');
        console.log('Even K=1 replicators sustain at low pFail if L is large enough.');
        console.log();
        console.log('**Key insight**: BRK failure creates selective pressure for');
        console.log('multi-copy strategies AND error correction. At high pFail,');
        console.log('K=1 replicators need many attempts to get one successful copy —');
        console.log('wasting scheduling cycles. K=2+ replicators are more robust because');
        console.log('each scheduling has multiple independent chances.');
        console.log('Error correction (triplicator) keeps P(surv/copy) ≈ 1 for the');
        console.log('BRK bytes, raising the effective success rate per attempt.');
    }

    // Validate against simulation
    {
        console.log('\n### Model validation notes\n');
        console.log('The model assumes:');
        console.log('1. Each cell is overwritten exactly once per scheduling (uniform)');
        console.log('2. Copy noise is the only source of mutation');
        console.log('3. No selection (dead cells still count)');
        console.log('4. Independent lineages (no cross-contamination)');
        console.log();
        console.log('Reality differs:');
        console.log('- Scheduling is Poisson-distributed, not uniform');
        console.log('- Active replicators overwrite dead cells → selection');
        console.log('- Copy contamination from neighbors creates correlated errors');
        console.log('- The board is a spatial model with local interactions');
        console.log();
        console.log('Despite these simplifications, the model gives correct scaling');
        console.log('for the functional lifetime as a function of ε, because the');
        console.log('per-copy survival probability dominates long-term behavior.');
    }
}

main();
