import { describe, it, expect } from 'vitest';
import { Xoshiro128ss } from '../prng.js';

describe('Xoshiro128ss', () => {
  it('produces deterministic output from the same seed', () => {
    const a = new Xoshiro128ss(42);
    const b = new Xoshiro128ss(42);
    for (let i = 0; i < 1000; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('produces different output from different seeds', () => {
    const a = new Xoshiro128ss(42);
    const b = new Xoshiro128ss(43);
    let same = 0;
    for (let i = 0; i < 100; i++) {
      if (a.next() === b.next()) same++;
    }
    expect(same).toBeLessThan(5);
  });

  it('random() returns values in [0, 1)', () => {
    const rng = new Xoshiro128ss(123);
    for (let i = 0; i < 10000; i++) {
      const v = rng.random();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('serializes and deserializes correctly', () => {
    const a = new Xoshiro128ss(99);
    // Advance some steps
    for (let i = 0; i < 500; i++) a.next();

    const state = a.serialize();
    expect(state.length).toBe(16);

    // Continue with original
    const vals1 = [];
    for (let i = 0; i < 100; i++) vals1.push(a.next());

    // Restore and continue
    const b = new Xoshiro128ss(0);
    b.deserialize(state);
    const vals2 = [];
    for (let i = 0; i < 100; i++) vals2.push(b.next());

    expect(vals1).toEqual(vals2);
  });
});
