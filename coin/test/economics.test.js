import { describe, it, expect } from 'vitest';
import {
  coinsEarned,
  decayedBalance,
  canAffordMove,
  computeBalance,
  DEFAULT_COIN_PARAMS,
} from '../economics.js';

describe('coinsEarned', () => {
  it('coins earned = ticks / T_coin', () => {
    expect(coinsEarned(1000, false)).toBe(1);
    expect(coinsEarned(5000, false)).toBe(5);
    expect(coinsEarned(500, false)).toBe(0.5);
  });

  it('sharing doubles earn rate', () => {
    expect(coinsEarned(1000, true)).toBe(2);
    expect(coinsEarned(5000, true)).toBe(10);
  });

  it('respects custom T_coin', () => {
    expect(coinsEarned(500, false, { T_coin: 500 })).toBe(1);
  });

  it('respects custom shareBoost', () => {
    expect(coinsEarned(1000, true, { shareBoost: 3 })).toBe(3);
  });

  it('returns 0 for 0 ticks', () => {
    expect(coinsEarned(0, false)).toBe(0);
    expect(coinsEarned(0, true)).toBe(0);
  });
});

describe('decayedBalance', () => {
  it('balance decays with half-life', () => {
    const halfLife = DEFAULT_COIN_PARAMS.coinHalfLife; // 100000
    expect(decayedBalance(100, halfLife)).toBeCloseTo(50);
    expect(decayedBalance(100, halfLife * 2)).toBeCloseTo(25);
    expect(decayedBalance(100, halfLife * 3)).toBeCloseTo(12.5);
  });

  it('no decay at 0 ticks', () => {
    expect(decayedBalance(100, 0)).toBe(100);
  });

  it('respects custom coinHalfLife', () => {
    expect(decayedBalance(100, 500, { coinHalfLife: 500 })).toBeCloseTo(50);
  });

  it('decay makes old coins worthless', () => {
    // After 20 half-lives, balance should be negligible
    const halfLife = DEFAULT_COIN_PARAMS.coinHalfLife;
    const remaining = decayedBalance(1000000, halfLife * 30);
    expect(remaining).toBeLessThan(0.001);
  });
});

describe('canAffordMove', () => {
  it('can afford when balance >= cost', () => {
    expect(canAffordMove(1)).toBe(true);
    expect(canAffordMove(10, 5)).toBe(true);
    expect(canAffordMove(1, 1)).toBe(true);
  });

  it('cannot afford when balance < cost', () => {
    expect(canAffordMove(0)).toBe(false);
    expect(canAffordMove(0.5)).toBe(false);
    expect(canAffordMove(4.9, 5)).toBe(false);
  });
});

describe('computeBalance', () => {
  it('computes balance from earn events', () => {
    const history = [
      { tick: 0, type: 'earn', amount: 10 },
    ];
    // No decay (currentTick = 0)
    expect(computeBalance(history, 0)).toBe(10);
  });

  it('computes balance with earn and spend', () => {
    const history = [
      { tick: 0, type: 'earn', amount: 10 },
      { tick: 0, type: 'spend', amount: 3 },
    ];
    expect(computeBalance(history, 0)).toBe(7);
  });

  it('applies decay between events', () => {
    const halfLife = 100000;
    const history = [
      { tick: 0, type: 'earn', amount: 100 },
      { tick: halfLife, type: 'earn', amount: 0 }, // just to observe decay
    ];
    // After one half-life, 100 decays to 50, then +0 = 50
    expect(computeBalance(history, halfLife)).toBeCloseTo(50);
  });

  it('applies final decay to currentTick', () => {
    const halfLife = 100000;
    const history = [
      { tick: 0, type: 'earn', amount: 100 },
    ];
    expect(computeBalance(history, halfLife)).toBeCloseTo(50);
    expect(computeBalance(history, halfLife * 2)).toBeCloseTo(25);
  });

  it('full scenario: earn, spend, decay', () => {
    const halfLife = 100000;
    const history = [
      { tick: 0, type: 'earn', amount: 100 },
      // At tick 100000: balance decayed to 50, then spend 10 -> 40
      { tick: halfLife, type: 'spend', amount: 10 },
    ];
    // At tick 100000: 40 remaining, query at that tick
    expect(computeBalance(history, halfLife)).toBeCloseTo(40);
    // Query at tick 200000: 40 decayed by one more half-life = 20
    expect(computeBalance(history, halfLife * 2)).toBeCloseTo(20);
  });

  it('empty history returns 0', () => {
    expect(computeBalance([], 10000)).toBe(0);
  });
});
