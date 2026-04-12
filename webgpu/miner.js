/**
 * WebGPU Core Pattern Miner: BLAKE3 → Turtle's Tiers → 6-byte pattern scan.
 *
 * Scans batches of seeds for replicator core patterns (6-byte sequences).
 * CPU-side simulation verifies which hits are actually viable.
 *
 * Usage:
 *   const miner = await WebGPUMiner.create({ boardSize: 64 });
 *   const hits = await miner.scanBatch(startSeed, batchSize);
 *   // hits: Uint32Array where 1 = seed has a core pattern match
 */

// 6-byte core patterns for CPU-side matching (18 patterns: 6 variants × 3 rotations)
const CORE_PATTERNS = [
    // X, $0400: DEX rotations
    [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xCA],
    [0x9D, 0x00, 0x04, 0xCA, 0xB5, 0x00],
    [0xCA, 0xB5, 0x00, 0x9D, 0x00, 0x04],
    // X, $0400: INX rotations
    [0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8],
    [0x9D, 0x00, 0x04, 0xE8, 0xB5, 0x00],
    [0xE8, 0xB5, 0x00, 0x9D, 0x00, 0x04],
    // Y, $0400: DEY rotations
    [0xB7, 0x00, 0x99, 0x00, 0x04, 0x88],
    [0x99, 0x00, 0x04, 0x88, 0xB7, 0x00],
    [0x88, 0xB7, 0x00, 0x99, 0x00, 0x04],
    // Y, $0400: INY rotations
    [0xB7, 0x00, 0x99, 0x00, 0x04, 0xC8],
    [0x99, 0x00, 0x04, 0xC8, 0xB7, 0x00],
    [0xC8, 0xB7, 0x00, 0x99, 0x00, 0x04],
    // X, $03FF: INX rotations
    [0xB5, 0x00, 0x9D, 0xFF, 0x03, 0xE8],
    [0x9D, 0xFF, 0x03, 0xE8, 0xB5, 0x00],
    [0xE8, 0xB5, 0x00, 0x9D, 0xFF, 0x03],
    // Y, $03FF: INY rotations
    [0xB7, 0x00, 0x99, 0xFF, 0x03, 0xC8],
    [0x99, 0xFF, 0x03, 0xC8, 0xB7, 0x00],
    [0xC8, 0xB7, 0x00, 0x99, 0xFF, 0x03],
];

/**
 * Find a 6-byte core pattern in a byte array.
 * Returns { offset, patternIndex } or null.
 */
function findCorePattern(bytes, maxOffset = 18) {
    for (let off = 0; off <= maxOffset && off + 6 <= bytes.length; off++) {
        for (let p = 0; p < CORE_PATTERNS.length; p++) {
            const pat = CORE_PATTERNS[p];
            let match = true;
            for (let k = 0; k < 6; k++) {
                if (bytes[off + k] !== pat[k]) { match = false; break; }
            }
            if (match) return { offset: off, patternIndex: p };
        }
    }
    return null;
}

// Build the soup bias LUT (matching mine_turtles_tiers.py)
function buildSoupLUT() {
    const w = new Float64Array(256).fill(1);
    w[0]=400;w[4]=100;w[0xB5]=200;w[0x9D]=200;w[0xB7]=63;w[0x99]=63;
    w[0xCA]=200;w[0xE8]=40;w[0x88]=7;w[0xC8]=2;w[3]=5;w[0xFF]=5;
    for (const b of [0x10,0x30,0x50,0x70,0x90,0xB0,0xD0,0xF0]) w[b]=40;
    for (const b of [0xEA,0x1A,0x3A,0x5A,0x7A,0xDA,0xFA,0x08,0x48,0x58,0x78,0x9A,0xD8,0xF8,
                     0x18,0x38,0xB8,0xA8,0xAA,0xBA,0x98,0x8A,0x68,0x80,0x82,0x89,0xC2,0xE2,
                     0x44,0x64,0x14,0x34,0x54,0x74,0xD4,0xF4,0xA0,0xA2,0xA9,
                     0x0C,0x1C,0x3C,0x5C,0x7C,0xDC,0xFC]) if(w[b]<11)w[b]=11;
    const total = w.reduce((a,b)=>a+b,0);
    const cdf = new Float64Array(256); let c=0;
    for (let i=0;i<256;i++){c+=w[i]/total;cdf[i]=c;}
    const lut = new Uint8Array(65536); let bi=0;
    for (let i=0;i<65536;i++){while(bi<255&&cdf[bi]<(i+0.5)/65536)bi++;lut[i]=bi;}
    return lut;
}

export class WebGPUMiner {
    constructor(device, pipeline, bindGroup, hitsBuffer, readBuffer, batchSize) {
        this.device = device;
        this.pipeline = pipeline;
        this.bindGroup = bindGroup;
        this.hitsBuffer = hitsBuffer;
        this.readBuffer = readBuffer;
        this.batchSize = batchSize;
        this.uniformBuffer = null;
    }

    static async create(opts = {}) {
        const boardSize = opts.boardSize || 64;
        const batchSize = opts.batchSize || 1024;

        if (!navigator.gpu) throw new Error('WebGPU not available');
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('No WebGPU adapter');
        const device = await adapter.requestDevice();

        const shaderCode = await (await fetch('mine.wgsl')).text();
        const shaderModule = device.createShaderModule({ code: shaderCode });
        const compilationInfo = await shaderModule.getCompilationInfo();
        for (const msg of compilationInfo.messages) {
            console[msg.type === 'error' ? 'error' : 'warn'](
                `[mine.wgsl ${msg.type}] line ${msg.lineNum}: ${msg.message}`);
        }

        // Build soup LUT: 65536 bytes → packed as u32[16384]
        const lutBytes = buildSoupLUT();
        const lutPacked = new Uint32Array(16384);
        for (let i = 0; i < 65536; i += 4) {
            lutPacked[i / 4] = lutBytes[i] | (lutBytes[i+1] << 8) |
                               (lutBytes[i+2] << 16) | (lutBytes[i+3] << 24);
        }

        // Create GPU buffers (3 bindings: uniforms, soup LUT, hits)
        const uniformBuffer = device.createBuffer({
            size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const lutBuffer = device.createBuffer({
            size: lutPacked.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(lutBuffer, 0, lutPacked);
        const hitsBuffer = device.createBuffer({
            size: batchSize * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const readBuffer = device.createBuffer({
            size: batchSize * 4,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

        const pipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: shaderModule, entryPoint: 'main' },
        });

        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: 1, resource: { buffer: lutBuffer } },
                { binding: 2, resource: { buffer: hitsBuffer } },
            ],
        });

        const miner = new WebGPUMiner(device, pipeline, bindGroup, hitsBuffer, readBuffer, batchSize);
        miner.uniformBuffer = uniformBuffer;
        miner.boardSize = boardSize;
        return miner;
    }

    async scanBatch(seedBase, count) {
        count = Math.min(count, this.batchSize);

        const uniforms = new Uint32Array([seedBase, this.boardSize, count, 0]);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.dispatchWorkgroups(Math.ceil(count / 64));
        pass.end();

        encoder.copyBufferToBuffer(this.hitsBuffer, 0, this.readBuffer, 0, count * 4);
        this.device.queue.submit([encoder.finish()]);

        await this.readBuffer.mapAsync(GPUMapMode.READ);
        const data = new Uint32Array(this.readBuffer.getMappedRange().slice(0));
        this.readBuffer.unmap();

        return data.subarray(0, count);
    }
}

export { buildSoupLUT, findCorePattern, CORE_PATTERNS };
