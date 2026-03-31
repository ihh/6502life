import { describe, it, expect } from 'vitest';
import { simulateCandidate, quickReplicationCheck } from '../simulate.js';

// Canonical 8-byte replicator
const REP = new Uint8Array([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]);

describe('simulateCandidate', () => {
    it('canonical replicator copies to neighbors', async () => {
        const result = await simulateCandidate(REP, { passes: 100, seed: 42 });
        expect(result.copied).toBe(true);
        expect(result.fidelity).toBe(1.0);
        expect(result.spread).toBeGreaterThan(0);
    });

    it('canonical replicator has functional cells in census', async () => {
        const result = await simulateCandidate(REP, { passes: 100, seed: 42 });
        expect(result.functional).toBeGreaterThan(1);
    });

    it('random bytes do not replicate', async () => {
        const random = new Uint8Array([0x42, 0x13, 0x7F, 0x00, 0x99, 0xAB, 0xCD, 0xEF]);
        const result = await simulateCandidate(random, { passes: 50, seed: 42 });
        expect(result.copied).toBe(false);
        expect(result.fidelity).toBeLessThan(1.0);
    });

    it('all-NOPs do not replicate', async () => {
        const nops = new Uint8Array([0xEA, 0xEA, 0xEA, 0xEA, 0xEA, 0xEA, 0xEA, 0xEA]);
        const result = await simulateCandidate(nops, { passes: 50, seed: 42 });
        expect(result.copied).toBe(false);
    });

    it('BNE variant replicates', async () => {
        // Same as canonical but BNE instead of BCC
        const bne = new Uint8Array([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0xD0, 0xF8]);
        const result = await simulateCandidate(bne, { passes: 100, seed: 42 });
        expect(result.copied).toBe(true);
    });
});

describe('quickReplicationCheck', () => {
    it('canonical replicator passes', async () => {
        expect(await quickReplicationCheck(REP)).toBe(true);
    });

    it('random bytes fail', async () => {
        const random = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
        expect(await quickReplicationCheck(random)).toBe(false);
    });
});
