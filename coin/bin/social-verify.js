#!/usr/bin/env node

/**
 * Social session verifier — verifies a pair of social mining sessions.
 *
 * Checks both signatures on each block, hash chain integrity, boundary
 * frame cross-consistency, and optionally replays both boards with
 * edge-sharing to verify state hashes.
 *
 * Usage:
 *   node coin/bin/social-verify.js session-a.json session-b.json [options]
 *
 * Options:
 *   --skip-replay     Skip full replay verification (faster, less thorough)
 *   --json            Output result as JSON to stdout
 *   --verbose         Print detailed verification steps
 */

import { readFileSync } from 'node:fs';
import { LifeEngine } from '../engines/life.js';
import { verifySocialSession } from '../social-session.js';
import { computeCoinValue, sessionToSummary } from '../economics.js';

function parseArgs(argv) {
  const args = {
    fileA: null,
    fileB: null,
    skipReplay: false,
    json: false,
    verbose: false
  };

  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--help':
        console.log(`social-verify.js — Verify a pair of social mining sessions

Usage:
  node coin/bin/social-verify.js <session-a.json> <session-b.json> [options]

Options:
  --skip-replay      Skip full replay verification (faster, less thorough)
  --json             Output result as JSON to stdout
  --verbose          Print detailed verification steps
  --help             Show this help message`);
        process.exit(0);
      case '--skip-replay': args.skipReplay = true; break;
      case '--json': args.json = true; break;
      case '--verbose': args.verbose = true; break;
      default:
        if (argv[i].startsWith('--')) {
          console.error(`Unknown option: ${argv[i]}`);
          process.exit(1);
        }
        positional.push(argv[i]);
    }
  }

  if (positional.length < 2) {
    console.error('Usage: social-verify.js <session-a.json> <session-b.json> [options]');
    process.exit(1);
  }

  args.fileA = positional[0];
  args.fileB = positional[1];
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const log = (...a) => console.error(...a);

  // Load sessions
  let sessionA, sessionB;
  try {
    sessionA = JSON.parse(readFileSync(args.fileA, 'utf-8'));
    sessionB = JSON.parse(readFileSync(args.fileB, 'utf-8'));
  } catch (err) {
    console.error(`Error loading session files: ${err.message}`);
    process.exit(1);
  }

  if (args.verbose) {
    log(`Session A: ${sessionA.id} (${sessionA.blocks.length} blocks, ${sessionA.finalTick} ticks)`);
    log(`Session B: ${sessionB.id} (${sessionB.blocks.length} blocks, ${sessionB.finalTick} ticks)`);
    log(`Partner cross-reference: A.partner=${sessionA.partnerSessionId}, B.partner=${sessionB.partnerSessionId}`);
    log('');
  }

  // Verify partner cross-references
  if (sessionA.partnerSessionId !== sessionB.id) {
    log(`Warning: A's partnerSessionId (${sessionA.partnerSessionId}) != B's id (${sessionB.id})`);
  }
  if (sessionB.partnerSessionId !== sessionA.id) {
    log(`Warning: B's partnerSessionId (${sessionB.partnerSessionId}) != A's id (${sessionA.id})`);
  }

  // Create fresh engines for replay
  const engineA = new LifeEngine();
  const engineB = new LifeEngine();

  if (args.verbose) {
    log(`Verifying...${args.skipReplay ? ' (replay skipped)' : ' (with full replay)'}`);
  }

  const result = verifySocialSession(sessionA, sessionB, engineA, engineB, {
    skipReplay: args.skipReplay
  });

  // Economics
  const summaryA = sessionToSummary(sessionA);
  const summaryB = sessionToSummary(sessionB);
  const valueA = computeCoinValue(summaryA);
  const valueB = computeCoinValue(summaryB);

  const output = {
    valid: result.valid,
    errors: result.errors,
    sessionA: {
      id: sessionA.id,
      blocks: sessionA.blocks.length,
      finalTick: sessionA.finalTick,
      coinValue: valueA.totalValue
    },
    sessionB: {
      id: sessionB.id,
      blocks: sessionB.blocks.length,
      finalTick: sessionB.finalTick,
      coinValue: valueB.totalValue
    }
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    if (result.valid) {
      log('VERIFICATION PASSED');
      log(`  Session A: ${sessionA.blocks.length} blocks, value=${valueA.totalValue.toFixed(2)}`);
      log(`  Session B: ${sessionB.blocks.length} blocks, value=${valueB.totalValue.toFixed(2)}`);
    } else {
      log('VERIFICATION FAILED');
      for (const err of result.errors) {
        log(`  ERROR: ${err}`);
      }
    }
  }

  process.exit(result.valid ? 0 : 1);
}

main();
