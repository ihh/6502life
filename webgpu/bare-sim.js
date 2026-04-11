/**
 * WebGPU bare sim host.
 * Runs the 6502 compute shader on GPU via Safari/Chrome WebGPU.
 *
 * Usage (in browser):
 *   import { BareSim } from './bare-sim.js';
 *   const sim = await BareSim.create(16); // 16×16 board
 *   sim.writeCell(0, 0, 0, [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]);
 *   sim.writeCell(0, 0, 0xF9, [0x00, 0x00]); // saved PC = 0
 *   sim.writeCell(0, 0, 0xFF, [0xFF]);        // saved S
 *   await sim.runPass();
 *   const census = await sim.census();
 */

import { buildOpcodeTable } from './opcode_table.js';
import { PRNG } from './prng.js';

export class BareSim {
    constructor(device, pipeline, B, M, storageBuffer, opcodeBuffer, pairBuffer, budgetBuffer, seed) {
        this.device = device;
        this.pipeline = pipeline;
        this.B = B;
        this.M = M;
        this.rng = new PRNG(seed || 42);
        this.storageBuffer = storageBuffer;
        this.opcodeBuffer = opcodeBuffer;
        this.pairBuffer = pairBuffer;
        this.budgetBuffer = budgetBuffer;
        this.totalQuanta = 0;
        // Shadow buffer for read-modify-write in writeCell
        this._storageSnapshot = new Uint8Array(B * B * M);
        // GPU census pipeline (lazy init)
        this._censusPipeline = null;
        this._censusBindGroup = null;
        this._censusUniformBuffer = null;
        this._censusHashBuffer = null;
        this._censusReadBuffer = null;
    }

    static async create(B = 16, M = 1024, opts = {}) {
        if (!navigator.gpu) throw new Error('WebGPU not supported');
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('No GPU adapter found');
        const device = await adapter.requestDevice();

        // Load shader
        const shaderCode = await (await fetch('./cpu6502.wgsl?v=' + Date.now())).text();
        const shaderModule = device.createShaderModule({ code: shaderCode });

        // Check for compilation errors
        const compilationInfo = await shaderModule.getCompilationInfo();
        for (const msg of compilationInfo.messages) {
            const prefix = msg.type === 'error' ? 'SHADER ERROR' : 'SHADER WARN';
            console.error(`${prefix} [${msg.lineNum}:${msg.linePos}]: ${msg.message}`);
            if (msg.type === 'error') {
                throw new Error(`Shader compile error at line ${msg.lineNum}: ${msg.message}`);
            }
        }

        // Create pipeline
        const pipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: shaderModule, entryPoint: 'main' },
        });

        const totalBytes = B * B * M;
        const N = (B * B) / 2; // pairs per pass

        // Board storage buffer (read-write)
        const storageBuffer = device.createBuffer({
            size: Math.ceil(totalBytes / 4) * 4, // u32-aligned
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        // Opcode table buffer (read-only)
        const opcodeTable = buildOpcodeTable();
        const opcodeBuffer = device.createBuffer({
            size: opcodeTable.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Int32Array(opcodeBuffer.getMappedRange()).set(opcodeTable);
        opcodeBuffer.unmap();

        // Pad buffer sizes to full workgroup (64 threads) so out-of-range
        // threads read zeros instead of going out of bounds.
        const WG = 32;
        const bufferN = Math.ceil(N / WG) * WG;

        // Pair indices buffer (bufferN × 2 uint32, zero-padded)
        const pairBuffer = device.createBuffer({
            size: bufferN * 2 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Cycle budgets buffer (bufferN uint32, zero-padded)
        const budgetBuffer = device.createBuffer({
            size: bufferN * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Initialize storage to zeros
        const zeros = new Uint8Array(totalBytes);
        device.queue.writeBuffer(storageBuffer, 0, zeros);

        return new BareSim(device, pipeline, B, M, storageBuffer, opcodeBuffer, pairBuffer, budgetBuffer, opts.seed);
    }

    writeCell(i, j, offset, data) {
        const base = (i * this.B + j) * this.M + offset;
        // Update shadow buffer (used by census/getCellView)
        if (this._storageSnapshot) {
            for (let k = 0; k < data.length; k++) this._storageSnapshot[base + k] = data[k];
        }
        // writeBuffer offset must be a multiple of 4 on some GPUs.
        // Align and do read-modify-write using the snapshot as source of truth.
        const alignedBase = base & ~3;
        const alignedEnd = ((base + data.length) + 3) & ~3;
        const alignedLen = alignedEnd - alignedBase;
        const buf = new Uint8Array(alignedLen);
        // Fill from snapshot (or zeros if no snapshot yet)
        if (this._storageSnapshot) {
            buf.set(this._storageSnapshot.subarray(alignedBase, alignedEnd));
        }
        // Patch in the new data
        for (let k = 0; k < data.length; k++) buf[base - alignedBase + k] = data[k];
        this.device.queue.writeBuffer(this.storageBuffer, alignedBase, buf);
    }

    async runPass() {
        const B = this.B, M = this.M;
        const N = (B * B) / 2;

        // Build checkerboard pairs (CPU-side, seeded PRNG)
        const rng = this.rng;
        const rv = rng.below(8);
        const tiling = rv & 1;
        const offsetI = (rv >> 1) & 1;
        const offsetJ = (rv >> 2) & 1;

        const pairs = new Uint32Array(N * 2);
        const budgets = new Uint32Array(N);
        let idx = 0;

        if (tiling === 0) {
            for (let k = 0; k < B / 2; k++) {
                for (let j = 0; j < B; j++) {
                    const role = rng.int() & 1;
                    const i0 = (2 * k + offsetI) % B;
                    const i1 = (2 * k + 1 + offsetI) % B;
                    const jj = (j + offsetJ) % B;
                    const ci = role === 0 ? i0 : i1;
                    const ni = role === 0 ? i1 : i0;
                    pairs[idx * 2] = (ci * B + jj) * M;
                    pairs[idx * 2 + 1] = (ni * B + jj) * M;
                    // Budget: geometric-exponential
                    let r = rng.int(); let hl = 0;
                    while (hl < 32 && (r & 1)) { r >>= 1; hl++; }
                    budgets[idx] = Math.max(1, Math.ceil(16 * 177 * (hl + rng.real())));
                    idx++;
                }
            }
        } else {
            for (let i = 0; i < B; i++) {
                for (let k = 0; k < B / 2; k++) {
                    const role = rng.int() & 1;
                    const ii = (i + offsetI) % B;
                    const j0 = (2 * k + offsetJ) % B;
                    const j1 = (2 * k + 1 + offsetJ) % B;
                    const cj = role === 0 ? j0 : j1;
                    const nj = role === 0 ? j1 : j0;
                    pairs[idx * 2] = (ii * B + cj) * M;
                    pairs[idx * 2 + 1] = (ii * B + nj) * M;
                    let r = rng.int(); let hl = 0;
                    while (hl < 32 && (r & 1)) { r >>= 1; hl++; }
                    budgets[idx] = Math.max(1, Math.ceil(16 * 177 * (hl + rng.real())));
                    idx++;
                }
            }
        }

        // Upload pairs and budgets, padded to full workgroup size.
        // Extra entries are zero (budget=0 makes shader skip execution).
        const WG = 32;
        const paddedN = Math.ceil(N / WG) * WG;
        const paddedPairs = new Uint32Array(paddedN * 2); // zero-filled
        paddedPairs.set(pairs);
        const paddedBudgets = new Uint32Array(paddedN); // zero-filled
        paddedBudgets.set(budgets);
        this.device.queue.writeBuffer(this.pairBuffer, 0, paddedPairs);
        this.device.queue.writeBuffer(this.budgetBuffer, 0, paddedBudgets);

        // Create bind group
        const bindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.opcodeBuffer } },
                { binding: 1, resource: { buffer: this.storageBuffer } },
                { binding: 2, resource: { buffer: this.pairBuffer } },
                { binding: 3, resource: { buffer: this.budgetBuffer } },
            ],
        });

        // Dispatch compute
        const commandEncoder = this.device.createCommandEncoder();
        const pass = commandEncoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(N / 32)); // workgroup_size = 32
        pass.end();
        this.device.queue.submit([commandEncoder.finish()]);
        // Don't await — GPU processes queue in order, so subsequent
        // writeBuffer/submit calls are safe without waiting. Avoiding
        // onSubmittedWorkDone fixes Safari where it can stall indefinitely.
        this.totalQuanta += N;
    }

    async census() {
        const totalBytes = this.B * this.B * this.M;
        // Reuse read buffer across census calls (avoid alloc/destroy overhead)
        if (!this._fullCensusReadBuf) {
            this._fullCensusReadBuf = this.device.createBuffer({
                size: totalBytes,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
        }
        const readBuffer = this._fullCensusReadBuf;
        const commandEncoder = this.device.createCommandEncoder();
        commandEncoder.copyBufferToBuffer(this.storageBuffer, 0, readBuffer, 0, totalBytes);
        this.device.queue.submit([commandEncoder.finish()]);
        await readBuffer.mapAsync(GPUMapMode.READ);
        const storage = new Uint8Array(readBuffer.getMappedRange());

        let functional = 0;
        const loopSigs = {};
        const cellMap = new Uint8Array(this.B * this.B);
        const cellChars = new Uint8Array(this.B * this.B);
        for (let ci = 0; ci < this.B * this.B; ci++) {
            const base = ci * this.M;
            const c = storage;
            if (c[base] === 0xB5 && c[base + 2] === 0x9D && c[base + 3] === 0x00 &&
                c[base + 4] === 0x04 &&
                (c[base + 5] === 0xE8 || c[base + 5] === 0xCA) &&
                [0xD0, 0x90, 0x50, 0x10, 0x30, 0xB0, 0x70].includes(c[base + 6])) {
                functional++;
                cellMap[ci] = 1;
                const sig = Array.from(storage.slice(base, base + 8))
                    .map(b => b.toString(16).padStart(2, '0')).join('');
                loopSigs[sig] = (loopSigs[sig] || 0) + 1;
            }
            // Hash non-volatile: page 0 ($00-$EF), page 2 ($200-$2FF), page 3 ($300-$3FF)
            let h = 5381;
            for (let k = 0; k < 0xF0; k++) h = ((h * 33) ^ c[base + k]) >>> 0;
            for (let k = 0x200; k < 0x400; k++) h = ((h * 33) ^ c[base + k]) >>> 0;
            cellChars[ci] = 33 + (h % 94);
        }

        // Copy snapshot BEFORE unmap (getMappedRange view is detached on unmap)
        this._storageSnapshot = new Uint8Array(storage.length);
        this._storageSnapshot.set(storage);

        readBuffer.unmap();

        return {
            functional,
            total: this.B * this.B,
            loopVariants: Object.keys(loopSigs).length,
            topLoops: Object.entries(loopSigs).sort((a, b) => b[1] - a[1]).slice(0, 5),
            cellMap, cellChars,
        };
    }

    /**
     * Fast GPU-side cell hash: returns Uint8Array[B*B] of per-cell hashes.
     * Only transfers B*B bytes (4KB for 64x64) instead of the full 4MB board.
     * Use for grid display every frame; use full census() less frequently.
     */
    async cellHashes() {
        const nCells = this.B * this.B;
        // Lazy-init the census compute pipeline
        if (!this._censusPipeline) {
            const code = await (await fetch('./census.wgsl?v=' + Date.now())).text();
            const mod = this.device.createShaderModule({ code });
            this._censusPipeline = this.device.createComputePipeline({
                layout: 'auto',
                compute: { module: mod, entryPoint: 'main' },
            });
            this._censusUniformBuffer = this.device.createBuffer({
                size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            // Output: one u32 per cell (only low byte matters)
            this._censusHashBuffer = this.device.createBuffer({
                size: nCells * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
            this._censusReadBuffer = this.device.createBuffer({
                size: nCells * 4,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            this._censusBindGroup = this.device.createBindGroup({
                layout: this._censusPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this._censusUniformBuffer } },
                    { binding: 1, resource: { buffer: this.storageBuffer } },
                    { binding: 2, resource: { buffer: this._censusHashBuffer } },
                ],
            });
        }
        // Write uniforms
        this.device.queue.writeBuffer(this._censusUniformBuffer, 0,
            new Uint32Array([nCells, this.M, 0, 0]));
        // Dispatch
        const enc = this.device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(this._censusPipeline);
        pass.setBindGroup(0, this._censusBindGroup);
        pass.dispatchWorkgroups(Math.ceil(nCells / 64));
        pass.end();
        enc.copyBufferToBuffer(this._censusHashBuffer, 0, this._censusReadBuffer, 0, nCells * 4);
        this.device.queue.submit([enc.finish()]);
        // Read back (only nCells*4 bytes = 16KB for 64x64, not 4MB)
        await this._censusReadBuffer.mapAsync(GPUMapMode.READ);
        const raw = new Uint32Array(this._censusReadBuffer.getMappedRange());
        const hashes = new Uint8Array(nCells);
        for (let i = 0; i < nCells; i++) hashes[i] = raw[i] & 0xFF;
        this._censusReadBuffer.unmap();
        return hashes;
    }

    getCellView(i, j) {
        if (!this._storageSnapshot) return null;
        const base = (i * this.B + j) * this.M;
        return {
            data: this._storageSnapshot.slice(base, base + this.M),
            writes: new Float32Array(this.M),  // no tracking in GPU mode
            fetches: new Float32Array(this.M),
        };
    }

    destroy() {
        this.storageBuffer.destroy();
        this.opcodeBuffer.destroy();
        this.pairBuffer.destroy();
        this.budgetBuffer.destroy();
    }
}
