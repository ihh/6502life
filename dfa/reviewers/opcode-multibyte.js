/**
 * Multi-byte-aware opcode reviewer.
 *
 * Extends the standard opcode reviewer with instruction-length-aware
 * slide states. Each slide position has 3 sub-states:
 *   idle: waiting for an opcode byte
 *   eat1: consuming 1 operand byte (2-byte instruction)
 *   eat2: consuming 2 operand bytes (3-byte instruction)
 *
 * At idle: the opcode determines the transition:
 *   1-byte → stay in idle
 *   2-byte → go to eat1
 *   3-byte → go to eat2
 *   core byte (B5, 9D, etc.) → transition to core state
 *
 * At eat1/eat2: any byte (operand), weight 1.0, no verdict.
 * These are "free" bytes — operands don't affect viability.
 */

import { buildOpcodeTable } from '../../webgpu/opcode_table.js';
import { buildCopyTransducer, PASS, FAIL } from '../transducer.js';

const opcTable = buildOpcodeTable();

/** Get instruction byte count for an opcode. */
function instrBytes(op) {
    return opcTable[op * 7 + 5];
}

/**
 * Build the multi-byte-aware opcode reviewer.
 *
 * States: 4 slide positions × 3 sub-states + 9 core states = 21 states.
 * Composed with offset (50 states) = 1050 product states.
 */
export function buildMultibyteOpcodeReviewer() {
    const states = [];

    // Slide states: idle + eat1 + eat2 for each position
    for (const pos of [0, 1, 2, 3]) {
        states.push(`slide${pos}`, `slide${pos}_eat1`, `slide${pos}_eat2`);
    }

    // Core states (same as standard reviewer)
    states.push(
        'seen-LDA',     // after B5
        'seen-addr1',   // after addr byte
        'seen-STA',     // after 9D
        'seen-addr2',   // after addr2
        'seen-page',    // after 04
        'seen-INC',     // after E8/CA
        'seen-branch',  // after branch opcode
        'seen-offset',  // after offset byte
        'accept',       // done
    );

    const rules = [];

    // --- Slide state rules ---
    for (const pos of [0, 1, 2, 3]) {
        const idle = `slide${pos}`;
        const eat1 = `slide${pos}_eat1`;
        const eat2 = `slide${pos}_eat2`;

        // At idle: dispatch by instruction length
        // Default: 1-byte opcodes self-loop in idle
        rules.push({ from: idle, to: idle, match: '*' });

        // 2-byte opcodes → eat1
        for (let op = 0; op < 256; op++) {
            if (instrBytes(op) === 2) {
                rules.push({ from: idle, to: eat1, match: op });
            }
        }

        // 3-byte opcodes → eat2
        for (let op = 0; op < 256; op++) {
            if (instrBytes(op) === 3) {
                rules.push({ from: idle, to: eat2, match: op });
            }
        }

        // eat2: consume first operand → eat1
        rules.push({ from: eat2, to: eat1, match: '*' });

        // eat1: consume last operand → back to idle
        rules.push({ from: eat1, to: idle, match: '*' });
    }

    // --- Core byte transitions from slide idle states ---

    // slide0 idle → seen-LDA on $B5
    rules.push({ from: 'slide0', to: 'seen-LDA', match: 0xB5,
        verdict: PASS, tag: 'core-lda', label: 'LDA zp,X' });

    // seen-LDA → seen-addr1: any byte (address)
    rules.push({ from: 'seen-LDA', to: 'seen-addr1', match: '*',
        tag: 'addr1', label: 'source address' });

    // seen-addr1 → slide1 idle (or directly to STA)
    rules.push({ from: 'seen-addr1', to: 'slide1', match: '*' });
    rules.push({ from: 'seen-addr1', to: 'seen-STA', match: 0x9D,
        verdict: PASS, tag: 'core-sta', label: 'STA abs,X' });

    // slide1 idle → seen-STA on $9D
    rules.push({ from: 'slide1', to: 'seen-STA', match: 0x9D,
        verdict: PASS, tag: 'core-sta', label: 'STA abs,X' });

    // seen-STA → seen-addr2: any byte (destination low)
    rules.push({ from: 'seen-STA', to: 'seen-addr2', match: '*',
        tag: 'addr2', label: 'destination low' });

    // seen-addr2 → seen-page: check $04
    rules.push({ from: 'seen-addr2', to: 'seen-page', match: '*',
        verdict: FAIL, tag: 'page', label: 'wrong destination page' });
    rules.push({ from: 'seen-addr2', to: 'seen-page', match: 0x04,
        verdict: PASS, tag: 'page', label: 'destination page $04' });

    // seen-page → slide2 idle (or directly to INC)
    rules.push({ from: 'seen-page', to: 'slide2', match: '*' });
    rules.push({ from: 'seen-page', to: 'seen-INC', match: [0xE8, 0xCA],
        verdict: PASS, tag: 'core-inc', label: 'INX/DEX' });

    // slide2 idle → seen-INC on INX/DEX
    rules.push({ from: 'slide2', to: 'seen-INC', match: [0xE8, 0xCA],
        verdict: PASS, tag: 'core-inc', label: 'INX/DEX' });

    // seen-INC → slide3 idle (or directly to branch)
    rules.push({ from: 'seen-INC', to: 'slide3', match: '*' });
    rules.push({ from: 'seen-INC', to: 'seen-branch',
        match: [0x90, 0xB0, 0xD0, 0x10, 0x30, 0x50, 0x70],
        verdict: PASS, tag: 'branch', label: 'branch opcode' });
    rules.push({ from: 'seen-INC', to: 'seen-branch', match: 0x00,
        verdict: PASS, tag: 'brk-loop', label: 'BRK loop' });

    // slide3 idle → seen-branch on branch opcodes
    rules.push({ from: 'slide3', to: 'seen-branch',
        match: [0x90, 0xB0, 0xD0, 0x10, 0x30, 0x50, 0x70],
        verdict: PASS, tag: 'branch', label: 'branch opcode' });
    rules.push({ from: 'slide3', to: 'seen-branch', match: 0x00,
        verdict: PASS, tag: 'brk-loop', label: 'BRK loop' });

    // seen-branch → seen-offset: any byte (checked by offset reviewer)
    rules.push({ from: 'seen-branch', to: 'seen-offset', match: '*',
        tag: 'offset', label: 'branch offset' });

    // seen-offset → accept
    rules.push({ from: 'seen-offset', to: 'accept', match: '*' });

    return buildCopyTransducer({
        states,
        accept: 'accept',
        rules,
        passthrough: false,
    });
}
