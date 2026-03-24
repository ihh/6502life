import { useRef, useEffect } from 'react';

// Renders the 16x16 monochrome bitmap at 0x3C0-0x3DF, colored by hue byte at 0x3FF
export default function CellDetail({ controller, i, j, refreshTick }) {
    const canvasRef = useRef(null);
    const mem = controller.memory;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(16, 16);

        const base = mem.ijbToByteIndex(i, j, 0);
        const bitmapAddr = mem.bitmapAddr;
        const hue = mem.getByte(base + mem.hueAddr);

        // Convert hue byte (0-255) to RGB
        let hr = 255, hg = 255, hb = 255;
        if (hue > 0) {
            const h = (hue / 255) * 360;
            const c = 1, x = 1 - Math.abs((h / 60) % 2 - 1);
            if (h < 60)       { hr = c * 255; hg = x * 255; hb = 0; }
            else if (h < 120) { hr = x * 255; hg = c * 255; hb = 0; }
            else if (h < 180) { hr = 0; hg = c * 255; hb = x * 255; }
            else if (h < 240) { hr = 0; hg = x * 255; hb = c * 255; }
            else if (h < 300) { hr = x * 255; hg = 0; hb = c * 255; }
            else              { hr = c * 255; hg = 0; hb = x * 255; }
        }

        for (let py = 0; py < 16; py++) {
            for (let px = 0; px < 16; px++) {
                const bitIndex = py * 16 + px;
                const byteOffset = Math.floor(bitIndex / 8);
                const bitMask = 1 << (7 - (bitIndex % 8));

                const on = (mem.getByte(base + bitmapAddr + byteOffset) & bitMask) !== 0;

                const pos = (py * 16 + px) * 4;
                imageData.data[pos] = on ? hr : 0;
                imageData.data[pos + 1] = on ? hg : 0;
                imageData.data[pos + 2] = on ? hb : 0;
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
