import { describe, it, expect } from 'vitest';
import { verifyEconomics } from '../verify-economics.js';
import { DEFAULT_COIN_PARAMS } from '../economics.js';
import { Session } from '../session.js';
import { LifeEngine } from '../engines/life.js';

describe('verifyEconomics', () => {
  it('session with no inputs is always valid', () => {
    const record = {
      blocks: [
        { index: 0, startTick: 0, endTick: 1000, inputs: [] },
        { index: 1, startTick: 1000, endTick: 2000, inputs: [] },
      ]
    };
    const result = verifyEconomics(record);
    expect(result.valid).toBe(true);
    expect(result.finalBalance).toBeGreaterThan(0);
  });

  it('affordable inputs pass', () => {
    // Default: earn 1 coin per 1000 ticks, cost 1 per move
    // After 2000 ticks, balance ≈ 2 (minus decay). One input should be fine.
    const record = {
      blocks: [
        { index: 0, startTick: 0, endTick: 2000, inputs: [{ tick: 1500, action: {} }] },
      ]
    };
    const result = verifyEconomics(record);
    expect(result.valid).toBe(true);
  });

  it('too many inputs too early fails', () => {
    // 5 inputs at tick 10 — balance is ~0.01 coins, can't afford 5 moves
    const record = {
      blocks: [{
        index: 0, startTick: 0, endTick: 100,
        inputs: Array.from({ length: 5 }, (_, i) => ({ tick: 10, action: {} }))
      }]
    };
    const result = verifyEconomics(record);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Insufficient coins/);
  });

  it('inputs spread over time pass', () => {
    // 1 input every 2000 ticks — earns ~2 coins between each
    const record = {
      blocks: [{
        index: 0, startTick: 0, endTick: 10000,
        inputs: [
          { tick: 2000, action: {} },
          { tick: 4000, action: {} },
          { tick: 6000, action: {} },
          { tick: 8000, action: {} },
        ]
      }]
    };
    const result = verifyEconomics(record);
    expect(result.valid).toBe(true);
  });

  it('respects custom coin params', () => {
    // With moveCost=0, any number of inputs is fine
    const record = {
      blocks: [{
        index: 0, startTick: 0, endTick: 10,
        inputs: Array.from({ length: 100 }, () => ({ tick: 5, action: {} }))
      }]
    };
    const result = verifyEconomics(record, { coinParams: { moveCost: 0 } });
    expect(result.valid).toBe(true);
  });

  it('sharing boost increases earn rate', () => {
    // Without sharing: 1 coin per 1000 ticks. 2 inputs at tick 500 needs 2 coins.
    // Balance at tick 500 is ~0.5, insufficient.
    const record = {
      blocks: [{
        index: 0, startTick: 0, endTick: 1000,
        inputs: [{ tick: 500, action: {} }, { tick: 500, action: {} }]
      }]
    };
    const noShare = verifyEconomics(record, { isSharing: false });
    expect(noShare.valid).toBe(false);

    // With sharing (2x boost): earn rate doubles. At tick 500, balance ≈ 1.0. Still not 2.
    // But with higher boost:
    const boosted = verifyEconomics(record, {
      isSharing: true,
      coinParams: { shareBoost: 10 }
    });
    expect(boosted.valid).toBe(true);
  });

  it('initial balance carries over', () => {
    const record = {
      blocks: [{
        index: 0, startTick: 0, endTick: 10,
        inputs: [{ tick: 1, action: {} }]
      }]
    };
    // Without initial balance: ~0.001 coins at tick 1, insufficient
    expect(verifyEconomics(record).valid).toBe(false);
    // With initial balance of 5: easily affordable
    expect(verifyEconomics(record, { initialBalance: 5 }).valid).toBe(true);
  });

  it('checks recorded coinBalance when present', () => {
    const record = {
      blocks: [{
        index: 0, startTick: 0, endTick: 1000, inputs: [],
        coinBalance: 999  // wildly wrong
      }]
    };
    const result = verifyEconomics(record);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Balance mismatch/);
  });

  it('recorded coinBalance within tolerance passes', () => {
    // Earn 1 coin over 1000 ticks with slight decay
    const record = {
      blocks: [{
        index: 0, startTick: 0, endTick: 1000, inputs: [],
        coinBalance: 1.0  // approximately correct
      }]
    };
    const result = verifyEconomics(record, { balanceTolerance: 0.01 });
    expect(result.valid).toBe(true);
  });

  it('integrates with real Session records', async () => {
    const config = { gameId: 'life', width: 8, height: 8, seed: 42 };
    const engine = new LifeEngine();
    engine.init(config);
    const session = new Session(engine, config, { blockInterval: 500 });

    // Run some ticks, apply an input, run more
    session.step(2000);
    await session.applyInput({ tick: engine.clock(), action: { type: 'set', x: 0, y: 0, value: 1 } });
    session.step(3000);
    const record = session.finalize();

    const result = verifyEconomics(record, {
      coinParams: session.coinParams,
      isSharing: session.isSharing,
    });
    expect(result.valid).toBe(true);
    expect(result.blocks.length).toBe(record.blocks.length);
  });
});
