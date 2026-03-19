// Sextant character rendering for byte-level memory visualization
// Unicode sextant characters: U+1FB00-U+1FB3B (2x3 pixel grid per character)
// Pixel numbering in a sextant:
//   0 1
//   2 3
//   4 5
// Pattern bits: bit 0 = top-left, bit 1 = top-right, bit 2 = mid-left, etc.

// Build lookup table: 6-bit pattern → sextant character
const SEXTANT = new Array(64);
SEXTANT[0] = ' ';
for (let i = 1; i < 63; i++) SEXTANT[i] = String.fromCodePoint(0x1FB00 + i - 1);
SEXTANT[63] = '\u2588'; // full block

// Convert a byte to a 4-pixel sextant pattern (using top 2x2 of the 2x3 grid)
// Each pixel represents 2 bits of the byte, thresholded (0 = off, 1-3 = on)
// Bits 7-6 → top-left (pixel 0), Bits 5-4 → top-right (pixel 1)
// Bits 3-2 → mid-left (pixel 2), Bits 1-0 → mid-right (pixel 3)
// Bottom row (pixels 4,5) available for border indicators
export function byteToPattern(byte) {
    let pattern = 0;
    if (byte & 0xC0) pattern |= 1;  // bits 7-6 → pixel 0
    if (byte & 0x30) pattern |= 2;  // bits 5-4 → pixel 1
    if (byte & 0x0C) pattern |= 4;  // bits 3-2 → pixel 2
    if (byte & 0x03) pattern |= 8;  // bits 1-0 → pixel 3
    return pattern;
}

// Get sextant character from a 6-bit pattern
export function sextantChar(pattern) {
    return SEXTANT[pattern & 63];
}

// Convert byte to sextant character (top 4 pixels only, no border)
export function byteToSextant(byte) {
    return SEXTANT[byteToPattern(byte)];
}

// Convert byte to sextant with border pixels set on specified edges
// edges: { bottom: bool, right: bool } — uses bottom row pixels for borders
export function byteToSextantWithBorder(byte, borderBottom, borderRight) {
    let pattern = byteToPattern(byte);
    if (borderBottom) pattern |= 0x10 | 0x20; // pixels 4,5
    if (borderRight) pattern |= 0x02 | 0x08 | 0x20; // pixels 1,3,5
    return SEXTANT[pattern & 63];
}

// HSV to RGB (for coloring bytes by value)
export function hsvToRGB(h, s, v) {
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    const mod = i % 6;
    const r = [v, q, p, p, t, v][mod];
    const g = [t, v, v, q, p, p][mod];
    const b = [p, p, t, v, v, q][mod];
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// Color a byte value: hue encodes value, saturation/brightness encode "non-zero-ness"
export function byteColor(byte) {
    if (byte === 0) return [40, 40, 40]; // dim gray for zero
    const h = byte / 256;
    return hsvToRGB(h, 0.7, 0.9);
}

// Border color (subtle, to mark cell boundaries)
export const BORDER_COLOR = [80, 80, 120];

// Cursor color (bright, flashing)
export const CURSOR_COLOR_ON = [255, 255, 0];
export const CURSOR_COLOR_OFF = [180, 180, 0];

export { SEXTANT };
