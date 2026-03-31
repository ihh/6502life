/**
 * Transducer composition: compose multiple copy-transducers into one.
 *
 * Standard product-state composition following Machine Boss semantics.
 * Verdict logic lives at the product-state level, not via gating.
 */

import { composeCopyTransducers, andGate, CopyTransducer, PASS, FAIL } from './transducer.js';
import { correctOffsetAt } from './reviewers/offset.js';

export { composeCopyTransducers, andGate };

/**
 * Compose N copy-transducers into a single transducer.
 * Left-to-right: composePipeline(A, B, C) = (A ∘ B) ∘ C.
 *
 * Verdicts from all transducers accumulate. FAIL from any → FAIL
 * in the composed verdict at that position. Weights multiply.
 *
 * @param {...import('./transducer.js').CopyTransducer} transducers
 * @returns {import('./transducer.js').CopyTransducer}
 */
export function composePipeline(...transducers) {
    if (transducers.length === 0) {
        throw new Error('composePipeline requires at least one transducer');
    }
    if (transducers.length === 1) return transducers[0];
    return transducers.reduce((acc, t) => composeCopyTransducers(acc, t));
}

/**
 * Inject offset verdicts into a composed opcode×offset product machine.
 *
 * The offset reviewer is a silent position counter. After standard
 * composition with the opcode reviewer, the product state encodes
 * (opcode_state, posK). This function adds PASS/FAIL verdicts at the
 * transitions where the opcode reviewer is reading the offset byte
 * (opcode state = gateState) and the offset counter is at posK:
 *   - byte = correctOffsetAt(K) → PASS
 *   - byte ≠ correctOffsetAt(K) → FAIL
 *
 * Mutates the composed transducer in place and returns it.
 *
 * @param {CopyTransducer} composed - product of opcode × offset
 * @param {CopyTransducer} opcode - the opcode reviewer
 * @param {CopyTransducer} offset - the offset position counter
 * @param {string} gateState - opcode state name where offset byte is read
 * @returns {CopyTransducer}
 */
export function injectOffsetVerdicts(composed, opcode, offset, gateState) {
    const gateIdx = opcode.stateIdx.get(gateState);
    if (gateIdx === undefined) {
        throw new Error(`Unknown opcode state: ${gateState}`);
    }

    const nS = offset.numStates;

    for (let posK = 0; posK < offset.numStates; posK++) {
        const productFrom = gateIdx * nS + posK;
        const correct = correctOffsetAt(posK);

        for (let byte = 0; byte < 256; byte++) {
            const t = composed.trans[productFrom * 256 + byte];
            if (!t) continue;

            const isCorrect = byte === correct;
            const offsetVerdict = isCorrect ? PASS : FAIL;
            const offsetTag = 'offset';
            const offsetLabel = isCorrect
                ? `correct offset $${correct.toString(16).padStart(2, '0')} at pos ${posK}`
                : `wrong offset at pos ${posK}: expected $${correct.toString(16).padStart(2, '0')}`;

            // Merge with any existing verdict from opcode reviewer
            if (t.verdict !== null) {
                t.verdict = (t.verdict === FAIL || offsetVerdict === FAIL) ? FAIL : PASS;
                t.tag = [t.tag, offsetTag].filter(Boolean).join('+');
                t.label = [t.label, offsetLabel].filter(Boolean).join('; ');
            } else {
                t.verdict = offsetVerdict;
                t.tag = offsetTag;
                t.label = offsetLabel;
            }
        }
    }

    return composed;
}

/**
 * Build a composed opcode+offset reviewer.
 * Standard composition + offset verdict injection.
 *
 * @param {CopyTransducer} opcode - from buildOpcodeReviewer()
 * @param {CopyTransducer} offset - from buildOffsetReviewer()
 * @param {Object} [opts]
 * @param {string} [opts.gateState='seen-branch'] - opcode state reading offset byte
 * @returns {CopyTransducer}
 */
export function composeOpcodeOffset(opcode, offset, opts = {}) {
    const { gateState = 'seen-branch' } = opts;
    const composed = composeCopyTransducers(opcode, offset);
    return injectOffsetVerdicts(composed, opcode, offset, gateState);
}

/**
 * Inject addr=0 constraint: at the opcode states where the addr byte
 * is consumed (seen-LDA and seen-STA), FAIL for any byte ≠ $00.
 *
 * @param {CopyTransducer} composed - product of opcode × offset
 * @param {CopyTransducer} opcode - the opcode reviewer
 * @param {CopyTransducer} offset - the offset counter
 * @param {string[]} addrStates - opcode states where addr byte is read
 * @returns {CopyTransducer}
 */
export function injectAddrConstraint(composed, opcode, offset, addrStates = ['seen-LDA', 'seen-STA']) {
    const nS = offset.numStates;

    for (const stateName of addrStates) {
        const opcIdx = opcode.stateIdx.get(stateName);
        if (opcIdx === undefined) continue;

        for (let posK = 0; posK < nS; posK++) {
            const productFrom = opcIdx * nS + posK;
            for (let byte = 0; byte < 256; byte++) {
                if (byte === 0x00) continue; // $00 is the only valid addr
                const t = composed.trans[productFrom * 256 + byte];
                if (!t) continue;
                t.verdict = FAIL;
                t.tag = 'addr';
                t.label = `addr must be $00, got $${byte.toString(16).padStart(2, '0')}`;
            }
        }
    }

    return composed;
}

/**
 * Inject branch constraint: at the opcode state where the branch byte
 * is consumed (seen-INC), only allow BVC ($50) and BCC ($90).
 *
 * @param {CopyTransducer} composed
 * @param {CopyTransducer} opcode
 * @param {CopyTransducer} offset
 * @param {number[]} [viableBranches=[0x50, 0x90]]
 * @returns {CopyTransducer}
 */
export function injectBranchConstraint(composed, opcode, offset, viableBranches = [0x50, 0x90]) {
    const nS = offset.numStates;
    const opcIdx = opcode.stateIdx.get('seen-INC');
    if (opcIdx === undefined) return composed;

    const allowed = new Set(viableBranches);

    for (let posK = 0; posK < nS; posK++) {
        const productFrom = opcIdx * nS + posK;
        for (let byte = 0; byte < 256; byte++) {
            const t = composed.trans[productFrom * 256 + byte];
            if (!t) continue;
            // The opcode reviewer already FAILs non-branch bytes and
            // PASses branch bytes. We now FAIL the non-viable branches.
            if (t.verdict === PASS && !allowed.has(byte)) {
                t.verdict = FAIL;
                t.tag = 'branch-nonviable';
                t.label = `branch $${byte.toString(16)} does not spread`;
            }
        }
    }

    return composed;
}

/**
 * Build a fully constrained composed machine.
 * Structural constraints (addr=0, viable branches, offset) are hard FAILs.
 * Slide transitions retain trainable weights.
 */
export function composeFullPipeline(opcode, offset) {
    let composed = composeCopyTransducers(opcode, offset);
    composed = injectOffsetVerdicts(composed, opcode, offset, 'seen-branch');
    composed = injectAddrConstraint(composed, opcode, offset);
    composed = injectBranchConstraint(composed, opcode, offset);
    return composed;
}
