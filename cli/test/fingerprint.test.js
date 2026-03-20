import { describe, it, expect } from 'vitest';
import { minhash, minhashSimilarity, contentHash, fingerprint, hashHex } from '../lib/probe/fingerprint.js';

describe('contentHash', () => {
    it('produces consistent hashes', () => {
        const data = new Uint8Array([1, 2, 3, 4, 5]);
        expect(contentHash(data, 0, 5)).toBe(contentHash(data, 0, 5));
    });

    it('differs for different data', () => {
        const a = new Uint8Array([1, 2, 3, 4, 5]);
        const b = new Uint8Array([1, 2, 3, 4, 6]);
        expect(contentHash(a, 0, 5)).not.toBe(contentHash(b, 0, 5));
    });

    it('respects offset and length', () => {
        const data = new Uint8Array([0, 1, 2, 3, 4, 5, 0]);
        const sub = new Uint8Array([1, 2, 3, 4, 5]);
        expect(contentHash(data, 1, 5)).toBe(contentHash(sub, 0, 5));
    });
});

describe('minhash', () => {
    it('returns Uint32Array of the right size', () => {
        const data = new Uint8Array(100).fill(42);
        const sig = minhash(data, 0, 100, 4, 16);
        expect(sig).toBeInstanceOf(Uint32Array);
        expect(sig.length).toBe(16);
    });

    it('identical data produces identical signatures', () => {
        const a = new Uint8Array(100);
        const b = new Uint8Array(100);
        for (let i = 0; i < 100; i++) a[i] = b[i] = i;
        const sigA = minhash(a, 0, 100);
        const sigB = minhash(b, 0, 100);
        expect(minhashSimilarity(sigA, sigB)).toBe(1.0);
    });

    it('single-byte change has high similarity', () => {
        const a = new Uint8Array(256);
        const b = new Uint8Array(256);
        for (let i = 0; i < 256; i++) a[i] = b[i] = (i * 7 + 13) & 0xFF;
        b[128] = (b[128] + 1) & 0xFF; // change one byte
        const sigA = minhash(a, 0, 256);
        const sigB = minhash(b, 0, 256);
        const sim = minhashSimilarity(sigA, sigB);
        expect(sim).toBeGreaterThan(0.7); // should be very similar
    });

    it('completely different data has low similarity', () => {
        const a = new Uint8Array(256);
        const b = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            a[i] = i;
            b[i] = (255 - i);
        }
        const sigA = minhash(a, 0, 256);
        const sigB = minhash(b, 0, 256);
        const sim = minhashSimilarity(sigA, sigB);
        expect(sim).toBeLessThan(0.5);
    });
});

describe('fingerprint', () => {
    it('returns hash and minhash', () => {
        const bytes = new Uint8Array(1024);
        for (let i = 0; i < 1024; i++) bytes[i] = i & 0xFF;
        const fp = fingerprint(bytes);
        expect(typeof fp.hash).toBe('number');
        expect(fp.minhash).toBeInstanceOf(Uint32Array);
        expect(fp.minhash.length).toBe(64);
    });

    it('custom range works', () => {
        const bytes = new Uint8Array(1024);
        for (let i = 0; i < 1024; i++) bytes[i] = i & 0xFF;
        const fp1 = fingerprint(bytes, [0, 256]);
        const fp2 = fingerprint(bytes, [0, 512]);
        expect(fp1.hash).not.toBe(fp2.hash); // different ranges = different hashes
    });
});

describe('hashHex', () => {
    it('pads to 8 chars', () => {
        expect(hashHex(0)).toBe('00000000');
        expect(hashHex(255)).toBe('000000ff');
        expect(hashHex(0xDEADBEEF)).toBe('deadbeef');
    });
});
