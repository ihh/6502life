export function hexByte(v) {
    return v.toString(16).toUpperCase().padStart(2, '0');
}

export function hexWord(v) {
    return v.toString(16).toUpperCase().padStart(4, '0');
}

export function flagsString(p) {
    return [
        p & 0x80 ? 'N' : '-',
        p & 0x40 ? 'V' : '-',
        '-',
        p & 0x10 ? 'B' : '-',
        p & 0x08 ? 'D' : '-',
        p & 0x04 ? 'I' : '-',
        p & 0x02 ? 'Z' : '-',
        p & 0x01 ? 'C' : '-',
    ].join('');
}
