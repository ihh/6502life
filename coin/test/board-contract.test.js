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

    it('generates BLAKE3 init', () => {
        const c = new BoardContract({ initSeed: 'hello', size: 8 });
        const init = c.generateInit();
        expect(init.length).toBe(8 * 8 * 1024);
    });

    it('deterministic: same seed same output', () => {
        const c1 = new BoardContract({ initSeed: 42, size: 4 });
        const c2 = new BoardContract({ initSeed: 42, size: 4 });
        expect(c1.generateInit()).toEqual(c2.generateInit());
    });

    it('different seeds produce different boards', () => {
        const a = new BoardContract({ initSeed: 100, size: 4 });
        const b = new BoardContract({ initSeed: 200, size: 4 });
        expect(a.generateInit()).not.toEqual(b.generateInit());
    });

    it('string seeds are hashed to u32', () => {
        const c = new BoardContract({ initSeed: 'hello', size: 4 });
        const init = c.generateInit();
        expect(init.length).toBe(4 * 4 * 1024);
        // Should be deterministic
        const init2 = new BoardContract({ initSeed: 'hello', size: 4 }).generateInit();
        expect(init).toEqual(init2);
    });

    it('meetsDifficulty checks leading zero bits', () => {
        const c = new BoardContract({ initSeed: 'test', difficulty: 4 });
        expect(c.meetsDifficulty('0' + 'f'.repeat(63))).toBe(true);  // 4 zero bits
        expect(c.meetsDifficulty('1' + 'f'.repeat(63))).toBe(false); // 3 zero bits

        const c2 = new BoardContract({ initSeed: 'test', difficulty: 8 });
        expect(c2.meetsDifficulty('00' + 'f'.repeat(62))).toBe(true);  // 8 zero bits
        expect(c2.meetsDifficulty('01' + 'f'.repeat(62))).toBe(false); // 4 zero bits
    });

    it('toEngineConfig produces valid config with blake3 init method', () => {
        const c = new BoardContract({ initSeed: 'test', size: 16, difficulty: 5 });
        const config = c.toEngineConfig();
        expect(config.gameId).toBe('6502life');
        expect(config.width).toBe(16);
        expect(config.height).toBe(16);
        expect(config.seed).toBe('test');
        expect(config.rules.initMethod).toBe('blake3');
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
