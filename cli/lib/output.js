import { hexByte, hexWord, flagsString } from '../../engine/format.js';
import { fgRGB, reset, bold, dim } from './ansi.js';

export function formatRegisters(regs) {
    const lines = [];
    lines.push(`${bold}Registers${reset}`);
    lines.push(`  A=${hexByte(regs.A)}  X=${hexByte(regs.X)}  Y=${hexByte(regs.Y)}  S=${hexByte(regs.S)}`);
    lines.push(`  PC=${hexWord(regs.PC)}`);
    lines.push(`  P=${flagsString(regs.P)} (${hexByte(regs.P)})`);
    return lines.join('\n');
}

export function formatHexDump(bytes, startAddr = 0) {
    const lines = [];
    for (let offset = 0; offset < bytes.length; offset += 16) {
        const hex = [];
        const chars = [];
        for (let k = 0; k < 16 && offset + k < bytes.length; k++) {
            const b = bytes[offset + k];
            hex.push(hexByte(b));
            chars.push(b >= 32 && b < 127 ? String.fromCharCode(b) : '.');
        }
        const addr = dim + hexWord(startAddr + offset) + reset;
        const ascii = dim + chars.join('') + reset;
        lines.push(`${addr}  ${hex.join(' ')}  ${ascii}`);
    }
    return lines.join('\n');
}

export function formatActivity(stats, totalCycles) {
    if (stats.length === 0) return `${dim}No activity${reset}`;
    const lines = [];
    lines.push(`${bold}Active cells${reset} (total cycles: ${totalCycles})`);
    lines.push(`${'Cell'.padEnd(10)} ${'Last Write'.padEnd(14)} ${'Last Move'.padEnd(14)}`);
    for (const s of stats) {
        const cell = `(${s.i},${s.j})`.padEnd(10);
        const write = s.lastWrite > 0 ? String(s.lastWrite).padEnd(14) : '-'.padEnd(14);
        const move = s.lastMove > 0 ? String(s.lastMove).padEnd(14) : '-'.padEnd(14);
        lines.push(`${cell} ${write} ${move}`);
    }
    return lines.join('\n');
}

export { hexByte, hexWord, flagsString };
