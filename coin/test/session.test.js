import { describe, it, expect } from 'vitest';
import { LifeEngine } from '../engines/life.js';
import { Session } from '../session.js';
import { verifySession } from '../verify.js';

describe('Session', () => {
  function makeSession(opts = {}) {
    const config = {
      gameId: 'life',
      width: opts.size ?? 16,
      height: opts.size ?? 16,
      seed: opts.seed ?? 42
    };
    const engine = new LifeEngine();
    engine.init(config);
    return new Session(engine, config, {
      blockInterval: opts.blockInterval ?? 100
    });
  }

  it('produces blocks at the correct intervals', () => {
    const session = makeSession({ blockInterval: 100 });
    session.step(250);
    const record = session.finalize();

    // 250 ticks with interval 100 => blocks at 100, 200, 250
    expect(record.blocks.length).toBe(3);
    expect(record.blocks[0].startTick).toBe(0);
    expect(record.blocks[0].endTick).toBe(100);
    expect(record.blocks[1].startTick).toBe(100);
    expect(record.blocks[1].endTick).toBe(200);
    expect(record.blocks[2].startTick).toBe(200);
    expect(record.blocks[2].endTick).toBe(250);
  });

  it('hash chain is linked correctly', () => {
    const session = makeSession({ blockInterval: 50 });
    session.step(200);
    const record = session.finalize();

    expect(record.blocks.length).toBe(4);
    expect(record.blocks[0].prevHash).toBe('0'.repeat(64));

    for (let i = 1; i < record.blocks.length; i++) {
      expect(record.blocks[i].prevHash).toBe(record.blocks[i - 1].hash);
    }
  });

  it('end state hash of block N equals start state hash of block N+1', () => {
    const session = makeSession({ blockInterval: 50 });
    session.step(200);
    const record = session.finalize();

    for (let i = 0; i < record.blocks.length - 1; i++) {
      expect(record.blocks[i].endStateHash).toBe(record.blocks[i + 1].startStateHash);
    }
  });

  it('records inputs', async () => {
    const session = makeSession({ blockInterval: 100 });
    session.step(50);
    await session.applyInput({ tick: 50, action: { type: 'set', x: 0, y: 0, value: 1 } });
    session.step(150);

    const record = session.finalize();
    expect(record.inputs.length).toBe(1);
    expect(record.inputs[0].action.type).toBe('set');
  });

  it('finalTick matches total steps', () => {
    const session = makeSession({ blockInterval: 100 });
    session.step(350);
    const record = session.finalize();
    expect(record.finalTick).toBe(350);
  });

  it('includes summary stats in blocks', () => {
    const session = makeSession({ blockInterval: 100 });
    session.step(100);
    const record = session.finalize();

    const summary = record.blocks[0].summary;
    expect(summary).toBeDefined();
    expect(typeof summary.liveCells).toBe('number');
    expect(typeof summary.density).toBe('number');
    expect(typeof summary.clock).toBe('number');
  });
});

describe('Session verification', () => {
  function mineAndVerify(opts = {}) {
    const config = {
      gameId: 'life',
      width: opts.size ?? 16,
      height: opts.size ?? 16,
      seed: opts.seed ?? 42
    };
    const engine = new LifeEngine();
    engine.init(config);
    const session = new Session(engine, config, {
      blockInterval: opts.blockInterval ?? 100
    });
    session.step(opts.ticks ?? 500);
    const record = session.finalize();

    const verifyEngine = new LifeEngine();
    return { record, result: verifySession(record, verifyEngine) };
  }

  it('valid session passes verification', () => {
    const { result } = mineAndVerify({ ticks: 500, blockInterval: 100 });
    expect(result.valid).toBe(true);
    expect(result.blocks.length).toBe(5);
    for (const b of result.blocks) {
      expect(b.valid).toBe(true);
    }
  });

  it('valid session with inputs passes verification', async () => {
    const config = { gameId: 'life', width: 8, height: 8, seed: 99 };
    const engine = new LifeEngine();
    engine.init(config);
    const session = new Session(engine, config, { blockInterval: 50 });

    session.step(25);
    await session.applyInput({ tick: 25, action: { type: 'set', x: 3, y: 3, value: 1 } });
    session.step(75);

    const record = session.finalize();
    const verifyEngine = new LifeEngine();
    const result = verifySession(record, verifyEngine);
    expect(result.valid).toBe(true);
  });

  it('tampered end state hash fails verification', () => {
    const { record } = mineAndVerify({ ticks: 200, blockInterval: 100 });

    // Tamper with the first block's end state hash
    record.blocks[0].endStateHash = 'ff'.repeat(32);

    const verifyEngine = new LifeEngine();
    const result = verifySession(record, verifyEngine);
    expect(result.valid).toBe(false);
  });

  it('tampered block hash fails verification', () => {
    const { record } = mineAndVerify({ ticks: 200, blockInterval: 100 });

    // Tamper with the first block's hash
    record.blocks[0].hash = 'aa'.repeat(32);

    const verifyEngine = new LifeEngine();
    const result = verifySession(record, verifyEngine);
    expect(result.valid).toBe(false);
  });

  it('larger sessions verify correctly', () => {
    const { result } = mineAndVerify({ ticks: 5000, blockInterval: 1000, size: 32, seed: 777 });
    expect(result.valid).toBe(true);
    expect(result.blocks.length).toBe(5);
  });
});
