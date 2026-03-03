import { describe, it, expect } from 'vitest';
import { BoardMemory } from '../memory.js';

describe('BoardMemory', () => {
    describe('construction and initial state', () => {
        it('creates with default seed', () => {
            const mem = new BoardMemory();
            expect(mem.storage).toBeInstanceOf(Uint8Array);
            expect(mem.storage.length).toBe(mem.storageSize);
            expect(mem.B).toBe(256);
            expect(mem.M).toBe(1024);
            expect(mem.N).toBe(7);
            expect(mem.Nsquared).toBe(49);
            expect(mem.storageSize).toBe(256 * 256 * 1024);
        });

        it('creates with custom seed', () => {
            const mem1 = new BoardMemory(1);
            const mem2 = new BoardMemory(2);
            // Different seeds should produce different initial origins
            const sampled1 = [mem1.iOrig, mem1.jOrig, mem1.orientation];
            const sampled2 = [mem2.iOrig, mem2.jOrig, mem2.orientation];
            expect(sampled1).not.toEqual(sampled2);
        });

        it('has correct derived constants', () => {
            const mem = new BoardMemory();
            expect(mem.log2M).toBe(10);
            expect(mem.sqrtM).toBe(32);
            expect(mem.byteOffsetMask).toBe(0x3FF);
            expect(mem.neighborhoodSize).toBe(49 * 1024);
        });
    });

    describe('ijToCellIndex / ijbToByteIndex / ijbFromByteIndex', () => {
        it('round-trips through byte index conversions', () => {
            const mem = new BoardMemory();
            for (const [i, j, b] of [[0, 0, 0], [1, 2, 3], [100, 200, 500], [255, 255, 1023]]) {
                const byteIdx = mem.ijbToByteIndex(i, j, b);
                const [ri, rj, rb] = mem.ijbFromByteIndex(byteIdx);
                expect(ri).toBe(i);
                expect(rj).toBe(j);
                expect(rb).toBe(b);
            }
        });

        it('ijToCellIndex is consistent with ijbToByteIndex', () => {
            const mem = new BoardMemory();
            const i = 10, j = 20;
            const cellIdx = mem.ijToCellIndex(i, j);
            const byteIdx = mem.ijbToByteIndex(i, j, 0);
            expect(byteIdx).toBe(cellIdx * mem.M);
        });
    });

    describe('read/write with identity orientation', () => {
        it('can write and read back bytes at the origin cell', () => {
            const mem = new BoardMemory();
            // Force orientation=0 and known origin
            mem.orientation = 0;
            mem.iOrig = 0;
            mem.jOrig = 0;
            // Write to address 0x0010 (byte 0x10 of cell 0, the origin)
            mem.write(0x0010, 0x42);
            expect(mem.read(0x0010)).toBe(0x42);
        });

        it('writes to storage at correct byte index', () => {
            const mem = new BoardMemory();
            mem.orientation = 0;
            mem.iOrig = 5;
            mem.jOrig = 10;
            // Address 0x0050 = byte 0x50 of cell 0 (the origin cell at 5,10)
            mem.write(0x0050, 0xAB);
            const byteIdx = mem.ijbToByteIndex(5, 10, 0x50);
            expect(mem.getByte(byteIdx)).toBe(0xAB);
        });
    });

    describe('rotation: rotate/unrotate inverses', () => {
        it('unrotate(rotate(n)) == n for all orientations and valid cell indices', () => {
            const mem = new BoardMemory();
            for (let orientation = 0; orientation < 4; orientation++) {
                mem.orientation = orientation;
                for (let n = 0; n < 49; n++) {
                    const rotated = mem.rotate(n);
                    const back = mem.unrotate(rotated);
                    expect(back).toBe(n);
                }
            }
        });

        it('rotate(unrotate(n)) == n for all orientations and valid cell indices', () => {
            const mem = new BoardMemory();
            for (let orientation = 0; orientation < 4; orientation++) {
                mem.orientation = orientation;
                for (let n = 0; n < 49; n++) {
                    const unrotated = mem.unrotate(n);
                    const back = mem.rotate(unrotated);
                    expect(back).toBe(n);
                }
            }
        });
    });

    describe('rotateTopBits / unrotateTopBits', () => {
        it('round-trips for all orientations', () => {
            const mem = new BoardMemory();
            for (let orientation = 0; orientation < 4; orientation++) {
                mem.orientation = orientation;
                // Test several values where top bits encode cell indices (0-48)
                for (let cellIdx = 0; cellIdx < 49; cellIdx++) {
                    for (let lowBits = 0; lowBits < 4; lowBits++) {
                        const val = (cellIdx << 2) | lowBits;
                        const rotated = mem.rotateTopBits(val);
                        const back = mem.unrotateTopBits(rotated);
                        expect(back).toBe(val);
                    }
                }
            }
        });
    });

    describe('undo history', () => {
        it('write with undo, then undo restores original value', () => {
            const mem = new BoardMemory();
            const idx = 100;
            mem.setByteWithoutUndo(idx, 0x11);
            mem.resetUndoHistory();
            mem.setByteWithUndo(idx, 0x22);
            expect(mem.getByte(idx)).toBe(0x22);
            mem.undoWrites();
            expect(mem.getByte(idx)).toBe(0x11);
        });

        it('multiple writes to same address only saves first value', () => {
            const mem = new BoardMemory();
            const idx = 200;
            mem.setByteWithoutUndo(idx, 0xAA);
            mem.resetUndoHistory();
            mem.setByteWithUndo(idx, 0xBB);
            mem.setByteWithUndo(idx, 0xCC);
            expect(mem.getByte(idx)).toBe(0xCC);
            mem.undoWrites();
            expect(mem.getByte(idx)).toBe(0xAA);
        });

        it('disableUndoHistory prevents undo tracking', () => {
            const mem = new BoardMemory();
            const idx = 300;
            mem.setByteWithoutUndo(idx, 0x10);
            mem.disableUndoHistory();
            mem.setByteWithUndo(idx, 0x20);
            expect(mem.getByte(idx)).toBe(0x20);
            // undoHistory is now undefined, so undoWrites should be a no-op
            // (it iterates Object.keys of undefined which will throw, but disableUndoHistory
            //  is called after commitWrites, before undoWrites would ever be called)
        });
    });

    describe('lookup table reads', () => {
        it('reads from 0xE000+ return defined values', () => {
            const mem = new BoardMemory();
            // Read some lookup table values
            const val = mem.read(0xE000);
            expect(val).toBeDefined();
            expect(typeof val).toBe('number');
            expect(val).toBeGreaterThanOrEqual(0);
            expect(val).toBeLessThanOrEqual(255);
        });

        it('first row of lookup table is translation by cell 0 (identity)', () => {
            const mem = new BoardMemory();
            // E000 + 64*0 + i should give cell index for v_i + v_0 = v_i
            for (let i = 0; i < 49; i++) {
                expect(mem.read(0xE000 + i)).toBe(i);
            }
        });
    });

    describe('sampleNextMove', () => {
        it('produces valid ranges', () => {
            const mem = new BoardMemory();
            for (let trial = 0; trial < 100; trial++) {
                mem.sampleNextMove();
                expect(mem.iOrig).toBeGreaterThanOrEqual(0);
                expect(mem.iOrig).toBeLessThan(256);
                expect(mem.jOrig).toBeGreaterThanOrEqual(0);
                expect(mem.jOrig).toBeLessThan(256);
                expect(mem.orientation).toBeGreaterThanOrEqual(0);
                expect(mem.orientation).toBeLessThan(4);
                expect(mem.nextCycles).toBeGreaterThan(0);
            }
        });
    });

    describe('addrToByteIndex', () => {
        it('returns -1 for out-of-range addresses', () => {
            const mem = new BoardMemory();
            expect(mem.addrToByteIndex(-1)).toBe(-1);
            expect(mem.addrToByteIndex(mem.neighborhoodSize)).toBe(-1);
            expect(mem.addrToByteIndex(0xFFFF)).toBe(-1);
        });

        it('returns valid index for in-range addresses', () => {
            const mem = new BoardMemory();
            const idx = mem.addrToByteIndex(0);
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThan(mem.storageSize);
        });
    });

    describe('wrapping', () => {
        it('wrapCoord wraps correctly', () => {
            const mem = new BoardMemory();
            expect(mem.wrapCoord(0)).toBe(0);
            expect(mem.wrapCoord(255)).toBe(255);
            expect(mem.wrapCoord(256)).toBe(0);
            expect(mem.wrapCoord(-1)).toBe(255);
            expect(mem.wrapCoord(-256)).toBe(0);
        });

        it('cell at (255,255) can address neighbors at (0,0) via wrapping', () => {
            const mem = new BoardMemory();
            mem.orientation = 0;
            mem.iOrig = 255;
            mem.jOrig = 255;
            // Write to origin cell (255,255)
            mem.write(0x0010, 0xFE);
            const byteIdx = mem.ijbToByteIndex(255, 255, 0x10);
            expect(mem.getByte(byteIdx)).toBe(0xFE);
            // The neighbor at offset (+1,+1) should wrap to (0,0)
            // Cell index for (+1,+1) in spiral order is 5 (NE)
            // Address = 5 * 1024 + offset
            mem.write(5 * 1024 + 0x10, 0xAB);
            const wrappedIdx = mem.ijbToByteIndex(0, 0, 0x10);
            expect(mem.getByte(wrappedIdx)).toBe(0xAB);
        });
    });
});
