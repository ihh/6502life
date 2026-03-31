/**
 * Board Contract: specifies the full configuration of a board instance.
 *
 * A board contract commits to:
 * - initSeed: the ChaCha20 seed for generating initial cell memory
 * - size: board dimension (size × size cells)
 * - boardParams: simulation hyperparameters (noise, scheduler, BRK ops, etc.)
 * - difficulty: cryptopuzzle difficulty (number of leading zero bits on
 *   hash required to mine a coin that can be used for moves)
 * - saltWithParams: if true, the board params and difficulty are mixed
 *   into the ChaCha20 nonce, so the owner commits to their board setup
 *   before seeing the random initialization. This prevents cherry-picking
 *   params after finding a seed with a viable replicator.
 * - coinParams: coin economics (earn rate, decay, move cost)
 *
 * The contract is serialized to a canonical JSON string. Its SHA-256 hash
 * serves as the board's identity.
 *
 * @module coin/board-contract
 */

import { sha256, toHex } from './hash.js';
import { generateBoardInit, seedToKey, deriveNonce } from './chacha20.js';
import { DEFAULT_COIN_PARAMS } from './economics.js';

/**
 * Default board parameters (matches CLAUDE.md spec).
 */
export const DEFAULT_BOARD_PARAMS = {
    pBitNoise: 1 / 2048,
    pBitNoiseZero: 0.5,
    decayRate: 0,
    hasCompass: false,
    schedulerMode: 'random',
    brkOps: {
        reset: { range: [0, 0], enabled: true },
        swap: { range: [1, 48], enabled: true },
        copy: { range: [49, 96], enabled: true },
    },
};

/**
 * Board contract specification.
 */
export class BoardContract {
    /**
     * @param {Object} spec
     * @param {string|number} spec.initSeed - ChaCha20 seed for initial memory
     * @param {number} [spec.size=16] - board dimension
     * @param {Object} [spec.boardParams] - simulation hyperparameters
     * @param {number} [spec.difficulty=0] - mining difficulty (leading zero bits)
     * @param {boolean} [spec.saltWithParams=false] - commit to params before seeing init
     * @param {Object} [spec.coinParams] - coin economics overrides
     */
    constructor(spec) {
        this.initSeed = spec.initSeed;
        this.size = spec.size ?? 16;
        this.boardParams = { ...DEFAULT_BOARD_PARAMS, ...spec.boardParams };
        this.difficulty = spec.difficulty ?? 0;
        this.saltWithParams = spec.saltWithParams ?? false;
        this.coinParams = { ...DEFAULT_COIN_PARAMS, ...spec.coinParams };
    }

    /**
     * Canonical JSON serialization (deterministic key ordering).
     * @returns {string}
     */
    serialize() {
        return JSON.stringify({
            initSeed: this.initSeed,
            size: this.size,
            boardParams: sortKeys(this.boardParams),
            difficulty: this.difficulty,
            saltWithParams: this.saltWithParams,
            coinParams: sortKeys(this.coinParams),
        }, null, 0);
    }

    /**
     * Board identity = SHA-256 of canonical serialization.
     * @returns {string} hex
     */
    id() {
        return toHex(sha256(new TextEncoder().encode(this.serialize())));
    }

    /**
     * Generate the initial board memory using ChaCha20.
     * @returns {Uint8Array} size*size*1024 bytes
     */
    generateInit() {
        return generateBoardInit(this.initSeed, this.size, {
            saltWithParams: this.saltWithParams,
            boardParams: this.boardParams,
            difficulty: this.difficulty,
        });
    }

    /**
     * Build the EngineConfig for initializing a Board6502Engine.
     * @returns {Object}
     */
    toEngineConfig() {
        return {
            gameId: '6502life',
            width: this.size,
            height: this.size,
            seed: this.initSeed,
            rules: {
                ...this.boardParams,
                initMethod: 'chacha20',
                saltWithParams: this.saltWithParams,
                difficulty: this.difficulty,
            },
        };
    }

    /**
     * Check if a hash meets the mining difficulty.
     * @param {string} hashHex - hex-encoded hash
     * @returns {boolean}
     */
    meetsDifficulty(hashHex) {
        return countLeadingZeroBits(hashHex) >= this.difficulty;
    }

    /**
     * Deserialize from JSON string.
     * @param {string} json
     * @returns {BoardContract}
     */
    static fromJSON(json) {
        return new BoardContract(JSON.parse(json));
    }
}

/**
 * Count leading zero bits in a hex-encoded hash.
 * @param {string} hex
 * @returns {number}
 */
function countLeadingZeroBits(hex) {
    let bits = 0;
    for (const ch of hex) {
        const nibble = parseInt(ch, 16);
        if (nibble === 0) { bits += 4; continue; }
        if (nibble < 2) bits += 3;
        else if (nibble < 4) bits += 2;
        else if (nibble < 8) bits += 1;
        break;
    }
    return bits;
}

/**
 * Sort object keys recursively for canonical JSON.
 */
function sortKeys(obj) {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return obj;
    const sorted = {};
    for (const key of Object.keys(obj).sort()) {
        sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
}
