let Assembler = null;

// @neshacker/6502-tools is CommonJS, load it dynamically
async function loadAssembler() {
    if (!Assembler) {
        try {
            const mod = await import('@neshacker/6502-tools');
            Assembler = mod.Assembler || mod.default?.Assembler;
        } catch (e) {
            console.warn('6502-tools assembler not available:', e.message);
        }
    }
    return Assembler;
}

// --- Spiral index: maps (dx,dy) to neighborhood cell index ---
// Duplicates the ordering logic from board/memory.js so the assembler
// stays self-contained (no dependency on board/).

const CELL_SIZE = 1024;

const _coordRange = Array.from({length: 7}, (_, n) => n - 3);
const _taxicab = (v) => Math.abs(v[0]) + Math.abs(v[1]);
const _maxDelta = (v) => Math.max(Math.abs(v[0]), Math.abs(v[1]));
const _posAngle = (a) => a < 0 ? a + 2 * Math.PI : a;
const _angle = (v) => _posAngle(Math.atan2(v[0], v[1]));

const _spiralVecs = _coordRange
    .reduce((a, y) => a.concat(_coordRange.map(x => [x, y])), [])
    .sort((a, b) => _taxicab(a) - _taxicab(b)
                 || _maxDelta(a) - _maxDelta(b)
                 || _angle(a) - _angle(b));

const _spiralLookup = _coordRange.map(() => _coordRange.map(() => -1));
_spiralVecs.forEach((vec, idx) => { _spiralLookup[vec[0] + 3][vec[1] + 3] = idx; });

export function spiralIndexFromDxDy(dx, dy) {
    if (dx < -3 || dx > 3 || dy < -3 || dy > 3) return -1;
    return _spiralLookup[dx + 3][dy + 3];
}

export function dxDyFromSpiralIndex(idx) {
    return idx >= 0 && idx < 49 ? _spiralVecs[idx] : null;
}

// --- Core assembler ---

export function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

export async function assemble(source) {
    const Asm = await loadAssembler();
    if (!Asm) {
        throw new Error('Assembler not available');
    }
    const hex = Asm.toHexString(source);
    return hexToBytes(hex);
}

export async function assembleTo(source, memory, cellI, cellJ, startByte = 0) {
    const bytes = await assemble(source);
    for (let k = 0; k < bytes.length; k++) {
        const idx = memory.ijbToByteIndex(cellI, cellJ, startByte + k);
        memory.setByteWithoutUndo(idx, bytes[k]);
    }
    return bytes.length;
}

// --- Multi-segment assembler with .cell/.celladdr/.addr directives ---

// Preprocessor: splits source on directives, returns raw segments
// with their target addresses and source lines.
//
// Directives:
//   .cell dx,dy [offset]  — select neighbor cell, optional hex offset (default 0)
//   .celladdr HEX         — set byte offset within current cell
//   .addr HEX             — set absolute neighborhood address
function preprocess(source) {
    const lines = source.split('\n');
    const segments = [];
    let currentAddress = 0;
    let currentLines = [];

    function flush() {
        if (currentLines.length > 0) {
            segments.push({ address: currentAddress, sourceLines: currentLines });
            currentLines = [];
        }
    }

    for (const line of lines) {
        const trimmed = line.trim();

        // .cell dx,dy [offset]
        const cellMatch = trimmed.match(
            /^\.cell\s+(-?\d+)\s*,\s*(-?\d+)(?:\s+([0-9a-fA-F]+))?$/i
        );
        if (cellMatch) {
            flush();
            const dx = parseInt(cellMatch[1]);
            const dy = parseInt(cellMatch[2]);
            const offset = cellMatch[3] ? parseInt(cellMatch[3], 16) : 0;
            const idx = spiralIndexFromDxDy(dx, dy);
            if (idx < 0) throw new Error(`.cell (${dx},${dy}) is outside the 7x7 neighborhood`);
            if (offset < 0 || offset >= CELL_SIZE)
                throw new Error(`.cell offset $${offset.toString(16)} out of range (0-3FF)`);
            currentAddress = idx * CELL_SIZE + offset;
            continue;
        }

        // .celladdr HEX
        const celladdrMatch = trimmed.match(/^\.celladdr\s+([0-9a-fA-F]+)$/i);
        if (celladdrMatch) {
            flush();
            const offset = parseInt(celladdrMatch[1], 16);
            if (offset < 0 || offset >= CELL_SIZE)
                throw new Error(`.celladdr $${offset.toString(16)} out of range (0-3FF)`);
            const cellBase = Math.floor(currentAddress / CELL_SIZE) * CELL_SIZE;
            currentAddress = cellBase + offset;
            continue;
        }

        // .addr HEX
        const addrMatch = trimmed.match(/^\.addr\s+([0-9a-fA-F]+)$/i);
        if (addrMatch) {
            flush();
            currentAddress = parseInt(addrMatch[1], 16);
            continue;
        }

        currentLines.push(line);
    }

    flush();
    return segments;
}

// Assemble source with .cell/.celladdr/.addr directives.
// Returns an AssemblyImage: { segments: [{address, bytes}] }
//
// Each segment has a neighborhood-relative address and the assembled bytes.
// If the source contains no directives, returns a single segment at address 0.
export async function assembleMulti(source) {
    const rawSegments = preprocess(source);
    const segments = [];

    for (const seg of rawSegments) {
        const src = seg.sourceLines.join('\n').trim();
        if (!src) continue;
        // Prepend .org so labels resolve to correct absolute addresses
        const withOrg = `.org $${seg.address.toString(16).padStart(4, '0')}\n${src}`;
        const bytes = await assemble(withOrg);
        if (bytes.length > 0) {
            segments.push({ address: seg.address, bytes });
        }
    }

    return { segments };
}

// --- AssemblyImage utilities ---

// Serialize an image to a JSON-safe object
export function imageToJSON(image) {
    return {
        segments: image.segments.map(s => ({
            address: s.address,
            hex: Array.from(s.bytes).map(b => b.toString(16).padStart(2, '0')).join(''),
        })),
    };
}

// Deserialize from JSON
export function imageFromJSON(json) {
    return {
        segments: json.segments.map(s => ({
            address: s.address,
            bytes: hexToBytes(s.hex),
        })),
    };
}

// Apply an image to a board, writing each segment to the correct cell.
// originI, originJ is the board cell that corresponds to .cell 0,0 (the origin).
// boardSize is needed for coordinate wrapping.
export function applyImage(image, memory, originI, originJ) {
    const B = memory.B;
    for (const seg of image.segments) {
        const cellIdx = Math.floor(seg.address / CELL_SIZE);
        const offset = seg.address % CELL_SIZE;
        const vec = dxDyFromSpiralIndex(cellIdx);
        if (!vec) throw new Error(`Segment address $${seg.address.toString(16)} maps to invalid cell index ${cellIdx}`);
        const targetI = ((originI + vec[1]) % B + B) % B;
        const targetJ = ((originJ + vec[0]) % B + B) % B;
        for (let k = 0; k < seg.bytes.length; k++) {
            const idx = memory.ijbToByteIndex(targetI, targetJ, offset + k);
            memory.setByteWithoutUndo(idx, seg.bytes[k]);
        }
    }
}

// Describe an image's segments for human consumption
export function describeImage(image) {
    return image.segments.map(s => {
        const cellIdx = Math.floor(s.address / CELL_SIZE);
        const offset = s.address % CELL_SIZE;
        const vec = dxDyFromSpiralIndex(cellIdx);
        const cellLabel = vec ? `(${vec[0]},${vec[1]})` : `cell#${cellIdx}`;
        return `${cellLabel}+$${offset.toString(16).padStart(3, '0')}: ${s.bytes.length} bytes`;
    });
}
