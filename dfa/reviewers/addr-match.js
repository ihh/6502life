/**
 * Address match reviewer: checks byte 1 (source) = byte 3 (dest low).
 *
 * Fixed-position variant (no NOP slides between bytes 1 and 3).
 * 256-state expansion to remember byte 1's value.
 */

import { buildCopyTransducer, PASS, FAIL } from '../transducer.js';

/**
 * @param {Object} [opts]
 * @param {boolean} [opts.relaxed=false] - mismatch emits weighted FAIL
 * @param {number} [opts.mismatchWeight=0.01] - weight for mismatch
 */
export function buildAddrMatchReviewer(opts = {}) {
    const { relaxed = false, mismatchWeight = 0.01 } = opts;

    const states = [
        'byte0',       // read byte 0 (LDA opcode), pass through
    ];
    for (let v = 0; v < 256; v++) states.push(`rem_${v}`); // remembered byte 1
    states.push('byte2');  // read byte 2 (STA opcode), pass through
    for (let v = 0; v < 256; v++) states.push(`chk_${v}`); // check byte 3
    states.push('tail');   // bytes 4-7, pass through
    states.push('accept');

    const rules = [];

    // byte0: read byte 0, advance to rem_XX based on NEXT byte
    // Actually: byte0 reads byte 0 (any) and goes to a state that reads byte 1.
    // But we need to remember byte 1. So byte0 → rem_XX where XX = byte 1.
    // This means byte0 transitions based on the byte it reads (which is byte 0).
    // That's wrong — we need to transition based on byte 1.
    //
    // Fix: byte0 reads byte 0 (any, ignore), goes to a single 'read1' state.
    // read1 reads byte 1, goes to rem_XX.

    states.splice(1, 0, 'read1'); // insert after byte0

    // byte0 → read1 on any byte
    rules.push({ from: 'byte0', to: 'read1', match: '*' });

    // read1 → rem_XX on byte XX
    for (let v = 0; v < 256; v++) {
        rules.push({ from: 'read1', to: `rem_${v}`, match: v });
    }

    // rem_XX → chk_XX: read byte 2 (STA), advance
    for (let v = 0; v < 256; v++) {
        rules.push({ from: `rem_${v}`, to: `chk_${v}`, match: '*' });
    }

    // chk_XX: read byte 3. Match = PASS, mismatch = FAIL.
    for (let v = 0; v < 256; v++) {
        rules.push({
            from: `chk_${v}`, to: 'tail', match: '*',
            verdict: FAIL, tag: 'addr-mismatch',
            label: `byte 1=$${v.toString(16).padStart(2,'0')}, byte 3 differs`,
            weight: relaxed ? mismatchWeight : 1,
        });
        rules.push({
            from: `chk_${v}`, to: 'tail', match: v,
            verdict: PASS, tag: 'addr-match',
            label: `addr match $${v.toString(16).padStart(2,'0')}`,
        });
    }

    // tail: read bytes 4-7 (4 bytes), then accept
    // Use a counter: tail0 → tail1 → tail2 → tail3 → accept
    // Replace single 'tail' with tail0..tail3
    const tailIdx = states.indexOf('tail');
    states.splice(tailIdx, 1, 'tail0', 'tail1', 'tail2', 'tail3');

    // Update chk rules to go to tail0 instead of tail
    for (const r of rules) {
        if (r.to === 'tail') r.to = 'tail0';
    }

    rules.push({ from: 'tail0', to: 'tail1', match: '*' });
    rules.push({ from: 'tail1', to: 'tail2', match: '*' });
    rules.push({ from: 'tail2', to: 'tail3', match: '*' });
    rules.push({ from: 'tail3', to: 'accept', match: '*' });

    return buildCopyTransducer({
        states,
        accept: 'accept',
        rules,
        passthrough: false,
    });
}
