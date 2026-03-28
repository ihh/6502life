/**
 * Share negotiation protocol: 4-message cell exchange.
 *
 * 1. PROPOSE: Alice offers cells, requests cells from Bob
 * 2. ACCEPT/COUNTER/REJECT: Bob responds
 * 3. COMMIT: Alice sends signature + cell data
 * 4. COMMIT: Bob sends signature + cell data
 *
 * Both parties sign the same attestation. The attestation includes
 * hashes of all cells in both directions — neither can claim they
 * gave without receiving.
 *
 * @module coin/share-negotiate
 */

import { sha256, toHex } from './hash.js';
import { readCellMemory } from '../engine/board.js';

/**
 * Hash a cell's 1024 bytes.
 */
function hashCell(data) {
    return toHex(sha256(data instanceof Uint8Array ? data : new Uint8Array(data)));
}

/**
 * Compute the canonical attestation from agreed terms.
 * Both parties must compute the same attestation independently.
 */
export function computeAttestation(aliceBoardHash, bobBoardHash, aliceCellHashes, bobCellHashes, tick) {
    const canonical = JSON.stringify({
        a: aliceBoardHash,
        b: bobBoardHash,
        ac: aliceCellHashes.map(c => [c.i, c.j, c.hash]).sort(),
        bc: bobCellHashes.map(c => [c.i, c.j, c.hash]).sort(),
        t: tick,
    });
    return {
        content: canonical,
        hash: toHex(sha256(new TextEncoder().encode(canonical))),
    };
}

// ── Message constructors ──

/**
 * Alice creates a PROPOSE message.
 */
export function createPropose(engine, offerCells, wantCells) {
    const boardHash = toHex(sha256(engine.serialize()));
    const cellHashes = offerCells.map(({ i, j }) => ({
        i, j, hash: hashCell(readCellMemory(engine.controller, i, j)),
    }));
    return {
        type: 'propose',
        boardHash,
        offerCells: cellHashes,
        wantCells, // [{i,j}] — no hashes yet, we don't have Bob's data
    };
}

/**
 * Bob creates an ACCEPT, COUNTER, or REJECT in response to a PROPOSE.
 */
export function createResponse(engine, propose, action, counterOffer = null, counterWant = null) {
    const boardHash = toHex(sha256(engine.serialize()));

    if (action === 'reject') {
        return { type: 'reject' };
    }

    // For accept: use the proposed cells. For counter: use the counter-proposal.
    const myOfferCoords = action === 'accept' ? propose.wantCells : counterOffer;
    const myWantCoords = action === 'accept'
        ? propose.offerCells.map(c => ({ i: c.i, j: c.j }))
        : counterWant;

    const cellHashes = myOfferCoords.map(({ i, j }) => ({
        i, j, hash: hashCell(readCellMemory(engine.controller, i, j)),
    }));

    return {
        type: action, // 'accept' or 'counter'
        boardHash,
        offerCells: cellHashes,
        wantCells: myWantCoords,
    };
}

/**
 * Create a COMMIT message: signature + actual cell data.
 * Called after both parties have agreed (PROPOSE + ACCEPT).
 *
 * @param {Object} engine - the board
 * @param {string} myBoardHash - my board hash from propose/accept
 * @param {string} theirBoardHash - their board hash
 * @param {Array} myCellCoords - [{i,j}] cells I'm giving
 * @param {Array} theirCellHashes - [{i,j,hash}] cells I expect to receive
 * @param {number} tick
 * @param {Function} signFn - (attestationHash) => signature
 */
export function createCommit(engine, myBoardHash, theirBoardHash, myCellCoords, theirCellHashes, tick, signFn) {
    const myCellHashes = myCellCoords.map(({ i, j }) => ({
        i, j, hash: hashCell(readCellMemory(engine.controller, i, j)),
    }));
    const myCellData = myCellCoords.map(({ i, j }) => ({
        i, j, data: Array.from(readCellMemory(engine.controller, i, j)),
    }));

    const attestation = computeAttestation(
        myBoardHash, theirBoardHash, myCellHashes, theirCellHashes, tick
    );

    return {
        type: 'commit',
        attestation,
        signature: signFn(attestation.hash),
        cellData: myCellData,
        cellHashes: myCellHashes,
    };
}

/**
 * Verify a received COMMIT: check cell data matches attestation hashes.
 */
export function verifyCommit(commit, expectedAttestationHash) {
    if (commit.attestation.hash !== expectedAttestationHash) {
        return { valid: false, error: 'Attestation hash mismatch' };
    }
    for (const cell of commit.cellData) {
        const hash = hashCell(new Uint8Array(cell.data));
        const expected = commit.cellHashes.find(c => c.i === cell.i && c.j === cell.j);
        if (!expected || expected.hash !== hash) {
            return { valid: false, error: `Cell (${cell.i},${cell.j}) hash mismatch` };
        }
    }
    return { valid: true };
}

/**
 * Apply a verified COMMIT to a board: write received cells.
 */
export function applyCommit(engine, commit) {
    for (const cell of commit.cellData) {
        const { writeCellBytes } = engine; // assumes engine exposes writeCellBytes
        const base = engine.controller.memory.ijbToByteIndex(cell.i, cell.j, 0);
        const data = new Uint8Array(cell.data);
        for (let k = 0; k < data.length; k++) {
            engine.controller.memory.setByteWithoutUndo(base + k, data[k]);
        }
    }
}
