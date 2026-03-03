export default function Toolbar({ boardSize, boardSizes, onSizeChange, running, totalCycles }) {
    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            padding: '6px 16px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
        }}>
            <span style={{ fontWeight: 'bold', fontSize: '15px', letterSpacing: '0.5px' }}>6502life</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
                Board:
                <select
                    value={boardSize}
                    onChange={e => onSizeChange(Number(e.target.value))}
                    disabled={running}
                >
                    {boardSizes.map(s => (
                        <option key={s} value={s}>{s}x{s} ({(s * s).toLocaleString()} cells)</option>
                    ))}
                </select>
            </label>
            {running && (
                <span style={{ fontSize: '12px', color: 'var(--success)', fontFamily: 'var(--font-mono)' }}>
                    RUNNING
                </span>
            )}
        </div>
    );
}
