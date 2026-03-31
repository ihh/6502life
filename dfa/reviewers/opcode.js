/**
 * Core opcode reviewer: checks that the replicator's fixed bytes
 * are at the expected positions.
 *
 * Pattern: B5 NN 9D NN 04 (E8|CA) <branch> <offset>
 *
 * This reviewer checks bytes 0, 2, 4, 5. Bytes 1, 3 (addresses)
 * and 6, 7 (branch) are handled by other reviewers.
 *
 * With NOP slides enabled, the core bytes can be at variable positions.
 * This reviewer handles the FIXED opcode constraints only.
 */

import { buildCopyTransducer, PASS, FAIL } from '../transducer.js';

/**
 * Build the core opcode reviewer.
 *
 * States model the replicator structure sequentially:
 *   slide0 → seen-LDA → seen-addr1 → slide1 → seen-STA → seen-addr2 →
 *   seen-page → slide2 → seen-INC → slide3 → seen-branch → seen-offset → accept
 *
 * At each "seen-X" state, the core byte is checked. Between core bytes,
 * slide states allow tolerable opcodes (handled by nop-slide reviewer;
 * this reviewer just passes through unknown bytes in slide states).
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.strict=true] - if false, skip some checks
 * @returns {import('../transducer.js').CopyTransducer}
 */
export function buildOpcodeReviewer(opts = {}) {
    const states = [
        'slide0',      // before LDA (NOP slide allowed)
        'seen-LDA',    // byte 0: must be $B5
        'seen-addr1',  // byte 1: any (addr, checked by addr-match reviewer)
        'slide1',      // between addr1 and STA
        'seen-STA',    // byte 2: must be $9D
        'seen-addr2',  // byte 3: any (checked by addr-match reviewer)
        'seen-page',   // byte 4: must be $04
        'slide2',      // between page and INC
        'seen-INC',    // byte 5: must be $E8 or $CA
        'slide3',      // between INC and branch
        'seen-branch', // byte 6: branch opcode (checked by branch reviewer)
        'seen-offset', // byte 7: branch offset (checked by offset reviewer)
        'accept',      // done
    ];

    return buildCopyTransducer({
        states,
        accept: 'accept',
        rules: [
            // slide0: any byte passes through (NOP slide reviewed elsewhere)
            // Transition to seen-LDA on $B5
            { from: 'slide0', to: 'slide0', match: '*' },
            { from: 'slide0', to: 'seen-LDA', match: 0xB5,
              verdict: PASS, tag: 'core-lda', label: 'LDA zp,X' },

            // seen-LDA → seen-addr1: any byte (address)
            { from: 'seen-LDA', to: 'seen-addr1', match: '*',
              tag: 'addr1', label: 'source address' },

            // seen-addr1 → slide1: any byte starts the slide
            // But first we need to check for 9D directly (no slide)
            { from: 'seen-addr1', to: 'slide1', match: '*' },
            { from: 'seen-addr1', to: 'seen-STA', match: 0x9D,
              verdict: PASS, tag: 'core-sta', label: 'STA abs,X' },

            // slide1: pass through, watch for 9D
            { from: 'slide1', to: 'slide1', match: '*' },
            { from: 'slide1', to: 'seen-STA', match: 0x9D,
              verdict: PASS, tag: 'core-sta', label: 'STA abs,X' },

            // seen-STA → seen-addr2: any byte (destination low)
            { from: 'seen-STA', to: 'seen-addr2', match: '*',
              tag: 'addr2', label: 'destination low' },

            // seen-addr2 → seen-page: check $04
            { from: 'seen-addr2', to: 'seen-page', match: '*',
              verdict: FAIL, tag: 'page', label: 'wrong destination page' },
            { from: 'seen-addr2', to: 'seen-page', match: 0x04,
              verdict: PASS, tag: 'page', label: 'destination page $04' },

            // seen-page → slide2
            { from: 'seen-page', to: 'slide2', match: '*' },
            { from: 'seen-page', to: 'seen-INC', match: [0xE8, 0xCA],
              verdict: PASS, tag: 'core-inc', label: 'INX/DEX' },

            // slide2: pass through, watch for INX/DEX
            { from: 'slide2', to: 'slide2', match: '*' },
            { from: 'slide2', to: 'seen-INC', match: [0xE8, 0xCA],
              verdict: PASS, tag: 'core-inc', label: 'INX/DEX' },

            // seen-INC → slide3
            { from: 'seen-INC', to: 'slide3', match: '*' },
            { from: 'seen-INC', to: 'seen-branch', match: [0x90, 0xB0, 0xD0, 0x10, 0x30, 0x50, 0x70],
              verdict: PASS, tag: 'branch', label: 'branch opcode' },
            // Also accept BRK ($00) as loop mechanism
            { from: 'seen-INC', to: 'seen-branch', match: 0x00,
              verdict: PASS, tag: 'brk-loop', label: 'BRK loop' },

            // slide3: pass through, watch for branch
            { from: 'slide3', to: 'slide3', match: '*' },
            { from: 'slide3', to: 'seen-branch', match: [0x90, 0xB0, 0xD0, 0x10, 0x30, 0x50, 0x70],
              verdict: PASS, tag: 'branch', label: 'branch opcode' },
            { from: 'slide3', to: 'seen-branch', match: 0x00,
              verdict: PASS, tag: 'brk-loop', label: 'BRK loop' },

            // seen-branch → seen-offset: any byte (checked by offset reviewer)
            { from: 'seen-branch', to: 'seen-offset', match: '*',
              tag: 'offset', label: 'branch offset' },

            // seen-offset → accept
            { from: 'seen-offset', to: 'accept', match: '*' },
            // Also accept if sequence ends here (exactly 8 bytes, no trailing)
        ],
        passthrough: false,
    });
}
