// Preset 6502 programs for the cellular automata board
// Loaded from .asm files in the presets/ directory

import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PRESETS_DIR = join(__dirname, '..', '..', '..', 'presets');

// Parse the first line of an .asm file for name and description.
// Expected format: "; Name: description"
function parseHeader(source) {
    const first = source.split('\n')[0];
    const m = first.match(/^;\s*(.+?):\s*(.+)$/);
    if (m) return { name: m[1].trim(), desc: m[2].trim() };
    return { name: '', desc: '' };
}

// Load all .asm files from the presets directory
const PRESETS = {};
for (const file of readdirSync(PRESETS_DIR).filter(f => f.endsWith('.asm')).sort()) {
    const key = basename(file, '.asm');
    const source = readFileSync(join(PRESETS_DIR, file), 'utf-8');
    const { name, desc } = parseHeader(source);
    PRESETS[key] = { name, desc, source };
}

export { PRESETS };

export function listPresets() {
    return Object.entries(PRESETS).map(([key, p]) => ({ key, name: p.name, desc: p.desc }));
}

export function getPreset(name) {
    const lower = name.toLowerCase();
    return PRESETS[lower] || null;
}
