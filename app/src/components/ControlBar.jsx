export default function ControlBar({ running, speed, onStart, onStop, onStep, onSetSpeed }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {running ? (
                <button onClick={onStop} title="Pause">Pause</button>
            ) : (
                <button onClick={onStart} title="Play">Play</button>
            )}
            <button onClick={onStep} disabled={running} title="Step one interrupt">
                Step
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
                Speed:
                <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.1}
                    value={Math.log10(speed)}
                    onChange={e => onSetSpeed(Math.pow(10, Number(e.target.value)))}
                    style={{ width: '80px' }}
                />
                <span style={{ fontFamily: 'var(--font-mono)', width: '36px' }}>
                    {speed.toFixed(1)}x
                </span>
            </label>
        </div>
    );
}
