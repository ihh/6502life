import { useState, useCallback } from 'react';
import { useSimulation } from '../hooks/useSimulation.js';
import { useCellSelection } from '../hooks/useCellSelection.js';
import Toolbar from './Toolbar.jsx';
import OverviewMap from './OverviewMap.jsx';
import TiledView from './TiledView.jsx';
import ActivityLog from './ActivityLog.jsx';
import CellInspector from './CellInspector.jsx';
import AssemblyEditor from './AssemblyEditor.jsx';
import ControlBar from './ControlBar.jsx';
import BulkOps from './BulkOps.jsx';
import SaveLoad from './SaveLoad.jsx';

export default function Dashboard({ controller, visualizer, boardSize, boardSizes, onSizeChange }) {
    const sim = useSimulation(controller);
    const sel = useCellSelection();
    const [refreshTick, setRefreshTick] = useState(0);
    const [viewCenter, setViewCenter] = useState({ i: Math.floor(boardSize / 2), j: Math.floor(boardSize / 2) });
    const tilesPerSide = Math.min(boardSize, 8);

    const refresh = useCallback(() => setRefreshTick(t => t + 1), []);

    const handleOverviewClick = useCallback((i, j) => {
        sel.selectCell(i, j);
        setViewCenter({ i, j });
    }, [sel]);

    return (
        <div className="dashboard">
            <Toolbar
                boardSize={boardSize}
                boardSizes={boardSizes}
                onSizeChange={onSizeChange}
                running={sim.running}
                totalCycles={sim.totalCycles}
            />

            <div className="dashboard-main">
                <div className="left-panel">
                    <div className="overview-area">
                        <OverviewMap
                            controller={controller}
                            visualizer={visualizer}
                            selectedCell={sel.selectedCell}
                            viewCenter={viewCenter}
                            tilesPerSide={tilesPerSide}
                            onCellClick={handleOverviewClick}
                            running={sim.running}
                            refreshTick={refreshTick}
                        />
                    </div>
                    <div className="tiled-area">
                        <TiledView
                            controller={controller}
                            visualizer={visualizer}
                            viewCenter={viewCenter}
                            tilesPerSide={tilesPerSide}
                            selectedCell={sel.selectedCell}
                            onCellClick={(i, j) => { sel.selectCell(i, j); setViewCenter({ i, j }); }}
                            refreshTick={refreshTick}
                            running={sim.running}
                        />
                    </div>
                </div>

                <div className="side-panel">
                    <ActivityLog
                        controller={controller}
                        refreshTick={refreshTick}
                        running={sim.running}
                        onCellClick={(i, j) => { sel.selectCell(i, j); setViewCenter({ i, j }); }}
                    />
                    <CellInspector
                        controller={controller}
                        selectedCell={sel.selectedCell}
                        refreshTick={refreshTick}
                    />
                    <AssemblyEditor
                        controller={controller}
                        selectedCell={sel.selectedCell}
                        onAssemble={refresh}
                    />
                </div>
            </div>

            <div className="bottom-bar">
                <ControlBar
                    running={sim.running}
                    speed={sim.speed}
                    onStart={sim.start}
                    onStop={sim.stop}
                    onStep={() => { sim.step(); refresh(); }}
                    onSetSpeed={sim.setSpeed}
                />
                <BulkOps
                    controller={controller}
                    selectedCell={sel.selectedCell}
                    onUpdate={refresh}
                />
                <SaveLoad
                    controller={controller}
                    selectedCell={sel.selectedCell}
                    onLoad={refresh}
                />
                <span className="stats">
                    Cycles: {sim.totalCycles.toLocaleString()}
                    {' | '}
                    Board: {boardSize}x{boardSize}
                    {sel.selectedCell && ` | Cell: (${sel.selectedCell.i}, ${sel.selectedCell.j})`}
                    {sel.hoveredCell && ` | Hover: (${sel.hoveredCell.i}, ${sel.hoveredCell.j})`}
                </span>
            </div>
        </div>
    );
}
