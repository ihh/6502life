import { describe, it, expect } from 'vitest';
import {
    buildSlideCandidate, generateCandidates, simulateBatch,
    trainSlideWeights, runSlideExperiment,
    SAFE_OPS, RISKY_OPS, ALL_SLIDE_OPS, VIABLE_PAIRS,
} from '../slide-training.js';
import { PRNG } from '../../webgpu/prng.js';

describe('buildSlideCandidate', () => {
    it('no slides = 8-byte canonical', () => {
        const c = buildSlideCandidate({ pair: VIABLE_PAIRS[1] }); // INX+BCC
        expect([...c]).toEqual([0xB5, 0x00, 0x9D, 0x00, 0x04, 0xE8, 0x90, 0xF8]);
    });

    it('one slide at pos 0 = 9-byte prefix', () => {
        const c = buildSlideCandidate({
            slides: [[0, 0xEA]], // NOP before LDA
            pair: VIABLE_PAIRS[1],
        });
        expect(c.length).toBe(9);
        expect(c[0]).toBe(0xEA); // NOP
        expect(c[1]).toBe(0xB5); // LDA
        expect(c[8]).toBe(0xF7); // offset for 9 bytes
    });

    it('two slides at different positions', () => {
        const c = buildSlideCandidate({
            slides: [[0, 0xEA], [3, 0x18]], // NOP before LDA, CLC before branch
            pair: VIABLE_PAIRS[0], // INX+BVC
        });
        expect(c.length).toBe(10);
        expect(c[0]).toBe(0xEA); // NOP
        expect(c[1]).toBe(0xB5); // LDA
        // CLC should be between INX and BVC
        const bvcIdx = [...c].indexOf(0x50);
        expect(c[bvcIdx - 1]).toBe(0x18); // CLC before BVC
    });
});

describe('Multi-slide training experiment', () => {
    it('generates, simulates, and trains on 200 candidates', async () => {
        const { results, trained } = await runSlideExperiment({
            batchSize: 200,
            passes: 80,
            seed: 42,
            maxSlides: 3,
        });

        console.log(`\n=== Multi-Slide Training (${trained.n} candidates) ===`);
        console.log(`  Overall spread rate: ${(trained.overallRate * 100).toFixed(1)}% (${trained.nSpread}/${trained.n})`);

        // Base rates per pair
        console.log('\n--- Base rates (no slides) ---');
        for (const [pair, rate] of Object.entries(trained.baseRates)) {
            console.log(`  ${pair}: ${(rate * 100).toFixed(0)}%`);
        }

        // Per-opcode weights, sorted by position then probability
        const byPos = [[], [], [], []];
        for (const [key, w] of Object.entries(trained.weights)) {
            if (w.total >= 3) byPos[w.pos].push(w);
        }

        const posNames = ['before LDA', 'between addr/STA', 'between page/INC', 'between INC/branch'];
        for (let pos = 0; pos < 4; pos++) {
            const ops = byPos[pos].sort((a, b) => b.p - a.p);
            if (ops.length === 0) continue;
            console.log(`\n--- Position ${pos}: ${posNames[pos]} ---`);
            for (const w of ops) {
                const hex = w.op.toString(16).padStart(2, '0');
                const pStr = w.p.toFixed(3);
                const safe = SAFE_OPS.includes(w.op) ? 'safe' : 'risky';
                console.log(`  $${hex} (${safe}): P=${pStr} (${w.spread}/${w.total})`);
            }
        }

        // Collect all unique probabilities
        const allPs = Object.values(trained.weights)
            .filter(w => w.total >= 3)
            .map(w => Math.round(w.p * 1000) / 1000);
        const uniquePs = [...new Set(allPs)].sort((a, b) => a - b);
        console.log(`\n  Unique probability values (n≥3): ${uniquePs.join(', ')}`);

        // Length distribution of candidates
        const lengthDist = {};
        for (const r of results) {
            lengthDist[r.length] = (lengthDist[r.length] || { total: 0, spread: 0 });
            lengthDist[r.length].total++;
            if (r.copied) lengthDist[r.length].spread++;
        }
        console.log('\n--- Spread rate by program length ---');
        for (const [len, d] of Object.entries(lengthDist).sort((a,b) => a[0]-b[0])) {
            console.log(`  ${len} bytes: ${(d.spread/d.total*100).toFixed(0)}% (${d.spread}/${d.total})`);
        }

        expect(trained.n).toBe(200);
        expect(trained.nSpread).toBeGreaterThan(0);
    }, 120000);
});

describe('Interaction effects', () => {
    it('SEC then CLC rescues BCC', async () => {
        // SEC at pos 0, CLC at pos 3 (between INC and branch)
        // SEC sets C=1, but CLC clears it back → BCC should work
        const secClc = buildSlideCandidate({
            slides: [[0, 0x38], [3, 0x18]], // SEC, CLC
            pair: { inc: 0xE8, branch: 0x90 }, // INX+BCC
        });

        // SEC alone at pos 0 kills BCC
        const secOnly = buildSlideCandidate({
            slides: [[0, 0x38]],
            pair: { inc: 0xE8, branch: 0x90 },
        });

        const [rBoth, rSec] = await simulateBatch(
            [
                { bytes: secClc, pair: { inc: 0xE8, branch: 0x90, name: 'INX+BCC' }, slides: [[0,0x38],[3,0x18]], length: secClc.length },
                { bytes: secOnly, pair: { inc: 0xE8, branch: 0x90, name: 'INX+BCC' }, slides: [[0,0x38]], length: secOnly.length },
            ],
            { passes: 80, seed: 42 },
        );

        console.log(`\n=== Interaction: SEC + CLC → BCC ===`);
        console.log(`  SEC only:    spread=${rSec.spread} copied=${rSec.copied}`);
        console.log(`  SEC + CLC:   spread=${rBoth.spread} copied=${rBoth.copied}`);

        // SEC alone should kill BCC (spread=0 or very low)
        expect(rSec.copied).toBe(false);
        // SEC+CLC should rescue BCC (CLC undoes SEC)
        expect(rBoth.copied).toBe(true);
    }, 30000);
});
