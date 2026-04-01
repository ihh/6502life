#!/usr/bin/env node
/**
 * Mine for replicators with real-time narration of near-misses.
 *
 * Usage:
 *   node dfa/mine-and-narrate.js [biasWeight=100] [boardSize=64] [maxSeeds=1000000]
 */

import { analyzeCell, OPCODE_LENGTHS } from './loop-detector.js';
import { PRNG } from '../webgpu/prng.js';
import crypto from 'crypto';

// ── Biased byte generation ───────────────────────────────────────────

const ELEVATED = [
    0x00, 0x04, 0x08, 0x18, 0x1A, 0x3A, 0x48, 0x50,
    0x58, 0x5A, 0x78, 0x7A, 0x88, 0x90, 0x99, 0x9A,
    0x9D, 0xA0, 0xA8, 0xB5, 0xB7, 0xB8, 0xC8, 0xCA,
    0xD8, 0xDA, 0xE8, 0xEA, 0xF8, 0xFA,
];
const ELEVATED_SET = new Set(ELEVATED);
const BG_BYTES = [];
for (let i = 0; i < 256; i++) if (!ELEVATED_SET.has(i)) BG_BYTES.push(i);

function makeBiasedCell(rng, biasWeight) {
    const N1 = ELEVATED.length, N0 = BG_BYTES.length;
    const pElev = (N1 * biasWeight) / (N1 * biasWeight + N0);
    const cell = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        if (rng.real() < pElev) {
            cell[i] = ELEVATED[rng.below(ELEVATED.length)];
        } else {
            cell[i] = BG_BYTES[rng.below(BG_BYTES.length)];
        }
    }
    return cell;
}

// ── Offset verification ──────────────────────────────────────────────

function verifyOffset(loopBytes, targetPos) {
    // Walk the loop to find LDA/LAX position and branch position
    let pc = 0;
    let ldaPos = null;
    let branchPos = null;
    let branchOffset = null;

    while (pc < loopBytes.length) {
        const op = loopBytes[pc];
        const len = OPCODE_LENGTHS[op];
        if (len === 0) break;
        if (pc + len > loopBytes.length) break;

        if ((op === 0xB5 || op === 0xB7) && ldaPos === null) {
            ldaPos = targetPos + pc;
        }
        if ([0x10, 0x30, 0x50, 0x70, 0x90, 0xB0, 0xD0, 0xF0].includes(op)) {
            branchPos = targetPos + pc;
            branchOffset = loopBytes[pc + 1];
        }
        pc += len;
    }

    if (ldaPos === null || branchPos === null) return { valid: false, reason: 'no LDA or branch' };

    const expected = (ldaPos - branchPos - 2) & 0xFF;
    if (branchOffset === expected) {
        return { valid: true, ldaPos, branchPos };
    }

    const diff = ((branchOffset - expected + 128) & 0xFF) - 128;
    return {
        valid: false,
        reason: `offset ${branchOffset.toString(16)} targets byte ${(branchPos + 2 + (branchOffset >= 128 ? branchOffset - 256 : branchOffset)) & 0xFF}, ` +
                `need ${expected.toString(16)} to reach LDA at byte ${ldaPos} (off by ${diff >= 0 ? '+' : ''}${diff})`,
        expected,
        actual: branchOffset,
        offBy: Math.abs(diff),
    };
}

// ── Disassemble for display ──────────────────────────────────────────

const OPCODE_NAMES = {};
{
    // Just the ones we care about for display
    const names = {
        0x00: 'BRK', 0x08: 'PHP', 0x18: 'CLC', 0x38: 'SEC',
        0x48: 'PHA', 0x50: 'BVC', 0x58: 'CLI', 0x68: 'PLA',
        0x70: 'BVS', 0x78: 'SEI', 0x88: 'DEY', 0x8A: 'TXA',
        0x90: 'BCC', 0x98: 'TYA', 0x9A: 'TXS', 0xA8: 'TAY',
        0xAA: 'TAX', 0xB0: 'BCS', 0xB8: 'CLV', 0xBA: 'TSX',
        0xC8: 'INY', 0xCA: 'DEX', 0xD0: 'BNE', 0xD8: 'CLD',
        0xE8: 'INX', 0xEA: 'NOP', 0xF0: 'BEQ', 0xF8: 'SED',
        0x10: 'BPL', 0x30: 'BMI',
        0xB5: 'LDA zpx', 0xB7: 'LAX zpy',
        0x9D: 'STA abx', 0x99: 'STA aby',
        0xA0: 'LDY #',
        0x1A: 'NOP*', 0x3A: 'NOP*', 0x5A: 'NOP*',
        0x7A: 'NOP*', 0xDA: 'NOP*', 0xFA: 'NOP*',
    };
    Object.assign(OPCODE_NAMES, names);
}

function disasmShort(loopBytes, maxInstrs = 8) {
    const parts = [];
    let pc = 0;
    let count = 0;
    while (pc < loopBytes.length && count < maxInstrs) {
        const op = loopBytes[pc];
        const len = OPCODE_LENGTHS[op];
        if (len === 0) { parts.push('JAM'); break; }
        if (pc + len > loopBytes.length) break;

        const name = OPCODE_NAMES[op] || `$${op.toString(16).padStart(2, '0')}`;
        if (len === 1) {
            parts.push(name);
        } else if (len === 2) {
            parts.push(`${name} $${loopBytes[pc + 1].toString(16).padStart(2, '0')}`);
        } else {
            const lo = loopBytes[pc + 1], hi = loopBytes[pc + 2];
            parts.push(`${name} $${hi.toString(16).padStart(2, '0')}${lo.toString(16).padStart(2, '0')}`);
        }
        pc += len;
        count++;
    }
    if (pc < loopBytes.length) parts.push('...');
    return parts.join('; ');
}

// ── Level descriptions ───────────────────────────────────────────────

const LEVEL_EMOJI = {
    0: '  ',  1: '🔄', 2: '🔧', 3: '⚡', 4: '📝',
    5: '🔗', 6: '🧬', 7: '🔬', 8: '🎯', 9: '💫', 10: '⭐',
};

const LEVEL_DESC = {
    1: 'loop detected',
    2: 'loop + 1 interesting op',
    3: 'loop + 2 interacting ops',
    4: 'loop with load+store+inc',
    5: 'indexed copy pattern',
    6: 'near-complete core (2/3)',
    7: 'complete core, wrong addrs',
    8: 'correct addresses!',
    9: 'correct offset — simulating...',
    10: 'VIABLE REPLICATOR!',
};

// ── Main mining loop ─────────────────────────────────────────────────

const biasWeight = parseInt(process.argv[2] || '100');
const boardSize = parseInt(process.argv[3] || '64');
const maxSeeds = parseInt(process.argv[4] || '1000000');
const nCells = boardSize * boardSize;

console.log(`╔═══════════════════════════════════════════════════════════╗`);
console.log(`║  6502life Replicator Mining                              ║`);
console.log(`║  Board: ${boardSize}×${boardSize} (${nCells} cells)  Bias: ${biasWeight}                     ║`);
console.log(`╚═══════════════════════════════════════════════════════════╝`);
console.log();

const stats = {
    seeds: 0,
    cellsScanned: 0,
    levelCounts: new Array(11).fill(0),
    bestLevel: 0,
    bestEvent: null,
    nearMisses: [],      // L7+ events
    startTime: Date.now(),
    lastReport: Date.now(),
    viable: [],
};

// Throttle output: show at most 1 event per second, preferring higher levels
let pendingEvents = [];
let lastEventTime = 0;

function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

function reportEvent(event) {
    const now = Date.now();
    const elapsed = formatTime(now - stats.startTime);
    const rate = stats.seeds / ((now - stats.startTime) / 1000);
    const emoji = LEVEL_EMOJI[event.level] || '  ';
    const levelName = LEVEL_DESC[event.level] || `L${event.level}`;

    const hex = Array.from(event.loop.loopBytes.slice(0, 16))
        .map(b => b.toString(16).padStart(2, '0')).join(' ');
    const asm = disasmShort(event.loop.loopBytes);

    console.log(`${emoji} L${event.level} [${elapsed}] seed=${event.seed} cell=(${event.cellI},${event.cellJ})`);
    console.log(`   ${levelName}`);
    console.log(`   ${asm}`);

    if (event.level >= 7 && event.coreMatch) {
        console.log(`   Core: ${event.coreMatch.variant}`);
        if (event.coreMatch.issues.length > 0) {
            console.log(`   Issues: ${event.coreMatch.issues.join(', ')}`);
        }
    }

    if (event.offsetCheck) {
        if (event.offsetCheck.valid) {
            console.log(`   ✓ Branch offset correct!`);
        } else if (event.offsetCheck.offBy !== undefined) {
            console.log(`   ✗ ${event.offsetCheck.reason}`);
        }
    }

    if (event.level === 10) {
        console.log(`   ⭐⭐⭐ VIABLE REPLICATOR FOUND! ⭐⭐⭐`);
        console.log(`   Spread: ${event.spread} cells`);
    }

    console.log(`   [${stats.seeds} seeds, ${rate.toFixed(0)}/s, L7+: ${stats.levelCounts.slice(7).reduce((a, b) => a + b, 0)}]`);
    console.log();
}

function flushEvents() {
    if (pendingEvents.length === 0) return;

    const now = Date.now();
    if (now - lastEventTime < 1000 && !pendingEvents.some(e => e.level >= 9)) return;

    // Pick the most interesting pending event
    pendingEvents.sort((a, b) => b.level - a.level || b.score - a.score);
    const best = pendingEvents[0];
    reportEvent(best);
    pendingEvents = [];
    lastEventTime = now;
}

// Mining loop
for (let seed = 0; seed < maxSeeds; seed++) {
    const rng = new PRNG(seed * 2654435761 >>> 0);  // hash the seed for variety

    for (let ci = 0; ci < boardSize; ci++) {
        for (let cj = 0; cj < boardSize; cj++) {
            const cell = makeBiasedCell(rng, biasWeight);
            const results = analyzeCell(cell);

            if (results.length > 0) {
                const best = results[0];
                stats.levelCounts[best.level]++;

                if (best.level > stats.bestLevel) {
                    stats.bestLevel = best.level;
                    stats.bestEvent = best;
                }

                // For L7+: check offset and maybe simulate
                if (best.level >= 7) {
                    const offsetCheck = verifyOffset(best.loop.loopBytes, best.loop.targetPos);

                    const event = {
                        ...best,
                        seed,
                        cellI: ci,
                        cellJ: cj,
                        offsetCheck,
                        score: best.coreMatch ? best.coreMatch.score : 0,
                    };

                    if (offsetCheck.valid) {
                        // L9: offset correct! This might actually work.
                        event.level = 9;
                        stats.levelCounts[9]++;
                        // TODO: simulate to confirm (would need the JS bare sim)
                        // For now, report as L9
                    }

                    pendingEvents.push(event);
                } else if (best.level >= 4) {
                    pendingEvents.push({
                        ...best,
                        seed,
                        cellI: ci,
                        cellJ: cj,
                        score: best.coreMatch ? best.coreMatch.score : 0,
                    });
                }
            } else {
                stats.levelCounts[0]++;
            }

            stats.cellsScanned++;
        }
    }

    stats.seeds++;
    flushEvents();

    // Periodic status (every 30 seconds)
    const now = Date.now();
    if (now - stats.lastReport > 30000) {
        const elapsed = formatTime(now - stats.startTime);
        const rate = stats.seeds / ((now - stats.startTime) / 1000);
        console.log(`── Status [${elapsed}] ──────────────────────────────────`);
        console.log(`   Seeds: ${stats.seeds}/${maxSeeds} (${rate.toFixed(0)}/s)`);
        console.log(`   Levels: ` + stats.levelCounts.map((c, i) => c > 0 ? `L${i}:${c}` : '').filter(Boolean).join(' '));
        console.log(`   Best: L${stats.bestLevel}`);
        console.log();
        stats.lastReport = now;
    }
}

// Final report
const elapsed = Date.now() - stats.startTime;
console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
console.log(`║  Mining Complete                                         ║`);
console.log(`╚═══════════════════════════════════════════════════════════╝`);
console.log(`  Time: ${formatTime(elapsed)}`);
console.log(`  Seeds: ${stats.seeds}`);
console.log(`  Cells scanned: ${stats.cellsScanned}`);
console.log(`  Rate: ${(stats.seeds / (elapsed / 1000)).toFixed(0)} seeds/s`);
console.log(`  Level distribution:`);
for (let l = 0; l <= 10; l++) {
    if (stats.levelCounts[l] > 0) {
        const pct = (stats.levelCounts[l] / stats.seeds * 100).toFixed(1);
        const bar = '█'.repeat(Math.min(40, Math.ceil(stats.levelCounts[l] / stats.seeds * 40)));
        console.log(`    L${l.toString().padStart(2)}: ${stats.levelCounts[l].toString().padStart(8)} (${pct.padStart(5)}%) ${bar}`);
    }
}
if (stats.viable.length > 0) {
    console.log(`\n  VIABLE ORGANISMS: ${stats.viable.length}`);
    for (const v of stats.viable) {
        console.log(`    Seed ${v.seed} cell (${v.cellI},${v.cellJ})`);
    }
}
