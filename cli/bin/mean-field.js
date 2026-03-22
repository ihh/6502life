#!/usr/bin/env node

/**
 * Mean-field ODE model for 6502life cell population dynamics.
 *
 * Tracks three coarse-grained states based on the first two bytes of cell memory:
 *   D ("dead"):   byte[0]=00, byte[1]=00  →  BRK 0 loop (PC stuck at 0)
 *   B ("brk"):    byte[0]=00, byte[1]≠00  →  BRK n (swap/copy/noop), then PC=2
 *   A ("alive"):  byte[0]≠00              →  executing real opcodes
 *
 * Two mechanisms drive transitions:
 *   1. Noisy copy: a cell copies itself to a neighbor, flipping bits with
 *      per-bit probability ε (default 1/2048).  The noise channel replaces
 *      each bit with a uniform random bit independently (not a flip), so
 *      P(bit changes) = ε/2 regardless of its current value.
 *   2. Self-modification: executing code may write to bytes [0:1].
 *
 * The mean-field approximation assumes well-mixed populations (no spatial
 * correlations).  Time is measured in epochs (one epoch = N² interrupts =
 * each cell scheduled once on average).
 *
 * Usage:
 *   node cli/bin/mean-field.js [options]
 *
 * Options:
 *   --eps <float>        Per-bit noise rate (default 1/2048 ≈ 0.000488)
 *   --ra <float>         Copy rate for alive cells per scheduling (default 0.001)
 *   --crash <float>      Rate alive cells self-destruct to dead per scheduling (default 0.0001)
 *   --selfwrite <float>  Rate alive cells write non-zero to byte[0] (d/b→a via self-mod, default 0.0005)
 *   --epochs <int>       Number of epochs to simulate (default 10000)
 *   --dt <float>         Integration timestep in epochs (default 0.1)
 *   --d0 <float>         Initial dead fraction (default: from random bytes)
 *   --b0 <float>         Initial BRK-active fraction (default: from random bytes)
 *   --rbeff <float>      Effective BRK-active copy rate (default: 8/255, see --help)
 *   --sweep              Sweep over ra values and show steady states
 *   --json               Output as JSON
 *   --samples <int>      Number of time samples to output (default 200)
 */

// ── Argument parsing ──────────────────────────────────────────────────

function parseArgs(argv) {
    const args = {
        eps: 1 / 2048,
        ra: 0.001,        // alive cell copy rate per scheduling
        crash: 0.0001,    // alive → dead self-destruct rate
        selfwrite: 0.0005,// alive cell writes to own byte[0], potentially changing d/b→a
        epochs: 10000,
        dt: 0.1,
        d0: null,
        b0: null,
        rbeff: null,      // effective BRK-active copy rate (null = 8/255)
        sweep: false,
        json: false,
        samples: 200,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--eps')       args.eps       = parseFloat(argv[++i]);
        if (arg === '--ra')        args.ra        = parseFloat(argv[++i]);
        if (arg === '--crash')     args.crash     = parseFloat(argv[++i]);
        if (arg === '--selfwrite') args.selfwrite = parseFloat(argv[++i]);
        if (arg === '--epochs')    args.epochs    = parseInt(argv[++i]);
        if (arg === '--dt')        args.dt        = parseFloat(argv[++i]);
        if (arg === '--d0')        args.d0        = parseFloat(argv[++i]);
        if (arg === '--b0')        args.b0        = parseFloat(argv[++i]);
        if (arg === '--rbeff')     args.rbeff     = parseFloat(argv[++i]);
        if (arg === '--sweep')     args.sweep     = true;
        if (arg === '--json')      args.json      = true;
        if (arg === '--samples')   args.samples   = parseInt(argv[++i]);
    }
    return args;
}

// ── Noise transition matrix ───────────────────────────────────────────

/**
 * Compute the 3×3 transition matrix T[source][target] for the noisy copy
 * channel.  T[s][t] = probability that a copy of a cell in state s produces
 * a cell in state t.
 *
 * Noise model: each bit is independently replaced by a uniform random bit
 * with probability ε.  So P(bit changes) = ε/2 for either direction.
 *
 * P(zero byte stays zero)      = (1 - ε/2)^8
 * P(zero byte becomes non-zero) = 1 - (1 - ε/2)^8
 * P(non-zero byte becomes zero) ≈ (ε/2)^k for k set bits  (negligible for k≥1)
 */
function noiseTransitionMatrix(eps) {
    const halfEps = eps / 2;
    const pByteStaysZero = Math.pow(1 - halfEps, 8);
    const pByteBecomesNonZero = 1 - pByteStaysZero;

    // For non-zero → zero: average over all 255 non-zero byte values.
    // P(byte→0) = (ε/2)^popcount(byte) × (1-ε/2)^(8-popcount(byte))
    // Average over uniform distribution on {1,...,255}.
    let pNonZeroBecomesZero = 0;
    for (let v = 1; v <= 255; v++) {
        let k = 0;
        for (let bit = 0; bit < 8; bit++) if (v & (1 << bit)) k++;
        pNonZeroBecomesZero += Math.pow(halfEps, k) * Math.pow(1 - halfEps, 8 - k);
    }
    pNonZeroBecomesZero /= 255;  // average over non-zero bytes

    // T[source][target], indices: 0=D, 1=B, 2=A
    return {
        // Source D (00,00): both bytes start zero
        DD: pByteStaysZero * pByteStaysZero,
        DB: pByteStaysZero * pByteBecomesNonZero,
        DA: pByteBecomesNonZero,  // byte[0] becomes non-zero (byte[1] irrelevant)

        // Source B (00,xx): byte[0]=zero, byte[1]=non-zero
        BD: pByteStaysZero * pNonZeroBecomesZero,
        BB: pByteStaysZero * (1 - pNonZeroBecomesZero),
        BA: pByteBecomesNonZero,  // byte[0] becomes non-zero

        // Source A (xx,..): byte[0]=non-zero
        AD: pNonZeroBecomesZero * pNonZeroBecomesZero,   // both become zero (extremely rare)
        AB: pNonZeroBecomesZero * (1 - pNonZeroBecomesZero), // byte[0]→0, byte[1] stays non-zero
        AA: 1 - pNonZeroBecomesZero,  // byte[0] stays non-zero
    };
}

// ── Mean-field ODE system ─────────────────────────────────────────────

/**
 * Compute dd/dt, db/dt, da/dt.
 *
 * Per epoch, each cell is scheduled once.  When scheduled:
 *   - Dead cells: execute BRK 0, loop.  No copy.  No self-modification.
 *   - BRK-active cells: execute BRK n.
 *       Copy rate: r_b = 8/255 (prob operand ∈ [245,252])
 *       Swap rate: 244/255 (neutral in mean-field for fractions)
 *       After BRK n, PC=2 → subsequent schedulings run from PC=2
 *       (modeled via self-modification parameters)
 *   - Alive cells: execute real code.
 *       Copy rate: r_a (parameter)
 *       Self-destruct to D: σ_crash per scheduling
 *       Accidentally write to byte[0]: σ_selfwrite per scheduling
 *
 * Copy effects (per copy event):
 *   - Source cell unchanged (copies from self to neighbor)
 *   - Target cell overwritten: new state drawn from T[source→·]
 *   - Target cell was in some state drawn from (d,b,a) in mean-field
 *
 * Overwrite rate per cell per epoch:
 *   Each cell has 8 Moore neighbors. Each neighbor, when copying, targets
 *   one of its 8 neighbors (uniform over destinations in mean-field).
 *   So P(neighbor X overwrites me) = P(X copies) × 1/8.
 *   With 8 neighbors: overwrite rate = 8 × (avg copy rate) × (1/8) = R.
 *   where R = b × r_b + a × r_a.
 */
function derivatives(d, b, a, T, params) {
    const { ra, crash, selfwrite } = params;
    // BRK-active copy rate.  Naively 8/255 (prob byte[1] ∈ [245,252]),
    // but this only applies on the FIRST scheduling when PC=0.  After
    // that, PC=2 and the cell runs random code (effective rate ≈ r_a).
    // Use --rbeff to override.  Default 8/255 is the upper bound.
    const rb = params.rbeff ?? 8 / 255;

    // Total copy rate per cell per epoch (mean-field)
    const R = b * rb + a * ra;

    // Average copy-target distribution (what state does a copy produce?)
    // Weighted by source state and copy rate
    const copyWeight_b = (R > 0) ? (b * rb) / R : 0;
    const copyWeight_a = (R > 0) ? (a * ra) / R : 0;

    // Expected state of copy product:
    const copyToD = copyWeight_b * T.BD + copyWeight_a * T.AD;
    const copyToB = copyWeight_b * T.BB + copyWeight_a * T.AB;
    const copyToA = copyWeight_b * T.BA + copyWeight_a * T.AA;
    // (Dead cells never copy, so no D-source term)

    // ── Copy channel ──
    // Per epoch, each cell gets overwritten with probability R.
    // The overwritten cell leaves its old state, enters a new state drawn from copyTo*.
    // Net flow from copy: R × (copyToS - s) for each state s.
    const dd_copy = R * (copyToD - d);
    const db_copy = R * (copyToB - b);
    const da_copy = R * (copyToA - a);

    // ── Self-modification channel ──
    // Dead cells: no self-mod (BRK 0 loop)
    // BRK-active cells: after first BRK n, PC=2.  Most of the time the cell
    //   is running from random bytes.  Model: high probability of "crashing"
    //   back to expressing byte[0:1] state.  Since B cells have byte[0]=00,
    //   hitting BRK 0 at any (00,00) in their code resets PC=0 → dead.
    //   But they can also write to byte[0], becoming alive.
    //   For simplicity: B cells self-modify at same rates as A cells.
    // Alive cells:
    //   σ_crash: P(self-destruct to D per scheduling).  Happens when code
    //     writes 00 to both byte[0] and byte[1], or more commonly, when
    //     random execution eventually writes 00 00 to bytes [0:1].
    //   σ_selfwrite: P(code writes to byte[0] making it non-zero).  For cells
    //     already in A, this is a no-op.  For B cells, this transitions to A.
    //
    // Note: crash and selfwrite for B cells.  A B cell after its first
    // scheduling is effectively running random code from PC=2, similar to A.
    // We give B cells the same selfwrite rate (can transition B→A by writing
    // to byte[0]) and a crash rate (B→D by writing 00 to byte[1]).
    const b_to_a_selfmod = b * selfwrite;   // B writes non-zero to byte[0] → becomes A
    const b_to_d_selfmod = b * crash;       // B crashes: writes 00 to byte[1] → becomes D
    const a_to_d_selfmod = a * crash;       // A crashes: writes 00 00 to byte[0:1]
    const a_to_b_selfmod = a * crash * 0.1; // A writes 00 to byte[0] only (rare) → becomes B

    const dd_self = b_to_d_selfmod + a_to_d_selfmod;
    const db_self = -b_to_a_selfmod - b_to_d_selfmod + a_to_b_selfmod;
    const da_self = b_to_a_selfmod - a_to_d_selfmod - a_to_b_selfmod;

    return {
        dd: dd_copy + dd_self,
        db: db_copy + db_self,
        da: da_copy + da_self,
    };
}

// ── Integrator ────────────────────────────────────────────────────────

function integrate(params) {
    const T = noiseTransitionMatrix(params.eps);

    // Initial conditions: uniform random bytes
    // P(byte=0) = 1/256, so:
    //   d0 = (1/256)^2 ≈ 0.0000153
    //   b0 = (1/256)(255/256) ≈ 0.00389
    //   a0 = 255/256 ≈ 0.996
    let d = params.d0 ?? Math.pow(1 / 256, 2);
    let b = params.b0 ?? (1 / 256) * (255 / 256);
    let a = 1 - d - b;

    const { epochs, dt, samples } = params;
    const steps = Math.ceil(epochs / dt);
    const sampleEvery = Math.max(1, Math.floor(steps / samples));

    const trajectory = [];
    trajectory.push({ t: 0, d, b, a });

    for (let step = 1; step <= steps; step++) {
        const deriv = derivatives(d, b, a, T, params);

        // RK4 integration
        const k1d = deriv.dd, k1b = deriv.db, k1a = deriv.da;

        const d2 = d + 0.5 * dt * k1d, b2 = b + 0.5 * dt * k1b, a2 = a + 0.5 * dt * k1a;
        const deriv2 = derivatives(d2, b2, a2, T, params);
        const k2d = deriv2.dd, k2b = deriv2.db, k2a = deriv2.da;

        const d3 = d + 0.5 * dt * k2d, b3 = b + 0.5 * dt * k2b, a3 = a + 0.5 * dt * k2a;
        const deriv3 = derivatives(d3, b3, a3, T, params);
        const k3d = deriv3.dd, k3b = deriv3.db, k3a = deriv3.da;

        const d4 = d + dt * k3d, b4 = b + dt * k3b, a4 = a + dt * k3a;
        const deriv4 = derivatives(d4, b4, a4, T, params);
        const k4d = deriv4.dd, k4b = deriv4.db, k4a = deriv4.da;

        d += (dt / 6) * (k1d + 2 * k2d + 2 * k3d + k4d);
        b += (dt / 6) * (k1b + 2 * k2b + 2 * k3b + k4b);
        a += (dt / 6) * (k1a + 2 * k2a + 2 * k3a + k4a);

        // Clamp to valid probability simplex
        d = Math.max(0, d);
        b = Math.max(0, b);
        a = Math.max(0, a);
        const total = d + b + a;
        d /= total; b /= total; a /= total;

        if (step % sampleEvery === 0 || step === steps) {
            trajectory.push({ t: step * dt, d, b, a });
        }
    }

    return { trajectory, T, params };
}

// ── Sweep mode ────────────────────────────────────────────────────────

function sweep(params) {
    const raValues = [0, 0.0001, 0.0005, 0.001, 0.005, 0.01, 0.02, 0.03, 0.04, 0.05, 0.1, 0.2];
    const results = [];

    for (const ra of raValues) {
        const p = { ...params, ra, epochs: 50000, samples: 10 };
        const { trajectory } = integrate(p);
        const final = trajectory[trajectory.length - 1];
        results.push({ ra, d: final.d, b: final.b, a: final.a });
    }
    return results;
}

// ── Analytical steady state ───────────────────────────────────────────

/**
 * Attempt to find analytical steady state by setting derivatives to zero.
 * In general this requires numerical root-finding, but we can characterize
 * the qualitative behavior.
 */
function analyzeFixedPoints(T, params) {
    const notes = [];

    // Key insight: the noise transition matrix for ε=1/2048 is nearly identity.
    // T.BA ≈ T.DA ≈ 4ε ≈ 0.002 (rate zero bytes become non-zero)
    // T.AA ≈ 1 (alive copies stay alive)
    // T.BB ≈ 1-4ε (BRK copies stay BRK)
    //
    // So the copy channel creates a slow leak from D→A and B→A (rate ~4ε per copy),
    // while A→A copies are nearly perfect.  This means A is an attractor of the
    // copy channel.  The self-modification channel (crash) provides the counter-
    // balancing flow from A→D.

    notes.push(`Noise transition rates (ε = ${params.eps.toFixed(6)}):`);
    notes.push(`  T(D→D) = ${T.DD.toFixed(6)}  T(D→B) = ${T.DB.toFixed(6)}  T(D→A) = ${T.DA.toFixed(6)}`);
    notes.push(`  T(B→D) = ${T.BD.toExponential(3)}  T(B→B) = ${T.BB.toFixed(6)}  T(B→A) = ${T.BA.toFixed(6)}`);
    notes.push(`  T(A→D) = ${T.AD.toExponential(3)}  T(A→B) = ${T.AB.toExponential(3)}  T(A→A) = ${T.AA.toFixed(6)}`);
    notes.push('');
    notes.push('Key rates per copy event:');
    notes.push(`  P(zero byte → non-zero) = ${T.DA.toFixed(6)} ≈ 4ε`);
    notes.push(`  P(non-zero byte → zero) = ${(1 - T.AA).toExponential(3)} (averaged over byte values)`);
    notes.push(`  Asymmetry ratio: ${(T.DA / (1 - T.AA)).toFixed(1)}×`);
    notes.push('');

    // At steady state with no self-modification (crash=0, selfwrite=0):
    // The copy channel drives everything to A (since noise turns zeros into
    // non-zeros much faster than the reverse).  d* ≈ 0, b* ≈ 0, a* ≈ 1.
    //
    // With crash > 0: A cells die at rate σ_crash, creating D cells.
    // The balance is: R × T.DA × (1-a*) ≈ σ_crash × a* in steady state.
    // But since T.DA is tiny and crash is small, the steady state depends
    // sensitively on their ratio.

    if (params.crash > 0 && params.ra > 0) {
        // Rough steady-state estimate for a (ignoring b):
        // da/dt = 0:  R × (T_bar_A - a) - crash × a = 0
        // where R ≈ a × ra (alive cells dominate copying)
        // and T_bar_A ≈ T.AA ≈ 1
        // So: a × ra × (1 - a) ≈ crash × a
        //     ra × (1 - a) ≈ crash
        //     a* ≈ 1 - crash/ra
        const aStar = Math.max(0, 1 - params.crash / params.ra);
        notes.push(`Rough steady-state estimate (ignoring B, noise≈0):`);
        notes.push(`  a* ≈ 1 - σ_crash/r_a = 1 - ${params.crash}/${params.ra} = ${aStar.toFixed(6)}`);
        notes.push(`  d* ≈ ${(1 - aStar).toFixed(6)}`);
        notes.push(`  (valid when r_a >> σ_crash; actual a* is slightly lower due to noise leak to B)`);
    }

    return notes;
}

// ── Output formatting ─────────────────────────────────────────────────

function formatTrajectory(result) {
    const { trajectory, T, params } = result;
    const lines = [];

    lines.push('╔══════════════════════════════════════════════════════════════════╗');
    lines.push('║            Mean-Field Model: 6502life Cell Dynamics             ║');
    lines.push('╚══════════════════════════════════════════════════════════════════╝');
    lines.push('');
    lines.push('Parameters:');
    lines.push(`  ε (per-bit noise)     = ${params.eps.toFixed(6)} (1/${Math.round(1/params.eps)})`);
    const rb = params.rbeff ?? 8 / 255;
    lines.push(`  r_a (alive copy rate) = ${params.ra}`);
    lines.push(`  r_b (BRK copy rate)   = ${rb.toFixed(6)}${params.rbeff == null ? ' (default: 8/255)' : ' (custom)'}`);
    lines.push(`  σ_crash (A→D rate)    = ${params.crash}`);
    lines.push(`  σ_selfwrite (B→A)     = ${params.selfwrite}`);
    lines.push('');

    // Print analysis
    const analysis = analyzeFixedPoints(T, params);
    analysis.forEach(l => lines.push(l));
    lines.push('');

    // Print trajectory table
    lines.push('Trajectory (time in epochs):');
    lines.push('─'.repeat(66));
    lines.push('  epoch     │  D (dead)    │  B (brk)     │  A (alive)');
    lines.push('─'.repeat(66));

    // Select samples for compact display
    const displayPoints = [];
    const milestones = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
    for (const m of milestones) {
        const closest = trajectory.reduce((best, pt) =>
            Math.abs(pt.t - m) < Math.abs(best.t - m) ? pt : best
        );
        if (!displayPoints.length || displayPoints[displayPoints.length - 1].t !== closest.t) {
            displayPoints.push(closest);
        }
    }

    for (const pt of displayPoints) {
        if (pt.t > params.epochs) break;
        const tStr = pt.t.toFixed(0).padStart(8);
        const dStr = pt.d.toExponential(4).padStart(12);
        const bStr = pt.b.toExponential(4).padStart(12);
        const aStr = pt.a.toFixed(8).padStart(12);
        lines.push(`${tStr}   │${dStr}  │${bStr}  │${aStr}`);
    }
    lines.push('─'.repeat(66));
    lines.push('');

    // Steady state
    const final = trajectory[trajectory.length - 1];
    lines.push('Final state:');
    lines.push(`  D = ${final.d.toExponential(6)}  (${(final.d * 100).toFixed(4)}%)`);
    lines.push(`  B = ${final.b.toExponential(6)}  (${(final.b * 100).toFixed(4)}%)`);
    lines.push(`  A = ${final.a.toFixed(8)}         (${(final.a * 100).toFixed(4)}%)`);

    // Characteristic times
    lines.push('');
    lines.push('Characteristic times (epochs):');
    // Time for D to halve (from initial)
    const dHalf = trajectory.find(pt => pt.d < trajectory[0].d / 2);
    if (dHalf) lines.push(`  D half-life: ~${dHalf.t.toFixed(0)} epochs`);
    // Time for B to halve
    const bHalf = trajectory.find(pt => pt.b < trajectory[0].b / 2);
    if (bHalf) lines.push(`  B half-life: ~${bHalf.t.toFixed(0)} epochs`);
    // Time for A to reach 99% of final value
    const aTarget = 0.99 * final.a;
    const a99 = trajectory.find(pt => pt.a >= aTarget);
    if (a99) lines.push(`  A reaches 99% of steady state: ~${a99.t.toFixed(0)} epochs`);

    return lines.join('\n');
}

function formatSweep(results) {
    const lines = [];
    lines.push('╔══════════════════════════════════════════════════════════════════╗');
    lines.push('║         Parameter Sweep: Steady State vs Copy Rate (r_a)       ║');
    lines.push('╚══════════════════════════════════════════════════════════════════╝');
    lines.push('');
    lines.push('  r_a        │  D (dead)      │  B (brk)       │  A (alive)');
    lines.push('─'.repeat(66));

    for (const r of results) {
        const raStr = r.ra.toFixed(4).padStart(8);
        const dStr = (r.d * 100).toFixed(4).padStart(10) + '%';
        const bStr = (r.b * 100).toFixed(4).padStart(10) + '%';
        const aStr = (r.a * 100).toFixed(4).padStart(10) + '%';
        lines.push(`  ${raStr}   │  ${dStr}   │  ${bStr}   │  ${aStr}`);
    }
    lines.push('─'.repeat(66));
    lines.push('');
    lines.push('Note: r_a = 0 means alive cells never copy.  As r_a increases,');
    lines.push('alive cells spread more aggressively, reducing D and B fractions.');
    lines.push(`(σ_crash = ${results[0] ? '0.0001' : '?'}, ε = 1/2048)`);

    return lines.join('\n');
}

// ── Spark line (mini ASCII plot) ──────────────────────────────────────

function sparkLine(trajectory, key, width = 60) {
    const vals = trajectory.map(pt => pt[key]);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const range = max - min || 1;
    const blocks = ' ▁▂▃▄▅▆▇█';
    const step = Math.max(1, Math.floor(vals.length / width));
    let line = '';
    for (let i = 0; i < vals.length; i += step) {
        const idx = Math.floor(((vals[i] - min) / range) * (blocks.length - 1));
        line += blocks[idx];
    }
    return `  ${key.toUpperCase()}: ${min.toExponential(2)} ${line} ${max.toFixed(4)}`;
}

// ── Main ──────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

if (args.sweep) {
    const results = sweep(args);
    if (args.json) {
        console.log(JSON.stringify(results, null, 2));
    } else {
        console.log(formatSweep(results));
    }
} else {
    const result = integrate(args);
    if (args.json) {
        console.log(JSON.stringify({
            params: result.params,
            transitionMatrix: result.T,
            trajectory: result.trajectory,
        }, null, 2));
    } else {
        console.log(formatTrajectory(result));
        console.log('');
        console.log('Sparklines (time →):');
        console.log(sparkLine(result.trajectory, 'd'));
        console.log(sparkLine(result.trajectory, 'b'));
        console.log(sparkLine(result.trajectory, 'a'));
    }
}
