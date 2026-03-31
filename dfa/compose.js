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
