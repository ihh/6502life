import { describe, it, expect } from 'vitest';
import { BoardContract, DEFAULT_BOARD_PARAMS } from '../board-contract.js';

describe('BoardContract', () => {
    it('creates with defaults', () => {
        const c = new BoardContract({ initSeed: 'test' });
        expect(c.size).toBe(16);
        expect(c.difficulty).toBe(0);
        expect(c.saltWithParams).toBe(false);
        expect(c.boardParams.pBitNoise).toBe(1 / 2048);
    });

    it('creates with custom params', () => {
        const c = new BoardContract({
            initSeed: 'custom',
            size: 32,
            difficulty: 20,
            saltWithParams: true,
            boardParams: { pBitNoise: 0, hasCompass: true },
        });
        expect(c.size).toBe(32);
        expect(c.difficulty).toBe(20);
        expect(c.saltWithParams).toBe(true);
        expect(c.boardParams.pBitNoise).toBe(0);
        expect(c.boardParams.hasCompass).toBe(true);
        // Defaults still present for unspecified params
        expect(c.boardParams.schedulerMode).toBe('random');
    });

    it('serializes deterministically', () => {
        const c = new BoardContract({ initSeed: 'test', size: 8 });
        const a = c.serialize();
        const b = c.serialize();
        expect(a).toBe(b);
        // Must be valid JSON
        expect(() => JSON.parse(a)).not.toThrow();
    });

    it('serialization has sorted keys', () => {
        const c = new BoardContract({
            initSeed: 'test',
            boardParams: { hasCompass: true, pBitNoise: 0 },
        });
        const json = c.serialize();
        const parsed = JSON.parse(json);
        // boardParams keys should be sorted
        const bpKeys = Object.keys(parsed.boardParams);
        expect(bpKeys).toEqual([...bpKeys].sort());
    });

    it('produces stable id', () => {
        const c = new BoardContract({ initSeed: 'stable', size: 16 });
        const id1 = c.id();
        const id2 = c.id();
        expect(id1).toBe(id2);
        expect(id1.length).toBe(64); // SHA-256 hex
    });

    it('different contracts have different ids', () => {
        const a = new BoardContract({ initSeed: 'a' });
        const b = new BoardContract({ initSeed: 'b' });
        expect(a.id()).not.toBe(b.id());
    });

    it('generates ChaCha20 init', () => {
        const c = new BoardContract({ initSeed: 'hello', size: 8 });
        const init = c.generateInit();
        expect(init.length).toBe(8 * 8 * 1024);
    });

    it('salting changes init for same seed', () => {
        const unsalted = new BoardContract({ initSeed: 'seed', size: 4, saltWithParams: false });
        const salted = new BoardContract({
            initSeed: 'seed',
            size: 4,
            saltWithParams: true,
            difficulty: 10,
        });
        const a = unsalted.generateInit();
        const b = salted.generateInit();
        expect(a).not.toEqual(b);
    });

    it('meetsDifficulty checks leading zero bits', () => {
        const c = new BoardContract({ initSeed: 'test', difficulty: 4 });
        expect(c.meetsDifficulty('0' + 'f'.repeat(63))).toBe(true);  // 4 zero bits
        expect(c.meetsDifficulty('1' + 'f'.repeat(63))).toBe(false); // 3 zero bits

        const c2 = new BoardContract({ initSeed: 'test', difficulty: 8 });
        expect(c2.meetsDifficulty('00' + 'f'.repeat(62))).toBe(true);  // 8 zero bits
        expect(c2.meetsDifficulty('01' + 'f'.repeat(62))).toBe(false); // 4 zero bits
    });

    it('toEngineConfig produces valid config', () => {
        const c = new BoardContract({ initSeed: 'test', size: 16, difficulty: 5 });
        const config = c.toEngineConfig();
        expect(config.gameId).toBe('6502life');
        expect(config.width).toBe(16);
        expect(config.height).toBe(16);
        expect(config.seed).toBe('test');
        expect(config.rules.initMethod).toBe('chacha20');
        expect(config.rules.difficulty).toBe(5);
    });

    it('roundtrips through JSON', () => {
        const c = new BoardContract({
            initSeed: 'roundtrip',
            size: 32,
            difficulty: 15,
            saltWithParams: true,
            boardParams: { pBitNoise: 0.001 },
        });
        const json = c.serialize();
        const c2 = BoardContract.fromJSON(json);
        expect(c2.id()).toBe(c.id());
        expect(c2.size).toBe(c.size);
        expect(c2.difficulty).toBe(c.difficulty);
        expect(c2.saltWithParams).toBe(c.saltWithParams);
    });
});

describe('saltWithParams prevents cherry-picking', () => {
    it('changing difficulty changes init even with same seed', () => {
        const a = new BoardContract({
            initSeed: 'fixed',
            size: 8,
            saltWithParams: true,
            difficulty: 5,
        });
        const b = new BoardContract({
            initSeed: 'fixed',
            size: 8,
            saltWithParams: true,
            difficulty: 10,
        });
        expect(a.generateInit()).not.toEqual(b.generateInit());
    });

    it('changing noise changes init even with same seed', () => {
        const a = new BoardContract({
            initSeed: 'fixed',
            size: 8,
            saltWithParams: true,
            boardParams: { pBitNoise: 0 },
        });
        const b = new BoardContract({
            initSeed: 'fixed',
            size: 8,
            saltWithParams: true,
            boardParams: { pBitNoise: 0.01 },
        });
        expect(a.generateInit()).not.toEqual(b.generateInit());
    });

    it('without salt, params changes do NOT change init', () => {
        const a = new BoardContract({
            initSeed: 'fixed',
            size: 8,
            saltWithParams: false,
            difficulty: 5,
        });
        const b = new BoardContract({
            initSeed: 'fixed',
            size: 8,
            saltWithParams: false,
            difficulty: 10,
        });
        // Same seed, same size, no salt → same init
        expect(a.generateInit()).toEqual(b.generateInit());
    });
});
