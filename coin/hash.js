/**
 * SHA-256 hashing utilities using Node's built-in crypto module.
 *
 * @module coin/hash
 */

import { createHash } from 'node:crypto';

/**
 * Compute SHA-256 hash of a Uint8Array.
 * @param {Uint8Array} data
 * @returns {Uint8Array} 32-byte hash
 */
export function sha256(data) {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

/**
 * Compute SHA-256 hash of a UTF-8 string.
 * @param {string} str
 * @returns {Uint8Array} 32-byte hash
 */
export function sha256str(str) {
  return new Uint8Array(createHash('sha256').update(str, 'utf8').digest());
}

/**
 * Convert a Uint8Array to a hex string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Convert a hex string to a Uint8Array.
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function fromHex(hex) {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
