/**
 * xoshiro128** PRNG — fast, well-specified, small state.
 *
 * We use the 128-bit variant (4x uint32) because JavaScript bitwise ops
 * work on 32-bit integers. This avoids BigInt overhead while providing
 * excellent statistical quality.
 *
 * Reference: https://prng.di.unimi.it/xoshiro128starstar.c
 *
 * @module coin/prng
 */

/**
 * SplitMix32 — used to seed xoshiro128** from a single 32-bit integer.
 * @param {number} seed
 * @returns {function(): number}
 */
function splitmix32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x9e3779b9) | 0;
    let t = seed ^ (seed >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return t >>> 0;
  };
}

export class Xoshiro128ss {
  /**
   * @param {number} seed - 32-bit integer seed
   */
  constructor(seed) {
    const sm = splitmix32(seed);
    /** @type {Uint32Array} */
    this.s = new Uint32Array([sm(), sm(), sm(), sm()]);
  }

  /**
   * Return the next pseudorandom uint32.
   * @returns {number}
   */
  next() {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;

    const t = s[1] << 9;

    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];

    s[2] ^= t;
    s[3] = rotl(s[3], 11) >>> 0;

    return result;
  }

  /**
   * Return a float in [0, 1).
   * @returns {number}
   */
  random() {
    return this.next() / 0x100000000;
  }

  /**
   * Serialize PRNG state (16 bytes).
   * @returns {Uint8Array}
   */
  serialize() {
    return new Uint8Array(this.s.buffer.slice(0));
  }

  /**
   * Restore PRNG state from serialized bytes.
   * @param {Uint8Array} data - 16 bytes
   */
  deserialize(data) {
    if (data.length !== 16) throw new Error('PRNG state must be 16 bytes');
    this.s = new Uint32Array(data.buffer.slice(data.byteOffset, data.byteOffset + 16));
  }
}

/**
 * @param {number} x
 * @param {number} k
 * @returns {number}
 */
function rotl(x, k) {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}
