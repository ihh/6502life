import { describe, it, expect } from 'vitest';
import { BoardVisualizer } from '../visualizer.js';
import { BoardController } from '../controller.js';

describe('BoardVisualizer', () => {
    describe('construction', () => {
        it('creates with default controller', () => {
            const viz = new BoardVisualizer();
            expect(viz.controller).toBeInstanceOf(BoardController);
        });

        it('creates with provided controller', () => {
            const ctrl = new BoardController();
            const viz = new BoardVisualizer(ctrl);
            expect(viz.controller).toBe(ctrl);
        });

        it('has overview and detail configs', () => {
            const viz = new BoardVisualizer();
            expect(viz.overviewConfig).toBeDefined();
            expect(viz.overviewConfig.hue).toBe(1 / 3);
            expect(viz.detailConfig).toBeDefined();
        });
    });

    describe('getOverviewPixelBuffer', () => {
        it('returns correct-sized buffer', () => {
            const viz = new BoardVisualizer();
            const buffer = viz.getOverviewPixelBuffer();
            const B = viz.controller.memory.B;
            expect(buffer).toBeInstanceOf(Uint8ClampedArray);
            expect(buffer.length).toBe(B * B * 4);
        });

        it('returns non-zero pixel values', () => {
            const viz = new BoardVisualizer();
            const buffer = viz.getOverviewPixelBuffer();
            // Alpha channel should always be 255
            expect(buffer[3]).toBe(255);
        });
    });

    describe('getCellName', () => {
        it('reads ASCII from display name area', () => {
            const viz = new BoardVisualizer();
            const mem = viz.controller.memory;
            // Write "HELLO" to cell (0,0) display name area
            const nameAddr = mem.displayNameAddr;
            const text = 'HELLO';
            for (let k = 0; k < text.length; k++) {
                const byteIdx = mem.ijbToByteIndex(0, 0, nameAddr + k);
                mem.setByteWithoutUndo(byteIdx, text.charCodeAt(k));
            }
            // Clear the rest
            for (let k = text.length; k < mem.displayNameBytes; k++) {
                const byteIdx = mem.ijbToByteIndex(0, 0, nameAddr + k);
                mem.setByteWithoutUndo(byteIdx, 0);
            }
            const name = viz.getCellName(0, 0);
            expect(name).toBe('HELLO');
        });

        it('filters non-printable characters', () => {
            const viz = new BoardVisualizer();
            const mem = viz.controller.memory;
            const nameAddr = mem.displayNameAddr;
            // Write some non-printable characters
            const byteIdx = mem.ijbToByteIndex(0, 0, nameAddr);
            mem.setByteWithoutUndo(byteIdx, 1);     // non-printable
            mem.setByteWithoutUndo(byteIdx + 1, 65); // 'A'
            mem.setByteWithoutUndo(byteIdx + 2, 127); // DEL, non-printable
            for (let k = 3; k < mem.displayNameBytes; k++) {
                mem.setByteWithoutUndo(mem.ijbToByteIndex(0, 0, nameAddr + k), 0);
            }
            const name = viz.getCellName(0, 0);
            expect(name).toBe('A');
        });
    });

    describe('interleaveBits', () => {
        it('interleaves correctly for known values', () => {
            const viz = new BoardVisualizer();
            // interleaveBits(0, 0) should be 0
            expect(viz.interleaveBits(0, 0)).toBe(0);
            // interleaveBits(1, 0) should be 1 (bx bit 0 goes to position 0)
            expect(viz.interleaveBits(1, 0)).toBe(1);
            // interleaveBits(0, 1) should be 2 (by bit 0 goes to position 1)
            expect(viz.interleaveBits(0, 1)).toBe(2);
            // interleaveBits(1, 1) should be 3
            expect(viz.interleaveBits(1, 1)).toBe(3);
        });

        it('produces values in range 0-1023 for 5-bit inputs', () => {
            const viz = new BoardVisualizer();
            for (let bx = 0; bx < 32; bx++) {
                for (let by = 0; by < 32; by++) {
                    const result = viz.interleaveBits(bx, by);
                    expect(result).toBeGreaterThanOrEqual(0);
                    expect(result).toBeLessThan(1024);
                }
            }
        });

        it('produces unique values for all (bx, by) pairs', () => {
            const viz = new BoardVisualizer();
            const seen = new Set();
            for (let bx = 0; bx < 32; bx++) {
                for (let by = 0; by < 32; by++) {
                    const result = viz.interleaveBits(bx, by);
                    expect(seen.has(result)).toBe(false);
                    seen.add(result);
                }
            }
        });
    });

    describe('getDetailPixelBufferRect', () => {
        it('calls getDetailPixelRGB (not getOverviewPixelRGB)', () => {
            // This test verifies the bug fix: getDetailPixelBufferRect should use
            // getDetailPixelRGB, not getOverviewPixelRGB
            const ctrl = new BoardController();
            const viz = new BoardVisualizer(ctrl);

            let detailCalled = false;
            let overviewCalled = false;

            const origDetail = viz.getDetailPixelRGB.bind(viz);
            const origOverview = viz.getOverviewPixelRGB.bind(viz);

            viz.getDetailPixelRGB = (x, y) => {
                detailCalled = true;
                return origDetail(x, y);
            };
            viz.getOverviewPixelRGB = (i, j) => {
                overviewCalled = true;
                return origOverview(i, j);
            };

            viz.getDetailPixelBufferRect(0, 0, 2, 2);
            expect(detailCalled).toBe(true);
            expect(overviewCalled).toBe(false);
        });
    });
});
