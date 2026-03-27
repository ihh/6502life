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

export class BareSim {
    constructor(device, pipeline, B, M, storageBuffer, opcodeBuffer, pairBuffer, budgetBuffer) {
        this.device = device;
        this.pipeline = pipeline;
        this.B = B;
        this.M = M;
        this.storageBuffer = storageBuffer;
        this.opcodeBuffer = opcodeBuffer;
        this.pairBuffer = pairBuffer;
        this.budgetBuffer = budgetBuffer;
        this.totalQuanta = 0;
    }

    static async create(B = 16, M = 1024) {
        if (!navigator.gpu) throw new Error('WebGPU not supported');
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('No GPU adapter found');
        const device = await adapter.requestDevice();

        // Load shader
        const shaderCode = await (await fetch('./cpu6502.wgsl')).text();
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

        // Pair indices buffer (N × 2 uint32)
        const pairBuffer = device.createBuffer({
            size: N * 2 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Cycle budgets buffer (N uint32)
        const budgetBuffer = device.createBuffer({
            size: N * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Initialize storage to zeros
        const zeros = new Uint8Array(totalBytes);
        device.queue.writeBuffer(storageBuffer, 0, zeros);

        return new BareSim(device, pipeline, B, M, storageBuffer, opcodeBuffer, pairBuffer, budgetBuffer);
    }

    writeCell(i, j, offset, data) {
        const base = (i * this.B + j) * this.M + offset;
        const bytes = new Uint8Array(data);
        this.device.queue.writeBuffer(this.storageBuffer, base, bytes);
    }

    async runPass() {
        const B = this.B, M = this.M;
        const N = (B * B) / 2;

        // Build checkerboard pairs (CPU-side, fast enough)
        const rv = Math.random() * 8 | 0;
        const tiling = rv & 1;
        const offsetI = (rv >> 1) & 1;
        const offsetJ = (rv >> 2) & 1;

        const pairs = new Uint32Array(N * 2);
        const budgets = new Uint32Array(N);
        let idx = 0;

        if (tiling === 0) {
            for (let k = 0; k < B / 2; k++) {
                for (let j = 0; j < B; j++) {
                    const role = Math.random() < 0.5 ? 0 : 1;
                    const i0 = (2 * k + offsetI) % B;
                    const i1 = (2 * k + 1 + offsetI) % B;
                    const jj = (j + offsetJ) % B;
                    const ci = role === 0 ? i0 : i1;
                    const ni = role === 0 ? i1 : i0;
                    pairs[idx * 2] = (ci * B + jj) * M;
                    pairs[idx * 2 + 1] = (ni * B + jj) * M;
                    // Budget: geometric-exponential
                    let r = Math.random() * 0x7FFFFFFF | 0;
                    let hl = 0;
                    while (hl < 32 && (r & 1)) { r >>= 1; hl++; }
                    budgets[idx] = Math.max(1, Math.ceil(16 * 177 * (hl + Math.random())));
                    idx++;
                }
            }
        } else {
            for (let i = 0; i < B; i++) {
                for (let k = 0; k < B / 2; k++) {
                    const role = Math.random() < 0.5 ? 0 : 1;
                    const ii = (i + offsetI) % B;
                    const j0 = (2 * k + offsetJ) % B;
                    const j1 = (2 * k + 1 + offsetJ) % B;
                    const cj = role === 0 ? j0 : j1;
                    const nj = role === 0 ? j1 : j0;
                    pairs[idx * 2] = (ii * B + cj) * M;
                    pairs[idx * 2 + 1] = (ii * B + nj) * M;
                    let r = Math.random() * 0x7FFFFFFF | 0;
                    let hl = 0;
                    while (hl < 32 && (r & 1)) { r >>= 1; hl++; }
                    budgets[idx] = Math.max(1, Math.ceil(16 * 177 * (hl + Math.random())));
                    idx++;
                }
            }
        }

        // Upload pairs and budgets
        this.device.queue.writeBuffer(this.pairBuffer, 0, pairs);
        this.device.queue.writeBuffer(this.budgetBuffer, 0, budgets);

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
        pass.dispatchWorkgroups(Math.ceil(N / 64)); // workgroup_size = 64
        pass.end();
        this.device.queue.submit([commandEncoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();

        this.totalQuanta += N;
    }

    async census() {
        const totalBytes = this.B * this.B * this.M;
        // Read storage back to CPU
        const readBuffer = this.device.createBuffer({
            size: totalBytes,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const commandEncoder = this.device.createCommandEncoder();
        commandEncoder.copyBufferToBuffer(this.storageBuffer, 0, readBuffer, 0, totalBytes);
        this.device.queue.submit([commandEncoder.finish()]);
        await readBuffer.mapAsync(GPUMapMode.READ);
        const storage = new Uint8Array(readBuffer.getMappedRange());

        let functional = 0;
        const loopSigs = {};
        const cellMap = new Uint8Array(this.B * this.B);
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
        }

        readBuffer.unmap();
        readBuffer.destroy();

        return {
            functional,
            total: this.B * this.B,
            loopVariants: Object.keys(loopSigs).length,
            topLoops: Object.entries(loopSigs).sort((a, b) => b[1] - a[1]).slice(0, 5),
            cellMap,
        };
    }

    destroy() {
        this.storageBuffer.destroy();
        this.opcodeBuffer.destroy();
        this.pairBuffer.destroy();
        this.budgetBuffer.destroy();
    }
}
