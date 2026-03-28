/**
 * Share protocol: signed cell exchange between two boards.
 *
 * A share is a one-time write event where cells are swapped between
 * two boards. Both parties sign the same attestation covering:
 * - Both board state hashes at time of share
 * - Hashes of all cells given and received
 *
 * The share is recorded as a player input in each board's session.
 * No merged boards, no prolonged sessions, no edge negotiation.
 *
 * @module coin/share
 */

import { sha256, toHex } from './hash.js';
import { readCellMemory, writeCellBytes } from '../engine/board.js';

/**
 * @typedef {Object} CellRef
 * @property {number} i - row
 * @property {number} j - column
 * @property {string} hash - hex SHA-256 of the cell's 1024 bytes
 */

/**
 * @typedef {Object} ShareAttestation
 * @property {string} boardAHash - state hash of board A at time of share
 * @property {string} boardBHash - state hash of board B at time of share
 * @property {CellRef[]} cellsFromA - cells given by A (hashes only)
 * @property {CellRef[]} cellsFromB - cells given by B (hashes only)
 * @property {number} tick - board tick at time of share
 */

/**
 * Hash a single cell's data.
 */
function hashCell(data) {
    return toHex(sha256(data instanceof Uint8Array ? data : new Uint8Array(data)));
}

/**
 * Build the canonical attestation string for signing.
 * Both parties sign the same content.
 */
function attestationString(attestation) {
    return JSON.stringify({
        boardAHash: attestation.boardAHash,
        boardBHash: attestation.boardBHash,
        cellsFromA: attestation.cellsFromA.map(c => ({ i: c.i, j: c.j, hash: c.hash })),
        cellsFromB: attestation.cellsFromB.map(c => ({ i: c.i, j: c.j, hash: c.hash })),
        tick: attestation.tick,
    });
}

/**
 * Execute a share between two boards.
 *
 * @param {Object} engineA - board A (has .controller, .serialize())
 * @param {Object} engineB - board B
 * @param {Array<{i: number, j: number}>} cellsA - cells from A to give to B
 * @param {Array<{i: number, j: number}>} cellsB - cells from B to give to A
 * @param {number} tick - current tick
 * @returns {{ attestation: ShareAttestation, inputA: Object, inputB: Object }}
 */
export function executeShare(engineA, engineB, cellsA, cellsB, tick = 0) {
    // Hash board states
    const boardAHash = toHex(sha256(engineA.serialize()));
    const boardBHash = toHex(sha256(engineB.serialize()));

    // Read and hash cells from each board
    const cellDataFromA = cellsA.map(({ i, j }) => ({
        i, j,
        data: readCellMemory(engineA.controller, i, j),
        hash: hashCell(readCellMemory(engineA.controller, i, j)),
    }));
    const cellDataFromB = cellsB.map(({ i, j }) => ({
        i, j,
        data: readCellMemory(engineB.controller, i, j),
        hash: hashCell(readCellMemory(engineB.controller, i, j)),
    }));

    // Build attestation (both parties sign this)
    const attestation = {
        boardAHash,
        boardBHash,
        cellsFromA: cellDataFromA.map(c => ({ i: c.i, j: c.j, hash: c.hash })),
        cellsFromB: cellDataFromB.map(c => ({ i: c.i, j: c.j, hash: c.hash })),
        tick,
    };

    // Swap: write B's cells to A, A's cells to B
    for (const cell of cellDataFromB) {
        writeCellBytes(engineA.controller, cell.i, cell.j, 0, cell.data);
    }
    for (const cell of cellDataFromA) {
        writeCellBytes(engineB.controller, cell.i, cell.j, 0, cell.data);
    }

    // Build input events for each board's session log
    const inputA = {
        tick,
        action: {
            type: 'share',
            received: cellDataFromB.map(c => ({ i: c.i, j: c.j, data: Array.from(c.data) })),
            given: attestation.cellsFromA,
            sourceBoard: boardBHash,
            attestation,
        },
    };
    const inputB = {
        tick,
        action: {
            type: 'share',
            received: cellDataFromA.map(c => ({ i: c.i, j: c.j, data: Array.from(c.data) })),
            given: attestation.cellsFromB,
            sourceBoard: boardAHash,
            attestation,
        },
    };

    return { attestation, inputA, inputB, attestationString: attestationString(attestation) };
}

/**
 * Verify a share attestation: check that the cell hashes match
 * the actual data in the input event.
 */
export function verifyShareInput(input) {
    if (input.action.type !== 'share') return { valid: false, error: 'Not a share input' };
    const att = input.action.attestation;
    if (!att) return { valid: false, error: 'No attestation' };

    // Verify received cell hashes match the attestation
    for (const cell of input.action.received) {
        const data = new Uint8Array(cell.data);
        const hash = hashCell(data);
        // Find this cell in the attestation's source cells
        const sourceKey = input.action.sourceBoard === att.boardAHash ? 'cellsFromA' : 'cellsFromB';
        const attCell = att[sourceKey].find(c => c.i === cell.i && c.j === cell.j);
        if (!attCell) return { valid: false, error: `Cell (${cell.i},${cell.j}) not in attestation` };
        if (attCell.hash !== hash) return { valid: false, error: `Cell (${cell.i},${cell.j}) hash mismatch` };
    }

    return { valid: true };
}

export { hashCell, attestationString };
