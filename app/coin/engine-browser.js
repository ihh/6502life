/**
 * Browser-compatible 6502life engine adapter.
 * Wraps BoardMemory + BoardController + BoardVisualizer for the coin PWA.
 *
 * Prefers WASM engine in browsers, falls back to Sfotty.
 * Check Board6502Engine.backend after init() to see which is active.
 */

import { createBoard, createBoardAsync, writeCellBytes, readCellMemory } from '@engine/board.js';
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
    /** @type {'wasm'|'sfotty'|null} */
    this.backend = null;
    this._wasmInner = null;
  }

  async init(config) {
    this.size = config.size ?? config.width ?? 16;
    const seed = config.seed ?? 42;
    const noiseParams = config.pBitNoise != null ? { pBitNoise: config.pBitNoise } : undefined;

    // Try WASM first, fall back to Sfotty
    const board = await createBoardAsync(this.size, seed, noiseParams);
    this.backend = createBoardAsync.backend;
    this.memory = board.memory;
    this.controller = board.controller;
    this.visualizer = board.visualizer;
    this._wasmInner = board._wasmInner ?? null;

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

    console.log(`6502life engine: using ${this.backend} backend`);
  }

  async ready() {
    return this._presetReady;
  }

  async _injectPreset(name, cell) {
    const preset = getPreset(name);
    if (!preset) throw new Error(`Unknown preset: ${name}`);
    const bytes = await assemble(preset.source);
    const [i, j] = cell;
    if (this._wasmInner) {
      // Use WASM's native write_cell_bytes for efficiency
      this._wasmInner.write_cell_bytes(i, j, 0, bytes);
    } else {
      writeCellBytes(this.controller, i, j, 0, bytes);
    }
  }

  step(n = 1) {
    if (this._wasmInner) {
      // Use WASM's batch interrupt runner for speed
      this._wasmInner.run_interrupts(n);
      this._ticks += n;
    } else {
      for (let s = 0; s < n; s++) {
        this.controller.runToNextInterrupt();
        this._ticks++;
        this.controller.sfotty.crashed = false;
      }
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
    if (this._wasmInner) {
      // Use WASM overview buffer directly
      const buf = this._wasmInner.overview_pixel_buffer();
      const idx = (x * this.size + y) * 4;
      const r = buf[idx];
      const g = buf[idx + 1];
      const b = buf[idx + 2];

      const cellIdx = x * this.size + y;
      const currentTime = Number(this._wasmInner.total_cycles());
      const timeSinceLastWrite = currentTime - Number(this._wasmInner.last_write_time(cellIdx));
      const timeSinceLastMove = currentTime - Number(this._wasmInner.last_move_time(cellIdx));
      const activity = Math.exp(-timeSinceLastWrite / 100) * 0.4 +
                       Math.exp(-timeSinceLastMove / 10) * 0.6;

      const name = this._wasmInner.cell_name(x, y);

      return { rgb: [r, g, b], activity, name };
    }

    // Sfotty path (unchanged)
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

    if (this._wasmInner) {
      const currentTime = Number(this._wasmInner.total_cycles());
      let activeCells = 0;
      const recentThreshold = 10000;
      for (let idx = 0; idx < totalCells; idx++) {
        const timeSinceWrite = currentTime - Number(this._wasmInner.last_write_time(idx));
        const timeSinceMove = currentTime - Number(this._wasmInner.last_move_time(idx));
        if (timeSinceWrite < recentThreshold || timeSinceMove < recentThreshold) {
          activeCells++;
        }
      }

      const hashes = new Set();
      const M = 1024;
      for (let i = 0; i < B; i++) {
        for (let j = 0; j < B; j++) {
          const base = (i * B + j) * M;
          let h = 0x811c9dc5;
          for (let b = 0; b < M; b++) {
            h ^= this._wasmInner.get_byte(base + b);
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

    // Sfotty path (unchanged)
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
      if (this._wasmInner) {
        const M = 1024;
        const idx = (i * this.size + j) * M + action.offset;
        this._wasmInner.set_byte(idx, action.value);
      } else {
        const idx = this.memory.ijbToByteIndex(i, j, action.offset);
        this.memory.setByteWithoutUndo(idx, action.value);
      }
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

    if (this._wasmInner) {
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
        const base = (i * B + j) * M;
        for (let b = 0; b < M; b++) {
          cells[k * M + b] = this._wasmInner.get_byte(base + b);
        }
      }
      return cells;
    }

    // Sfotty path
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
      if (this._wasmInner) {
        this._wasmInner.write_cell_bytes(i, j, 0, cellBytes);
      } else {
        writeCellBytes(this.controller, i, j, 0, cellBytes);
      }
    }
  }
}
