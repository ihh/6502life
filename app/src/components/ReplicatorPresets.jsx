import { useState, useCallback } from 'react';
import { writeCellBytes } from '../engine/boardEngine.js';

const ORGANISMS = [
    {
        key: 'tt-x-dex-bcc-417314',
        label: 'Seed 417314 — DEX/BCC L=8 (bare core)',
        seed: 417314,
        variant: 'X-DEX',
        branch: 'BCC',
        length: 8,
        hex: 'B5 00 9D 00 04 CA 90 F8',
        program: [181, 0, 157, 0, 4, 202, 144, 248],
        spread: 7,
        cell: [28, 6],
    },
    {
        key: 'tt-x-dex-bvc-1548160',
        label: 'Seed 1548160 — DEX/BVC L=12 (4 inserts)',
        seed: 1548160,
        variant: 'X-DEX',
        branch: 'BVC',
        length: 12,
        hex: 'B5 00 9D 00 04 D8 7C BA CA CA 50 F4',
        program: [181, 0, 157, 0, 4, 216, 124, 186, 202, 202, 80, 244],
        spread: 4,
        cell: [15, 38],
    },
    {
        key: 'tt-x-dex-bcc-2025457',
        label: 'Seed 2025457 — DEX/BCC L=12 (4 inserts)',
        seed: 2025457,
        variant: 'X-DEX',
        branch: 'BCC',
        length: 12,
        hex: '04 00 B5 00 9D 00 04 CA 74 9D 90 F4',
        program: [4, 0, 181, 0, 157, 0, 4, 202, 116, 157, 144, 244],
        spread: 4,
        cell: [22, 36],
    },
    {
        key: 'tt-x-dex-bvc-2805158',
        label: 'Seed 2805158 — DEX/BVC L=8 (bare core)',
        seed: 2805158,
        variant: 'X-DEX',
        branch: 'BVC',
        length: 8,
        hex: 'B5 00 9D 00 04 CA 50 F8',
        program: [181, 0, 157, 0, 4, 202, 80, 248],
        spread: 7,
        cell: [53, 25],
    },
    {
        key: 'tt-x-dex-bvc-4818116',
        label: 'Seed 4818116 — DEX/BVC L=8 (bare core)',
        seed: 4818116,
        variant: 'X-DEX',
        branch: 'BVC',
        length: 8,
        hex: 'B5 00 9D 00 04 CA 50 F8',
        program: [181, 0, 157, 0, 4, 202, 80, 248],
        spread: 7,
        cell: [30, 45],
    },
    {
        key: 'tt-x-dex-bvc-5843534',
        label: 'Seed 5843534 — DEX/BVC L=8 (bare core)',
        seed: 5843534,
        variant: 'X-DEX',
        branch: 'BVC',
        length: 8,
        hex: 'B5 00 9D 00 04 CA 50 F8',
        program: [181, 0, 157, 0, 4, 202, 80, 248],
        spread: 7,
        cell: [53, 51],
    },
    {
        key: 'tt-x-dex-bcc-7430868',
        label: 'Seed 7430868 — DEX/BCC L=8 (bare core)',
        seed: 7430868,
        variant: 'X-DEX',
        branch: 'BCC',
        length: 8,
        hex: 'B5 00 9D 00 04 CA 90 F8',
        program: [181, 0, 157, 0, 4, 202, 144, 248],
        spread: 7,
        cell: [8, 63],
    },
    {
        key: 'tt-x-dex-bvc-10998689',
        label: 'Seed 10998689 — DEX/BVC L=8 (bare core)',
        seed: 10998689,
        variant: 'X-DEX',
        branch: 'BVC',
        length: 8,
        hex: 'B5 00 9D 00 04 CA 50 F8',
        program: [181, 0, 157, 0, 4, 202, 80, 248],
        spread: 7,
        cell: [15, 37],
    },
    {
        key: 'tt-x-dex-bvc-11664352',
        label: 'Seed 11664352 — DEX/BVC L=8 (bare core)',
        seed: 11664352,
        variant: 'X-DEX',
        branch: 'BVC',
        length: 8,
        hex: 'B5 00 9D 00 04 CA 50 F8',
        program: [181, 0, 157, 0, 4, 202, 80, 248],
        spread: 7,
        cell: [40, 40],
    },
];

export default function ReplicatorPresets({ controller, selectedCell, onLoad }) {
    const [selected, setSelected] = useState('');
    const [status, setStatus] = useState(null);

    const handleSelect = useCallback((key) => {
        setSelected(key);
        setStatus(null);
    }, []);

    const handleLoad = useCallback(() => {
        if (!selected) return;
        if (!selectedCell) {
            setStatus({ type: 'error', text: 'Select a cell on the board first' });
            return;
        }
        const org = ORGANISMS.find(o => o.key === selected);
        if (!org) return;
        const bytes = new Uint8Array(org.program);
        writeCellBytes(controller, selectedCell.i, selectedCell.j, 0, bytes);
        setStatus({
            type: 'success',
            text: `Loaded ${org.length}B into (${selectedCell.i}, ${selectedCell.j})`,
        });
        onLoad();
    }, [selected, selectedCell, controller, onLoad]);

    const org = ORGANISMS.find(o => o.key === selected);

    return (
        <section>
            <h3>Turtle's Tiers Replicators</h3>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '6px', alignItems: 'center' }}>
                <select
                    value={selected}
                    onChange={e => handleSelect(e.target.value)}
                    style={{ flex: 1 }}
                >
                    <option value="">-- Select replicator --</option>
                    {ORGANISMS.map(o => (
                        <option key={o.key} value={o.key}>{o.label}</option>
                    ))}
                </select>
                <button onClick={handleLoad} disabled={!selected}>
                    Load
                </button>
            </div>
            {org && (
                <div style={{
                    fontSize: '12px',
                    fontFamily: 'var(--font-mono)',
                    background: 'var(--bg-tertiary, #1a1a2e)',
                    padding: '8px',
                    borderRadius: '4px',
                    lineHeight: '1.6',
                }}>
                    <div><strong>Variant:</strong> {org.variant}/{org.branch}</div>
                    <div><strong>Length:</strong> {org.length} bytes</div>
                    <div><strong>Spread:</strong> {org.spread} cells</div>
                    <div><strong>Seed:</strong> {org.seed.toLocaleString()}</div>
                    <div><strong>Origin cell:</strong> ({org.cell[0]}, {org.cell[1]})</div>
                    <div style={{ marginTop: '4px' }}>
                        <strong>Hex:</strong>{' '}
                        <span style={{ color: 'var(--accent, #64ffda)' }}>{org.hex}</span>
                    </div>
                </div>
            )}
            {status && (
                <span style={{
                    fontSize: '12px',
                    color: status.type === 'error' ? 'var(--danger)' : 'var(--success)',
                    display: 'block',
                    marginTop: '4px',
                }}>
                    {status.text}
                </span>
            )}
        </section>
    );
}
