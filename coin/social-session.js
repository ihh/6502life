/**
 * Dual-witness social session — both players sign each other's blocks.
 *
 * Player A records their session blocks AND signs player B's blocks.
 * Player B does the same for A. A social block includes:
 *   block data + author signature + witness signature
 *
 * This creates a dual-witness record analogous to Bitcoin transaction recording.
 *
 * Uses Ed25519 via Node's built-in crypto module (available since Node 19+).
 *
 * @module coin/social-session
 */

import { randomUUID, generateKeyPairSync, sign, verify, createHash } from 'node:crypto';
import { sha256, toHex, fromHex } from './hash.js';
import { EdgeSession } from './social.js';

/**
 * Generate an Ed25519 keypair for signing.
 * @returns {{ publicKey: Buffer, privateKey: Buffer }}
 */
export function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });
  return { publicKey, privateKey };
}

/**
 * Sign data with an Ed25519 private key.
 * @param {Buffer|Uint8Array} data
 * @param {Buffer} privateKeyDer
 * @returns {Buffer}
 */
export function signData(data, privateKeyDer) {
  const key = {
    key: privateKeyDer,
    format: 'der',
    type: 'pkcs8'
  };
  return sign(null, Buffer.from(data), key);
}

/**
 * Verify an Ed25519 signature.
 * @param {Buffer|Uint8Array} data
 * @param {Buffer|Uint8Array} signature
 * @param {Buffer} publicKeyDer
 * @returns {boolean}
 */
export function verifySignature(data, signature, publicKeyDer) {
  const key = {
    key: publicKeyDer,
    format: 'der',
    type: 'spki'
  };
  return verify(null, Buffer.from(data), key, Buffer.from(signature));
}

const ZERO_HASH = '0'.repeat(64);

/**
 * Produce a canonical string representation of a social block for hashing/signing.
 * @param {Object} block
 * @returns {string}
 */
function canonicalBlockString(block) {
  const obj = {
    endStateHash: block.endStateHash,
    endTick: block.endTick,
    index: block.index,
    inputs: block.inputs,
    prevHash: block.prevHash,
    startStateHash: block.startStateHash,
    startTick: block.startTick,
    summary: sortObj(block.summary),
    wallTimeMs: block.wallTimeMs,
    // Social fields
    boundaryFramesSent: block.boundaryFramesSent,
    boundaryFramesReceived: block.boundaryFramesReceived,
    partnerPubkeyHex: block.partnerPubkeyHex,
    edgeExport: block.edgeExport,
  };
  return JSON.stringify(obj);
}

/**
 * Sort object keys recursively for canonical JSON.
 */
function sortObj(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortObj);
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObj(obj[key]);
  }
  return sorted;
}

/**
 * A social mining session where two players sign each other's blocks.
 *
 * Wraps an EdgeSession and produces dual-signed blocks for both players.
 */
export class SocialSession {
  /**
   * @param {import('./engine.js').Engine} engineA - initialized engine for player A
   * @param {import('./engine.js').Engine} engineB - initialized engine for player B
   * @param {import('./engine.js').EngineConfig} configA - config for player A
   * @param {import('./engine.js').EngineConfig} configB - config for player B
   * @param {Object} [options]
   * @param {number} [options.blockInterval=10000] - ticks per block
   * @param {number} [options.shareInterval=100] - ticks between boundary syncs
   * @param {string} [options.edgeA='east'] - A's export edge
   * @param {string} [options.edgeB='east'] - B's export edge
   * @param {{ publicKey: Buffer, privateKey: Buffer }} [options.keypairA] - A's keys (auto-generated if missing)
   * @param {{ publicKey: Buffer, privateKey: Buffer }} [options.keypairB] - B's keys (auto-generated if missing)
   */
  constructor(engineA, engineB, configA, configB, options = {}) {
    this.idA = randomUUID();
    this.idB = randomUUID();
    this.engineA = engineA;
    this.engineB = engineB;
    this.configA = configA;
    this.configB = configB;
    this.blockInterval = options.blockInterval ?? 10000;

    this.keypairA = options.keypairA ?? generateKeypair();
    this.keypairB = options.keypairB ?? generateKeypair();

    const edgeA = options.edgeA ?? 'east';
    const edgeB = options.edgeB ?? 'east';

    this.edgeSession = new EdgeSession(engineA, engineB, {
      edgeA,
      edgeB,
      shareInterval: options.shareInterval ?? 100
    });

    this.edgeA = edgeA;
    this.edgeB = edgeB;

    // Capture initial states
    this.initialStateA = engineA.serialize();
    this.initialStateB = engineB.serialize();
    this.initialStateAHex = toHex(this.initialStateA);
    this.initialStateBHex = toHex(this.initialStateB);

    /** @type {Object[]} dual-signed blocks for player A */
    this.blocksA = [];
    /** @type {Object[]} dual-signed blocks for player B */
    this.blocksB = [];

    // Block tracking
    this._blockStartTickA = engineA.clock();
    this._blockStartTickB = engineB.clock();
    this._blockStartHashA = toHex(sha256(this.initialStateA));
    this._blockStartHashB = toHex(sha256(this.initialStateB));
    this._blockStartWallTime = Date.now();
    this._nextBlockTick = this._blockStartTickA + this.blockInterval;

    // Track which boundary frames belong to the current block
    this._blockFrameStartIdx = 0;
  }

  /**
   * Advance both engines by n ticks, producing dual-signed blocks at intervals.
   * @param {number} n
   * @returns {{ ticksExecuted: number, blocksProduced: number, sharesPerformed: number }}
   */
  step(n) {
    let remaining = n;
    let totalExecuted = 0;
    let blocksProduced = 0;
    let totalShares = 0;

    while (remaining > 0) {
      const currentTickA = this.engineA.clock();
      const ticksToNextBlock = this._nextBlockTick - currentTickA;
      const batch = Math.min(remaining, ticksToNextBlock);

      const { ticksExecuted, sharesPerformed } = this.edgeSession.step(batch);
      totalExecuted += ticksExecuted;
      totalShares += sharesPerformed;
      remaining -= ticksExecuted;

      // Check if we've reached a block boundary
      if (this.engineA.clock() >= this._nextBlockTick) {
        this._produceBlocks();
        blocksProduced++;
      }
    }

    return { ticksExecuted: totalExecuted, blocksProduced, sharesPerformed: totalShares };
  }

  /**
   * Produce dual-signed blocks for both players.
   * @private
   */
  _produceBlocks() {
    const now = Date.now();
    const wallTimeMs = now - this._blockStartWallTime;

    const endStateA = this.engineA.serialize();
    const endStateB = this.engineB.serialize();
    const endHashA = toHex(sha256(endStateA));
    const endHashB = toHex(sha256(endStateB));

    const endTickA = this.engineA.clock();
    const endTickB = this.engineB.clock();

    // Gather boundary frames for this block
    const allFrames = this.edgeSession.serializeFrames();
    const blockFramesAtoB = allFrames.aToB.slice(this._blockFrameStartIdx);
    const blockFramesBtoA = allFrames.bToA.slice(this._blockFrameStartIdx);
    this._blockFrameStartIdx = allFrames.aToB.length;

    // Serialize frames for inclusion in blocks (just hashes, not full data)
    const frameHashesAtoB = blockFramesAtoB.map(f => f.hash);
    const frameHashesBtoA = blockFramesBtoA.map(f => f.hash);

    const prevHashA = this.blocksA.length > 0
      ? this.blocksA[this.blocksA.length - 1].blockHash
      : ZERO_HASH;
    const prevHashB = this.blocksB.length > 0
      ? this.blocksB[this.blocksB.length - 1].blockHash
      : ZERO_HASH;

    // Build block A
    const blockA = {
      index: this.blocksA.length,
      prevHash: prevHashA,
      startStateHash: this._blockStartHashA,
      endStateHash: endHashA,
      inputs: [],
      startTick: this._blockStartTickA,
      endTick: endTickA,
      wallTimeMs,
      summary: this.engineA.summarize(),
      // Social fields
      boundaryFramesSent: frameHashesAtoB,
      boundaryFramesReceived: frameHashesBtoA,
      partnerPubkeyHex: this.keypairB.publicKey.toString('hex'),
      edgeExport: this.edgeA,
    };

    // Build block B
    const blockB = {
      index: this.blocksB.length,
      prevHash: prevHashB,
      startStateHash: this._blockStartHashB,
      endStateHash: endHashB,
      inputs: [],
      startTick: this._blockStartTickB,
      endTick: endTickB,
      wallTimeMs,
      summary: this.engineB.summarize(),
      // Social fields
      boundaryFramesSent: frameHashesBtoA,
      boundaryFramesReceived: frameHashesAtoB,
      partnerPubkeyHex: this.keypairA.publicKey.toString('hex'),
      edgeExport: this.edgeB,
    };

    // Compute block content hashes
    const blockAStr = canonicalBlockString(blockA);
    const blockBStr = canonicalBlockString(blockB);
    const blockAHash = toHex(sha256(new TextEncoder().encode(blockAStr)));
    const blockBHash = toHex(sha256(new TextEncoder().encode(blockBStr)));

    blockA.blockHash = blockAHash;
    blockB.blockHash = blockBHash;

    // Author signatures (each player signs their own block)
    const sigA = signData(Buffer.from(blockAStr), this.keypairA.privateKey);
    const sigB = signData(Buffer.from(blockBStr), this.keypairB.privateKey);

    blockA.authorSignature = sigA.toString('hex');
    blockA.authorPubkeyHex = this.keypairA.publicKey.toString('hex');

    blockB.authorSignature = sigB.toString('hex');
    blockB.authorPubkeyHex = this.keypairB.publicKey.toString('hex');

    // Witness signatures (each player signs the OTHER player's block)
    const witnessSigAonB = signData(Buffer.from(blockBStr), this.keypairA.privateKey);
    const witnessSigBonA = signData(Buffer.from(blockAStr), this.keypairB.privateKey);

    blockA.witnessSignature = witnessSigBonA.toString('hex');
    blockA.witnessPubkeyHex = this.keypairB.publicKey.toString('hex');

    blockB.witnessSignature = witnessSigAonB.toString('hex');
    blockB.witnessPubkeyHex = this.keypairA.publicKey.toString('hex');

    this.blocksA.push(blockA);
    this.blocksB.push(blockB);

    // Reset for next block
    this._blockStartTickA = endTickA;
    this._blockStartTickB = endTickB;
    this._blockStartHashA = endHashA;
    this._blockStartHashB = endHashB;
    this._blockStartWallTime = now;
    this._nextBlockTick = endTickA + this.blockInterval;
  }

  /**
   * Finalize the session, producing a final block if needed.
   * @returns {{ sessionA: Object, sessionB: Object }}
   */
  finalize() {
    // Produce final block if there are unrecorded ticks
    if (this.engineA.clock() > this._blockStartTickA) {
      this._produceBlocks();
    }

    const sessionA = {
      id: this.idA,
      config: this.configA,
      initialStateHex: this.initialStateAHex,
      finalTick: this.engineA.clock(),
      blocks: this.blocksA,
      partnerSessionId: this.idB,
      partnerPubkeyHex: this.keypairB.publicKey.toString('hex'),
      authorPubkeyHex: this.keypairA.publicKey.toString('hex'),
    };

    const sessionB = {
      id: this.idB,
      config: this.configB,
      initialStateHex: this.initialStateBHex,
      finalTick: this.engineB.clock(),
      blocks: this.blocksB,
      partnerSessionId: this.idA,
      partnerPubkeyHex: this.keypairA.publicKey.toString('hex'),
      authorPubkeyHex: this.keypairB.publicKey.toString('hex'),
    };

    return { sessionA, sessionB };
  }
}

/**
 * Verify a pair of social mining sessions.
 *
 * Checks:
 * 1. Both sessions have valid hash chains
 * 2. Author signatures on each block are valid
 * 3. Witness signatures on each block are valid
 * 4. Boundary frame hashes are cross-consistent (what A sent = what B received)
 * 5. Replay both boards with edge-sharing to verify state hashes
 *
 * @param {Object} sessionA - player A's session record
 * @param {Object} sessionB - player B's session record
 * @param {import('./engine.js').Engine} freshEngineA - uninitialized engine for replay
 * @param {import('./engine.js').Engine} freshEngineB - uninitialized engine for replay
 * @param {Object} [options]
 * @param {boolean} [options.skipReplay=false] - skip full replay verification
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function verifySocialSession(sessionA, sessionB, freshEngineA, freshEngineB, options = {}) {
  const errors = [];

  // 1. Check hash chains
  checkHashChain(sessionA, 'A', errors);
  checkHashChain(sessionB, 'B', errors);

  // 2. Check author signatures
  for (const block of sessionA.blocks) {
    const blockStr = canonicalBlockString(block);
    const valid = verifySignature(
      Buffer.from(blockStr),
      Buffer.from(block.authorSignature, 'hex'),
      Buffer.from(block.authorPubkeyHex, 'hex')
    );
    if (!valid) {
      errors.push(`Block A[${block.index}]: invalid author signature`);
    }
  }

  for (const block of sessionB.blocks) {
    const blockStr = canonicalBlockString(block);
    const valid = verifySignature(
      Buffer.from(blockStr),
      Buffer.from(block.authorSignature, 'hex'),
      Buffer.from(block.authorPubkeyHex, 'hex')
    );
    if (!valid) {
      errors.push(`Block B[${block.index}]: invalid author signature`);
    }
  }

  // 3. Check witness signatures
  for (const block of sessionA.blocks) {
    const blockStr = canonicalBlockString(block);
    const valid = verifySignature(
      Buffer.from(blockStr),
      Buffer.from(block.witnessSignature, 'hex'),
      Buffer.from(block.witnessPubkeyHex, 'hex')
    );
    if (!valid) {
      errors.push(`Block A[${block.index}]: invalid witness signature`);
    }
  }

  for (const block of sessionB.blocks) {
    const blockStr = canonicalBlockString(block);
    const valid = verifySignature(
      Buffer.from(blockStr),
      Buffer.from(block.witnessSignature, 'hex'),
      Buffer.from(block.witnessPubkeyHex, 'hex')
    );
    if (!valid) {
      errors.push(`Block B[${block.index}]: invalid witness signature`);
    }
  }

  // 4. Cross-consistency of boundary frames
  const minBlocks = Math.min(sessionA.blocks.length, sessionB.blocks.length);
  for (let i = 0; i < minBlocks; i++) {
    const blockA = sessionA.blocks[i];
    const blockB = sessionB.blocks[i];

    // What A sent should equal what B received
    const aSent = JSON.stringify(blockA.boundaryFramesSent);
    const bReceived = JSON.stringify(blockB.boundaryFramesReceived);
    if (aSent !== bReceived) {
      errors.push(`Block ${i}: A's sent frames != B's received frames`);
    }

    // What B sent should equal what A received
    const bSent = JSON.stringify(blockB.boundaryFramesSent);
    const aReceived = JSON.stringify(blockA.boundaryFramesReceived);
    if (bSent !== aReceived) {
      errors.push(`Block ${i}: B's sent frames != A's received frames`);
    }
  }

  // 5. Full replay verification (optional, expensive)
  if (!options.skipReplay && errors.length === 0) {
    replayAndVerify(sessionA, sessionB, freshEngineA, freshEngineB, errors);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check hash chain integrity for a session.
 * @param {Object} session
 * @param {string} label
 * @param {string[]} errors
 */
function checkHashChain(session, label, errors) {
  let prevHash = ZERO_HASH;
  for (let i = 0; i < session.blocks.length; i++) {
    const block = session.blocks[i];
    if (block.prevHash !== prevHash) {
      errors.push(`${label} block ${i}: broken hash chain (expected ${prevHash}, got ${block.prevHash})`);
    }

    // Verify block hash
    const blockStr = canonicalBlockString(block);
    const computedHash = toHex(sha256(new TextEncoder().encode(blockStr)));
    if (computedHash !== block.blockHash) {
      errors.push(`${label} block ${i}: block hash mismatch (computed ${computedHash}, recorded ${block.blockHash})`);
    }

    // Verify end-start state continuity
    if (i < session.blocks.length - 1) {
      if (block.endStateHash !== session.blocks[i + 1].startStateHash) {
        errors.push(`${label} block ${i}: endStateHash != next block's startStateHash`);
      }
    }

    prevHash = block.blockHash;
  }
}

/**
 * Replay both sessions with edge-sharing and verify state hashes.
 * @param {Object} sessionA
 * @param {Object} sessionB
 * @param {import('./engine.js').Engine} engineA
 * @param {import('./engine.js').Engine} engineB
 * @param {string[]} errors
 */
function replayAndVerify(sessionA, sessionB, engineA, engineB, errors) {
  try {
    // Initialize and deserialize
    engineA.init(sessionA.config);
    engineA.deserialize(fromHex(sessionA.initialStateHex));

    engineB.init(sessionB.config);
    engineB.deserialize(fromHex(sessionB.initialStateHex));

    // Verify initial state hashes
    const initHashA = toHex(sha256(engineA.serialize()));
    const initHashB = toHex(sha256(engineB.serialize()));

    if (sessionA.blocks.length > 0 && initHashA !== sessionA.blocks[0].startStateHash) {
      errors.push(`Replay: A initial state hash mismatch`);
      return;
    }
    if (sessionB.blocks.length > 0 && initHashB !== sessionB.blocks[0].startStateHash) {
      errors.push(`Replay: B initial state hash mismatch`);
      return;
    }

    // Determine edges from first block
    const edgeA = sessionA.blocks[0]?.edgeExport ?? 'east';
    const edgeB = sessionB.blocks[0]?.edgeExport ?? 'east';

    // Reconstruct share interval from frame count and tick range
    // We use the EdgeSession for replay
    const OPPOSITE_EDGE = { north: 'south', south: 'north', east: 'west', west: 'east' };

    // Replay each block pair
    const minBlocks = Math.min(sessionA.blocks.length, sessionB.blocks.length);
    for (let i = 0; i < minBlocks; i++) {
      const blockA = sessionA.blocks[i];
      const blockB = sessionB.blocks[i];

      const ticksA = blockA.endTick - blockA.startTick;
      const ticksB = blockB.endTick - blockB.startTick;

      // Determine share interval from frame count
      const numFrames = blockA.boundaryFramesSent.length;
      const shareInterval = numFrames > 0 ? Math.floor(ticksA / numFrames) : ticksA;

      // Step engines with boundary sharing
      let ticksDone = 0;
      let frameIdx = 0;
      while (ticksDone < ticksA) {
        const batch = numFrames > 0
          ? Math.min(shareInterval, ticksA - ticksDone)
          : ticksA - ticksDone;

        engineA.step(batch);
        engineB.step(batch);
        ticksDone += batch;

        // Share boundary at interval
        if (numFrames > 0 && ticksDone < ticksA && frameIdx < numFrames) {
          const dataA = engineA.getBoundary(edgeA);
          const dataB = engineB.getBoundary(edgeB);
          const importB = OPPOSITE_EDGE[edgeA];
          const importA = OPPOSITE_EDGE[edgeB];
          engineB.setBoundary(importB, dataA);
          engineA.setBoundary(importA, dataB);
          frameIdx++;
        }
      }

      // Verify end state hashes
      const endHashA = toHex(sha256(engineA.serialize()));
      const endHashB = toHex(sha256(engineB.serialize()));

      if (endHashA !== blockA.endStateHash) {
        errors.push(`Replay: A block ${i} end state hash mismatch (computed ${endHashA}, recorded ${blockA.endStateHash})`);
        return;
      }
      if (endHashB !== blockB.endStateHash) {
        errors.push(`Replay: B block ${i} end state hash mismatch (computed ${endHashB}, recorded ${blockB.endStateHash})`);
        return;
      }
    }
  } catch (err) {
    errors.push(`Replay error: ${err.message}`);
  }
}
