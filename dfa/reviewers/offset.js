/**
 * Branch offset reviewer: silent position counter.
 *
 * Counts bytes consumed. Does NOT emit verdicts on its own —
 * it's a pure state tracker. When composed with the opcode
 * reviewer via product-state construction, the product state
 * (opcode_state, posK) encodes both "this is the offset byte"
 * and "the correct offset for position K." The composition
 * layer injects the verdict at the right product states.
 *
 * For a branch at position K (0-indexed), the offset byte is at
 * position K+1. Target = 0 means: (K+2) + signed_offset = 0,
 * so signed_offset = -(K+2), byte = (256-(K+2)) & 0xFF = (254-K) & 0xFF.
 *
 * Wait — the offset byte is AT position K. The branch opcode is at K-1.
 * PC after reading the branch = K-1+2 = K+1. Target = 0.
 * signed_offset = -(K+1). byte = (256-(K+1)) & 0xFF = (255-K) & 0xFF.
 *
 * So at state posK (byte position K): correct offset = (255-K) & 0xFF.
 *
 * @module
 */

import { buildCopyTransducer } from '../transducer.js';

const MAX_LEN = 48; // max replicator length (generous)

/**
 * Build the branch offset position counter.
 * Silent: no verdicts. Just tracks byte position.
 *
 * Use correctOffsetAt(k) to query what the correct offset
 * byte would be if the offset is at position k.
 *
 * @returns {import('../transducer.js').CopyTransducer}
 */
export function buildOffsetReviewer() {
    const states = [];
    for (let k = 0; k <= MAX_LEN; k++) states.push(`pos${k}`);
    states.push('overflow');

    const rules = [];
    for (let k = 0; k < MAX_LEN; k++) {
        // Advance counter, no verdict
        rules.push({
            from: `pos${k}`, to: `pos${k + 1}`, match: '*',
            tag: 'offset-counter',
        });
    }

    // At pos MAX_LEN, overflow
    rules.push({ from: `pos${MAX_LEN}`, to: 'overflow', match: '*' });
    rules.push({ from: 'overflow', to: 'overflow', match: '*' });

    return buildCopyTransducer({
        states,
        accept: `pos${MAX_LEN}`,
        rules,
        passthrough: false,
    });
}

/**
 * Correct offset byte for a branch at position k.
 * @param {number} k - 0-indexed byte position of the offset byte
 * @returns {number} the byte value that makes the branch jump to address 0
 */
export function correctOffsetAt(k) {
    return (255 - k) & 0xFF;
}
