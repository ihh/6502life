// ANSI escape code helpers

export const ESC = '\x1b[';

export const reset = ESC + '0m';
export const bold = ESC + '1m';
export const dim = ESC + '2m';

export function fgRGB(r, g, b) {
    return `${ESC}38;2;${r};${g};${b}m`;
}

export function bgRGB(r, g, b) {
    return `${ESC}48;2;${r};${g};${b}m`;
}

export function fg256(n) {
    return `${ESC}38;5;${n}m`;
}

export function bg256(n) {
    return `${ESC}48;5;${n}m`;
}

export function moveTo(row, col) {
    return `${ESC}${row};${col}H`;
}

export function clear() {
    return `${ESC}2J${ESC}H`;
}

export const hideCursor = ESC + '?25l';
export const showCursor = ESC + '?25h';
export const altScreen = ESC + '?1049h';
export const mainScreen = ESC + '?1049l';
export const clearLine = ESC + '2K';
