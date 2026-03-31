/**
 * Branch offset reviewer: 256-state byte counter.
 *
 * Counts bytes consumed. At the branch offset position (identified
 * by the opcode reviewer reaching the 'seen-offset' state), checks
 * that the offset byte is the correct negative displacement back to
 * byte 0.
 *
 * For a program of total length L (bytes 0..L-1), the branch at
 * byte L-2 with offset at byte L-1 needs: offset = -(L) mod 256
 * (because the branch target = PC + 2 + signed_offset, and we want
 * target = 0, so signed_offset = -(PC+2) = -(L)).
 *
 * But this reviewer doesn't know which byte is the "branch offset"
 * — it just counts bytes and, at each position, knows what the
 * correct offset WOULD BE if this were the offset byte. The opcode
 * reviewer identifies which byte is the offset; this reviewer
 * provides the constraint.
 *
 * Implementation: compose this with the opcode reviewer. The opcode
 * reviewer transitions to 'seen-offset' at the offset byte. This
 * reviewer, running in parallel, has counted to position N. The
 * composition's product state encodes both.
 *
 * For standalone use: this is a 256-state copy-transducer that
 * emits PASS at each byte where the byte value equals the correct
 * backward offset, and FAIL otherwise. When composed with the opcode
 * reviewer, only the verdict at the offset position matters.
 *
 * Simpler approach for composition: just build a copy-transducer
 * with MAX_LEN states. At state N (= byte position N), the correct
 * offset for a branch back to 0 from position N is: -(N+2) mod 256
 * (the branch is at position N-1, offset at N, target = (N+1) +
 * signed_offset = 0, so signed_offset = -(N+1), byte = 256-(N+1)).
 *
 * Actually: if the branch opcode is at position P and the offset is
 * at position P+1, and the branch target is (P+2) + signed_offset,
 * we want target = 0, so signed_offset = -(P+2), byte = (256-(P+2)) & 0xFF.
 *
 * But this reviewer doesn't know P — it just sees bytes sequentially.
 * The offset byte is at some position in the stream. If it's at
 * position K (0-indexed), then the branch opcode is at K-1, and
 * the correct offset = (256 - (K-1+2)) & 0xFF = (256 - K - 1) & 0xFF
 * = (255 - K) & 0xFF.
 *
 * We build this as a MAX_LEN-state machine where state K checks
 * byte value = (255-K) & 0xFF.
 */

import { buildCopyTransducer, PASS, FAIL } from '../transducer.js';

const MAX_LEN = 48; // max replicator length (generous)

/**
 * Build the branch offset reviewer.
 * At each byte position K, emits PASS if the byte = (255-K)&0xFF,
 * FAIL otherwise. When composed with the opcode reviewer, only
 * the verdict at the actual offset position matters.
 *
 * @returns {import('../transducer.js').CopyTransducer}
 */
export function buildOffsetReviewer() {
    const states = [];
    for (let k = 0; k <= MAX_LEN; k++) states.push(`pos${k}`);
    states.push('overflow'); // beyond MAX_LEN

    const rules = [];
    for (let k = 0; k < MAX_LEN; k++) {
        const correctOffset = (255 - k) & 0xFF;
        // Default: FAIL (wrong offset for this position)
        rules.push({
            from: `pos${k}`, to: `pos${k + 1}`, match: '*',
            verdict: FAIL, tag: 'offset',
            label: `offset at pos ${k}: expected $${correctOffset.toString(16).padStart(2, '0')}`,
        });
        // Correct offset: PASS
        rules.push({
            from: `pos${k}`, to: `pos${k + 1}`, match: correctOffset,
            verdict: PASS, tag: 'offset',
            label: `correct offset $${correctOffset.toString(16).padStart(2, '0')} at pos ${k}`,
        });
    }

    // overflow: just pass through
    rules.push({ from: 'overflow', to: 'overflow', match: '*' });

    return buildCopyTransducer({
        states,
        accept: `pos${MAX_LEN}`, // accept at any final position
        rules,
        passthrough: false,
    });
}
