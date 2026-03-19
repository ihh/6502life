// Minimal 6502 disassembler built from @sfotty-pie/opcodes

// Addressing mode info: operand size and format
const MODE_INFO = {
    imp: { size: 1, fmt: () => '' },
    acc: { size: 1, fmt: () => 'A' },
    imm: { size: 2, fmt: (lo) => `#$${hex(lo)}` },
    zpg: { size: 2, fmt: (lo) => `$${hex(lo)}` },
    zpx: { size: 2, fmt: (lo) => `$${hex(lo)},X` },
    zpy: { size: 2, fmt: (lo) => `$${hex(lo)},Y` },
    abs: { size: 3, fmt: (lo, hi) => `$${hex(hi)}${hex(lo)}` },
    abx: { size: 3, fmt: (lo, hi) => `$${hex(hi)}${hex(lo)},X` },
    aby: { size: 3, fmt: (lo, hi) => `$${hex(hi)}${hex(lo)},Y` },
    ind: { size: 3, fmt: (lo, hi) => `($${hex(hi)}${hex(lo)})` },
    inx: { size: 2, fmt: (lo) => `($${hex(lo)},X)` },
    iny: { size: 2, fmt: (lo) => `($${hex(lo)}),Y` },
    rel: { size: 2, fmt: (lo, _hi, pc) => {
        const offset = lo < 128 ? lo : lo - 256;
        const target = (pc + 2 + offset) & 0xFFFF;
        return `$${hex16(target)}`;
    }},
};

function hex(v) { return v.toString(16).toUpperCase().padStart(2, '0'); }
function hex16(v) { return v.toString(16).toUpperCase().padStart(4, '0'); }

// Build opcode table (256 entries, null for illegal opcodes)
let OPCODE_TABLE = null;

async function ensureOpcodeTable() {
    if (OPCODE_TABLE) return;
    OPCODE_TABLE = new Array(256).fill(null);
    try {
        const { VANILLA_OPCODES } = await import('@sfotty-pie/opcodes');
        for (const op of VANILLA_OPCODES) {
            OPCODE_TABLE[op.opcode] = { mnemonic: op.mnemonic, mode: op.mode };
        }
    } catch {
        // Fallback: minimal opcode table for the most common instructions
        const basics = [
            [0x00, 'BRK', 'imp'], [0xEA, 'NOP', 'imp'],
            [0xA9, 'LDA', 'imm'], [0xA5, 'LDA', 'zpg'], [0xAD, 'LDA', 'abs'],
            [0x85, 'STA', 'zpg'], [0x8D, 'STA', 'abs'],
            [0x4C, 'JMP', 'abs'], [0x20, 'JSR', 'abs'], [0x60, 'RTS', 'imp'],
        ];
        for (const [op, mn, md] of basics) {
            OPCODE_TABLE[op] = { mnemonic: mn, mode: md };
        }
    }
}

// Disassemble one instruction at addr
// readFn(addr) → byte value
export async function disassembleAt(readFn, addr) {
    await ensureOpcodeTable();
    return disassembleAtSync(readFn, addr);
}

export function disassembleAtSync(readFn, addr) {
    const opcode = readFn(addr);
    const entry = OPCODE_TABLE ? OPCODE_TABLE[opcode] : null;

    if (!entry) {
        return {
            addr,
            bytes: [opcode],
            mnemonic: '???',
            operand: `$${hex(opcode)}`,
            size: 1,
            nextAddr: (addr + 1) & 0xFFFF,
        };
    }

    const info = MODE_INFO[entry.mode];
    const size = info.size;
    const bytes = [];
    for (let i = 0; i < size; i++) bytes.push(readFn((addr + i) & 0xFFFF));

    const operand = size === 1
        ? info.fmt()
        : size === 2
            ? info.fmt(bytes[1], 0, addr)
            : info.fmt(bytes[1], bytes[2], addr);

    return {
        addr,
        bytes,
        mnemonic: entry.mnemonic,
        operand,
        size,
        nextAddr: (addr + size) & 0xFFFF,
    };
}

// Disassemble N lines starting from addr
export async function disassembleRange(readFn, startAddr, lines) {
    await ensureOpcodeTable();
    return disassembleRangeSync(readFn, startAddr, lines);
}

export function disassembleRangeSync(readFn, startAddr, lines) {
    const result = [];
    let addr = startAddr & 0xFFFF;
    for (let i = 0; i < lines; i++) {
        const instr = disassembleAtSync(readFn, addr);
        result.push(instr);
        addr = instr.nextAddr;
    }
    return result;
}

// Format a disassembled instruction as a string
export function formatInstruction(instr) {
    const addrStr = hex16(instr.addr);
    const bytesStr = instr.bytes.map(hex).join(' ').padEnd(8);
    const operand = instr.operand ? ` ${instr.operand}` : '';
    return `$${addrStr}  ${bytesStr}  ${instr.mnemonic}${operand}`;
}

// Initialize opcode table (call at startup)
export async function initDisassembler() {
    await ensureOpcodeTable();
}

export { hex, hex16, OPCODE_TABLE };
