/**
 * 6502life Engine Adapter for 6502coin.
 *
 * Wraps BoardMemory + BoardController as a coin Engine.
 * Each step() runs one interrupt (runToNextInterrupt).
 *
 * @module coin/engines/board6502
 */

import { Engine } from '../engine.js';
import { createBoard, writeCellBytes, readCellMemory, zeroAllCells } from '../../engine/board.js';
import { assemble } from '../../engine/assembler.js';
import { getPreset } from '../../cli/lib/terminal/presets.js';

export class Board6502Engine extends Engine {
  constructor() {
    super();
    /** @type {import('../../board/controller.js').BoardController|null} */
    this.controller = null;
    /** @type {import('../../board/memory.js').BoardMemory|null} */
    this.memory = null;
    /** @type {import('../../board/visualizer.js').BoardVisualizer|null} */
    this.visualizer = null;
    /** @type {number} */
    this.size = 0;
    /** @type {number} */
    this._ticks = 0;
    /** @type {number} */
    this._totalCopies = 0;
    /** @type {number} */
    this._totalSwaps = 0;
  }

  /**
   * @param {Object} config
   * @param {number} [config.size=16]
   * @param {number} [config.seed=42]
   * @param {number} [config.pBitNoise]
   * @param {Array<{name: string, cell: [number, number]}>} [config.presets]
   */
  init(config) {
    this.size = config.size ?? config.width ?? 16;
    const seed = config.seed ?? 42;
    const noiseParams = config.pBitNoise != null ? { pBitNoise: config.pBitNoise } : undefined;

    const board = createBoard(this.size, seed, noiseParams);
    this.memory = board.memory;
    this.controller = board.controller;
    this.visualizer = board.visualizer;

    // Ensure deterministic initial CPU state by loading registers from storage.
    // The Sfotty constructor initializes registers randomly, so we must
    // overwrite them with the values stored in cell memory.
    this.controller.readRegisters();

    this._ticks = 0;
    this._totalCopies = 0;
    this._totalSwaps = 0;

    // Install BRK event hook to count copies and swaps
    this.controller.onBrkEvent = (type, src, dest) => {
      if (type === 'copy') this._totalCopies++;
      else if (type === 'swap') this._totalSwaps++;
    };

    // Load presets if specified (returns a promise if presets are present)
    if (config.presets && config.presets.length > 0) {
      this._presetReady = Promise.all(
        config.presets.map(p => this._injectPreset(p.name, p.cell))
      );
    } else {
      this._presetReady = Promise.resolve();
    }
  }

  /**
   * Wait for any async initialization (preset loading) to complete.
   * @returns {Promise<void>}
   */
  async ready() {
    return this._presetReady;
  }

  /**
   * Inject a preset program into a cell.
   * @param {string} name - preset name
   * @param {number[]} cell - [i, j]
   */
  async _injectPreset(name, cell) {
    const preset = getPreset(name);
    if (!preset) throw new Error(`Unknown preset: ${name}`);
    const bytes = await assemble(preset.source);
    const [i, j] = cell;
    writeCellBytes(this.controller, i, j, 0, bytes);
  }

  /**
   * Run n interrupts.
   * @param {number} [n=1]
   * @returns {number}
   */
  step(n = 1) {
    for (let s = 0; s < n; s++) {
      this.controller.runToNextInterrupt();
      this._ticks++;
      // Reset crashed state so the next interrupt starts cleanly
      this.controller.sfotty.crashed = false;
    }
    return n;
  }

  /**
   * Serialize the full board state to a JSON string (as Uint8Array).
   * Uses controller.state which uses Array serialization for storage.
   * @returns {Uint8Array}
   */
  serialize() {
    const state = {
      board: this.controller.state,
      totalCycles: this.controller.totalCycles,
      lastWriteTime: this.controller.lastWriteTime,
      lastMoveTime: this.controller.lastMoveTime,
      lastWriter: this.controller.lastWriter,
      ticks: this._ticks,
      totalCopies: this._totalCopies,
      totalSwaps: this._totalSwaps,
      size: this.size,
    };
    const json = JSON.stringify(state);
    return new TextEncoder().encode(json);
  }

  /**
   * Restore engine state from serialize() output.
   * @param {Uint8Array} data
   */
  deserialize(data) {
    const json = new TextDecoder().decode(data);
    const state = JSON.parse(json);
    this.controller.state = state.board;
    this.controller.totalCycles = state.totalCycles;
    this.controller.lastWriteTime = state.lastWriteTime;
    this.controller.lastMoveTime = state.lastMoveTime;
    if (state.lastWriter)
      this.controller.lastWriter = state.lastWriter;
    this._ticks = state.ticks;
    this._totalCopies = state.totalCopies;
    this._totalSwaps = state.totalSwaps;
    this.size = state.size;
  }

  /**
   * Apply a player input action.
   * Supported types:
   *   - {type: 'inject', preset: string, cell: [i, j]}
   *   - {type: 'poke', cell: [i, j], offset: number, value: number}
   * @param {import('../engine.js').Input} input
   */
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
   * Return cells along an edge. Each cell = 1024 bytes.
   * @param {import('../engine.js').Edge} edge
   * @returns {Uint8Array}
   */
  getBoundary(edge) {
    const B = this.size;
    const M = this.memory.M; // 1024
    let cells;

    switch (edge) {
      case 'north':
        cells = new Uint8Array(B * M);
        for (let x = 0; x < B; x++) {
          const cellData = readCellMemory(this.controller, x, 0);
          cells.set(cellData, x * M);
        }
        return cells;
      case 'south':
        cells = new Uint8Array(B * M);
        for (let x = 0; x < B; x++) {
          const cellData = readCellMemory(this.controller, x, B - 1);
          cells.set(cellData, x * M);
        }
        return cells;
      case 'west':
        cells = new Uint8Array(B * M);
        for (let y = 0; y < B; y++) {
          const cellData = readCellMemory(this.controller, 0, y);
          cells.set(cellData, y * M);
        }
        return cells;
      case 'east':
        cells = new Uint8Array(B * M);
        for (let y = 0; y < B; y++) {
          const cellData = readCellMemory(this.controller, B - 1, y);
          cells.set(cellData, y * M);
        }
        return cells;
      default:
        throw new Error(`Unknown edge: ${edge}`);
    }
  }

  /**
   * Write a boundary strip received from a neighboring board.
   * @param {import('../engine.js').Edge} edge
   * @param {Uint8Array} data
   */
  setBoundary(edge, data) {
    const B = this.size;
    const M = this.memory.M; // 1024

    switch (edge) {
      case 'north':
        for (let x = 0; x < B; x++) {
          writeCellBytes(this.controller, x, 0, 0, data.subarray(x * M, (x + 1) * M));
        }
        break;
      case 'south':
        for (let x = 0; x < B; x++) {
          writeCellBytes(this.controller, x, B - 1, 0, data.subarray(x * M, (x + 1) * M));
        }
        break;
      case 'west':
        for (let y = 0; y < B; y++) {
          writeCellBytes(this.controller, 0, y, 0, data.subarray(y * M, (y + 1) * M));
        }
        break;
      case 'east':
        for (let y = 0; y < B; y++) {
          writeCellBytes(this.controller, B - 1, y, 0, data.subarray(y * M, (y + 1) * M));
        }
        break;
      default:
        throw new Error(`Unknown edge: ${edge}`);
    }
  }

  /**
   * @returns {number}
   */
  clock() {
    return this._ticks;
  }

  /**
   * @returns {{ width: number, height: number }}
   */
  dimensions() {
    return { width: this.size, height: this.size };
  }

  /**
   * Get a cell view for rendering.
   * @param {number} x - column (i coordinate)
   * @param {number} y - row (j coordinate)
   * @returns {{ rgb: [number, number, number], activity: number, name: string }}
   */
  getCell(x, y) {
    // Use visualizer's overview color logic
    const rgb32 = this.visualizer.getOverviewPixelRGB(x, y);
    const r = rgb32 & 0xFF;
    const g = (rgb32 >> 8) & 0xFF;
    const b = (rgb32 >> 16) & 0xFF;

    // Activity: 0-1 based on recency of writes/moves
    const cellIdx = this.memory.ijToCellIndex(x, y);
    const currentTime = this.controller.totalCycles;
    const timeSinceLastWrite = currentTime - this.controller.lastWriteTime[cellIdx];
    const timeSinceLastMove = currentTime - this.controller.lastMoveTime[cellIdx];
    const activity = Math.exp(-timeSinceLastWrite / 100) * 0.4 +
                     Math.exp(-timeSinceLastMove / 10) * 0.6;

    // Cell name
    const name = this.visualizer.getCellName(x, y);

    return { rgb: [r, g, b], activity, name };
  }

  /**
   * Summary statistics for anti-cheat / interest scoring.
   * @returns {Record<string, number>}
   */
  summarize() {
    const B = this.size;
    const totalCells = B * B;
    const currentTime = this.controller.totalCycles;

    // Count cells with recent writes (within last 10000 cycles)
    let activeCells = 0;
    const recentThreshold = 10000;
    for (let idx = 0; idx < totalCells; idx++) {
      const timeSinceWrite = currentTime - this.controller.lastWriteTime[idx];
      const timeSinceMove = currentTime - this.controller.lastMoveTime[idx];
      if (timeSinceWrite < recentThreshold || timeSinceMove < recentThreshold) {
        activeCells++;
      }
    }

    // Simple hash-based uniqueness: count distinct 32-bit checksums across cells
    const hashes = new Set();
    for (let i = 0; i < B; i++) {
      for (let j = 0; j < B; j++) {
        const base = this.memory.ijbToByteIndex(i, j, 0);
        // Simple FNV-1a-like hash of cell contents
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
}
