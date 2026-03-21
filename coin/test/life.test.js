import { describe, it, expect } from 'vitest';
import { LifeEngine } from '../engines/life.js';
import { sha256, toHex } from '../hash.js';

describe('LifeEngine', () => {
  function makeEngine(seed = 42, size = 16) {
    const engine = new LifeEngine();
    engine.init({ gameId: 'life', width: size, height: size, seed });
    return engine;
  }

  it('produces deterministic state from the same seed', () => {
    const a = makeEngine(42, 32);
    const b = makeEngine(42, 32);

    a.step(1000);
    b.step(1000);

    const sa = a.serialize();
    const sb = b.serialize();
    expect(toHex(sa)).toBe(toHex(sb));
  });

  it('produces different state from different seeds', () => {
    const a = makeEngine(42, 16);
    const b = makeEngine(43, 16);

    a.step(100);
    b.step(100);

    expect(toHex(a.serialize())).not.toBe(toHex(b.serialize()));
  });

  it('serialize/deserialize round-trips exactly', () => {
    const engine = makeEngine(42, 16);
    engine.step(500);

    const state = engine.serialize();
    const hash1 = toHex(sha256(state));

    // Deserialize into a fresh engine
    const engine2 = new LifeEngine();
    engine2.init({ gameId: 'life', width: 16, height: 16, seed: 0 });
    engine2.deserialize(state);

    // State should be identical
    const state2 = engine2.serialize();
    expect(toHex(sha256(state2))).toBe(hash1);

    // Further evolution should also be identical
    engine.step(200);
    engine2.step(200);
    expect(toHex(engine.serialize())).toBe(toHex(engine2.serialize()));
  });

  it('clock advances correctly', () => {
    const engine = makeEngine(42, 8);
    expect(engine.clock()).toBe(0);
    engine.step(10);
    expect(engine.clock()).toBe(10);
    engine.step(5);
    expect(engine.clock()).toBe(15);
  });

  it('deterministic after 10000 steps', () => {
    const a = makeEngine(12345, 32);
    const b = makeEngine(12345, 32);

    a.step(10000);
    b.step(10000);

    expect(toHex(sha256(a.serialize()))).toBe(toHex(sha256(b.serialize())));
  });

  it('applyInput sets cells correctly', () => {
    const engine = makeEngine(42, 8);
    engine.step(10);

    // Set a specific cell
    engine.applyInput({ tick: 10, action: { type: 'set', x: 0, y: 0, value: 1 } });
    expect(engine.getCell(0, 0).state[0]).toBe(1);

    engine.applyInput({ tick: 10, action: { type: 'set', x: 0, y: 0, value: 0 } });
    expect(engine.getCell(0, 0).state[0]).toBe(0);
  });

  it('boundary get/set works', () => {
    const engine = makeEngine(42, 8);
    engine.step(5);

    const north = engine.getBoundary('north');
    expect(north.length).toBe(8);

    const south = engine.getBoundary('south');
    expect(south.length).toBe(8);

    const east = engine.getBoundary('east');
    expect(east.length).toBe(8);

    const west = engine.getBoundary('west');
    expect(west.length).toBe(8);

    // Set boundary and verify it took effect
    const newBoundary = new Uint8Array(8).fill(1);
    engine.setBoundary('north', newBoundary);
    const readBack = engine.getBoundary('north');
    expect(Array.from(readBack)).toEqual(Array.from(newBoundary));
  });

  it('summarize returns valid stats', () => {
    const engine = makeEngine(42, 16);
    engine.step(100);

    const summary = engine.summarize();
    expect(summary.liveCells).toBeGreaterThanOrEqual(0);
    expect(summary.liveCells).toBeLessThanOrEqual(256);
    expect(summary.totalCells).toBe(256);
    expect(summary.density).toBeGreaterThanOrEqual(0);
    expect(summary.density).toBeLessThanOrEqual(1);
    expect(summary.clock).toBe(100);
    expect(summary.totalBorn).toBeGreaterThan(0);
    expect(summary.totalDied).toBeGreaterThan(0);
  });

  it('dimensions returns correct values', () => {
    const engine = makeEngine(42, 16);
    expect(engine.dimensions()).toEqual({ width: 16, height: 16 });
  });
});
