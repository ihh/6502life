import { useState, useRef, useCallback } from 'react';
import { createBoard } from './engine/boardEngine.js';
import Dashboard from './components/Dashboard.jsx';
import './App.css';

const BOARD_SIZES = [8, 16, 32, 64, 128, 256];

export default function App() {
    const [boardSize, setBoardSize] = useState(32);
    const boardRef = useRef(null);
    const [boardKey, setBoardKey] = useState(0);

    if (!boardRef.current || boardRef.current.memory.B !== boardSize) {
        boardRef.current = createBoard(boardSize);
    }

    const handleSizeChange = useCallback((newSize) => {
        setBoardSize(newSize);
        boardRef.current = createBoard(newSize);
        setBoardKey(k => k + 1);
    }, []);

    const { controller, visualizer } = boardRef.current;

    return (
        <Dashboard
            key={boardKey}
            controller={controller}
            visualizer={visualizer}
            boardSize={boardSize}
            boardSizes={BOARD_SIZES}
            onSizeChange={handleSizeChange}
        />
    );
}
