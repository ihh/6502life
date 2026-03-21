/**
 * 6502coin Engine Interface
 *
 * Every game engine must implement this interface. The engine is a black box
 * that advances a grid simulation deterministically.
 *
 * @module coin/engine
 */

/**
 * @typedef {'north' | 'south' | 'east' | 'west'} Edge
 */

/**
 * @typedef {Object} EngineConfig
 * @property {string} gameId - Identifier for the game type (e.g. 'life', '6502life')
 * @property {number} width - Board width in cells
 * @property {number} height - Board height in cells
 * @property {number} seed - PRNG seed for deterministic simulation
 * @property {Record<string, unknown>} [rules] - Game-specific rule configuration
 */

/**
 * @typedef {Object} Input
 * @property {number} tick - Simulation clock tick at which this input is applied
 * @property {Record<string, unknown>} action - Opaque action payload
 */

/**
 * @typedef {Object} CellView
 * @property {number} x - Grid x coordinate
 * @property {number} y - Grid y coordinate
 * @property {Uint8Array} state - Opaque state blob
 * @property {Record<string, string|number>} [meta] - Optional rendering metadata
 */

/**
 * Engine interface specification.
 *
 * All methods documented here must be implemented by any conforming engine.
 * This class serves as documentation and a base that throws "not implemented"
 * errors if methods are called without override.
 */
export class Engine {
  /**
   * Initialize the engine with a configuration.
   * @param {EngineConfig} config
   */
  init(config) {
    throw new Error('Engine.init() not implemented');
  }

  /**
   * Advance the simulation by n steps (default 1).
   * Returns the number of steps actually executed.
   * @param {number} [n=1]
   * @returns {number}
   */
  step(n = 1) {
    throw new Error('Engine.step() not implemented');
  }

  /**
   * Apply a timestamped player input deterministically.
   * @param {Input} input
   */
  applyInput(input) {
    throw new Error('Engine.applyInput() not implemented');
  }

  /**
   * Serialize complete engine state to a byte array.
   * Must be canonical: same state always produces identical bytes.
   * @returns {Uint8Array}
   */
  serialize() {
    throw new Error('Engine.serialize() not implemented');
  }

  /**
   * Restore engine state from a previous serialize() output.
   * @param {Uint8Array} data
   */
  deserialize(data) {
    throw new Error('Engine.deserialize() not implemented');
  }

  /**
   * Read the boundary strip along the given edge.
   * @param {Edge} edge
   * @returns {Uint8Array}
   */
  getBoundary(edge) {
    throw new Error('Engine.getBoundary() not implemented');
  }

  /**
   * Write a boundary strip received from a neighboring board.
   * @param {Edge} edge
   * @param {Uint8Array} data
   */
  setBoundary(edge, data) {
    throw new Error('Engine.setBoundary() not implemented');
  }

  /**
   * Return the current simulation clock value (integer ticks).
   * @returns {number}
   */
  clock() {
    throw new Error('Engine.clock() not implemented');
  }

  /**
   * Return board dimensions and cell access.
   * @returns {{ width: number, height: number }}
   */
  dimensions() {
    throw new Error('Engine.dimensions() not implemented');
  }

  /**
   * Get a single cell's view.
   * @param {number} x
   * @param {number} y
   * @returns {CellView}
   */
  getCell(x, y) {
    throw new Error('Engine.getCell() not implemented');
  }

  /**
   * Return summary statistics for anti-cheat / interest scoring.
   * Engine-specific; returns a plain object of verifiable stats.
   * @returns {Record<string, number>}
   */
  summarize() {
    throw new Error('Engine.summarize() not implemented');
  }
}
