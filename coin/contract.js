/**
 * Board contract — signed declaration of board hyperparameters and initial state.
 *
 * A BoardContract binds an owner's public key to a specific board configuration
 * and initial state hash. Once signed, it serves as a verifiable commitment.
 *
 * Uses Ed25519 from Node's built-in crypto module.
 *
 * @module coin/contract
 */

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { sha256, toHex, fromHex } from './hash.js';

export class BoardContract {
  /**
   * @param {Object} params
   * @param {Object} params.boardParams - board hyperparameters (size, seed, rules, etc.)
   * @param {string} params.initialStateHash - hex-encoded hash of initial board state
   * @param {number} params.maxMovesPerDay - cap on player events per day
   * @param {number} params.maxMoveSize - max bytes per move
   * @param {Uint8Array} params.ownerPublicKey - Ed25519 public key (32 bytes raw)
   */
  constructor({ boardParams, initialStateHash, maxMovesPerDay, maxMoveSize, ownerPublicKey }) {
    this.boardParams = boardParams;
    this.initialStateHash = initialStateHash;
    this.maxMovesPerDay = maxMovesPerDay;
    this.maxMoveSize = maxMoveSize;
    this.ownerPublicKey = ownerPublicKey;
    /** @type {Uint8Array|null} */
    this.signature = null;
  }

  /**
   * Get the canonical bytes to be signed.
   * @returns {Uint8Array}
   * @private
   */
  _signable() {
    const obj = {
      boardParams: sortObj(this.boardParams),
      initialStateHash: this.initialStateHash,
      maxMoveSize: this.maxMoveSize,
      maxMovesPerDay: this.maxMovesPerDay,
      ownerPublicKey: toHex(this.ownerPublicKey)
    };
    return new TextEncoder().encode(JSON.stringify(obj));
  }

  /**
   * Sign the contract with an Ed25519 private key.
   * @param {import('node:crypto').KeyObject} privateKey - Ed25519 private KeyObject
   */
  sign(privateKey) {
    const data = this._signable();
    this.signature = new Uint8Array(sign(null, data, privateKey));
  }

  /**
   * Verify the contract's signature against the embedded public key.
   * @returns {boolean}
   */
  verify() {
    if (!this.signature) return false;
    const data = this._signable();
    const pubKeyObj = createPublicKey({
      key: Buffer.concat([
        // Ed25519 public key DER prefix
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(this.ownerPublicKey)
      ]),
      format: 'der',
      type: 'spki'
    });
    return verify(null, data, pubKeyObj, Buffer.from(this.signature));
  }

  /**
   * Serialize the contract to a plain object.
   * @returns {Object}
   */
  serialize() {
    return {
      boardParams: this.boardParams,
      initialStateHash: this.initialStateHash,
      maxMovesPerDay: this.maxMovesPerDay,
      maxMoveSize: this.maxMoveSize,
      ownerPublicKey: toHex(this.ownerPublicKey),
      signature: this.signature ? toHex(this.signature) : null
    };
  }

  /**
   * Deserialize a contract from a plain object.
   * @param {Object} data
   * @returns {BoardContract}
   */
  static deserialize(data) {
    const contract = new BoardContract({
      boardParams: data.boardParams,
      initialStateHash: data.initialStateHash,
      maxMovesPerDay: data.maxMovesPerDay,
      maxMoveSize: data.maxMoveSize,
      ownerPublicKey: fromHex(data.ownerPublicKey)
    });
    if (data.signature) {
      contract.signature = fromHex(data.signature);
    }
    return contract;
  }
}

/**
 * Sort an object's keys for canonical JSON.
 * @param {Record<string, unknown>} obj
 * @returns {Record<string, unknown>}
 */
function sortObj(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortObj);
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObj(obj[key]);
  }
  return sorted;
}
