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

// Fix addressing mode bugs in the upstream assembler:
// The assembler classifies any address < $100 as zero-page, but zero_page,Y
// only exists for LDX/STX. For all other instructions with ,Y the assembler
// throws "Invalid addressing mode". We fix this by replacing zero-page ,Y
// addresses with a placeholder absolute address ($0100 + original), assembling
// to get the correct absolute_y opcode, then patching the address bytes back.
// The fixup is done in a preprocessing pass using sentinel addresses.
const ZP_Y_SENTINEL = 0x0100;  // add this to force absolute mode
function fixAddressingModes(source) {
    // For ,Y addressing: LDX/STX DO have zero_page,Y so leave them alone.
    // For everything else with $XX,Y where XX fits in a byte, add sentinel.
    const sentinels = [];
    const fixed = source.replace(
        /(\b(?:LDA|STA|ADC|SBC|AND|ORA|EOR|CMP)\s+\$)([0-9a-fA-F]{1,2})(,\s*Y\b)/gi,
        (match, prefix, addr, suffix) => {
            const orig = parseInt(addr, 16);
            const newAddr = orig + ZP_Y_SENTINEL;
            sentinels.push({ orig, newAddr });
            return `${prefix}${newAddr.toString(16).padStart(4, '0')}${suffix}`;
        }
    );
    return { source: fixed, sentinels };
}

// Resolve label arithmetic expressions: @label+N, @label-N
// Two-pass: first collect label addresses, then substitute.
// Only handles local labels (@name) with constant offsets.
function resolveExpressions(source) {
    const lines = source.split('\n');

    // Pass 1: find .org base and collect label positions
    let org = 0;
    let pc = 0;
    const labels = {};
    const orgMatch = source.match(/\.org\s+\$([0-9a-fA-F]+)/i);
    if (orgMatch) org = parseInt(orgMatch[1], 16);
    pc = org;

    // Rough size estimation for each instruction line (for label resolution)
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(';')) continue;
        if (trimmed.match(/^\.org\s/i)) { pc = org; continue; }
        const labelMatch = trimmed.match(/^(@\w+):/);
        if (labelMatch) {
            labels[labelMatch[1]] = pc;
            // Label might be on the same line as an instruction
            const rest = trimmed.slice(labelMatch[0].length).trim();
            if (rest && !rest.startsWith(';')) pc += estimateInsnSize(rest);
            continue;
        }
        if (trimmed.startsWith('.byte')) {
            // Count comma-separated values
            pc += trimmed.replace(/^\.byte\s+/i, '').split(',').length;
            continue;
        }
        pc += estimateInsnSize(trimmed);
    }

    // Pass 2: replace @label+N and @label-N with computed addresses
    const result = lines.map(line => {
        return line.replace(/@(\w+)\s*([+-])\s*(\d+)/g, (match, name, op, offset) => {
            const label = '@' + name;
            if (!(label in labels)) return match; // leave unresolved
            const addr = op === '+' ? labels[label] + parseInt(offset) : labels[label] - parseInt(offset);
            return '$' + addr.toString(16).padStart(4, '0');
        });
    });
    return result.join('\n');
}

function estimateInsnSize(line) {
    const trimmed = line.trim().replace(/;.*$/, '').trim();
    if (!trimmed) return 0;
    // Implied/accumulator: 1 byte
    if (trimmed.match(/^(NOP|CLC|SEC|CLI|SEI|CLV|CLD|SED|TAX|TAY|TXA|TYA|TSX|TXS|PHA|PLA|PHP|PLP|INX|INY|DEX|DEY|RTS|RTI|ASL|LSR|ROL|ROR)\s*$/i)) return 1;
    // Branches: 2 bytes
    if (trimmed.match(/^(BCC|BCS|BEQ|BNE|BMI|BPL|BVC|BVS)\s/i)) return 2;
    // Immediate: 2 bytes
    if (trimmed.match(/#/)) return 2;
    // Zero page (no comma or with ,X): 2 bytes; but if 4-digit address: 3 bytes
    if (trimmed.match(/\$[0-9a-fA-F]{3,4}/i)) return 3;
    if (trimmed.match(/\$[0-9a-fA-F]{1,2}[,\s]/i) || trimmed.match(/\$[0-9a-fA-F]{1,2}$/i)) return 2;
    // JMP/JSR: 3 bytes
    if (trimmed.match(/^(JMP|JSR)\s/i)) return 3;
    // BRK: 1 byte
    if (trimmed.match(/^BRK/i)) return 1;
    return 2; // default guess
}

export async function assemble(source) {
    const Asm = await loadAssembler();
    if (!Asm) {
        throw new Error('Assembler not available');
    }
    const resolved = resolveExpressions(source);
    const { source: fixed, sentinels } = fixAddressingModes(resolved);
    const hex = Asm.toHexString(fixed);
    const bytes = hexToBytes(hex);

    // Patch sentinel addresses back to the original values.
    // The absolute,Y instruction is 3 bytes: opcode, lo, hi.
    // We need to find each sentinel address in the bytes and replace it.
    if (sentinels.length > 0) {
        for (let i = 0; i < bytes.length - 2; i++) {
            const lo = bytes[i + 1];
            const hi = bytes[i + 2];
            const addr = (hi << 8) | lo;
            for (const s of sentinels) {
                if (addr === s.newAddr) {
                    bytes[i + 1] = s.orig & 0xFF;
                    bytes[i + 2] = 0x00;
                    break;
                }
            }
        }
    }

    return bytes;
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
