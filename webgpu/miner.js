/**
 * WebGPU DFA Miner: BLAKE3 → Turtle's Tiers → 18 DFAs on GPU.
 *
 * Scans batches of seeds in parallel. Each seed generates a full board
 * via BLAKE3, and 18 DFAs check each cell for replicator patterns.
 *
 * Usage:
 *   const miner = await WebGPUMiner.create({ boardSize: 64 });
 *   const hits = await miner.scanBatch(startSeed, batchSize);
 *   // hits: Uint32Array where 1 = seed has a DFA match
 */

// Build DFA tables in JS (matching jax6502/replicator_dfa.py exactly)
const N_STATES = 25;
const DEAD = 24;
const ACCEPT = 9;
const N_DFAS = 18;

// Instruction lengths (from replicator_dfa.py)
const ILEN = new Uint8Array(256).fill(1);
[0x09,0x29,0x49,0x69,0xA0,0xA2,0xA9,0xC0,0xC9,0xE0,0xE9,
 0x05,0x06,0x24,0x25,0x26,0x45,0x46,0x65,0x66,0x84,0x85,
 0x86,0xA4,0xA5,0xA6,0xC4,0xC5,0xC6,0xE4,0xE5,0xE6,
 0x15,0x16,0x35,0x36,0x55,0x56,0x75,0x76,0x94,0x95,
 0xB4,0xB5,0xD5,0xD6,0xF5,0xF6,0x96,0xB6,
 0x10,0x30,0x50,0x70,0x90,0xB0,0xD0,0xF0,
 0x01,0x21,0x41,0x61,0x81,0xA1,0xC1,0xE1,
 0x11,0x31,0x51,0x71,0x91,0xB1,0xD1,0xF1,
 0x80,0x82,0x89,0xC2,0xE2,0x04,0x44,0x64,
 0x14,0x34,0x54,0x74,0xD4,0xF4,
 0xA7,0xB7,0x87,0x97,0xC7,0xD7,0xC3,0xD3,
 0xE7,0xF7,0xE3,0xF3,0x07,0x17,0x03,0x13,
 0x27,0x37,0x23,0x33,0x47,0x57,0x43,0x53,
 0x67,0x77,0x63,0x73,0x0B,0x2B,0x4B,0x6B,
 0xAB,0x8B,0xCB,0xEB,0x00].forEach(op => ILEN[op] = 2);
[0x0D,0x0E,0x20,0x2C,0x2D,0x2E,0x4C,0x4D,0x4E,0x6C,
 0x6D,0x6E,0x8C,0x8D,0x8E,0xAC,0xAD,0xAE,0xCC,0xCD,
 0xCE,0xEC,0xED,0xEE,0x1D,0x1E,0x3D,0x3E,0x5D,0x5E,
 0x7D,0x7E,0x9D,0xBC,0xBD,0xDD,0xDE,0xFD,0xFE,
 0x19,0x39,0x59,0x79,0x99,0xB9,0xBE,0xD9,0xF9,
 0x0C,0x1C,0x3C,0x5C,0x7C,0xDC,0xFC,
 0x0F,0x1F,0x1B,0x2F,0x3F,0x3B,0x4F,0x5F,0x5B,
 0x6F,0x7F,0x7B,0xAF,0xBF,0xB3,0x8F,0x83,
 0xCF,0xDF,0xDB,0xEF,0xFF,0xFB,
 0x9F,0x93,0x9B,0x9C,0x9E,0xBB].forEach(op => ILEN[op] = 3);
[0x02,0x12,0x22,0x32,0x42,0x52,0x62,0x72,
 0x92,0xB2,0xD2,0xF2].forEach(op => ILEN[op] = 0);

const SAFE_1B = new Set([0xEA,0x1A,0x3A,0x5A,0x7A,0xDA,0xFA,0x08,0x48,0x58,0x78,0x9A,0xD8,0xF8,0x18,0xB8]);
const SAFE_2B = new Set([0x80,0x82,0x89,0xC2,0xE2,0x04,0x44,0x64,0x14,0x34,0x54,0x74,0xD4,0xF4]);
const SAFE_3B = new Set([0x0C,0x1C,0x3C,0x5C,0x7C,0xDC,0xFC]);
const BRANCH_OPS = new Set([0x90, 0x50]);
const VALID_OFFSETS = new Set(Array.from({length: 25}, (_, i) => 0xE0 + i)); // E0-F8

function buildOneDFA(coreBytes) {
    const [g1, g2, g3] = coreBytes;
    const T = new Int32Array(N_STATES * 256).fill(DEAD);

    function addInserts(wait, ins2b, ins3b_a, ins3b_b) {
        for (const b of SAFE_1B) T[wait * 256 + b] = wait;
        for (const b of SAFE_2B) T[wait * 256 + b] = ins2b;
        for (const b of SAFE_3B) T[wait * 256 + b] = ins3b_a;
        for (let b = 0; b < 256; b++) T[ins2b * 256 + b] = wait;
        for (let b = 0; b < 256; b++) T[ins3b_a * 256 + b] = ins3b_b;
        for (let b = 0; b < 256; b++) T[ins3b_b * 256 + b] = wait;
    }

    // State 0: WAIT_CORE1
    addInserts(0, 10, 11, 12);
    if (g1[1].length === 0) T[0 * 256 + g1[0]] = 3;
    else T[0 * 256 + g1[0]] = 1;

    // State 1: CORE1_OP1
    if (g1[1].length >= 1) T[1 * 256 + g1[1][0]] = g1[1].length >= 2 ? 2 : 3;
    // State 2: CORE1_OP2
    if (g1[1].length >= 2) T[2 * 256 + g1[1][1]] = 3;

    // State 3: WAIT_CORE2
    addInserts(3, 13, 14, 15);
    if (g2[1].length === 0) T[3 * 256 + g2[0]] = 6;
    else T[3 * 256 + g2[0]] = 4;

    // State 4: CORE2_OP1
    if (g2[1].length >= 1) T[4 * 256 + g2[1][0]] = g2[1].length >= 2 ? 5 : 6;
    // State 5: CORE2_OP2
    if (g2[1].length >= 2) T[5 * 256 + g2[1][1]] = 6;

    // State 6: WAIT_CORE3
    addInserts(6, 16, 17, 18);
    if (g3[1].length === 0) T[6 * 256 + g3[0]] = 7;
    else if (g3[1].length === 1) {
        T[6 * 256 + g3[0]] = 22;
        for (let b = 0; b < 256; b++) T[22 * 256 + b] = DEAD;
        T[22 * 256 + g3[1][0]] = 7;
    } else if (g3[1].length === 2) {
        T[6 * 256 + g3[0]] = 22;
        for (let b = 0; b < 256; b++) T[22 * 256 + b] = DEAD;
        T[22 * 256 + g3[1][0]] = 23;
        for (let b = 0; b < 256; b++) T[23 * 256 + b] = DEAD;
        T[23 * 256 + g3[1][1]] = 7;
    }

    // State 7: WAIT_BRANCH
    addInserts(7, 19, 20, 21);
    for (const br of BRANCH_OPS) T[7 * 256 + br] = 8;

    // State 8: WAIT_OFFSET
    for (const off of VALID_OFFSETS) T[8 * 256 + off] = ACCEPT;

    // ACCEPT absorbing
    for (let b = 0; b < 256; b++) T[ACCEPT * 256 + b] = ACCEPT;
    // DEAD absorbing
    for (let b = 0; b < 256; b++) T[DEAD * 256 + b] = DEAD;

    return T;
}

function buildAllDFAs() {
    const variants = {
        DEX:    [[0xB5, [0x00]], [0x9D, [0x00, 0x04]], [0xCA, []]],
        INX:    [[0xB5, [0x00]], [0x9D, [0x00, 0x04]], [0xE8, []]],
        DEY:    [[0xB7, [0x00]], [0x99, [0x00, 0x04]], [0x88, []]],
        INY:    [[0xB7, [0x00]], [0x99, [0x00, 0x04]], [0xC8, []]],
        INX3FF: [[0xB5, [0x00]], [0x9D, [0xFF, 0x03]], [0xE8, []]],
        INY3FF: [[0xB7, [0x00]], [0x99, [0xFF, 0x03]], [0xC8, []]],
    };

    const tables = [];
    for (const groups of Object.values(variants)) {
        for (let rot = 0; rot < 3; rot++) {
            const rotated = [0, 1, 2].map(i => groups[(rot + i) % 3]);
            tables.push(buildOneDFA(rotated));
        }
    }
    return tables;
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
        this.uniformBuffer = null; // set during scanBatch
    }

    static async create(opts = {}) {
        const boardSize = opts.boardSize || 64;
        const batchSize = opts.batchSize || 1024;

        if (!navigator.gpu) throw new Error('WebGPU not available');
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('No WebGPU adapter');
        const device = await adapter.requestDevice();

        // Load shader
        const shaderCode = await (await fetch('mine.wgsl')).text();
        const shaderModule = device.createShaderModule({ code: shaderCode });

        // Build DFA tables: [18][25][256] → flat u32 array
        const dfaTables = buildAllDFAs();
        const dfaFlat = new Uint32Array(N_DFAS * N_STATES * 256);
        for (let d = 0; d < N_DFAS; d++) {
            for (let s = 0; s < N_STATES; s++) {
                for (let b = 0; b < 256; b++) {
                    dfaFlat[d * N_STATES * 256 + s * 256 + b] = dfaTables[d][s * 256 + b];
                }
            }
        }

        // Build soup LUT: 65536 bytes → packed as u32[16384]
        const lutBytes = buildSoupLUT();
        const lutPacked = new Uint32Array(16384);
        for (let i = 0; i < 65536; i += 4) {
            lutPacked[i / 4] = lutBytes[i] | (lutBytes[i+1] << 8) |
                               (lutBytes[i+2] << 16) | (lutBytes[i+3] << 24);
        }

        // Create GPU buffers
        const uniformBuffer = device.createBuffer({
            size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const dfaBuffer = device.createBuffer({
            size: dfaFlat.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(dfaBuffer, 0, dfaFlat);
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
                { binding: 1, resource: { buffer: dfaBuffer } },
                { binding: 2, resource: { buffer: lutBuffer } },
                { binding: 3, resource: { buffer: hitsBuffer } },
            ],
        });

        const miner = new WebGPUMiner(device, pipeline, bindGroup, hitsBuffer, readBuffer, batchSize);
        miner.uniformBuffer = uniformBuffer;
        miner.boardSize = boardSize;
        return miner;
    }

    async scanBatch(seedBase, count) {
        count = Math.min(count, this.batchSize);

        // Write uniforms
        const uniforms = new Uint32Array([seedBase, this.boardSize, count, 0]);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

        // Dispatch
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.dispatchWorkgroups(Math.ceil(count / 64));
        pass.end();

        // Copy hits to readable buffer
        encoder.copyBufferToBuffer(this.hitsBuffer, 0, this.readBuffer, 0, count * 4);
        this.device.queue.submit([encoder.finish()]);

        // Read back
        await this.readBuffer.mapAsync(GPUMapMode.READ);
        const data = new Uint32Array(this.readBuffer.getMappedRange().slice(0));
        this.readBuffer.unmap();

        return data.subarray(0, count);
    }
}

// Export DFA builder for CPU fallback / testing
export { buildAllDFAs, buildSoupLUT, N_DFAS, N_STATES, ACCEPT, DEAD };
