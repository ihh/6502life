#!/usr/bin/env node

/**
 * Solo mining CLI — runs a Game of Life session, records it, produces a "coin".
 *
 * Usage:
 *   node coin/bin/mine.js [options]
 *
 * Options:
 *   --size N          Board size NxN (default: 32)
 *   --seed N          PRNG seed (default: 42)
 *   --ticks N         Total simulation ticks (default: 100000)
 *   --block-interval N  Ticks per block (default: 10000)
 *   --out FILE        Output session file (default: session.json)
 *   --verify          Verify the session after mining
 *   --json            Output result as JSON to stdout
 *   --quiet           Suppress progress output
 */

import { writeFileSync } from 'node:fs';
import { LifeEngine } from '../engines/life.js';
import { Session } from '../session.js';
import { verifySession } from '../verify.js';

function parseArgs(argv) {
  const args = {
    size: 32,
    seed: 42,
    ticks: 100000,
    blockInterval: 10000,
    out: 'session.json',
    verify: false,
    json: false,
    quiet: false
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--help':
        console.log(`mine.js — Solo mining CLI for 6502coin

Usage:
  node coin/bin/mine.js [options]

Options:
  --size N             Board size NxN (default: 32)
  --seed N             PRNG seed (default: 42)
  --ticks N            Total simulation ticks (default: 100000)
  --block-interval N   Ticks per block (default: 10000)
  --out FILE           Output session file (default: session.json)
  --verify             Verify the session after mining
  --json               Output result as JSON to stdout
  --quiet              Suppress progress output
  --help               Show this help message`);
        process.exit(0);
      case '--size': args.size = parseInt(argv[++i]); break;
      case '--seed': args.seed = parseInt(argv[++i]); break;
      case '--ticks': args.ticks = parseInt(argv[++i]); break;
      case '--block-interval': args.blockInterval = parseInt(argv[++i]); break;
      case '--out': args.out = argv[++i]; break;
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

  const config = {
    gameId: 'life',
    width: args.size,
    height: args.size,
    seed: args.seed
  };

  log(`Mining: Game of Life ${args.size}x${args.size}, seed=${args.seed}, ticks=${args.ticks}`);

  // Initialize engine
  const engine = new LifeEngine();
  engine.init(config);

  // Create session
  const session = new Session(engine, config, { blockInterval: args.blockInterval });

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
  const record = session.finalize();

  writeFileSync(args.out, JSON.stringify(record, null, 2));
  log(`Session saved to ${args.out}`);
  log(`  ${record.blocks.length} blocks, ${elapsedMs}ms wall time`);

  // Verify if requested
  let verifyResult = null;
  if (args.verify) {
    log('Verifying session...');
    const verifyEngine = new LifeEngine();
    verifyResult = verifySession(record, verifyEngine);
    if (verifyResult.valid) {
      log(`  Verification PASSED (${verifyResult.blocks.length} blocks OK)`);
    } else {
      log(`  Verification FAILED: ${verifyResult.error || verifyResult.blocks.find(b => !b.valid)?.error}`);
    }
  }

  // Summary output
  const summary = engine.summarize();
  const coin = {
    sessionId: record.id,
    gameId: 'life',
    boardSize: `${args.size}x${args.size}`,
    seed: args.seed,
    totalTicks: record.finalTick,
    blocks: record.blocks.length,
    wallTimeMs: elapsedMs,
    liveCells: summary.liveCells,
    density: summary.density,
    totalBorn: summary.totalBorn,
    totalDied: summary.totalDied,
    verified: verifyResult?.valid ?? null,
    sessionFile: args.out
  };

  if (args.json) {
    console.log(JSON.stringify(coin, null, 2));
  } else {
    log('\n--- COIN MINTED ---');
    log(`  Session:    ${coin.sessionId}`);
    log(`  Game:       ${coin.gameId} (${coin.boardSize})`);
    log(`  Ticks:      ${coin.totalTicks}`);
    log(`  Blocks:     ${coin.blocks}`);
    log(`  Wall time:  ${(coin.wallTimeMs / 1000).toFixed(1)}s`);
    log(`  Live cells: ${coin.liveCells} (${(coin.density * 100).toFixed(1)}%)`);
    log(`  Born/Died:  ${coin.totalBorn}/${coin.totalDied}`);
    if (coin.verified !== null) {
      log(`  Verified:   ${coin.verified ? 'YES' : 'FAILED'}`);
    }
  }
}

main();
