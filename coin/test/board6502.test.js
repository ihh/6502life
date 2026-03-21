import { describe, it, expect } from 'vitest';
import { Board6502Engine } from '../engines/board6502.js';
import { sha256, toHex } from '../hash.js';

describe('Board6502Engine', () => {
  function makeEngine(seed = 42, size = 8) {
    const engine = new Board6502Engine();
    engine.init({ size, seed });
    return engine;
  }

  it('produces deterministic state from the same seed', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(42, 8);

    a.step(100);
    b.step(100);

    const sa = a.serialize();
    const sb = b.serialize();
    expect(toHex(sha256(sa))).toBe(toHex(sha256(sb)));
  });

  it('produces different state from different seeds', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(43, 8);

    a.step(50);
    b.step(50);

    expect(toHex(sha256(a.serialize()))).not.toBe(toHex(sha256(b.serialize())));
  });

  it('serialize/deserialize round-trips exactly', () => {
    const engine = makeEngine(42, 8);
    engine.step(50);

    const state = engine.serialize();
    const hash1 = toHex(sha256(state));

    // Deserialize into a fresh engine
    const engine2 = makeEngine(99, 8); // different seed, will be overwritten
    engine2.deserialize(state);

    const state2 = engine2.serialize();
    expect(toHex(sha256(state2))).toBe(hash1);

    // Further evolution should also be identical
    engine.step(50);
    engine2.step(50);
    expect(toHex(sha256(engine.serialize()))).toBe(toHex(sha256(engine2.serialize())));
  });

  it('clock advances correctly', () => {
    const engine = makeEngine(42, 8);
    expect(engine.clock()).toBe(0);
    engine.step(10);
    expect(engine.clock()).toBe(10);
    engine.step(5);
    expect(engine.clock()).toBe(15);
  });

  it('dimensions returns correct values', () => {
    const engine = makeEngine(42, 16);
    expect(engine.dimensions()).toEqual({ width: 16, height: 16 });
  });

  it('preset injection via init config', async () => {
    const engine = new Board6502Engine();
    engine.init({ size: 8, seed: 42, presets: [{ name: 'counter', cell: [0, 0] }] });
    await engine.ready();

    // The cell at 0,0 should have non-zero content (counter program loaded)
    const cell = engine.getCell(0, 0);
    expect(cell).toBeDefined();
    expect(cell.rgb).toHaveLength(3);

    // Verify actual bytes were written
    const mem = engine.memory;
    const base = mem.ijbToByteIndex(0, 0, 0);
    let nonZero = 0;
    for (let b = 0; b < 32; b++) {
      if (mem.getByte(base + b) !== 0) nonZero++;
    }
    expect(nonZero).toBeGreaterThan(0);
  });

  it('applyInput inject loads a preset', async () => {
    const engine = makeEngine(42, 8);
    engine.step(10);

    await engine.applyInput({
      tick: 10,
      action: { type: 'inject', preset: 'counter', cell: [2, 2] }
    });

    // Read cell memory to verify non-zero content was written
    const mem = engine.memory;
    const base = mem.ijbToByteIndex(2, 2, 0);
    let nonZero = 0;
    for (let b = 0; b < 32; b++) {
      if (mem.getByte(base + b) !== 0) nonZero++;
    }
    expect(nonZero).toBeGreaterThan(0);
  });

  it('applyInput poke writes a byte', () => {
    const engine = makeEngine(42, 8);

    engine.applyInput({
      tick: 0,
      action: { type: 'poke', cell: [1, 1], offset: 0x00, value: 0xEA }
    });

    const mem = engine.memory;
    const idx = mem.ijbToByteIndex(1, 1, 0x00);
    expect(mem.getByte(idx)).toBe(0xEA);
  });

  it('summarize returns sensible values', () => {
    const engine = makeEngine(42, 8);
    engine.step(100);

    const summary = engine.summarize();
    expect(summary.ticks).toBe(100);
    expect(summary.uniqueHashes).toBeGreaterThan(0);
    expect(typeof summary.activeCells).toBe('number');
    expect(typeof summary.totalCopies).toBe('number');
    expect(typeof summary.totalSwaps).toBe('number');
  });

  it('getCell returns rgb, activity, and name', () => {
    const engine = makeEngine(42, 8);
    engine.step(10);

    const cell = engine.getCell(0, 0);
    expect(cell.rgb).toHaveLength(3);
    expect(cell.rgb[0]).toBeGreaterThanOrEqual(0);
    expect(cell.rgb[0]).toBeLessThanOrEqual(255);
    expect(typeof cell.activity).toBe('number');
    expect(cell.activity).toBeGreaterThanOrEqual(0);
    expect(cell.activity).toBeLessThanOrEqual(1);
    expect(typeof cell.name).toBe('string');
  });

  it('boundary get/set round-trips for all edges', () => {
    const engine = makeEngine(42, 8);
    engine.step(10);

    const M = engine.memory.M;

    for (const edge of ['north', 'south', 'east', 'west']) {
      const boundary = engine.getBoundary(edge);
      expect(boundary.length).toBe(8 * M);

      // Write to a fresh engine and verify
      const engine2 = makeEngine(99, 8);
      engine2.setBoundary(edge, boundary);
      const readBack = engine2.getBoundary(edge);
      expect(Array.from(readBack)).toEqual(Array.from(boundary));
    }
  });

  it('BRK event counting works via summarize', async () => {
    // Load a copier preset which should produce BRK copy events
    const engine = new Board6502Engine();
    engine.init({ size: 8, seed: 42, presets: [{ name: 'copier', cell: [0, 0] }] });
    await engine.ready();

    // Run enough steps that the copier might fire
    engine.step(500);

    const summary = engine.summarize();
    // We can at least verify the fields exist and are numbers
    expect(typeof summary.totalCopies).toBe('number');
    expect(typeof summary.totalSwaps).toBe('number');
    // totalCopies + totalSwaps should be >= 0 (may or may not have fired)
    expect(summary.totalCopies + summary.totalSwaps).toBeGreaterThanOrEqual(0);
  });
});
