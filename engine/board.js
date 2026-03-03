import { BoardMemory } from '../board/memory.js';
import { BoardController } from '../board/controller.js';
import { BoardVisualizer } from '../board/visualizer.js';

export function createBoard(size = 32, seed = 42) {
    const memory = new BoardMemory(seed, size);
    const controller = new BoardController(memory);
    const visualizer = new BoardVisualizer(controller);
    return { memory, controller, visualizer };
}

export function readCellRegisters(controller, i, j) {
    const mem = controller.memory;
    const base = mem.ijbToByteIndex(i, j, 0);
    return {
        PCHI: mem.getByte(base + 0xF9),
        PCLO: mem.getByte(base + 0xFA),
        PC: (mem.getByte(base + 0xF9) << 8) | mem.getByte(base + 0xFA),
        P: mem.getByte(base + 0xFB),
        A: mem.getByte(base + 0xFC),
        X: mem.getByte(base + 0xFD),
        Y: mem.getByte(base + 0xFE),
        S: mem.getByte(base + 0xFF),
    };
}

export function readCellMemory(controller, i, j) {
    const mem = controller.memory;
    const M = mem.M;
    const base = mem.ijbToByteIndex(i, j, 0);
    const bytes = new Uint8Array(M);
    for (let b = 0; b < M; b++) {
        bytes[b] = mem.getByte(base + b);
    }
    return bytes;
}

export function writeCellBytes(controller, i, j, startByte, data) {
    const mem = controller.memory;
    for (let k = 0; k < data.length; k++) {
        const idx = mem.ijbToByteIndex(i, j, startByte + k);
        mem.setByteWithoutUndo(idx, data[k]);
    }
}

export function zeroCellMemory(controller, i, j) {
    const mem = controller.memory;
    const M = mem.M;
    for (let b = 0; b < M; b++) {
        const idx = mem.ijbToByteIndex(i, j, b);
        mem.setByteWithoutUndo(idx, 0);
    }
}

export function zeroAllCells(controller) {
    controller.memory.storage.fill(0);
}

export function getActivityStats(controller) {
    const B = controller.memory.B;
    const totalCells = B * B;
    const now = controller.totalCycles;
    const stats = [];

    for (let idx = 0; idx < totalCells; idx++) {
        const j = idx % B;
        const i = Math.floor(idx / B);
        const lastWrite = controller.lastWriteTime[idx];
        const lastMove = controller.lastMoveTime[idx];
        if (lastWrite > 0 || lastMove > 0) {
            stats.push({
                i, j, idx,
                lastWrite,
                lastMove,
                writeDelta: now - lastWrite,
                moveDelta: now - lastMove,
            });
        }
    }
    return stats;
}

export function getRecentlyActiveCells(controller, maxCount = 20) {
    const stats = getActivityStats(controller);
    stats.sort((a, b) => {
        const aRecent = Math.max(a.lastWrite, a.lastMove);
        const bRecent = Math.max(b.lastWrite, b.lastMove);
        return bRecent - aRecent;
    });
    return stats.slice(0, maxCount);
}

export function parseCellName(name) {
    if (!name || name.trim() === '') return { color: null, icon: null, raw: '' };
    const parts = name.split(':');
    if (parts.length >= 2) {
        return { color: parts[0], icon: parts.slice(1).join(':'), raw: name };
    }
    return { color: null, icon: name, raw: name };
}
