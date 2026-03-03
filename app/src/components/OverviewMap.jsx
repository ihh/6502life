import { useRef, useEffect, useCallback } from 'react';

export default function OverviewMap({ controller, visualizer, selectedCell, viewCenter, tilesPerSide, onCellClick, running, refreshTick }) {
    const canvasRef = useRef(null);
    const animRef = useRef(null);
    const containerRef = useRef(null);
    const B = controller.memory.B;

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const buffer = visualizer.getOverviewPixelBuffer();
        const imageData = new ImageData(buffer, B, B);
        ctx.putImageData(imageData, 0, 0);

        // Draw focus rectangle showing the tiled view region
        const half = Math.floor(tilesPerSide / 2);
        const left = ((viewCenter.i - half) % B + B) % B;
        const top = ((viewCenter.j - half) % B + B) % B;

        ctx.strokeStyle = 'rgba(255, 80, 80, 0.9)';
        ctx.lineWidth = 1;
        // Draw with wrapping
        for (let dx = -B; dx <= B; dx += B) {
            for (let dy = -B; dy <= B; dy += B) {
                ctx.strokeRect(left + dx + 0.5, top + dy + 0.5, tilesPerSide - 1, tilesPerSide - 1);
            }
        }

        // Highlight selected cell
        if (selectedCell) {
            ctx.fillStyle = 'rgba(14, 165, 233, 0.6)';
            ctx.fillRect(selectedCell.i, selectedCell.j, 1, 1);
        }
    }, [visualizer, B, selectedCell, viewCenter, tilesPerSide]);

    useEffect(() => {
        draw();
    }, [draw, refreshTick]);

    // Animation loop when running
    useEffect(() => {
        if (!running) {
            if (animRef.current) cancelAnimationFrame(animRef.current);
            animRef.current = null;
            return;
        }
        const animate = () => {
            draw();
            animRef.current = requestAnimationFrame(animate);
        };
        animRef.current = requestAnimationFrame(animate);
        return () => {
            if (animRef.current) cancelAnimationFrame(animRef.current);
        };
    }, [running, draw]);

    const handleClick = useCallback((e) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = B / rect.width;
        const scaleY = B / rect.height;
        const i = Math.floor((e.clientX - rect.left) * scaleX);
        const j = Math.floor((e.clientY - rect.top) * scaleY);
        if (i >= 0 && i < B && j >= 0 && j < B) {
            onCellClick(i, j);
        }
    }, [B, onCellClick]);

    // Compute display size to fill container, maintaining square aspect ratio
    // We want at least 2px per cell for visibility, and fill available space
    const minPixelsPerCell = Math.max(2, Math.floor(500 / B));
    const displaySize = B * minPixelsPerCell;

    return (
        <div ref={containerRef} style={{ position: 'relative' }}>
            <canvas
                ref={canvasRef}
                width={B}
                height={B}
                onClick={handleClick}
                style={{
                    width: displaySize,
                    height: displaySize,
                    maxWidth: '100%',
                    maxHeight: '100%',
                    imageRendering: 'pixelated',
                    cursor: 'crosshair',
                }}
            />
        </div>
    );
}
