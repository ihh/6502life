import { useState, useCallback } from 'react';

export function useCellSelection() {
    const [selectedCell, setSelectedCell] = useState(null);
    const [hoveredCell, setHoveredCell] = useState(null);

    const selectCell = useCallback((i, j) => {
        setSelectedCell({ i, j });
    }, []);

    const clearSelection = useCallback(() => {
        setSelectedCell(null);
    }, []);

    const setHover = useCallback((i, j) => {
        setHoveredCell(i !== null ? { i, j } : null);
    }, []);

    return { selectedCell, hoveredCell, selectCell, clearSelection, setHover };
}
