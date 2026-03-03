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
