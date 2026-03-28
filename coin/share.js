/**
 * Share protocol: signed offers and signed receipts.
 *
 * Primitives:
 *   OFFER:   "Here are cells from my board. Signed by me."
 *   RECEIPT: "I received your offer and applied it. Signed by me."
 *
 * A "successful share" is an interpretation-layer pattern:
 *   Alice's chain: offer_to_Bob + receipt_of_Bob's_offer
 *   Bob's chain:   offer_to_Alice + receipt_of_Alice's_offer
 * where the offers and receipts cross-reference each other.
 *
 * Anyone can back out at any time without consequence.
 * One-way colonization (offer + receipt, no counter-offer) is fine.
 * The crypto layer only provides non-repudiation.
 *
 * @module coin/share
 */

import { sha256, toHex } from './hash.js';
import { readCellMemory, writeCellBytes } from '../engine/board.js';

function hashCell(data) {
    return toHex(sha256(data instanceof Uint8Array ? data : new Uint8Array(data)));
}

function hashString(s) {
    return toHex(sha256(new TextEncoder().encode(s)));
}

/**
 * Create a signed OFFER: cells from my board, available to anyone.
 *
 * @param {Object} engine - board engine
 * @param {Array<{i: number, j: number}>} cells - cells to offer
 * @param {number} tick - current board tick
 * @param {Function} signFn - (hash) => signature
 * @returns {Object} offer message
 */
export function createOffer(engine, cells, tick, signFn) {
    const boardHash = toHex(sha256(engine.serialize()));
    const cellData = cells.map(({ i, j }) => {
        const data = readCellMemory(engine.controller, i, j);
        return { i, j, data: Array.from(data), hash: hashCell(data) };
    });

    const content = JSON.stringify({
        boardHash,
        cells: cellData.map(c => ({ i: c.i, j: c.j, hash: c.hash })),
        tick,
    });
    const contentHash = hashString(content);

    return {
        type: 'offer',
        boardHash,
        tick,
        cells: cellData,
        contentHash,
        signature: signFn(contentHash),
    };
}

/**
 * Verify an offer: check cell data matches declared hashes.
 */
export function verifyOffer(offer) {
    for (const cell of offer.cells) {
        const actual = hashCell(new Uint8Array(cell.data));
        if (actual !== cell.hash) {
            return { valid: false, error: `Cell (${cell.i},${cell.j}) hash mismatch` };
        }
    }
    // Verify content hash
    const content = JSON.stringify({
        boardHash: offer.boardHash,
        cells: offer.cells.map(c => ({ i: c.i, j: c.j, hash: c.hash })),
        tick: offer.tick,
    });
    if (hashString(content) !== offer.contentHash) {
        return { valid: false, error: 'Content hash mismatch' };
    }
    return { valid: true };
}

/**
 * Apply an offer to my board (paste received cells) and create a signed RECEIPT.
 *
 * @param {Object} engine - my board engine
 * @param {Object} offer - the received offer
 * @param {Array<{i: number, j: number}>} destCoords - where to paste each cell on my board
 *   (must be same length as offer.cells; null entries = skip that cell)
 * @param {number} tick - my current board tick
 * @param {Function} signFn - (hash) => signature
 * @returns {Object} receipt message + input event for my session log
 */
export function acceptOffer(engine, offer, destCoords, tick, signFn) {
    const myBoardHash = toHex(sha256(engine.serialize()));

    // Verify offer first
    const v = verifyOffer(offer);
    if (!v.valid) throw new Error('Invalid offer: ' + v.error);

    // Apply cells to my board
    const applied = [];
    for (let k = 0; k < offer.cells.length; k++) {
        const dest = destCoords[k];
        if (!dest) continue;
        const cellData = new Uint8Array(offer.cells[k].data);
        writeCellBytes(engine.controller, dest.i, dest.j, 0, cellData);
        applied.push({
            srcI: offer.cells[k].i, srcJ: offer.cells[k].j,
            dstI: dest.i, dstJ: dest.j,
            hash: offer.cells[k].hash,
        });
    }

    // Build receipt
    const receiptContent = JSON.stringify({
        offerHash: offer.contentHash,
        offerBoardHash: offer.boardHash,
        myBoardHash,
        applied,
        tick,
    });
    const receiptHash = hashString(receiptContent);

    const receipt = {
        type: 'receipt',
        offerHash: offer.contentHash,
        offerBoardHash: offer.boardHash,
        myBoardHash,
        applied,
        tick,
        receiptHash,
        signature: signFn(receiptHash),
    };

    // Input event for my session log
    const input = {
        tick,
        action: {
            type: 'share_receive',
            offer: {
                contentHash: offer.contentHash,
                boardHash: offer.boardHash,
                signature: offer.signature,
            },
            applied,
            receipt: {
                receiptHash,
                signature: receipt.signature,
            },
        },
    };

    return { receipt, input };
}

/**
 * Check if a pair of chains contains a "successful share":
 * both parties have an offer and a matching receipt from each other.
 *
 * @param {Array} chainA - Alice's input events
 * @param {Array} chainB - Bob's input events
 * @returns {Array} list of matched share pairs
 */
export function findSuccessfulShares(chainA, chainB) {
    const shares = [];

    // Find all share_receive events in A that reference offers from B
    const aReceives = chainA.filter(e => e.action?.type === 'share_receive');
    const bReceives = chainB.filter(e => e.action?.type === 'share_receive');

    // For each receive in A, look for a matching receive in B
    for (const ar of aReceives) {
        const offerHashFromB = ar.action.offer.contentHash;
        // Find B's receive that references an offer from A
        for (const br of bReceives) {
            // B received from A if B's offer.boardHash matches A's board
            // This is a heuristic — a full implementation would track board IDs
            if (br.action.offer.boardHash !== ar.action.receipt?.myBoardHash) continue;
            shares.push({
                aReceived: ar,
                bReceived: br,
                tick: Math.max(ar.tick, br.tick),
            });
        }
    }

    return shares;
}

export { hashCell, hashString };
