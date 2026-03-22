/**
 * WASM board engine wrapper — drop-in replacement for the JS BoardController.
 *
 * Usage:
 *   import { createWasmBoard } from './wasm-board.js';
 *   const board = await createWasmBoard(32, 42);
 *   board.randomize();
 *   board.runToNextInterrupt();
 *   const pixels = board.overviewPixelBuffer(); // Uint8ClampedArray
 */

let wasmModule = null;

async function ensureWasm() {
    if (!wasmModule) {
        const mod = await import('../pkg/board6502_wasm.js');
        await mod.default();
        wasmModule = mod;
    }
    return wasmModule;
}

/**
 * Create a WASM-backed board.
 * @param {number} size - Board dimension (cells per side)
 * @param {number} seed - RNG seed for deterministic simulation
 * @returns {Promise<WasmBoardWrapper>}
 */
export async function createWasmBoard(size = 32, seed = 42) {
    const { WasmBoard } = await ensureWasm();
    const inner = new WasmBoard(size, seed);

    return {
        /** @type {number} Board dimension */
        get size() { return inner.size(); },

        /** @type {number} Total storage bytes */
        get storageSize() { return inner.storage_size(); },

        /** @type {number} Total elapsed CPU cycles */
        get totalCycles() { return Number(inner.total_cycles()); },

        /** Fill all cells with random data */
        randomize() { inner.randomize(); },

        /** Run until next interrupt. Returns scheduler cycles. */
        runToNextInterrupt() { return inner.run_to_next_interrupt(); },

        /** Run N interrupts. Returns total scheduler cycles. */
        runInterrupts(count) { return Number(inner.run_interrupts(count)); },

        /** Get byte at absolute storage index */
        getByte(idx) { return inner.get_byte(idx); },

        /** Set byte at absolute storage index */
        setByte(idx, val) { inner.set_byte(idx, val); },

        /** Get last write time for cell */
        lastWriteTime(cellIdx) { return Number(inner.last_write_time(cellIdx)); },

        /** Get last move time for cell */
        lastMoveTime(cellIdx) { return Number(inner.last_move_time(cellIdx)); },

        /** Get RGBA pixel buffer for overview (1px per cell) */
        overviewPixelBuffer() {
            return new Uint8ClampedArray(inner.overview_pixel_buffer());
        },

        /** Write bytes into a cell */
        writeCellBytes(i, j, startByte, data) {
            inner.write_cell_bytes(i, j, startByte, data);
        },

        /** Read cell display name */
        cellName(i, j) { return inner.cell_name(i, j); },

        /** Free WASM memory */
        free() { inner.free(); },
    };
}
