// Input handler — raw stdin key parsing and mode dispatch
// Parses escape sequences including shift/ctrl modifiers

// Parse a raw stdin chunk into a key descriptor
export function parseKey(data) {
    // Ctrl-C
    if (data === '\x03') return { name: 'ctrl-c' };
    // Tab
    if (data === '\t' || data === '\x09') return { name: 'tab' };
    // Escape
    if (data === '\x1b') return { name: 'escape' };
    // Enter
    if (data === '\r' || data === '\n') return { name: 'enter' };
    // Backspace
    if (data === '\x7f' || data === '\b') return { name: 'backspace' };

    // CSI sequences: \x1b[...
    if (data.startsWith('\x1b[')) {
        return parseCSI(data.slice(2));
    }

    // Alt+key: \x1b + char
    if (data.length === 2 && data[0] === '\x1b') {
        return { name: 'alt-' + data[1] };
    }

    // Ctrl+A through Ctrl-Z
    if (data.length === 1 && data.charCodeAt(0) >= 1 && data.charCodeAt(0) <= 26) {
        return { name: 'ctrl-' + String.fromCharCode(96 + data.charCodeAt(0)) };
    }

    // Regular character
    if (data.length === 1 && data >= ' ') {
        return { name: 'char', char: data };
    }

    // Multi-byte character (e.g. unicode)
    if (data.length > 1 && !data.startsWith('\x1b')) {
        return { name: 'char', char: data };
    }

    return { name: 'unknown', raw: data };
}

function parseCSI(seq) {
    // Arrow keys with modifiers: 1;MOD + A/B/C/D
    // MOD: 2=shift, 3=alt, 5=ctrl, 6=ctrl+shift
    const arrowMatch = seq.match(/^1;(\d+)([ABCD])$/);
    if (arrowMatch) {
        const mod = parseInt(arrowMatch[1]);
        const dir = { A: 'up', B: 'down', C: 'right', D: 'left' }[arrowMatch[2]];
        const shift = (mod === 2 || mod === 6);
        const ctrl = (mod === 5 || mod === 6);
        const alt = (mod === 3);
        return { name: 'arrow', dir, shift, ctrl, alt };
    }

    // Plain arrow keys
    if (seq === 'A') return { name: 'arrow', dir: 'up', shift: false, ctrl: false };
    if (seq === 'B') return { name: 'arrow', dir: 'down', shift: false, ctrl: false };
    if (seq === 'C') return { name: 'arrow', dir: 'right', shift: false, ctrl: false };
    if (seq === 'D') return { name: 'arrow', dir: 'left', shift: false, ctrl: false };

    // Page up/down
    if (seq === '5~') return { name: 'pageup' };
    if (seq === '6~') return { name: 'pagedown' };

    // Home/End
    if (seq === 'H' || seq === '1~') return { name: 'home' };
    if (seq === 'F' || seq === '4~') return { name: 'end' };

    // Delete
    if (seq === '3~') return { name: 'delete' };

    // Shift+Tab (backtab)
    if (seq === 'Z') return { name: 'shift-tab' };

    return { name: 'unknown', raw: '\x1b[' + seq };
}
