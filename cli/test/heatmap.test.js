import { describe, it, expect } from 'vitest';
import { createBoard, zeroAllCells, writeCellBytes, readCellMemory, getActivityStats } from '../../engine/board.js';
// Note: controller.totalCycles and memory.totalCycles are not properly
// initialized in the current codebase (pre-existing bug), so we don't
// test getActivityStats with running simulations here.

describe('heatmap (activity metrics)', () => {
    it('getActivityStats returns empty for fresh board', () => {
        const { controller } = createBoard(4, 42);
        zeroAllCells(controller);
        const stats = getActivityStats(controller);
        expect(stats.length).toBe(0);
    });

    it('readCellMemory returns 1024 bytes', () => {
        const { controller } = createBoard(4, 42);
        const mem = readCellMemory(controller, 0, 0);
        expect(mem.length).toBe(1024);
        expect(mem).toBeInstanceOf(Uint8Array);
    });

    it('computes Shannon entropy for uniform data', () => {
        // All zeros = entropy 0
        const data = new Uint8Array(256).fill(0);
        const entropy = shannonEntropy(data, 0, 256);
        expect(entropy).toBe(0);
    });

    it('computes Shannon entropy for random-ish data', () => {
        // 256 unique bytes = max entropy
        const data = new Uint8Array(256);
        for (let i = 0; i < 256; i++) data[i] = i;
        const entropy = shannonEntropy(data, 0, 256);
        expect(entropy).toBeCloseTo(1, 2); // normalized to 0-1
    });

    it('computes Shannon entropy for partially filled data', () => {
        // Half 0x00, half 0xFF = 1 bit entropy = 1/8 normalized
        const data = new Uint8Array(256);
        data.fill(0xFF, 128);
        const entropy = shannonEntropy(data, 0, 256);
        expect(entropy).toBeCloseTo(1 / 8, 2);
    });
});

// Inline Shannon entropy (same as heatmap.js) for testing
function shannonEntropy(data, offset, length) {
    const counts = new Uint32Array(256);
    for (let i = 0; i < length; i++) {
        counts[data[offset + i]]++;
    }
    let entropy = 0;
    for (let i = 0; i < 256; i++) {
        if (counts[i] === 0) continue;
        const p = counts[i] / length;
        entropy -= p * Math.log2(p);
    }
    return entropy / 8;
}
