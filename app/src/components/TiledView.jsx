import { useMemo, useRef, useEffect, useCallback } from 'react';
import { Icon } from '@iconify/react';
import { parseCellName } from '../engine/boardEngine.js';

function CellTile({ i, j, name, bgColor, isSelected, onClick }) {
    const parsed = useMemo(() => parseCellName(name), [name]);
    const iconName = parsed.icon
        ? (parsed.icon.includes(':') ? parsed.icon : `game-icons:${parsed.icon}`)
        : null;
    const iconColor = parsed.color || '#888';

    return (
        <div
            className={`tiled-cell${isSelected ? ' selected' : ''}`}
            style={{ backgroundColor: bgColor }}
            onClick={() => onClick(i, j)}
            title={`(${i},${j})${name ? ': ' + name : ''}`}
        >
            {iconName ? (
                <Icon icon={iconName} color={iconColor} className="cell-icon" width="24" height="24" />
            ) : (
                <span className="cell-coord">{i},{j}</span>
            )}
        </div>
    );
}

function HSVtoCSS(h, s, v) {
    // Convert HSV (all 0-1) to CSS hsl
    // H maps to 0-360, S and L need conversion from HSV
    const l = v * (1 - s / 2);
    const sl = (l === 0 || l === 1) ? 0 : (v - l) / Math.min(l, 1 - l);
    return `hsl(${Math.round(h * 360)}, ${Math.round(sl * 100)}%, ${Math.round(l * 100)}%)`;
}

export default function TiledView({ controller, visualizer, viewCenter, tilesPerSide, selectedCell, onCellClick, refreshTick, running }) {
    const B = controller.memory.B;
    const half = Math.floor(tilesPerSide / 2);
    const animRef = useRef(null);
    const containerRef = useRef(null);
    const cellsRef = useRef([]);
    const forceRef = useRef(0);

    // Periodically force re-render when running so colors update
    useEffect(() => {
        if (!running) return;
        const interval = setInterval(() => {
            forceRef.current++;
            // Force update by dispatching to container
            if (containerRef.current) {
                containerRef.current.querySelectorAll('.tiled-cell').forEach((el, idx) => {
                    const data = cellsRef.current[idx];
                    if (data) el.style.backgroundColor = data.bgColor;
                });
            }
        }, 200);
        return () => clearInterval(interval);
    }, [running]);

    const cells = useMemo(() => {
        const result = [];
        const now = controller.totalCycles;
        for (let dj = -half; dj < tilesPerSide - half; dj++) {
            for (let di = -half; di < tilesPerSide - half; di++) {
                const ci = ((viewCenter.i + di) % B + B) % B;
                const cj = ((viewCenter.j + dj) % B + B) % B;
                const cellIdx = controller.memory.ijToCellIndex(ci, cj);
                const name = visualizer.getCellName(ci, cj);

                // Compute background color from activity
                const timeSinceWrite = now - controller.lastWriteTime[cellIdx];
                const timeSinceMove = now - controller.lastMoveTime[cellIdx];
                const cfg = visualizer.overviewConfig;
                const s = visualizer.weightedExponential(cfg.saturation, timeSinceWrite, timeSinceMove);
                const v = visualizer.weightedExponential(cfg.value, timeSinceWrite, timeSinceMove);
                const bgColor = HSVtoCSS(cfg.hue, s, Math.max(0.08, v * 0.5));

                result.push({ i: ci, j: cj, name, bgColor });
            }
        }
        cellsRef.current = result;
        return result;
    }, [controller, visualizer, viewCenter, tilesPerSide, B, half, refreshTick]);

    const tileSize = Math.max(36, Math.floor(320 / tilesPerSide));

    return (
        <div ref={containerRef} style={{ padding: '4px', overflow: 'auto' }}>
            <div
                className="tiled-grid"
                style={{
                    gridTemplateColumns: `repeat(${tilesPerSide}, ${tileSize}px)`,
                    gridTemplateRows: `repeat(${tilesPerSide}, ${tileSize}px)`,
                    width: 'fit-content',
                    margin: '0 auto',
                }}
            >
                {cells.map((cell, idx) => (
                    <CellTile
                        key={idx}
                        i={cell.i}
                        j={cell.j}
                        name={cell.name}
                        bgColor={cell.bgColor}
                        isSelected={selectedCell?.i === cell.i && selectedCell?.j === cell.j}
                        onClick={onCellClick}
                    />
                ))}
            </div>
        </div>
    );
}
