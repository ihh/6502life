/**
 * WASM board adapter — wraps WasmBoard to expose the same interface as
 * createBoard() returns: { memory, controller, visualizer }.
 *
 * Browser-only. Used by createBoardAsync() in engine/board.js.
 */

let wasmInit = null;
let wasmModule = null;

/**
 * Initialize the WASM module. Returns true if successful, false if unavailable.
 * Safe to call multiple times (idempotent).
 */
export async function initWasm() {
    if (wasmModule) return true;
    if (wasmInit === false) return false; // previous attempt failed
    try {
        const mod = await import('../wasm/pkg/board6502_wasm.js');
        await mod.default();
        wasmModule = mod;
        return true;
    } catch (e) {
        wasmInit = false;
        console.warn('WASM engine unavailable, will use Sfotty fallback:', e.message);
        return false;
    }
}

/**
 * Check if WASM is available (after initWasm has been called).
 */
export function isWasmAvailable() {
    return wasmModule !== null;
}

/**
 * Create a WASM-backed board that exposes the same interface as
 * { memory, controller, visualizer } from createBoard().
 *
 * Must call initWasm() first.
 */
export function createWasmBoardAdapter(size = 32, seed = 42, boardParams) {
    if (!wasmModule) throw new Error('WASM not initialized — call initWasm() first');

    const { WasmBoard } = wasmModule;
    let inner;
    if (boardParams) {
        inner = WasmBoard.new_with_params(
            size, seed,
            boardParams.pBitNoise ?? 1 / 2048,
            boardParams.pBrkFailure ?? 0,
            boardParams.magnetosensing ?? false,
            boardParams.implementsMove ?? true,
            boardParams.implementsCopy ?? true,
            boardParams.implementsSync ?? false,
            boardParams.implementsAsync ?? false,
        );
    } else {
        inner = new WasmBoard(size, seed);
    }

    const M = 1024; // bytes per cell
    const B = size;
    const totalCells = B * B;

    // Build lastWriteTime/lastMoveTime proxy arrays that read from WASM
    const lastWriteTimeProxy = new Proxy([], {
        get(target, prop) {
            if (typeof prop === 'string' && !isNaN(prop)) {
                return Number(inner.last_write_time(parseInt(prop)));
            }
            if (prop === 'length') return totalCells;
            return target[prop];
        }
    });

    const lastMoveTimeProxy = new Proxy([], {
        get(target, prop) {
            if (typeof prop === 'string' && !isNaN(prop)) {
                return Number(inner.last_move_time(parseInt(prop)));
            }
            if (prop === 'length') return totalCells;
            return target[prop];
        }
    });

    // Memory adapter — mimics BoardMemory interface
    const memory = {
        get B() { return B; },
        get M() { return M; },
        get storageSize() { return inner.storage_size(); },

        // Storage proxy — reads/writes go through WASM
        get storage() {
            return new Proxy(new Uint8Array(0), {
                get(target, prop) {
                    if (typeof prop === 'string' && !isNaN(prop)) {
                        return inner.get_byte(parseInt(prop));
                    }
                    if (prop === 'length') return inner.storage_size();
                    if (prop === 'fill') return (val) => {
                        // Used by zeroAllCells
                        const total = inner.storage_size();
                        for (let k = 0; k < total; k++) inner.set_byte(k, val);
                    };
                    return target[prop];
                },
                set(target, prop, value) {
                    if (typeof prop === 'string' && !isNaN(prop)) {
                        inner.set_byte(parseInt(prop), value);
                        return true;
                    }
                    return false;
                }
            });
        },

        getByte(idx) { return inner.get_byte(idx); },
        setByte(idx, val) { inner.set_byte(idx, val); },
        setByteWithoutUndo(idx, val) { inner.set_byte(idx, val); },

        ijbToByteIndex(i, j, b) {
            return ((i * B + j) * M) + b;
        },

        ijToCellIndex(i, j) {
            return i * B + j;
        },

        ijbFromByteIndex(addr) {
            const cellIdx = Math.floor(addr / M);
            const b = addr % M;
            const i = Math.floor(cellIdx / B);
            const j = cellIdx % B;
            return [i, j, b];
        },
    };

    // Controller adapter
    const controller = {
        memory,
        onBrkEvent: null,
        lastWriteTime: lastWriteTimeProxy,
        lastMoveTime: lastMoveTimeProxy,

        get totalCycles() { return Number(inner.total_cycles()); },

        readRegisters() { /* no-op: WASM handles internally */ },

        runToNextInterrupt() {
            const schedulerCycles = inner.run_to_next_interrupt();
            return { cpuCycles: schedulerCycles, schedulerCycles };
        },

        randomize(rng) {
            inner.randomize();
        },

        // Minimal sfotty stub — some callers check sfotty.crashed
        sfotty: {
            crashed: false,
        },

        // State serialization (not fully supported for WASM — returns storage snapshot)
        get state() {
            const total = inner.storage_size();
            const storage = new Uint8Array(total);
            for (let k = 0; k < total; k++) storage[k] = inner.get_byte(k);
            return {
                memory: { storage: Array.from(storage), B, M },
                totalCycles: Number(inner.total_cycles()),
                boardParams: {
                    pBitNoise: inner.get_p_bit_noise(),
                    pBrkFailure: inner.get_p_brk_failure(),
                    magnetosensing: inner.get_magnetosensing(),
                    implementsMove: inner.get_implements_move(),
                    implementsCopy: inner.get_implements_copy(),
                    implementsSync: inner.get_implements_sync(),
                    implementsAsync: inner.get_implements_async(),
                },
            };
        },

        // Free WASM resources
        free() { inner.free(); },
    };

    // Visualizer adapter
    const visualizer = {
        getOverviewPixelRGB(i, j) {
            // Returns packed RGB (R in low byte)
            const buf = inner.overview_pixel_buffer();
            const idx = (i * B + j) * 4;
            return buf[idx] | (buf[idx + 1] << 8) | (buf[idx + 2] << 16);
        },

        getCellName(i, j) {
            return inner.cell_name(i, j);
        },

        // Cache the overview buffer for batch rendering
        _overviewBuf: null,
        getOverviewPixelBuffer() {
            return inner.overview_pixel_buffer();
        },
    };

    return { memory, controller, visualizer, _wasmInner: inner };
}
