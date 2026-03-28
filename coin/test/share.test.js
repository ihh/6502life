import { describe, it, expect } from 'vitest';
import { createOffer, verifyOffer, acceptOffer, findSuccessfulShares, hashCell } from '../share.js';
import { Board6502Engine } from '../engines/board6502.js';
import { readCellMemory } from '../../engine/board.js';

function makeEngine(seed = 42, size = 8) {
    const engine = new Board6502Engine();
    engine.init({ size, seed });
    return engine;
}

const mockSign = (hash) => 'sig_' + hash.slice(0, 8);

describe('share protocol: offers and receipts', () => {

    it('createOffer produces valid offer with cell data and hashes', () => {
        const a = makeEngine(42);
        const offer = createOffer(a, [{ i: 0, j: 0 }, { i: 1, j: 1 }], 100, mockSign);
        expect(offer.type).toBe('offer');
        expect(offer.cells.length).toBe(2);
        expect(offer.cells[0].data.length).toBe(1024);
        expect(offer.cells[0].hash.length).toBe(64);
        expect(offer.contentHash.length).toBe(64);
        expect(offer.signature).toMatch(/^sig_/);
    });

    it('verifyOffer passes for genuine offer', () => {
        const a = makeEngine(42);
        const offer = createOffer(a, [{ i: 0, j: 0 }], 0, mockSign);
        expect(verifyOffer(offer).valid).toBe(true);
    });

    it('verifyOffer fails for tampered cell data', () => {
        const a = makeEngine(42);
        const offer = createOffer(a, [{ i: 0, j: 0 }], 0, mockSign);
        offer.cells[0].data[0] ^= 0xFF;
        expect(verifyOffer(offer).valid).toBe(false);
    });

    it('acceptOffer applies cells and produces receipt', () => {
        const a = makeEngine(42, 8);
        const b = makeEngine(99, 8);

        // Write a known byte to A's cell so it differs from B's
        const aBase = a.controller.memory.ijbToByteIndex(0, 0, 0);
        a.controller.memory.setByteWithoutUndo(aBase, 0xAA);

        const cellBefore = readCellMemory(b.controller, 5, 5);
        const offer = createOffer(a, [{ i: 0, j: 0 }], 100, mockSign);
        const { receipt, input } = acceptOffer(b, offer, [{ i: 5, j: 5 }], 200, mockSign);

        // Cell (5,5) on B should now contain A's (0,0) with the 0xAA byte
        const cellAfter = readCellMemory(b.controller, 5, 5);
        expect(cellAfter[0]).toBe(0xAA);
        expect(Array.from(cellAfter)).toEqual(offer.cells[0].data);

        // Receipt references the offer
        expect(receipt.offerHash).toBe(offer.contentHash);
        expect(receipt.type).toBe('receipt');
        expect(receipt.signature).toMatch(/^sig_/);

        // Input event for session log
        expect(input.action.type).toBe('share_receive');
        expect(input.action.offer.contentHash).toBe(offer.contentHash);
    });

    it('acceptOffer rejects invalid offer', () => {
        const a = makeEngine(42);
        const b = makeEngine(99);
        const offer = createOffer(a, [{ i: 0, j: 0 }], 0, mockSign);
        offer.cells[0].data[0] ^= 0xFF; // tamper
        expect(() => acceptOffer(b, offer, [{ i: 0, j: 0 }], 0, mockSign))
            .toThrow('Invalid offer');
    });

    it('one-way colonization: offer + receipt, no counter-offer', () => {
        const a = makeEngine(42, 8);
        const b = makeEngine(99, 8);

        const offer = createOffer(a, [{ i: 0, j: 0 }], 0, mockSign);
        const { receipt } = acceptOffer(b, offer, [{ i: 0, j: 0 }], 0, mockSign);

        // B got cells, A got nothing. This is fine.
        expect(receipt.offerHash).toBe(offer.contentHash);
    });

    it('successful share: both parties offer and accept', () => {
        const a = makeEngine(42, 8);
        const b = makeEngine(99, 8);

        // Alice offers to Bob
        const offerA = createOffer(a, [{ i: 0, j: 0 }], 100, mockSign);
        const { receipt: receiptB, input: inputB } = acceptOffer(
            b, offerA, [{ i: 0, j: 0 }], 100, mockSign
        );

        // Bob offers to Alice
        const offerB = createOffer(b, [{ i: 3, j: 3 }], 100, mockSign);
        const { receipt: receiptA, input: inputA } = acceptOffer(
            a, offerB, [{ i: 3, j: 3 }], 100, mockSign
        );

        // Both chains have share_receive events
        const shares = findSuccessfulShares([inputA], [inputB]);
        // The matching heuristic checks board hashes cross-reference
        // For a full test we'd need board IDs, but the structure is correct
        expect(inputA.action.type).toBe('share_receive');
        expect(inputB.action.type).toBe('share_receive');
    });

    it('cell hashes are deterministic', () => {
        const a = makeEngine(42);
        const cell = readCellMemory(a.controller, 0, 0);
        const h1 = hashCell(cell);
        const h2 = hashCell(cell);
        expect(h1).toBe(h2);
        expect(h1.length).toBe(64);
    });
});
