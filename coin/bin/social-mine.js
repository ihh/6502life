#!/usr/bin/env node

/**
 * Social mining CLI — simulates two boards sharing an edge locally.
 *
 * Runs both boards in the same process, shares boundaries every N ticks,
 * and produces dual-signed session blocks for both players.
 *
 * Usage:
 *   node coin/bin/social-mine.js [options]
 *
 * Options:
 *   --size N             Board size NxN (default: 16)
 *   --seed-a N           PRNG seed for board A (default: 42)
 *   --seed-b N           PRNG seed for board B (default: 99)
 *   --ticks N            Total simulation ticks (default: 10000)
 *   --block-interval N   Ticks per block (default: 1000)
 *   --share-interval N   Ticks between boundary syncs (default: 100)
 *   --edge-a EDGE        A's export edge (default: east)
 *   --edge-b EDGE        B's export edge (default: east)
 *   --out-a FILE         Output session file for A (default: session-a.json)
 *   --out-b FILE         Output session file for B (default: session-b.json)
 *   --verify             Verify sessions after mining
 *   --json               Output result as JSON to stdout
 *   --quiet              Suppress progress output
 */

import { writeFileSync } from 'node:fs';
import { LifeEngine } from '../engines/life.js';
import { SocialSession, verifySocialSession } from '../social-session.js';

function parseArgs(argv) {
  const args = {
    size: 16,
    seedA: 42,
    seedB: 99,
    ticks: 10000,
    blockInterval: 1000,
    shareInterval: 100,
    edgeA: 'east',
    edgeB: 'east',
    outA: 'session-a.json',
    outB: 'session-b.json',
    verify: false,
    json: false,
    quiet: false
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--help':
        console.log(`social-mine.js — Social mining CLI for two boards sharing an edge

Usage:
  node coin/bin/social-mine.js [options]

Options:
  --size N             Board size NxN (default: 16)
  --seed-a N           PRNG seed for board A (default: 42)
  --seed-b N           PRNG seed for board B (default: 99)
  --ticks N            Total simulation ticks (default: 10000)
  --block-interval N   Ticks per block (default: 1000)
  --share-interval N   Ticks between boundary syncs (default: 100)
  --edge-a EDGE        A's export edge (default: east)
  --edge-b EDGE        B's export edge (default: east)
  --edge EDGE          Set both edges to the same value
  --out-a FILE         Output session file for A (default: session-a.json)
  --out-b FILE         Output session file for B (default: session-b.json)
  --verify             Verify sessions after mining
  --json               Output result as JSON to stdout
  --quiet              Suppress progress output
  --help               Show this help message`);
        process.exit(0);
      case '--size': args.size = parseInt(argv[++i]); break;
      case '--seed-a': args.seedA = parseInt(argv[++i]); break;
      case '--seed-b': args.seedB = parseInt(argv[++i]); break;
      case '--ticks': args.ticks = parseInt(argv[++i]); break;
      case '--block-interval': args.blockInterval = parseInt(argv[++i]); break;
      case '--share-interval': args.shareInterval = parseInt(argv[++i]); break;
      case '--edge-a': args.edgeA = argv[++i]; break;
      case '--edge-b': args.edgeB = argv[++i]; break;
      case '--edge': args.edgeA = argv[++i]; args.edgeB = args.edgeA; break;
      case '--out-a': args.outA = argv[++i]; break;
      case '--out-b': args.outB = argv[++i]; break;
      case '--verify': args.verify = true; break;
      case '--json': args.json = true; break;
      case '--quiet': args.quiet = true; break;
      default:
        console.error(`Unknown option: ${argv[i]}`);
        process.exit(1);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const log = args.quiet ? () => {} : (...a) => console.error(...a);

  const configA = {
    gameId: 'life',
    width: args.size,
    height: args.size,
    seed: args.seedA
  };

  const configB = {
    gameId: 'life',
    width: args.size,
    height: args.size,
    seed: args.seedB
  };

  log(`Social Mining: Game of Life ${args.size}x${args.size}`);
  log(`  Board A seed=${args.seedA}, Board B seed=${args.seedB}`);
  log(`  Edge: A exports ${args.edgeA}, B exports ${args.edgeB}`);
  log(`  Share interval: ${args.shareInterval} ticks`);
  log(`  Block interval: ${args.blockInterval} ticks`);
  log(`  Total ticks: ${args.ticks}`);

  // Initialize engines
  const engineA = new LifeEngine();
  engineA.init(configA);
  const engineB = new LifeEngine();
  engineB.init(configB);

  // Create social session
  const session = new SocialSession(engineA, engineB, configA, configB, {
    blockInterval: args.blockInterval,
    shareInterval: args.shareInterval,
    edgeA: args.edgeA,
    edgeB: args.edgeB
  });

  // Run simulation
  const startTime = Date.now();
  const progressInterval = Math.max(1, Math.floor(args.ticks / 10));
  let ticksDone = 0;

  while (ticksDone < args.ticks) {
    const batch = Math.min(args.blockInterval, args.ticks - ticksDone);
    session.step(batch);
    ticksDone += batch;

    if (ticksDone % progressInterval < args.blockInterval) {
      log(`  ${ticksDone}/${args.ticks} ticks (${Math.round(ticksDone / args.ticks * 100)}%)`);
    }
  }

  const elapsedMs = Date.now() - startTime;

  // Finalize and save
  const { sessionA, sessionB } = session.finalize();

  writeFileSync(args.outA, JSON.stringify(sessionA, null, 2));
  writeFileSync(args.outB, JSON.stringify(sessionB, null, 2));
  log(`Session A saved to ${args.outA}`);
  log(`Session B saved to ${args.outB}`);
  log(`  ${sessionA.blocks.length} blocks each, ${elapsedMs}ms wall time`);

  // Verify if requested
  let verifyResult = null;
  if (args.verify) {
    log('Verifying social sessions...');
    const verifyEngineA = new LifeEngine();
    const verifyEngineB = new LifeEngine();
    verifyResult = verifySocialSession(sessionA, sessionB, verifyEngineA, verifyEngineB);
    if (verifyResult.valid) {
      log(`  Verification PASSED`);
    } else {
      log(`  Verification FAILED:`);
      for (const err of verifyResult.errors) {
        log(`    - ${err}`);
      }
    }
  }

  // Coin balances from session blocks
  const lastBlockA = sessionA.blocks[sessionA.blocks.length - 1];
  const lastBlockB = sessionB.blocks[sessionB.blocks.length - 1];
  const balanceA = lastBlockA?.coinBalance ?? 0;
  const balanceB = lastBlockB?.coinBalance ?? 0;
  const coinsEarnedA = sessionA.finalTick / 1000 * 2; // sharing rate = 2x
  const coinsEarnedB = sessionB.finalTick / 1000 * 2;

  // Output
  const result = {
    playerA: {
      sessionId: sessionA.id,
      blocks: sessionA.blocks.length,
      finalTick: sessionA.finalTick,
      coinsEarned: coinsEarnedA,
      coinBalance: balanceA,
    },
    playerB: {
      sessionId: sessionB.id,
      blocks: sessionB.blocks.length,
      finalTick: sessionB.finalTick,
      coinsEarned: coinsEarnedB,
      coinBalance: balanceB,
    },
    wallTimeMs: elapsedMs,
    verified: verifyResult?.valid ?? null,
    sessionFileA: args.outA,
    sessionFileB: args.outB
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    log('\n--- SOCIAL SESSION COMPLETE ---');
    log(`  Player A: ${result.playerA.blocks} blocks, earned=${result.playerA.coinsEarned.toFixed(2)}, balance=${result.playerA.coinBalance.toFixed(4)}`);
    log(`  Player B: ${result.playerB.blocks} blocks, earned=${result.playerB.coinsEarned.toFixed(2)}, balance=${result.playerB.coinBalance.toFixed(4)}`);
    log(`  Wall time: ${(elapsedMs / 1000).toFixed(1)}s`);
    if (result.verified !== null) {
      log(`  Verified:  ${result.verified ? 'YES' : 'FAILED'}`);
    }
  }
}

main();
