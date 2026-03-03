import { useMemo, useState, useEffect, useRef } from 'react';
import { getRecentlyActiveCells } from '../engine/boardEngine.js';

export default function ActivityLog({ controller, refreshTick, running, onCellClick }) {
    const [stats, setStats] = useState([]);
    const intervalRef = useRef(null);

    // Update stats periodically when running, or on refreshTick when stepping
    useEffect(() => {
        const update = () => {
            setStats(getRecentlyActiveCells(controller, 30));
        };
        update();

        if (running) {
            intervalRef.current = setInterval(update, 500);
            return () => clearInterval(intervalRef.current);
        }
    }, [controller, refreshTick, running]);

    const totalCycles = controller.totalCycles;

    // Count cells that have been written or moved
    const summary = useMemo(() => {
        const B = controller.memory.B;
        const total = B * B;
        let writtenCells = 0;
        let movedCells = 0;
        for (let idx = 0; idx < total; idx++) {
            if (controller.lastWriteTime[idx] > 0) writtenCells++;
            if (controller.lastMoveTime[idx] > 0) movedCells++;
        }
        return { writtenCells, movedCells, total };
    }, [controller, refreshTick, stats]);

    function formatCycles(n) {
        if (n > 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n > 1e3) return (n / 1e3).toFixed(1) + 'K';
        return String(n);
    }

    return (
        <section>
            <h3>Activity</h3>
            <div style={{ fontSize: '12px', marginBottom: '6px', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                <span>Total cycles: <b>{formatCycles(totalCycles)}</b></span>
                <span>Written: <b>{summary.writtenCells}</b>/{summary.total}</span>
                <span>Moved: <b>{summary.movedCells}</b>/{summary.total}</span>
            </div>

            {stats.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '12px', fontStyle: 'italic' }}>
                    No activity yet. Click "Randomize" then "Play" to start.
                </div>
            ) : (
                <div className="activity-log">
                    <div className="activity-row" style={{ fontWeight: 'bold', color: 'var(--text-secondary)' }}>
                        <span className="coord">Cell</span>
                        <span className="time">Last Write</span>
                        <span className="time">Last Move</span>
                        <span className="label">Ago</span>
                    </div>
                    {stats.map((s, idx) => (
                        <div
                            key={idx}
                            className="activity-row"
                            onClick={() => onCellClick(s.i, s.j)}
                            style={{ cursor: 'pointer' }}
                        >
                            <span className="coord">({s.i},{s.j})</span>
                            <span className="time">{s.lastWrite > 0 ? formatCycles(s.lastWrite) : '-'}</span>
                            <span className="time">{s.lastMove > 0 ? formatCycles(s.lastMove) : '-'}</span>
                            <span className="label">
                                {s.writeDelta < s.moveDelta
                                    ? `w ${formatCycles(s.writeDelta)} ago`
                                    : `m ${formatCycles(s.moveDelta)} ago`
                                }
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}
