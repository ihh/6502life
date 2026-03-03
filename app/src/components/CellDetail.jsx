import { useRef, useEffect, useMemo } from 'react';

// Renders the 16x16 RGB bitmap stored in cell memory at 0x380-0x3BF
export default function CellDetail({ controller, i, j, refreshTick }) {
    const canvasRef = useRef(null);
    const mem = controller.memory;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(16, 16);

        const base = mem.ijbToByteIndex(i, j, 0);
        const rAddr = mem.bitmapAddrR;
        const gAddr = mem.bitmapAddrG;
        const bAddr = mem.bitmapAddrB;

        for (let py = 0; py < 16; py++) {
            for (let px = 0; px < 16; px++) {
                const bitIndex = py * 16 + px;
                const byteOffset = Math.floor(bitIndex / 8);
                const bitMask = 1 << (7 - (bitIndex % 8));

                const r = (mem.getByte(base + rAddr + byteOffset) & bitMask) ? 255 : 0;
                const g = (mem.getByte(base + gAddr + byteOffset) & bitMask) ? 255 : 0;
                const b = (mem.getByte(base + bAddr + byteOffset) & bitMask) ? 255 : 0;

                const pos = (py * 16 + px) * 4;
                imageData.data[pos] = r;
                imageData.data[pos + 1] = g;
                imageData.data[pos + 2] = b;
                imageData.data[pos + 3] = 255;
            }
        }

        ctx.putImageData(imageData, 0, 0);
    }, [controller, i, j, refreshTick, mem]);

    return (
        <canvas
            ref={canvasRef}
            width={16}
            height={16}
            style={{
                width: 64,
                height: 64,
                imageRendering: 'pixelated',
                border: '1px solid var(--border)',
                borderRadius: '2px',
            }}
        />
    );
}
