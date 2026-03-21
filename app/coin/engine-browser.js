/**
 * Browser-compatible 6502life engine adapter.
 * Wraps BoardMemory + BoardController + BoardVisualizer for the coin PWA.
 * Replaces Node-only imports (presets, hash) with browser equivalents.
 */

import { createBoard, writeCellBytes } from '@engine/board.js';
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
  }

  init(config) {
    this.size = config.size ?? config.width ?? 16;
    const seed = config.seed ?? 42;
    const noiseParams = config.pBitNoise != null ? { pBitNoise: config.pBitNoise } : undefined;

    const board = createBoard(this.size, seed, noiseParams);
    this.memory = board.memory;
    this.controller = board.controller;
    this.visualizer = board.visualizer;

    this.controller.readRegisters();

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

  getCell(x, y) {
    const rgb32 = this.visualizer.getOverviewPixelRGB(x, y);
    const r = rgb32 & 0xFF;
    const g = (rgb32 >> 8) & 0xFF;
    const b = (rgb32 >> 16) & 0xFF;

    const cellIdx = this.memory.ijToCellIndex(x, y);
    const currentTime = this.controller.totalCycles;
    const timeSinceLastWrite = currentTime - this.controller.lastWriteTime[cellIdx];
    const timeSinceLastMove = currentTime - this.controller.lastMoveTime[cellIdx];
    const activity = Math.exp(-timeSinceLastWrite / 100) * 0.4 +
                     Math.exp(-timeSinceLastMove / 10) * 0.6;

    const name = this.visualizer.getCellName(x, y);

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
}
