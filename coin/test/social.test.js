import { describe, it, expect } from 'vitest';
import { LifeEngine } from '../engines/life.js';
import { EdgeSession, shareBoundary } from '../social.js';
import { SocialSession, verifySocialSession, generateKeypair } from '../social-session.js';
import { sha256, toHex } from '../hash.js';

// --- Helpers ---

function makeEngine(seed = 42, size = 16) {
  const engine = new LifeEngine();
  engine.init({ gameId: 'life', width: size, height: size, seed });
  return engine;
}

function makeConfig(seed = 42, size = 16) {
  return { gameId: 'life', width: size, height: size, seed };
}

// --- Edge sharing tests ---

describe('shareBoundary', () => {
  it('copies boundary data between two engines', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);
    a.step(10);
    b.step(10);

    // Before sharing
    const eastA = a.getBoundary('east');
    const eastB = b.getBoundary('east');

    const { aToB, bToA } = shareBoundary(a, 'east', b, 'east');

    // Frames should have correct ticks
    expect(aToB.tick).toBe(10);
    expect(bToA.tick).toBe(10);

    // Frames should have valid hashes
    expect(aToB.hash).toBe(toHex(sha256(eastA)));
    expect(bToA.hash).toBe(toHex(sha256(eastB)));

    // After sharing: A's west edge should be B's old east, and vice versa
    const westA = a.getBoundary('west');
    const westB = b.getBoundary('west');
    expect(Array.from(westA)).toEqual(Array.from(eastB));
    expect(Array.from(westB)).toEqual(Array.from(eastA));
  });

  it('works with north-south edge pairing', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);
    a.step(5);
    b.step(5);

    const northA = a.getBoundary('north');
    const northB = b.getBoundary('north');

    shareBoundary(a, 'north', b, 'north');

    // A exports north -> B imports south (opposite of A's export)
    // B exports north -> A imports south (opposite of B's export)
    const southA = a.getBoundary('south');
    const southB = b.getBoundary('south');
    expect(Array.from(southA)).toEqual(Array.from(northB));
    expect(Array.from(southB)).toEqual(Array.from(northA));
  });
});

describe('EdgeSession', () => {
  it('runs both engines in lockstep', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    const edgeSession = new EdgeSession(a, b, {
      edgeA: 'east',
      edgeB: 'east',
      shareInterval: 50
    });

    const { ticksExecuted, sharesPerformed } = edgeSession.step(200);

    expect(ticksExecuted).toBe(200);
    expect(a.clock()).toBe(200);
    expect(b.clock()).toBe(200);
    expect(sharesPerformed).toBe(4); // 200 / 50 = 4
  });

  it('records boundary frames', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    const edgeSession = new EdgeSession(a, b, { shareInterval: 25 });
    edgeSession.step(100);

    const frames = edgeSession.getFrames();
    expect(frames.aToB.length).toBe(4);
    expect(frames.bToA.length).toBe(4);

    // Each frame should have tick, data, and hash
    for (const f of frames.aToB) {
      expect(typeof f.tick).toBe('number');
      expect(f.data).toBeInstanceOf(Uint8Array);
      expect(typeof f.hash).toBe('string');
      expect(f.hash.length).toBe(64);
    }
  });

  it('serializes frames to JSON-safe format', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    const edgeSession = new EdgeSession(a, b, { shareInterval: 50 });
    edgeSession.step(100);

    const serialized = edgeSession.serializeFrames();
    expect(serialized.aToB.length).toBe(2);
    expect(typeof serialized.aToB[0].dataHex).toBe('string');
    expect(typeof serialized.aToB[0].hash).toBe('string');

    // Should be JSON-serializable
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json);
    expect(parsed.aToB.length).toBe(2);
  });

  it('shared boundary affects simulation evolution', () => {
    // Run two engines without sharing
    const a1 = makeEngine(42, 8);
    const b1 = makeEngine(99, 8);
    a1.step(200);
    b1.step(200);

    // Run same engines WITH sharing
    const a2 = makeEngine(42, 8);
    const b2 = makeEngine(99, 8);
    const edgeSession = new EdgeSession(a2, b2, { shareInterval: 50 });
    edgeSession.step(200);

    // The shared versions should differ from the non-shared versions
    // (because boundary data injection changes evolution)
    const hashA1 = toHex(sha256(a1.serialize()));
    const hashA2 = toHex(sha256(a2.serialize()));
    const hashB1 = toHex(sha256(b1.serialize()));
    const hashB2 = toHex(sha256(b2.serialize()));

    // With different seeds, sharing should change the outcome
    expect(hashA1).not.toBe(hashA2);
    expect(hashB1).not.toBe(hashB2);
  });
});

// --- Organism crossing test ---

describe('Organism crossing', () => {
  it('organisms can cross between boards via shared edge', () => {
    // Create two boards: A has a glider heading toward the east edge,
    // B is mostly dead. After sharing, B should gain live cells.
    const size = 16;
    const a = makeEngine(1, size);
    const b = new LifeEngine();
    b.init({ gameId: 'life', width: size, height: size, seed: 2, rules: { density: 0.0 } });

    // Place a glider near A's east edge
    // Classic glider pattern (heading southeast):
    //  .X.
    //  ..X
    //  XXX
    const gx = size - 3;
    const gy = size / 2;
    a.applyInput({ tick: 0, action: { type: 'set', x: gx + 1, y: gy, value: 1 } });
    a.applyInput({ tick: 0, action: { type: 'set', x: gx + 2, y: gy + 1, value: 1 } });
    a.applyInput({ tick: 0, action: { type: 'set', x: gx, y: gy + 2, value: 1 } });
    a.applyInput({ tick: 0, action: { type: 'set', x: gx + 1, y: gy + 2, value: 1 } });
    a.applyInput({ tick: 0, action: { type: 'set', x: gx + 2, y: gy + 2, value: 1 } });

    // Count live cells on B before
    const liveBeforeB = b.summarize().liveCells;
    expect(liveBeforeB).toBe(0);

    // Run with edge sharing — east edge of A flows to west edge of B
    const edgeSession = new EdgeSession(a, b, {
      edgeA: 'east',
      edgeB: 'west',  // B exports west, so B imports east (opposite of A's export)
      shareInterval: 1
    });

    // Run enough steps for glider to reach the edge and cross
    edgeSession.step(50);

    // B should now have some live cells from the boundary injection
    const liveAfterB = b.summarize().liveCells;
    expect(liveAfterB).toBeGreaterThan(0);
  });
});

// --- Dual-witness signing tests ---

describe('SocialSession', () => {
  it('produces dual-signed blocks for both players', () => {
    const configA = makeConfig(42, 8);
    const configB = makeConfig(99, 8);
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    const session = new SocialSession(a, b, configA, configB, {
      blockInterval: 100,
      shareInterval: 25
    });

    session.step(300);
    const { sessionA, sessionB } = session.finalize();

    // Should have 3 blocks each (100, 200, 300)
    expect(sessionA.blocks.length).toBe(3);
    expect(sessionB.blocks.length).toBe(3);

    // Each block should have both signatures
    for (const block of sessionA.blocks) {
      expect(block.authorSignature).toBeTruthy();
      expect(block.witnessSignature).toBeTruthy();
      expect(block.authorPubkeyHex).toBeTruthy();
      expect(block.witnessPubkeyHex).toBeTruthy();
      expect(block.authorPubkeyHex).not.toBe(block.witnessPubkeyHex);
    }

    for (const block of sessionB.blocks) {
      expect(block.authorSignature).toBeTruthy();
      expect(block.witnessSignature).toBeTruthy();
    }
  });

  it('blocks have valid hash chain', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    const session = new SocialSession(a, b, makeConfig(42, 8), makeConfig(99, 8), {
      blockInterval: 50,
      shareInterval: 10
    });

    session.step(200);
    const { sessionA, sessionB } = session.finalize();

    // Check hash chain for A
    expect(sessionA.blocks[0].prevHash).toBe('0'.repeat(64));
    for (let i = 1; i < sessionA.blocks.length; i++) {
      expect(sessionA.blocks[i].prevHash).toBe(sessionA.blocks[i - 1].blockHash);
    }

    // Check hash chain for B
    expect(sessionB.blocks[0].prevHash).toBe('0'.repeat(64));
    for (let i = 1; i < sessionB.blocks.length; i++) {
      expect(sessionB.blocks[i].prevHash).toBe(sessionB.blocks[i - 1].blockHash);
    }
  });

  it('end state hash of block N matches start state hash of block N+1', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    const session = new SocialSession(a, b, makeConfig(42, 8), makeConfig(99, 8), {
      blockInterval: 50,
      shareInterval: 10
    });

    session.step(200);
    const { sessionA, sessionB } = session.finalize();

    for (let i = 0; i < sessionA.blocks.length - 1; i++) {
      expect(sessionA.blocks[i].endStateHash).toBe(sessionA.blocks[i + 1].startStateHash);
    }

    for (let i = 0; i < sessionB.blocks.length - 1; i++) {
      expect(sessionB.blocks[i].endStateHash).toBe(sessionB.blocks[i + 1].startStateHash);
    }
  });

  it('boundary frames are cross-consistent', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    const session = new SocialSession(a, b, makeConfig(42, 8), makeConfig(99, 8), {
      blockInterval: 100,
      shareInterval: 25
    });

    session.step(200);
    const { sessionA, sessionB } = session.finalize();

    for (let i = 0; i < sessionA.blocks.length; i++) {
      // What A sent should equal what B received
      expect(sessionA.blocks[i].boundaryFramesSent).toEqual(
        sessionB.blocks[i].boundaryFramesReceived
      );
      // What B sent should equal what A received
      expect(sessionB.blocks[i].boundaryFramesSent).toEqual(
        sessionA.blocks[i].boundaryFramesReceived
      );
    }
  });

  it('partner session IDs are cross-referenced', () => {
    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    const session = new SocialSession(a, b, makeConfig(42, 8), makeConfig(99, 8), {
      blockInterval: 100
    });

    session.step(100);
    const { sessionA, sessionB } = session.finalize();

    expect(sessionA.partnerSessionId).toBe(sessionB.id);
    expect(sessionB.partnerSessionId).toBe(sessionA.id);
  });
});

// --- Verification tests ---

describe('verifySocialSession', () => {
  function mineAndVerify(opts = {}) {
    const size = opts.size ?? 8;
    const configA = makeConfig(opts.seedA ?? 42, size);
    const configB = makeConfig(opts.seedB ?? 99, size);
    const a = new LifeEngine();
    a.init(configA);
    const b = new LifeEngine();
    b.init(configB);

    const session = new SocialSession(a, b, configA, configB, {
      blockInterval: opts.blockInterval ?? 100,
      shareInterval: opts.shareInterval ?? 25,
      edgeA: opts.edgeA ?? 'east',
      edgeB: opts.edgeB ?? 'east'
    });

    session.step(opts.ticks ?? 300);
    const { sessionA, sessionB } = session.finalize();

    const verifyA = new LifeEngine();
    const verifyB = new LifeEngine();
    const result = verifySocialSession(sessionA, sessionB, verifyA, verifyB, {
      skipReplay: opts.skipReplay ?? false
    });

    return { sessionA, sessionB, result };
  }

  it('valid social session passes verification', () => {
    const { result } = mineAndVerify({ ticks: 300, blockInterval: 100 });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('valid session passes with skip-replay', () => {
    const { result } = mineAndVerify({ ticks: 300, skipReplay: true });
    expect(result.valid).toBe(true);
  });

  it('tampered author signature fails verification', () => {
    const { sessionA, sessionB } = mineAndVerify({ ticks: 200 });
    // Tamper with A's first block author signature
    sessionA.blocks[0].authorSignature = 'aa'.repeat(64);

    const verifyA = new LifeEngine();
    const verifyB = new LifeEngine();
    const result = verifySocialSession(sessionA, sessionB, verifyA, verifyB, { skipReplay: true });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('author signature'))).toBe(true);
  });

  it('tampered witness signature fails verification', () => {
    const { sessionA, sessionB } = mineAndVerify({ ticks: 200 });
    // Tamper with B's witness signature on A's block
    sessionA.blocks[0].witnessSignature = 'bb'.repeat(64);

    const verifyA = new LifeEngine();
    const verifyB = new LifeEngine();
    const result = verifySocialSession(sessionA, sessionB, verifyA, verifyB, { skipReplay: true });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('witness signature'))).toBe(true);
  });

  it('tampered boundary frames fail cross-consistency check', () => {
    const { sessionA, sessionB } = mineAndVerify({ ticks: 200 });
    // Tamper with A's sent boundary frame hashes
    // This changes the block content, so it will fail either as a block hash
    // mismatch or a cross-consistency error (both are valid detection)
    if (sessionA.blocks[0].boundaryFramesSent.length > 0) {
      sessionA.blocks[0].boundaryFramesSent[0] = 'cc'.repeat(32);
    }

    const verifyA = new LifeEngine();
    const verifyB = new LifeEngine();
    const result = verifySocialSession(sessionA, sessionB, verifyA, verifyB, { skipReplay: true });
    expect(result.valid).toBe(false);
    // Tampering boundary data changes block content, so it may fail as
    // block hash mismatch, signature failure, or cross-consistency error
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('broken hash chain fails verification', () => {
    const { sessionA, sessionB } = mineAndVerify({ ticks: 300 });
    // Break the hash chain by tampering with blockHash
    if (sessionA.blocks.length > 1) {
      sessionA.blocks[0].blockHash = 'dd'.repeat(32);
    }

    const verifyA = new LifeEngine();
    const verifyB = new LifeEngine();
    const result = verifySocialSession(sessionA, sessionB, verifyA, verifyB, { skipReplay: true });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('hash'))).toBe(true);
  });

  it('different edge configurations work', () => {
    const { result } = mineAndVerify({
      ticks: 200,
      edgeA: 'north',
      edgeB: 'south',
      skipReplay: true
    });
    expect(result.valid).toBe(true);
  });

  it('larger sessions verify correctly', () => {
    const { result } = mineAndVerify({
      size: 16,
      seedA: 111,
      seedB: 222,
      ticks: 1000,
      blockInterval: 200,
      shareInterval: 50
    });
    expect(result.valid).toBe(true);
  });
});

// --- Ed25519 keypair tests ---

describe('Ed25519 signing', () => {
  it('generates distinct keypairs', () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    expect(kp1.publicKey.toString('hex')).not.toBe(kp2.publicKey.toString('hex'));
  });

  it('custom keypairs are used when provided', () => {
    const kpA = generateKeypair();
    const kpB = generateKeypair();

    const a = makeEngine(42, 8);
    const b = makeEngine(99, 8);

    const session = new SocialSession(a, b, makeConfig(42, 8), makeConfig(99, 8), {
      blockInterval: 50,
      keypairA: kpA,
      keypairB: kpB
    });

    session.step(50);
    const { sessionA, sessionB } = session.finalize();

    expect(sessionA.authorPubkeyHex).toBe(kpA.publicKey.toString('hex'));
    expect(sessionB.authorPubkeyHex).toBe(kpB.publicKey.toString('hex'));
  });
});
