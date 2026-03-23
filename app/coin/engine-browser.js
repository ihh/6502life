/**
 * Browser-compatible 6502life engine adapter.
 * Wraps BoardMemory + BoardController + BoardVisualizer for the coin PWA.
 *
 * Constructs the Sfotty-based board directly from pure-JS modules,
 * bypassing createBoardAsync (which tries WASM and may fail in browsers).
 */

import { BoardMemory } from '@board/memory.js';
import { BoardController } from '@board/controller.js';
import { BoardVisualizer } from '@board/visualizer.js';
import { writeCellBytes, readCellMemory } from '@engine/board.js';
import { assemble } from '@engine/assembler.js';
import { getPreset } from './presets-browser.js';

export class Board6502Engine {
  constructor() {
    this.controller = null;
    this.memory = null;
    this.visualizer = null;
    this.size = 0;
    this._ticks = 0;
    this._totalCopies = 0;
    this._totalSwaps = 0;
    this._presetReady = Promise.resolve();
    this.backend = 'sfotty';
  }

  async init(config) {
    this.size = config.size ?? config.width ?? 16;
    const seed = config.seed ?? 42;
    const boardParams = config.pBitNoise != null ? { pBitNoise: config.pBitNoise } : undefined;

    // Construct board directly from pure-JS modules (no WASM dance)
    const memory = new BoardMemory(seed, this.size);
    this.controller = new BoardController(memory, boardParams);
    this.visualizer = new BoardVisualizer(this.controller);
    this.memory = memory;

    this._ticks = 0;
    this._totalCopies = 0;
    this._totalSwaps = 0;

    this.controller.onBrkEvent = (type) => {
      if (type === 'copy') this._totalCopies++;
      else if (type === 'swap') this._totalSwaps++;
    };

    if (config.presets && config.presets.length > 0) {
      this._presetReady = Promise.all(
        config.presets.map(p => this._injectPreset(p.name, p.cell))
      );
    } else {
      this._presetReady = Promise.resolve();
    }

    console.log(`6502coin engine: sfotty ${this.size}x${this.size}, seed=${seed}`);
  }

  async ready() {
    return this._presetReady;
  }

  async _injectPreset(name, cell) {
    const preset = getPreset(name);
    if (!preset) throw new Error(`Unknown preset: ${name}`);
    const bytes = await assemble(preset.source);
    const [i, j] = cell;
    writeCellBytes(this.controller, i, j, 0, bytes);
  }

  step(n = 1) {
    for (let s = 0; s < n; s++) {
      this.controller.runToNextInterrupt();
      this._ticks++;
      this.controller.sfotty.crashed = false;
    }
    return n;
  }

  clock() {
    return this._ticks;
  }

  dimensions() {
    return { width: this.size, height: this.size };
  }

  /**
   * Get cell color and activity data for rendering.
   * Prefers RGB bitmap data (0x380-0x3BF) when nonzero,
   * falls back to activity-based HSV coloring from the visualizer.
   */
  getCell(x, y) {
    if (!this.memory) {
      return { rgb: [0, 0, 0], activity: 0, name: '' };
    }

    const cellIdx = this.memory.ijToCellIndex(x, y);
    const currentTime = this.controller.totalCycles;
    const timeSinceLastWrite = currentTime - (this.controller.lastWriteTime[cellIdx] || 0);
    const timeSinceLastMove = currentTime - (this.controller.lastMoveTime[cellIdx] || 0);
    const activity = Math.exp(-timeSinceLastWrite / 100) * 0.4 +
                     Math.exp(-timeSinceLastMove / 10) * 0.6;

    // Read RGB bitmap: just first byte of each channel (not OR of all 32)
    // Organisms write to the first byte; ORing all 32 mixes stale data
    const base = this.memory.ijbToByteIndex(x, y, 0);
    const bitmapR = this.memory.storage[base + 0x380];
    const bitmapG = this.memory.storage[base + 0x3A0];
    const bitmapB = this.memory.storage[base + 0x3C0];

    // Determine the dominant color from bitmap (which single channel is strongest?)
    const maxChannel = Math.max(bitmapR, bitmapG, bitmapB);
    let r, g, b;
    if (maxChannel > 128) {
      // Cell has strong bitmap signal — use it, scaled by activity
      const bright = Math.min(1.0, 0.3 + activity * 1.5);
      r = Math.floor(bitmapR * bright);
      g = Math.floor(bitmapG * bright);
      b = Math.floor(bitmapB * bright);
    } else if (this.visualizer) {
      // No bitmap -- use visualizer HSV coloring
      const rgb32 = this.visualizer.getOverviewPixelRGB(x, y);
      r = rgb32 & 0xFF;
      g = (rgb32 >> 8) & 0xFF;
      b = (rgb32 >> 16) & 0xFF;
    } else {
      // Last fallback: activity-based warm tone
      const v = Math.min(255, Math.floor(activity * 255));
      r = v; g = Math.floor(v * 0.7); b = Math.floor(v * 0.3);
    }

    const name = this.visualizer?.getCellName?.(x, y) || '';

    return { rgb: [r, g, b], activity, name };
  }

  summarize() {
    const B = this.size;
    const totalCells = B * B;
    const currentTime = this.controller.totalCycles;

    let activeCells = 0;
    const recentThreshold = 10000;
    for (let idx = 0; idx < totalCells; idx++) {
      const timeSinceWrite = currentTime - this.controller.lastWriteTime[idx];
      const timeSinceMove = currentTime - this.controller.lastMoveTime[idx];
      if (timeSinceWrite < recentThreshold || timeSinceMove < recentThreshold) {
        activeCells++;
      }
    }

    const hashes = new Set();
    for (let i = 0; i < B; i++) {
      for (let j = 0; j < B; j++) {
        const base = this.memory.ijbToByteIndex(i, j, 0);
        let h = 0x811c9dc5;
        for (let b = 0; b < this.memory.M; b++) {
          h ^= this.memory.getByte(base + b);
          h = Math.imul(h, 0x01000193);
        }
        hashes.add(h >>> 0);
      }
    }

    return {
      activeCells,
      totalCopies: this._totalCopies,
      totalSwaps: this._totalSwaps,
      uniqueHashes: hashes.size,
      ticks: this._ticks,
    };
  }

  async applyInput(input) {
    const action = input.action ?? input;
    if (action.type === 'inject') {
      await this._injectPreset(action.preset, action.cell);
    } else if (action.type === 'poke') {
      const [i, j] = action.cell;
      const idx = this.memory.ijbToByteIndex(i, j, action.offset);
      this.memory.setByteWithoutUndo(idx, action.value);
    }
  }

  /**
   * Read the boundary strip along the given edge.
   * Each cell = 1024 bytes, so the strip is size * 1024 bytes.
   * @param {'north'|'south'|'east'|'west'} edge
   * @returns {Uint8Array}
   */
  getBoundary(edge) {
    const B = this.size;
    const M = 1024;
    const cells = new Uint8Array(B * M);
    for (let k = 0; k < B; k++) {
      let i, j;
      switch (edge) {
        case 'north': i = k; j = 0; break;
        case 'south': i = k; j = B - 1; break;
        case 'west':  i = 0; j = k; break;
        case 'east':  i = B - 1; j = k; break;
        default: throw new Error(`Unknown edge: ${edge}`);
      }
      const cellData = readCellMemory(this.controller, i, j);
      cells.set(cellData, k * M);
    }
    return cells;
  }

  /**
   * Write a boundary strip received from a neighboring board.
   * @param {'north'|'south'|'east'|'west'} edge
   * @param {Uint8Array} data
   */
  setBoundary(edge, data) {
    const B = this.size;
    const M = 1024;
    for (let k = 0; k < B; k++) {
      let i, j;
      switch (edge) {
        case 'north': i = k; j = 0; break;
        case 'south': i = k; j = B - 1; break;
        case 'west':  i = 0; j = k; break;
        case 'east':  i = B - 1; j = k; break;
        default: throw new Error(`Unknown edge: ${edge}`);
      }
      const cellBytes = data.subarray(k * M, (k + 1) * M);
      writeCellBytes(this.controller, i, j, 0, cellBytes);
    }
  }
}
