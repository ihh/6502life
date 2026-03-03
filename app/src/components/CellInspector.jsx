import { useMemo } from 'react';
import { readCellRegisters, readCellMemory } from '../engine/boardEngine.js';
import CellDetail from './CellDetail.jsx';

function hexByte(v) {
    return v.toString(16).toUpperCase().padStart(2, '0');
}

function hexWord(v) {
    return v.toString(16).toUpperCase().padStart(4, '0');
}

function flagsString(p) {
    return [
        p & 0x80 ? 'N' : '-',
        p & 0x40 ? 'V' : '-',
        '-',
        p & 0x10 ? 'B' : '-',
        p & 0x08 ? 'D' : '-',
        p & 0x04 ? 'I' : '-',
        p & 0x02 ? 'Z' : '-',
        p & 0x01 ? 'C' : '-',
    ].join('');
}

export default function CellInspector({ controller, selectedCell, refreshTick }) {
    const regs = useMemo(() => {
        if (!selectedCell) return null;
        return readCellRegisters(controller, selectedCell.i, selectedCell.j);
    }, [controller, selectedCell, refreshTick]);

    const memBytes = useMemo(() => {
        if (!selectedCell) return null;
        return readCellMemory(controller, selectedCell.i, selectedCell.j);
    }, [controller, selectedCell, refreshTick]);

    const cellName = useMemo(() => {
        if (!selectedCell) return '';
        const viz = controller; // visualizer is on controller's parent, we read directly
        const mem = controller.memory;
        const nameAddr = mem.displayNameAddr;
        const nameLen = mem.displayNameBytes;
        const base = mem.ijbToByteIndex(selectedCell.i, selectedCell.j, nameAddr);
        const chars = [];
        for (let k = 0; k < nameLen; k++) {
            const c = mem.getByte(base + k);
            if (c > 31 && c < 127) chars.push(String.fromCharCode(c));
        }
        return chars.join('');
    }, [controller, selectedCell, refreshTick]);

    const cellActivity = useMemo(() => {
        if (!selectedCell) return null;
        const mem = controller.memory;
        const cellIdx = mem.ijToCellIndex(selectedCell.i, selectedCell.j);
        const now = controller.totalCycles;
        return {
            lastWrite: controller.lastWriteTime[cellIdx],
            lastMove: controller.lastMoveTime[cellIdx],
            writeDelta: now - controller.lastWriteTime[cellIdx],
            moveDelta: now - controller.lastMoveTime[cellIdx],
        };
    }, [controller, selectedCell, refreshTick]);

    if (!selectedCell) {
        return (
            <section>
                <h3>Cell Inspector</h3>
                <p style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Click a cell in the overview or tiled view to inspect it.</p>
            </section>
        );
    }

    const hexRows = [];
    if (memBytes) {
        for (let offset = 0; offset < memBytes.length; offset += 16) {
            const bytes = [];
            const chars = [];
            for (let k = 0; k < 16 && offset + k < memBytes.length; k++) {
                const b = memBytes[offset + k];
                bytes.push(hexByte(b));
                chars.push(b >= 32 && b < 127 ? String.fromCharCode(b) : '.');
            }
            hexRows.push(
                <div key={offset} style={{ display: 'flex', gap: '4px' }}>
                    <span style={{ color: 'var(--text-muted)', minWidth: '36px' }}>{hexWord(offset)}</span>
                    <span>{bytes.join(' ')}</span>
                    <span style={{ color: 'var(--text-muted)', marginLeft: '4px' }}>{chars.join('')}</span>
                </div>
            );
        }
    }

    return (
        <section>
            <h3>Cell ({selectedCell.i}, {selectedCell.j}){cellName && ` — ${cellName}`}</h3>

            <div style={{ display: 'flex', gap: '12px', marginBottom: '8px', alignItems: 'flex-start' }}>
                <CellDetail
                    controller={controller}
                    i={selectedCell.i}
                    j={selectedCell.j}
                    refreshTick={refreshTick}
                />
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
                    {regs && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '1px 10px', marginBottom: '6px' }}>
                            <span>A = {hexByte(regs.A)}</span>
                            <span>X = {hexByte(regs.X)}</span>
                            <span>Y = {hexByte(regs.Y)}</span>
                            <span>S = {hexByte(regs.S)}</span>
                            <span style={{ gridColumn: 'span 2' }}>PC = {hexWord(regs.PC)}</span>
                            <span style={{ gridColumn: 'span 2' }}>P  = {flagsString(regs.P)} ({hexByte(regs.P)})</span>
                        </div>
                    )}
                    {cellActivity && (
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                            <div>Last write: {cellActivity.lastWrite > 0 ? `cycle ${cellActivity.lastWrite.toLocaleString()}` : 'never'}</div>
                            <div>Last move: {cellActivity.lastMove > 0 ? `cycle ${cellActivity.lastMove.toLocaleString()}` : 'never'}</div>
                        </div>
                    )}
                </div>
            </div>

            <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '10px',
                lineHeight: '1.4',
                maxHeight: '200px',
                overflow: 'auto',
                background: 'var(--bg-primary)',
                padding: '4px',
                borderRadius: '4px',
            }}>
                {hexRows}
            </div>
        </section>
    );
}
