import { useCallback, useRef } from 'react';

export default function SaveLoad({ controller, selectedCell, onLoad }) {
    const fileRef = useRef(null);
    const modeRef = useRef('board');

    const handleSaveBoard = useCallback(() => {
        const state = controller.state;
        const json = JSON.stringify(state);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '6502life-board.json';
        a.click();
        URL.revokeObjectURL(url);
    }, [controller]);

    const handleLoadBoard = useCallback(() => {
        modeRef.current = 'board';
        fileRef.current?.click();
    }, []);

    const handleSaveCell = useCallback(() => {
        if (!selectedCell) return;
        const mem = controller.memory;
        const M = mem.M;
        const base = mem.ijbToByteIndex(selectedCell.i, selectedCell.j, 0);
        const bytes = [];
        for (let b = 0; b < M; b++) bytes.push(mem.getByte(base + b));
        const json = JSON.stringify({ i: selectedCell.i, j: selectedCell.j, bytes });
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cell-${selectedCell.i}-${selectedCell.j}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }, [controller, selectedCell]);

    const handleLoadCell = useCallback(() => {
        modeRef.current = 'cell';
        fileRef.current?.click();
    }, []);

    const handleFileChange = useCallback((e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                if (modeRef.current === 'board') {
                    controller.state = data;
                } else if (selectedCell) {
                    const mem = controller.memory;
                    const bytes = data.bytes || data;
                    const base = mem.ijbToByteIndex(selectedCell.i, selectedCell.j, 0);
                    for (let b = 0; b < bytes.length && b < mem.M; b++) {
                        mem.setByteWithoutUndo(base + b, bytes[b]);
                    }
                }
                onLoad();
            } catch (err) {
                console.error('Failed to load:', err);
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    }, [controller, selectedCell, onLoad]);

    return (
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <button onClick={handleSaveBoard}>Save Board</button>
            <button onClick={handleLoadBoard}>Load Board</button>
            {selectedCell && (
                <>
                    <button onClick={handleSaveCell}>Save Cell</button>
                    <button onClick={handleLoadCell}>Load Cell</button>
                </>
            )}
            <input
                ref={fileRef}
                type="file"
                accept=".json"
                onChange={handleFileChange}
                style={{ display: 'none' }}
            />
        </div>
    );
}
