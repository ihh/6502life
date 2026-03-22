#!/usr/bin/env node

/**
 * Fit mean-field ODE model to actual 6502life simulation data.
 *
 * Runs a simulation, periodically censuses the D/B/A fractions (based on
 * bytes [0:1] of each cell), then fits the mean-field ODE parameters
 * (ra, crash, selfwrite, rbeff) via Nelder-Mead minimization of the
 * sum-of-squared residuals against the observed trajectory.
 *
 * Usage:
 *   node cli/bin/mean-field-fit.js [options]
 *
 * Options:
 *   --size <int>         Board size (default 16)
 *   --seed <int>         RNG seed (default 42)
 *   --interrupts <int>   Total interrupts to simulate (default 100000)
 *   --census <int>       Census every N interrupts (default 1000)
 *   --randomize          Randomize board (default: yes)
 *   --state <file>       Load initial state from file
 *   --asm <file>         Load assembly into --cell
 *   --cell <i,j>         Cell for --asm (default 0,0)
 *   --preset <name>      Load preset into --cell
 *   --mix <d,b,a>        Initialize board with given D/B/A fractions (e.g. 0.5,0.2,0.3)
 *   --eps <float>        Per-bit noise rate (default 1/2048)
 *   --maxiter <int>      Max optimizer iterations (default 2000)
 *   --json               Output results as JSON
 *   --save-census <file> Save raw census data to JSONL file
 */

import { readFileSync, writeFileSync } from 'fs';
import { createBoard, writeCellBytes, zeroAllCells } from '../../engine/board.js';
import { assemble } from '../../engine/assembler.js';

// ── Argument parsing ──────────────────────────────────────────────────

function parseArgs(argv) {
    const args = {
        size: 16,
        seed: 42,
        interrupts: 100000,
        census: 1000,
        randomize: true,
        state: null,
        asm: null,
        cell: [0, 0],
        preset: null,
        mix: null,     // [d, b, a] fractions for initial mix
        eps: 1 / 2048,
        maxiter: 2000,
        json: false,
        saveCensus: null,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--size')         args.size       = parseInt(argv[++i]);
        if (arg === '--seed')         args.seed       = parseInt(argv[++i]);
        if (arg === '--interrupts')   args.interrupts = parseInt(argv[++i]);
        if (arg === '--census')       args.census     = parseInt(argv[++i]);
        if (arg === '--no-randomize') args.randomize  = false;
        if (arg === '--state')        args.state      = argv[++i];
        if (arg === '--asm')          args.asm        = argv[++i];
        if (arg === '--cell') {
            const parts = argv[++i].split(',').map(Number);
            args.cell = [parts[0], parts[1]];
        }
        if (arg === '--preset')       args.preset     = argv[++i];
        if (arg === '--mix') {
            const parts = argv[++i].split(',').map(Number);
            args.mix = [parts[0], parts[1], parts[2]];
        }
        if (arg === '--eps')          args.eps        = parseFloat(argv[++i]);
        if (arg === '--maxiter')      args.maxiter    = parseInt(argv[++i]);
        if (arg === '--json')         args.json       = true;
        if (arg === '--save-census')  args.saveCensus = argv[++i];
    }
    return args;
}

// ── Census: count D/B/A fractions ─────────────────────────────────────

function census(controller) {
    const mem = controller.memory;
    const B = mem.B;
    const M = mem.M;
    const storage = mem.storage;
    const totalCells = B * B;

    let nD = 0, nB = 0, nA = 0;

    for (let idx = 0; idx < totalCells; idx++) {
        const base = idx * M;
        const byte0 = storage[base];
        const byte1 = storage[base + 1];

        if (byte0 === 0 && byte1 === 0) nD++;
        else if (byte0 === 0) nB++;
        else nA++;
    }

    return {
        d: nD / totalCells,
        b: nB / totalCells,
        a: nA / totalCells,
        nD, nB, nA, totalCells,
    };
}

// ── Load presets ──────────────────────────────────────────────────────

async function loadPreset(name) {
    const { getPreset, listPresets } = await import('../lib/terminal/presets.js');
    const p = getPreset(name);
    if (!p) {
        const available = listPresets().map(x => x.key).join(', ');
        throw new Error(`Unknown preset "${name}". Available: ${available}`);
    }
    return await assemble(p.source);
}

// ── Run simulation with periodic census ───────────────────────────────

async function runSimulation(args) {
    let controller;

    if (args.state) {
        const state = JSON.parse(readFileSync(args.state, 'utf-8'));
        const bSize = Math.sqrt(state.memory.storage.length / 1024) | 0;
        ({ controller } = createBoard(bSize, 1));
        controller.state = state;
    } else {
        ({ controller } = createBoard(args.size, args.seed));
        if (args.randomize) controller.randomize();
    }

    // Apply mix initialization: set fractions of cells to D/B/A states
    if (args.mix) {
        const [dFrac, bFrac, _aFrac] = args.mix;
        const mem = controller.memory;
        const B = mem.B;
        const M = mem.M;
        const totalCells = B * B;
        const nD = Math.round(dFrac * totalCells);
        const nB = Math.round(bFrac * totalCells);

        // Shuffle cell indices for random assignment
        const indices = Array.from({ length: totalCells }, (_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
        }

        // First nD cells become Dead (zero byte[0] and byte[1])
        for (let k = 0; k < nD; k++) {
            const base = indices[k] * M;
            mem.storage[base] = 0;
            mem.storage[base + 1] = 0;
        }
        // Next nB cells become BRK-active (byte[0]=0, byte[1]=random non-zero)
        for (let k = nD; k < nD + nB; k++) {
            const base = indices[k] * M;
            mem.storage[base] = 0;
            if (mem.storage[base + 1] === 0) mem.storage[base + 1] = 1 + Math.floor(Math.random() * 255);
        }
        // Remaining cells stay Alive (ensure byte[0] is non-zero)
        for (let k = nD + nB; k < totalCells; k++) {
            const base = indices[k] * M;
            if (mem.storage[base] === 0) mem.storage[base] = 1 + Math.floor(Math.random() * 255);
        }

        process.stderr.write(`Mixed board: ${nD} D, ${nB} B, ${totalCells - nD - nB} A cells\n`);
    }

    // Load assembly or preset
    if (args.asm || args.preset) {
        const bytes = args.asm
            ? await assemble(readFileSync(args.asm, 'utf-8'))
            : await loadPreset(args.preset);
        const [ci, cj] = args.cell;
        writeCellBytes(controller, ci, cj, 0, bytes);
        writeCellBytes(controller, ci, cj, 0x200, bytes);
        // Set register save area: PC=$0000, P=$04 (I flag set for SEI presets)
        writeCellBytes(controller, ci, cj, 0xF9, new Uint8Array([0x00, 0x00, 0x04]));
        process.stderr.write(`Loaded ${bytes.length} bytes into cell (${ci},${cj}) with PC=0, I=1\n`);
    }

    const totalCells = args.size * args.size;
    const totalInterrupts = args.interrupts;
    const censusEvery = args.census;
    const numCensuses = Math.floor(totalInterrupts / censusEvery);

    // Take initial census
    const observations = [];
    const c0 = census(controller);
    observations.push({ interrupt: 0, epoch: 0, ...c0 });

    process.stderr.write(`Running ${totalInterrupts} interrupts on ${args.size}×${args.size} board (${totalCells} cells)...\n`);

    for (let intr = 0; intr < totalInterrupts; intr++) {
        controller.runToNextInterrupt();

        if ((intr + 1) % censusEvery === 0) {
            const c = census(controller);
            const epoch = (intr + 1) / totalCells;
            observations.push({ interrupt: intr + 1, epoch, ...c });

            if ((intr + 1) % (censusEvery * 10) === 0) {
                process.stderr.write(
                    `  ${intr + 1}/${totalInterrupts} interrupts ` +
                    `(epoch ${epoch.toFixed(1)}): ` +
                    `D=${(c.d * 100).toFixed(2)}% ` +
                    `B=${(c.b * 100).toFixed(2)}% ` +
                    `A=${(c.a * 100).toFixed(2)}%\n`
                );
            }
        }
    }

    process.stderr.write(`Done. ${observations.length} census points collected.\n`);
    return observations;
}

// ── Noise transition matrix (same as mean-field.js) ───────────────────

function noiseTransitionMatrix(eps) {
    const halfEps = eps / 2;
    const pByteStaysZero = Math.pow(1 - halfEps, 8);
    const pByteBecomesNonZero = 1 - pByteStaysZero;

    let pNonZeroBecomesZero = 0;
    for (let v = 1; v <= 255; v++) {
        let k = 0;
        for (let bit = 0; bit < 8; bit++) if (v & (1 << bit)) k++;
        pNonZeroBecomesZero += Math.pow(halfEps, k) * Math.pow(1 - halfEps, 8 - k);
    }
    pNonZeroBecomesZero /= 255;

    return {
        DD: pByteStaysZero * pByteStaysZero,
        DB: pByteStaysZero * pByteBecomesNonZero,
        DA: pByteBecomesNonZero,
        BD: pByteStaysZero * pNonZeroBecomesZero,
        BB: pByteStaysZero * (1 - pNonZeroBecomesZero),
        BA: pByteBecomesNonZero,
        AD: pNonZeroBecomesZero * pNonZeroBecomesZero,
        AB: pNonZeroBecomesZero * (1 - pNonZeroBecomesZero),
        AA: 1 - pNonZeroBecomesZero,
    };
}

// ── Mean-field ODE derivatives (same as mean-field.js) ────────────────

function derivatives(d, b, a, T, ra, rb, crash, selfwrite) {
    const R = b * rb + a * ra;

    const copyWeight_b = (R > 0) ? (b * rb) / R : 0;
    const copyWeight_a = (R > 0) ? (a * ra) / R : 0;

    const copyToD = copyWeight_b * T.BD + copyWeight_a * T.AD;
    const copyToB = copyWeight_b * T.BB + copyWeight_a * T.AB;
    const copyToA = copyWeight_b * T.BA + copyWeight_a * T.AA;

    const dd_copy = R * (copyToD - d);
    const db_copy = R * (copyToB - b);
    const da_copy = R * (copyToA - a);

    const b_to_a_selfmod = b * selfwrite;
    const b_to_d_selfmod = b * crash;
    const a_to_d_selfmod = a * crash;
    const a_to_b_selfmod = a * crash * 0.1;

    return {
        dd: dd_copy + b_to_d_selfmod + a_to_d_selfmod,
        db: db_copy - b_to_a_selfmod - b_to_d_selfmod + a_to_b_selfmod,
        da: da_copy + b_to_a_selfmod - a_to_d_selfmod - a_to_b_selfmod,
    };
}

// ── Integrate ODE for given parameters ────────────────────────────────

function integrateODE(T, ra, rb, crash, selfwrite, d0, b0, epochs, dt) {
    let d = d0, b = b0, a = 1 - d - b;
    const steps = Math.ceil(epochs / dt);
    const trajectory = [{ t: 0, d, b, a }];

    for (let step = 1; step <= steps; step++) {
        // RK4
        const k1 = derivatives(d, b, a, T, ra, rb, crash, selfwrite);
        const d2 = d + 0.5*dt*k1.dd, b2 = b + 0.5*dt*k1.db, a2 = a + 0.5*dt*k1.da;
        const k2 = derivatives(d2, b2, a2, T, ra, rb, crash, selfwrite);
        const d3 = d + 0.5*dt*k2.dd, b3 = b + 0.5*dt*k2.db, a3 = a + 0.5*dt*k2.da;
        const k3 = derivatives(d3, b3, a3, T, ra, rb, crash, selfwrite);
        const d4 = d + dt*k3.dd, b4 = b + dt*k3.db, a4 = a + dt*k3.da;
        const k4 = derivatives(d4, b4, a4, T, ra, rb, crash, selfwrite);

        d += (dt/6) * (k1.dd + 2*k2.dd + 2*k3.dd + k4.dd);
        b += (dt/6) * (k1.db + 2*k2.db + 2*k3.db + k4.db);
        a += (dt/6) * (k1.da + 2*k2.da + 2*k3.da + k4.da);

        d = Math.max(0, d); b = Math.max(0, b); a = Math.max(0, a);
        const total = d + b + a;
        d /= total; b /= total; a /= total;

        trajectory.push({ t: step * dt, d, b, a });
    }

    return trajectory;
}

// ── Interpolate ODE trajectory at observation times ───────────────────

function interpolateAt(trajectory, times) {
    const result = [];
    let j = 0;
    for (const t of times) {
        while (j < trajectory.length - 1 && trajectory[j + 1].t < t) j++;
        if (j >= trajectory.length - 1) {
            result.push(trajectory[trajectory.length - 1]);
            continue;
        }
        const t0 = trajectory[j].t, t1 = trajectory[j + 1].t;
        const frac = (t1 > t0) ? (t - t0) / (t1 - t0) : 0;
        result.push({
            t,
            d: trajectory[j].d + frac * (trajectory[j + 1].d - trajectory[j].d),
            b: trajectory[j].b + frac * (trajectory[j + 1].b - trajectory[j].b),
            a: trajectory[j].a + frac * (trajectory[j + 1].a - trajectory[j].a),
        });
    }
    return result;
}

// ── Cost function: sum of squared residuals ───────────────────────────

function cost(params, observations, T, eps) {
    const [logRa, logRb, logCrash, logSelfwrite] = params;
    const ra = Math.exp(logRa);
    const rb = Math.exp(logRb);
    const crash = Math.exp(logCrash);
    const selfwrite = Math.exp(logSelfwrite);

    // Sanity bounds
    if (ra > 1 || rb > 1 || crash > 1 || selfwrite > 1) return 1e12;
    if (ra < 1e-10 || rb < 1e-10 || crash < 1e-10 || selfwrite < 1e-10) return 1e12;

    const d0 = observations[0].d;
    const b0 = observations[0].b;
    const maxEpoch = observations[observations.length - 1].epoch;
    const dt = Math.min(0.5, maxEpoch / 500);

    const traj = integrateODE(T, ra, rb, crash, selfwrite, d0, b0, maxEpoch * 1.01, dt);
    const times = observations.map(o => o.epoch);
    const predicted = interpolateAt(traj, times);

    let sse = 0;
    for (let i = 0; i < observations.length; i++) {
        const obs = observations[i];
        const pred = predicted[i];
        // Weight all three fractions equally
        sse += (obs.d - pred.d) ** 2;
        sse += (obs.b - pred.b) ** 2;
        sse += (obs.a - pred.a) ** 2;
    }

    return sse;
}

// ── Nelder-Mead optimizer ─────────────────────────────────────────────

function nelderMead(fn, x0, { maxIter = 2000, tol = 1e-10 } = {}) {
    const n = x0.length;
    const alpha = 1, gamma = 2, rho = 0.5, sigma = 0.5;

    // Initialize simplex
    let simplex = [{ x: [...x0], f: fn(x0) }];
    for (let i = 0; i < n; i++) {
        const xi = [...x0];
        xi[i] += 0.5;  // step size in log-space
        simplex.push({ x: xi, f: fn(xi) });
    }

    for (let iter = 0; iter < maxIter; iter++) {
        simplex.sort((a, b) => a.f - b.f);

        // Convergence check
        const fRange = simplex[n].f - simplex[0].f;
        if (fRange < tol) break;

        // Centroid of all but worst
        const centroid = Array(n).fill(0);
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) centroid[j] += simplex[i].x[j];
        }
        centroid.forEach((_, j) => centroid[j] /= n);

        // Reflection
        const xr = centroid.map((c, j) => c + alpha * (c - simplex[n].x[j]));
        const fr = fn(xr);

        if (fr < simplex[0].f) {
            // Expansion
            const xe = centroid.map((c, j) => c + gamma * (xr[j] - c));
            const fe = fn(xe);
            simplex[n] = fe < fr ? { x: xe, f: fe } : { x: xr, f: fr };
        } else if (fr < simplex[n - 1].f) {
            simplex[n] = { x: xr, f: fr };
        } else {
            // Contraction
            const xc = centroid.map((c, j) => c + rho * (simplex[n].x[j] - c));
            const fc = fn(xc);
            if (fc < simplex[n].f) {
                simplex[n] = { x: xc, f: fc };
            } else {
                // Shrink
                for (let i = 1; i <= n; i++) {
                    simplex[i].x = simplex[i].x.map((v, j) =>
                        simplex[0].x[j] + sigma * (v - simplex[0].x[j])
                    );
                    simplex[i].f = fn(simplex[i].x);
                }
            }
        }
    }

    simplex.sort((a, b) => a.f - b.f);
    return { x: simplex[0].x, f: simplex[0].f };
}

// ── Multi-start optimization ──────────────────────────────────────────

function fitParameters(observations, T, maxiter) {
    const costFn = (params) => cost(params, observations, T);

    // Initial guesses in log-space: [log(ra), log(rb), log(crash), log(selfwrite)]
    const starts = [
        [Math.log(0.001), Math.log(8/255), Math.log(0.0001), Math.log(0.0005)],
        [Math.log(0.01),  Math.log(0.01),  Math.log(0.001),  Math.log(0.001)],
        [Math.log(0.0001),Math.log(0.05),  Math.log(0.00001),Math.log(0.0001)],
        [Math.log(0.05),  Math.log(0.001), Math.log(0.01),   Math.log(0.01)],
    ];

    let bestResult = null;
    for (const x0 of starts) {
        const result = nelderMead(costFn, x0, { maxIter: maxiter });
        if (!bestResult || result.f < bestResult.f) {
            bestResult = result;
        }
    }

    const [logRa, logRb, logCrash, logSelfwrite] = bestResult.x;
    return {
        ra: Math.exp(logRa),
        rb: Math.exp(logRb),
        crash: Math.exp(logCrash),
        selfwrite: Math.exp(logSelfwrite),
        sse: bestResult.f,
        rmse: Math.sqrt(bestResult.f / (observations.length * 3)),
    };
}

// ── Compute R² ────────────────────────────────────────────────────────

function rSquared(observations, T, fit) {
    const d0 = observations[0].d, b0 = observations[0].b;
    const maxEpoch = observations[observations.length - 1].epoch;
    const dt = Math.min(0.5, maxEpoch / 500);
    const traj = integrateODE(T, fit.ra, fit.rb, fit.crash, fit.selfwrite, d0, b0, maxEpoch * 1.01, dt);
    const times = observations.map(o => o.epoch);
    const predicted = interpolateAt(traj, times);

    let ssRes = 0, ssTotD = 0, ssTotB = 0, ssTotA = 0;
    const meanD = observations.reduce((s, o) => s + o.d, 0) / observations.length;
    const meanB = observations.reduce((s, o) => s + o.b, 0) / observations.length;
    const meanA = observations.reduce((s, o) => s + o.a, 0) / observations.length;

    for (let i = 0; i < observations.length; i++) {
        ssRes += (observations[i].d - predicted[i].d) ** 2;
        ssRes += (observations[i].b - predicted[i].b) ** 2;
        ssRes += (observations[i].a - predicted[i].a) ** 2;
        ssTotD += (observations[i].d - meanD) ** 2;
        ssTotB += (observations[i].b - meanB) ** 2;
        ssTotA += (observations[i].a - meanA) ** 2;
    }
    const ssTot = ssTotD + ssTotB + ssTotA;
    return 1 - ssRes / ssTot;
}

// ── Format results ────────────────────────────────────────────────────

function formatResults(observations, fit, T, args) {
    const lines = [];

    lines.push('╔══════════════════════════════════════════════════════════════════╗');
    lines.push('║          Mean-Field Model Fit to Simulation Data                ║');
    lines.push('╚══════════════════════════════════════════════════════════════════╝');
    lines.push('');
    lines.push('Simulation:');
    lines.push(`  Board: ${args.size}×${args.size} (${args.size * args.size} cells), seed ${args.seed}`);
    lines.push(`  Interrupts: ${args.interrupts} (${(args.interrupts / (args.size * args.size)).toFixed(1)} epochs)`);
    lines.push(`  Census points: ${observations.length}`);
    lines.push('');

    lines.push('Fitted parameters:');
    lines.push(`  r_a (alive copy rate)    = ${fit.ra.toExponential(4)}`);
    lines.push(`  r_b (BRK copy rate)      = ${fit.rb.toExponential(4)}  (naive: ${(8/255).toFixed(4)})`);
    lines.push(`  σ_crash (A→D rate)       = ${fit.crash.toExponential(4)}`);
    lines.push(`  σ_selfwrite (B→A rate)   = ${fit.selfwrite.toExponential(4)}`);
    lines.push('');
    lines.push('Goodness of fit:');
    lines.push(`  RMSE = ${fit.rmse.toExponential(4)}`);
    const r2 = rSquared(observations, T, fit);
    lines.push(`  R²   = ${r2.toFixed(6)}`);
    lines.push('');

    // Key derived quantities
    lines.push('Derived quantities:');
    lines.push(`  r_a / r_b ratio = ${(fit.ra / fit.rb).toFixed(4)}  (>1 means A dominates)`);
    lines.push(`  r_a / σ_crash   = ${(fit.ra / fit.crash).toFixed(4)}  (>1 means A persists)`);
    const aStar = Math.max(0, 1 - fit.crash / fit.ra);
    lines.push(`  a* ≈ 1 - σ_crash/r_a = ${aStar.toFixed(4)}  (rough steady-state A fraction)`);
    lines.push('');

    // Comparison table: observed vs predicted
    const d0 = observations[0].d, b0 = observations[0].b;
    const maxEpoch = observations[observations.length - 1].epoch;
    const dt = Math.min(0.5, maxEpoch / 500);
    const traj = integrateODE(T, fit.ra, fit.rb, fit.crash, fit.selfwrite, d0, b0, maxEpoch * 1.01, dt);
    const times = observations.map(o => o.epoch);
    const predicted = interpolateAt(traj, times);

    lines.push('Observed vs Predicted:');
    lines.push('─'.repeat(82));
    lines.push('  epoch   │  D_obs    D_pred  │  B_obs    B_pred  │  A_obs    A_pred');
    lines.push('─'.repeat(82));

    // Show ~20 evenly spaced points
    const step = Math.max(1, Math.floor(observations.length / 20));
    for (let i = 0; i < observations.length; i += step) {
        const obs = observations[i];
        const pred = predicted[i];
        const epoch = obs.epoch.toFixed(1).padStart(7);
        const dObs = (obs.d * 100).toFixed(2).padStart(7);
        const dPrd = (pred.d * 100).toFixed(2).padStart(7);
        const bObs = (obs.b * 100).toFixed(2).padStart(7);
        const bPrd = (pred.b * 100).toFixed(2).padStart(7);
        const aObs = (obs.a * 100).toFixed(2).padStart(7);
        const aPrd = (pred.a * 100).toFixed(2).padStart(7);
        lines.push(`  ${epoch} │ ${dObs}% ${dPrd}% │ ${bObs}% ${bPrd}% │ ${aObs}% ${aPrd}%`);
    }
    // Always show last point
    if ((observations.length - 1) % step !== 0) {
        const i = observations.length - 1;
        const obs = observations[i];
        const pred = predicted[i];
        const epoch = obs.epoch.toFixed(1).padStart(7);
        const dObs = (obs.d * 100).toFixed(2).padStart(7);
        const dPrd = (pred.d * 100).toFixed(2).padStart(7);
        const bObs = (obs.b * 100).toFixed(2).padStart(7);
        const bPrd = (pred.b * 100).toFixed(2).padStart(7);
        const aObs = (obs.a * 100).toFixed(2).padStart(7);
        const aPrd = (pred.a * 100).toFixed(2).padStart(7);
        lines.push(`  ${epoch} │ ${dObs}% ${dPrd}% │ ${bObs}% ${bPrd}% │ ${aObs}% ${aPrd}%`);
    }
    lines.push('─'.repeat(82));

    return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const T = noiseTransitionMatrix(args.eps);

process.stderr.write('Phase 1: Running simulation...\n');
const observations = await runSimulation(args);

// Save census data if requested
if (args.saveCensus) {
    const lines = observations.map(o => JSON.stringify(o)).join('\n') + '\n';
    writeFileSync(args.saveCensus, lines);
    process.stderr.write(`Census data saved to ${args.saveCensus}\n`);
}

process.stderr.write('Phase 2: Fitting mean-field model...\n');
const fit = fitParameters(observations, T, args.maxiter);
process.stderr.write(`  Best fit: ra=${fit.ra.toExponential(3)}, rb=${fit.rb.toExponential(3)}, crash=${fit.crash.toExponential(3)}, selfwrite=${fit.selfwrite.toExponential(3)}\n`);
process.stderr.write(`  RMSE=${fit.rmse.toExponential(3)}\n`);

if (args.json) {
    console.log(JSON.stringify({
        simulation: { size: args.size, seed: args.seed, interrupts: args.interrupts },
        fit,
        r2: rSquared(observations, T, fit),
        observations: observations.map((o, i) => {
            const d0 = observations[0].d, b0 = observations[0].b;
            const maxEpoch = observations[observations.length - 1].epoch;
            const dt = Math.min(0.5, maxEpoch / 500);
            return { epoch: o.epoch, d_obs: o.d, b_obs: o.b, a_obs: o.a };
        }),
    }, null, 2));
} else {
    console.log(formatResults(observations, fit, T, args));
}
