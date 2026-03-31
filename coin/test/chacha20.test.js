import { describe, it, expect } from 'vitest';
import { chacha20Stream, seedToKey, deriveNonce, generateBoardInit } from '../chacha20.js';

describe('chacha20Stream', () => {
    it('produces deterministic output', () => {
        const key = new Uint8Array(32);
        const nonce = new Uint8Array(12);
        const a = chacha20Stream(key, nonce, 64);
        const b = chacha20Stream(key, nonce, 64);
        expect(a).toEqual(b);
    });

    it('different keys produce different output', () => {
        const key1 = new Uint8Array(32); key1[0] = 1;
        const key2 = new Uint8Array(32); key2[0] = 2;
        const nonce = new Uint8Array(12);
        const a = chacha20Stream(key1, nonce, 64);
        const b = chacha20Stream(key2, nonce, 64);
        expect(a).not.toEqual(b);
    });

    it('different nonces produce different output', () => {
        const key = new Uint8Array(32);
        const nonce1 = new Uint8Array(12); nonce1[0] = 1;
        const nonce2 = new Uint8Array(12); nonce2[0] = 2;
        const a = chacha20Stream(key, nonce1, 64);
        const b = chacha20Stream(key, nonce2, 64);
        expect(a).not.toEqual(b);
    });

    it('generates correct length', () => {
        const key = new Uint8Array(32);
        const nonce = new Uint8Array(12);
        expect(chacha20Stream(key, nonce, 100).length).toBe(100);
        expect(chacha20Stream(key, nonce, 1000).length).toBe(1000);
    });

    it('multi-block output is consistent with single-block', () => {
        const key = new Uint8Array(32); key[0] = 42;
        const nonce = new Uint8Array(12);
        const long = chacha20Stream(key, nonce, 128);
        const short = chacha20Stream(key, nonce, 64);
        // First 64 bytes should match
        expect(long.subarray(0, 64)).toEqual(short);
    });

    it('output looks random (no obvious patterns)', () => {
        const key = seedToKey('test-seed');
        const nonce = new Uint8Array(12);
        const stream = chacha20Stream(key, nonce, 1024);
        // Count byte frequencies — should be roughly uniform
        const counts = new Uint32Array(256);
        for (const b of stream) counts[b]++;
        const mean = 1024 / 256; // 4
        const maxDeviation = Math.max(...Array.from(counts).map(c => Math.abs(c - mean)));
        // Chi-squared-like check: no byte should appear > 5x expected
        expect(maxDeviation).toBeLessThan(mean * 5);
    });
});

describe('seedToKey', () => {
    it('string seed produces 32-byte key', () => {
        const key = seedToKey('hello');
        expect(key.length).toBe(32);
    });

    it('numeric seed produces 32-byte key', () => {
        const key = seedToKey(42);
        expect(key.length).toBe(32);
    });

    it('different seeds produce different keys', () => {
        expect(seedToKey('a')).not.toEqual(seedToKey('b'));
    });
});

describe('deriveNonce', () => {
    it('produces 12-byte nonce', () => {
        const nonce = deriveNonce({ size: 16 });
        expect(nonce.length).toBe(12);
    });

    it('different sizes produce different nonces', () => {
        const a = deriveNonce({ size: 16 });
        const b = deriveNonce({ size: 32 });
        expect(a).not.toEqual(b);
    });

    it('salting with params changes the nonce', () => {
        const unsalted = deriveNonce({ size: 16, saltWithParams: false });
        const salted = deriveNonce({
            size: 16,
            saltWithParams: true,
            boardParams: { pBitNoise: 0.001 },
            difficulty: 20,
        });
        expect(unsalted).not.toEqual(salted);
    });

    it('same params produce same nonce', () => {
        const a = deriveNonce({ size: 16, saltWithParams: true, difficulty: 10 });
        const b = deriveNonce({ size: 16, saltWithParams: true, difficulty: 10 });
        expect(a).toEqual(b);
    });
});

describe('generateBoardInit', () => {
    it('generates correct total bytes', () => {
        const init = generateBoardInit('seed', 8);
        expect(init.length).toBe(8 * 8 * 1024); // 64 cells × 1024 bytes
    });

    it('deterministic: same seed same output', () => {
        const a = generateBoardInit('myseed', 4);
        const b = generateBoardInit('myseed', 4);
        expect(a).toEqual(b);
    });

    it('different seeds produce different boards', () => {
        const a = generateBoardInit('seed1', 4);
        const b = generateBoardInit('seed2', 4);
        expect(a).not.toEqual(b);
    });

    it('salting changes the output', () => {
        const a = generateBoardInit('seed', 4, { saltWithParams: false });
        const b = generateBoardInit('seed', 4, {
            saltWithParams: true,
            boardParams: { pBitNoise: 0 },
            difficulty: 5,
        });
        expect(a).not.toEqual(b);
    });
});
