import { useCallback } from 'react';
import { zeroAllCells, zeroCellMemory, readCellMemory, writeCellBytes } from '../engine/boardEngine.js';

export default function BulkOps({ controller, selectedCell, onUpdate }) {
    const handleZeroAll = useCallback(() => {
        zeroAllCells(controller);
        onUpdate();
    }, [controller, onUpdate]);

    const handleZeroCell = useCallback(() => {
        if (!selectedCell) return;
        zeroCellMemory(controller, selectedCell.i, selectedCell.j);
        onUpdate();
    }, [controller, selectedCell, onUpdate]);

    const handleRandomize = useCallback(() => {
        controller.randomize();
        onUpdate();
    }, [controller, onUpdate]);

    const handleCopyCell = useCallback(async () => {
        if (!selectedCell) return;
        const bytes = readCellMemory(controller, selectedCell.i, selectedCell.j);
        const json = JSON.stringify(Array.from(bytes));
        try {
            await navigator.clipboard.writeText(json);
        } catch {
            // Fallback: store in window
            window.__6502lifeCellClipboard = bytes;
        }
    }, [controller, selectedCell]);

    const handlePasteCell = useCallback(async () => {
        if (!selectedCell) return;
        let bytes;
        try {
            const text = await navigator.clipboard.readText();
            bytes = new Uint8Array(JSON.parse(text));
        } catch {
            bytes = window.__6502lifeCellClipboard;
        }
        if (bytes) {
            writeCellBytes(controller, selectedCell.i, selectedCell.j, 0, bytes);
            onUpdate();
        }
    }, [controller, selectedCell, onUpdate]);

    return (
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <button onClick={handleZeroAll}>Zero All</button>
            <button onClick={handleRandomize}>Randomize</button>
            {selectedCell && (
                <>
                    <button onClick={handleZeroCell}>Zero Cell</button>
                    <button onClick={handleCopyCell}>Copy Cell</button>
                    <button onClick={handlePasteCell}>Paste Cell</button>
                </>
            )}
        </div>
    );
}
