import { describe, it, expect } from 'vitest';
import { executeShare, verifyShareInput, hashCell, attestationString } from '../share.js';
import { Board6502Engine } from '../engines/board6502.js';
import { readCellMemory } from '../../engine/board.js';

function makeEngine(seed = 42, size = 8) {
    const engine = new Board6502Engine();
    engine.init({ size, seed });
    return engine;
}

describe('share protocol', () => {
    it('swaps cells between two boards', () => {
        const a = makeEngine(42, 8);
        const b = makeEngine(99, 8);

        const cellA00 = readCellMemory(a.controller, 0, 0);
        const cellB33 = readCellMemory(b.controller, 3, 3);

        const { attestation, inputA, inputB } = executeShare(
            a, b,
            [{ i: 0, j: 0 }],  // A gives cell (0,0)
            [{ i: 3, j: 3 }],  // B gives cell (3,3)
            100
        );

        // A's cell (0,0) should now contain B's old (3,3)
        const newA00 = readCellMemory(a.controller, 0, 0);
        expect(Array.from(newA00)).toEqual(Array.from(cellB33));

        // B's cell (0,0) should now contain A's old (0,0)
        // Wait — A gives (0,0), which goes to B at (0,0)
        const newB00 = readCellMemory(b.controller, 0, 0);
        expect(Array.from(newB00)).toEqual(Array.from(cellA00));
    });

    it('attestation covers both directions', () => {
        const a = makeEngine(42, 8);
        const b = makeEngine(99, 8);

        const { attestation } = executeShare(
            a, b,
            [{ i: 0, j: 0 }, { i: 1, j: 0 }],
            [{ i: 5, j: 5 }],
            200
        );

        expect(attestation.cellsFromA.length).toBe(2);
        expect(attestation.cellsFromB.length).toBe(1);
        expect(attestation.boardAHash).toBeTruthy();
        expect(attestation.boardBHash).toBeTruthy();
        expect(attestation.boardAHash).not.toBe(attestation.boardBHash);
        expect(attestation.tick).toBe(200);
    });

    it('attestation string is canonical', () => {
        const a = makeEngine(42, 8);
        const b = makeEngine(99, 8);

        const r1 = executeShare(a, b, [{ i: 0, j: 0 }], [{ i: 1, j: 1 }], 0);
        // Re-create engines to get same initial state
        const a2 = makeEngine(42, 8);
        const b2 = makeEngine(99, 8);
        const r2 = executeShare(a2, b2, [{ i: 0, j: 0 }], [{ i: 1, j: 1 }], 0);

        // Same inputs → same attestation string
        expect(r1.attestationString).toBe(r2.attestationString);
    });

    it('input events are verifiable', () => {
        const a = makeEngine(42, 8);
        const b = makeEngine(99, 8);

        const { inputA, inputB } = executeShare(
            a, b, [{ i: 0, j: 0 }], [{ i: 2, j: 2 }], 50
        );

        expect(verifyShareInput(inputA).valid).toBe(true);
        expect(verifyShareInput(inputB).valid).toBe(true);
    });

    it('tampered input fails verification', () => {
        const a = makeEngine(42, 8);
        const b = makeEngine(99, 8);

        const { inputA } = executeShare(
            a, b, [{ i: 0, j: 0 }], [{ i: 2, j: 2 }], 50
        );

        // Tamper: change a received byte
        inputA.action.received[0].data[0] = 0xFF;

        expect(verifyShareInput(inputA).valid).toBe(false);
    });

    it('cell hashes match data', () => {
        const a = makeEngine(42, 8);
        const cell = readCellMemory(a.controller, 0, 0);
        const hash = hashCell(cell);
        expect(hash.length).toBe(64); // hex SHA-256
        // Same data → same hash
        expect(hashCell(cell)).toBe(hash);
        // Different data → different hash
        const modified = new Uint8Array(cell);
        modified[0] ^= 0xFF;
        expect(hashCell(modified)).not.toBe(hash);
    });
});
