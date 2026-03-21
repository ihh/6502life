/**
 * Conway's Game of Life engine — reference implementation for 6502coin.
 *
 * Rules: B3/S23 on a toroidal NxN grid.
 * State per cell: 1 bit.
 * Canonical serialization: packed bits (row-major) + PRNG state + clock.
 *
 * @module coin/engines/life
 */

import { Engine } from '../engine.js';
import { Xoshiro128ss } from '../prng.js';

export class LifeEngine extends Engine {
  constructor() {
    super();
    /** @type {Uint8Array|null} */
    this.grid = null;
    /** @type {number} */
    this.width = 0;
    /** @type {number} */
    this.height = 0;
    /** @type {number} */
    this._clock = 0;
    /** @type {Xoshiro128ss|null} */
    this.rng = null;
    /** @type {number} */
    this._totalBorn = 0;
    /** @type {number} */
    this._totalDied = 0;
  }

  /**
   * @param {import('../engine.js').EngineConfig} config
   */
  init(config) {
    this.width = config.width;
    this.height = config.height;
    this._clock = 0;
    this._totalBorn = 0;
    this._totalDied = 0;
    this.rng = new Xoshiro128ss(config.seed);

    const size = this.width * this.height;
    this.grid = new Uint8Array(size);

    // Initialize with random density ~50% using the seeded PRNG
    const density = config.rules?.density ?? 0.5;
    for (let i = 0; i < size; i++) {
      this.grid[i] = this.rng.random() < density ? 1 : 0;
    }
  }

  /**
   * @param {number} [n=1]
   * @returns {number}
   */
  step(n = 1) {
    for (let s = 0; s < n; s++) {
      this._stepOnce();
    }
    return n;
  }

  _stepOnce() {
    const { width, height, grid } = this;
    const next = new Uint8Array(width * height);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const neighbors = this._countNeighbors(x, y);
        const idx = y * width + x;
        const alive = grid[idx];

        if (alive) {
          next[idx] = (neighbors === 2 || neighbors === 3) ? 1 : 0;
          if (!next[idx]) this._totalDied++;
        } else {
          next[idx] = (neighbors === 3) ? 1 : 0;
          if (next[idx]) this._totalBorn++;
        }
      }
    }

    this.grid = next;
    this._clock++;
  }

  /**
   * Count live neighbors (toroidal).
   * @param {number} x
   * @param {number} y
   * @returns {number}
   */
  _countNeighbors(x, y) {
    const { width, height, grid } = this;
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = (x + dx + width) % width;
        const ny = (y + dy + height) % height;
        count += grid[ny * width + nx];
      }
    }
    return count;
  }

  /**
   * @param {import('../engine.js').Input} input
   */
  applyInput(input) {
    const { action } = input;
    if (action.type === 'set') {
      const { x, y, value } = action;
      this.grid[y * this.width + x] = value ? 1 : 0;
    }
  }

  /**
   * Canonical serialization:
   *   [4 bytes: width LE] [4 bytes: height LE] [8 bytes: clock LE]
   *   [ceil(W*H/8) bytes: packed grid bits] [16 bytes: PRNG state]
   *   [4 bytes: totalBorn LE] [4 bytes: totalDied LE]
   * @returns {Uint8Array}
   */
  serialize() {
    const { width, height, grid, rng, _clock, _totalBorn, _totalDied } = this;
    const cellCount = width * height;
    const packedLen = Math.ceil(cellCount / 8);
    const prngState = rng.serialize();
    // 4+4+8 + packedLen + 16 + 4+4 = 40 + packedLen
    const totalLen = 40 + packedLen;
    const buf = new ArrayBuffer(totalLen);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);

    let off = 0;
    view.setUint32(off, width, true); off += 4;
    view.setUint32(off, height, true); off += 4;
    // Clock as two uint32s (little-endian 64-bit)
    view.setUint32(off, _clock & 0xFFFFFFFF, true); off += 4;
    view.setUint32(off, (_clock / 0x100000000) >>> 0, true); off += 4;

    // Pack grid bits
    for (let i = 0; i < cellCount; i++) {
      if (grid[i]) {
        bytes[off + (i >>> 3)] |= (1 << (i & 7));
      }
    }
    off += packedLen;

    // PRNG state
    bytes.set(prngState, off); off += 16;

    // Summary counters
    view.setUint32(off, _totalBorn, true); off += 4;
    view.setUint32(off, _totalDied, true); off += 4;

    return bytes;
  }

  /**
   * @param {Uint8Array} data
   */
  deserialize(data) {
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const view = new DataView(buf);
    let off = 0;

    this.width = view.getUint32(off, true); off += 4;
    this.height = view.getUint32(off, true); off += 4;
    const clockLo = view.getUint32(off, true); off += 4;
    const clockHi = view.getUint32(off, true); off += 4;
    this._clock = clockHi * 0x100000000 + clockLo;

    const cellCount = this.width * this.height;
    const packedLen = Math.ceil(cellCount / 8);

    this.grid = new Uint8Array(cellCount);
    for (let i = 0; i < cellCount; i++) {
      if (data[off + (i >>> 3)] & (1 << (i & 7))) {
        this.grid[i] = 1;
      }
    }
    off += packedLen;

    this.rng = new Xoshiro128ss(0);
    this.rng.deserialize(data.slice(off, off + 16)); off += 16;

    this._totalBorn = view.getUint32(off, true); off += 4;
    this._totalDied = view.getUint32(off, true); off += 4;
  }

  /**
   * @param {import('../engine.js').Edge} edge
   * @returns {Uint8Array}
   */
  getBoundary(edge) {
    const { width, height, grid } = this;
    let cells;
    switch (edge) {
      case 'north':
        cells = new Uint8Array(width);
        for (let x = 0; x < width; x++) cells[x] = grid[x];
        return cells;
      case 'south':
        cells = new Uint8Array(width);
        for (let x = 0; x < width; x++) cells[x] = grid[(height - 1) * width + x];
        return cells;
      case 'west':
        cells = new Uint8Array(height);
        for (let y = 0; y < height; y++) cells[y] = grid[y * width];
        return cells;
      case 'east':
        cells = new Uint8Array(height);
        for (let y = 0; y < height; y++) cells[y] = grid[y * width + (width - 1)];
        return cells;
      default:
        throw new Error(`Unknown edge: ${edge}`);
    }
  }

  /**
   * @param {import('../engine.js').Edge} edge
   * @param {Uint8Array} data
   */
  setBoundary(edge, data) {
    const { width, height, grid } = this;
    switch (edge) {
      case 'north':
        for (let x = 0; x < width; x++) grid[x] = data[x];
        break;
      case 'south':
        for (let x = 0; x < width; x++) grid[(height - 1) * width + x] = data[x];
        break;
      case 'west':
        for (let y = 0; y < height; y++) grid[y * width] = data[y];
        break;
      case 'east':
        for (let y = 0; y < height; y++) grid[y * width + (width - 1)] = data[y];
        break;
      default:
        throw new Error(`Unknown edge: ${edge}`);
    }
  }

  /**
   * @returns {number}
   */
  clock() {
    return this._clock;
  }

  /**
   * @returns {{ width: number, height: number }}
   */
  dimensions() {
    return { width: this.width, height: this.height };
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {import('../engine.js').CellView}
   */
  getCell(x, y) {
    return {
      x, y,
      state: new Uint8Array([this.grid[y * this.width + x]]),
      meta: { alive: this.grid[y * this.width + x] }
    };
  }

  /**
   * @returns {Record<string, number>}
   */
  summarize() {
    let alive = 0;
    for (let i = 0; i < this.grid.length; i++) {
      alive += this.grid[i];
    }
    return {
      liveCells: alive,
      totalCells: this.width * this.height,
      density: alive / (this.width * this.height),
      totalBorn: this._totalBorn,
      totalDied: this._totalDied,
      clock: this._clock
    };
  }
}
