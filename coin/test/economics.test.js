import { describe, it, expect } from 'vitest';
import { soloMiningRate, computeCoinValue, DEFAULT_COIN_PARAMS } from '../economics.js';

describe('soloMiningRate', () => {
  it('returns 1.0 at 0 hours', () => {
    expect(soloMiningRate(0)).toBe(1.0);
  });

  it('returns 0.5 at 24 hours (one half-life)', () => {
    expect(soloMiningRate(24)).toBe(0.5);
  });

  it('returns 0.25 at 48 hours', () => {
    expect(soloMiningRate(48)).toBe(0.25);
  });

  it('floors at 1/128 at 168 hours (1 week)', () => {
    // 168 / 24 = 7 halvings => 2^-7 = 1/128
    expect(soloMiningRate(168)).toBe(1 / 128);
  });

  it('stays at floor beyond 1 week', () => {
    expect(soloMiningRate(500)).toBe(1 / 128);
  });

  it('respects custom soloHalfLife', () => {
    expect(soloMiningRate(12, { soloHalfLife: 12 })).toBe(0.5);
  });

  it('respects custom minSoloRate', () => {
    expect(soloMiningRate(168, { minSoloRate: 0.1 })).toBeCloseTo(0.1);
  });
});

describe('computeCoinValue', () => {
  const baseSession = {
    sessionId: 'test',
    gameId: 'test',
    totalTicks: 50000,
    wallTimeMs: 60000,
    blockCount: 5,
    isSocial: false,
    partnerPubkey: null,
    lastSummary: {},
  };

  it('returns full rate for solo with no pairing history', () => {
    const result = computeCoinValue(baseSession, {});
    expect(result.baseCoins).toBe(5);
    expect(result.soloRate).toBe(1.0);
    expect(result.socialMultiplier).toBe(1.0);
    expect(result.nicheBonus).toBe(0);
    expect(result.totalCoins).toBe(5);
  });

  it('applies solo decay based on lastPairingTime', () => {
    const now = Date.now();
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
    const result = computeCoinValue(baseSession, {
      lastPairingTime: twentyFourHoursAgo,
      isSocial: false,
      nicheEvents: 0,
      now,
    });
    expect(result.soloRate).toBe(0.5);
    expect(result.totalCoins).toBe(5 * 0.5);
  });

  it('applies social multiplier during social session', () => {
    const result = computeCoinValue(
      { ...baseSession, isSocial: true },
      { isSocial: true, nicheEvents: 0 },
    );
    expect(result.socialMultiplier).toBe(1.5);
    expect(result.soloRate).toBe(1.0); // no decay during social
    expect(result.totalCoins).toBe(5 * 1.5);
  });

  it('adds niche bonus per event', () => {
    const result = computeCoinValue(baseSession, {
      isSocial: false,
      nicheEvents: 3,
    });
    expect(result.nicheBonus).toBeCloseTo(3 * 0.69);
    expect(result.totalCoins).toBeCloseTo(5 + 3 * 0.69);
  });

  it('combines all components correctly', () => {
    const now = Date.now();
    const fortyEightHoursAgo = now - 48 * 60 * 60 * 1000;
    const result = computeCoinValue(baseSession, {
      lastPairingTime: fortyEightHoursAgo,
      isSocial: false,
      nicheEvents: 2,
      now,
    });
    // solo rate at 48h = 0.25, not social so mult=1.0, niche=2*0.69
    expect(result.soloRate).toBe(0.25);
    expect(result.socialMultiplier).toBe(1.0);
    expect(result.nicheBonus).toBeCloseTo(2 * 0.69);
    expect(result.totalCoins).toBeCloseTo(5 * 0.25 + 2 * 0.69);
  });

  it('allows custom coinParams', () => {
    const result = computeCoinValue(
      { ...baseSession, isSocial: true },
      { isSocial: true, nicheEvents: 1 },
      { socialMultiplier: 2.0, nicheBonus: 1.0 },
    );
    expect(result.socialMultiplier).toBe(2.0);
    expect(result.nicheBonus).toBe(1.0);
    expect(result.totalCoins).toBe(5 * 2.0 + 1.0);
  });
});
