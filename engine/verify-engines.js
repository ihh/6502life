/**
 * Cross-engine verification: runs N interrupts on both WASM and Sfotty
 * engines and compares storage byte-by-byte.
 *
 * Usage (Node.js with pkg-node):
 *   node engine/verify-engines.js [--size 8] [--seed 42] [--interrupts 500] [--randomize]
 *
 * Usage (as module):
 *   import { verifyEngines } from './verify-engines.js';
 *   const result = await verifyEngines({ size: 8, seed: 42, interrupts: 500 });
 */

import { BoardMemory } from '../board/memory.js';
import { BoardController } from '../board/controller.js';

/**
 * Run N interrupts on both WASM and Sfotty engines and compare state.
 *
 * @param {object} opts
 * @param {number} opts.size - Board dimension (default 8)
 * @param {number} opts.seed - RNG seed (default 42)
 * @param {number} opts.interrupts - Number of interrupts to run (default 500)
 * @param {boolean} opts.randomize - Randomize board before running (default false)
 * @param {number} opts.checkInterval - Compare storage every N interrupts (default 100)
 * @param {function} opts.loadWasm - Async function returning { WasmBoard }. Default: import from pkg-node.
 * @param {function} opts.onProgress - Called with { interrupt, totalInterrupts, diffs } at each check
 * @returns {Promise<VerifyResult>}
 *
 * @typedef {object} VerifyResult
 * @property {boolean} pass - True if engines match at every checkpoint
 * @property {number} interrupts - Total interrupts run
 * @property {number} jsCycles - Total CPU cycles (Sfotty)
 * @property {number} wasmCycles - Total CPU cycles (WASM)
 * @property {boolean} cyclesMatch - Whether total cycles match
 * @property {DiffEntry[]} diffs - Array of first-difference entries per checkpoint
 *
 * @typedef {object} DiffEntry
 * @property {number} interrupt - Interrupt number
 * @property {number} count - Number of byte differences
 * @property {number} firstAddr - First differing storage address
 * @property {number} jsVal - JS byte value at firstAddr
 * @property {number} wasmVal - WASM byte value at firstAddr
 */
export async function verifyEngines(opts = {}) {
    const {
        size = 8,
        seed = 42,
        interrupts = 500,
        randomize = false,
        checkInterval = 100,
        loadWasm,
        onProgress,
    } = opts;

    // Load WASM
    let WasmBoard;
    if (loadWasm) {
        ({ WasmBoard } = await loadWasm());
    } else {
        // Default: try pkg-node for Node.js
        ({ WasmBoard } = await import('../wasm/pkg-node/board6502_wasm.js'));
    }

    // Create both engines
    const jsMem = new BoardMemory(seed, size);
    const jsCtrl = new BoardController(jsMem);
    const wasmBoard = new WasmBoard(size, seed);

    // Optionally randomize
    if (randomize) {
        jsCtrl.randomize(() => jsMem.mt.int());
        wasmBoard.randomize();
    }

    const totalBytes = size * size * 1024;
    const diffs = [];
    let pass = true;

    for (let intr = 0; intr < interrupts; intr++) {
        jsCtrl.runToNextInterrupt();
        wasmBoard.run_to_next_interrupt();

        // Check at intervals and at the last interrupt
        if (intr % checkInterval === checkInterval - 1 || intr === interrupts - 1 || intr === 0) {
            let diffCount = 0;
            let firstAddr = -1;
            let jsVal = 0, wasmVal = 0;

            for (let i = 0; i < totalBytes; i++) {
                const jsByte = jsMem.storage[i];
                const wasmByte = wasmBoard.get_byte(i);
                if (jsByte !== wasmByte) {
                    if (firstAddr < 0) {
                        firstAddr = i;
                        jsVal = jsByte;
                        wasmVal = wasmByte;
                    }
                    diffCount++;
                }
            }

            if (diffCount > 0) {
                pass = false;
                diffs.push({ interrupt: intr, count: diffCount, firstAddr, jsVal, wasmVal });
            }

            if (onProgress) {
                onProgress({ interrupt: intr, totalInterrupts: interrupts, diffs: diffCount });
            }
        }
    }

    const jsCycles = jsCtrl.totalCycles;
    const wasmCycles = Number(wasmBoard.total_cycles());

    wasmBoard.free();

    return {
        pass: pass && jsCycles === wasmCycles,
        interrupts,
        jsCycles,
        wasmCycles,
        cyclesMatch: jsCycles === wasmCycles,
        diffs,
    };
}


// --- CLI entry point ---
const isMainModule = typeof process !== 'undefined'
    && process.argv[1]
    && (process.argv[1].endsWith('verify-engines.js') || process.argv[1].endsWith('verify-engines'));

if (isMainModule) {
    const args = process.argv.slice(2);
    const getArg = (name, def) => {
        const idx = args.indexOf(name);
        return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
    };
    const hasFlag = (name) => args.includes(name);

    const size = parseInt(getArg('--size', '8'));
    const seed = parseInt(getArg('--seed', '42'));
    const interrupts = parseInt(getArg('--interrupts', '500'));
    const randomize = hasFlag('--randomize');

    console.log(`Verifying engines: size=${size}, seed=${seed}, interrupts=${interrupts}, randomize=${randomize}`);

    verifyEngines({
        size,
        seed,
        interrupts,
        randomize,
        onProgress({ interrupt, totalInterrupts, diffs }) {
            const status = diffs === 0 ? 'PASS' : `FAIL (${diffs} diffs)`;
            console.log(`  interrupt ${interrupt + 1}/${totalInterrupts}: ${status}`);
        },
    }).then(result => {
        console.log(`\nResult: ${result.pass ? 'PASS' : 'FAIL'}`);
        console.log(`  JS cycles:   ${result.jsCycles}`);
        console.log(`  WASM cycles:  ${result.wasmCycles}`);
        console.log(`  Cycles match: ${result.cyclesMatch}`);
        if (result.diffs.length > 0) {
            console.log(`  First diff at interrupt ${result.diffs[0].interrupt}:`);
            const d = result.diffs[0];
            const cell = Math.floor(d.firstAddr / 1024);
            const offset = d.firstAddr % 1024;
            console.log(`    addr=${d.firstAddr} (cell ${cell}, offset 0x${offset.toString(16)}): JS=${d.jsVal} WASM=${d.wasmVal}`);
        }
        process.exit(result.pass ? 0 : 1);
    }).catch(err => {
        console.error('Verification failed:', err);
        process.exit(2);
    });
}
