/**
 * Pipeline: bridge CopyTransducer → DFA for Forward/sampler.
 *
 * Converts a composed copy-transducer into a DFA-compatible object
 * where FAIL-verdict transitions are dead (no transition). This is
 * the implicit AND-gate: any FAIL along a path kills the path.
 *
 * Also handles addr-match via rejection sampling.
 */

import { DFA } from './dfa.js';
import { FAIL } from './transducer.js';
import { buildOpcodeReviewer } from './reviewers/opcode.js';
import { buildOffsetReviewer } from './reviewers/offset.js';
import { buildAddrMatchReviewer } from './reviewers/addr-match.js';
import { composeOpcodeOffset, composeCopyTransducers } from './compose.js';
import { forwardCountsBigInt, effectiveBits } from './forward.js';
import { prepareSampler, sampleSequence } from './sampler.js';

/**
 * Convert a CopyTransducer to a DFA for the Forward/sampler.
 *
 * FAIL-verdict transitions become dead (trans = -1).
 * Accept states are specified explicitly (since transducer acceptance
 * doesn't always align with sequence length).
 *
 * @param {import('./transducer.js').CopyTransducer} transducer
 * @param {Object} [opts]
 * @param {number[]} [opts.acceptStates] - state indices to treat as accepting.
 *   Default: all states (accept everywhere, rely on FAIL filtering).
 * @returns {DFA}
 */
export function transducerToDFA(transducer, opts = {}) {
    const { acceptStates } = opts;

    const dfa = new DFA();

    // Add states
    const acceptSet = acceptStates
        ? new Set(acceptStates)
        : null; // null = all states accept

    for (let s = 0; s < transducer.numStates; s++) {
        const isAccept = acceptSet ? acceptSet.has(s) : true;
        dfa.addState(transducer.stateNames[s], { accept: isAccept });
    }

    dfa.setInitial(transducer.stateNames[transducer.initial]);

    // Add transitions, skipping FAIL-verdict transitions
    for (let s = 0; s < transducer.numStates; s++) {
        const fromName = transducer.stateNames[s];
        for (let b = 0; b < 256; b++) {
            const t = transducer.trans[s * 256 + b];
            if (!t) continue;
            if (t.verdict === FAIL) continue; // implicit AND-gate
            dfa.addRule({
                from: fromName,
                to: transducer.stateNames[t.next],
                match: b,
                tag: t.tag,
                label: t.label,
            });
        }
    }

    dfa.compile();
    return dfa;
}

/**
 * Build the full reviewer pipeline as a DFA ready for Forward/sampling.
 *
 * Composes opcode × offset (with verdict injection), converts to DFA.
 * Addr-match is handled by rejection sampling (not in the DFA).
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.relaxedAddr=false] - use relaxed addr-match
 * @param {number} [opts.mismatchWeight=0.01] - addr mismatch weight
 * @returns {{ dfa: DFA, transducer: CopyTransducer, opcodeReviewer: CopyTransducer }}
 */
export function buildPipeline(opts = {}) {
    const opcode = buildOpcodeReviewer();
    const offset = buildOffsetReviewer();
    const composed = composeOpcodeOffset(opcode, offset);

    // Accept states: opcode in {seen-offset, accept} × any offset state
    const acceptStates = [];
    const opcSO = opcode.stateIdx.get('seen-offset');
    const opcAcc = opcode.stateIdx.get('accept');
    for (let os = 0; os < offset.numStates; os++) {
        acceptStates.push(opcSO * offset.numStates + os);
        acceptStates.push(opcAcc * offset.numStates + os);
    }

    const dfa = transducerToDFA(composed, { acceptStates });
    return { dfa, transducer: composed, opcodeReviewer: opcode, offsetReviewer: offset };
}

/**
 * Find structural positions in a candidate sequence.
 * Locates LDA ($B5), STA ($9D), and their operands.
 *
 * @param {Uint8Array} seq
 * @returns {{ ldaPos: number, addrPos: number, staPos: number, addr2Pos: number, pagePos: number } | null}
 */
export function findStructure(seq) {
    const ldaPos = seq.indexOf(0xB5);
    if (ldaPos < 0 || ldaPos + 1 >= seq.length) return null;
    const addrPos = ldaPos + 1;
    // STA should be after addr
    let staPos = -1;
    for (let i = addrPos + 1; i < seq.length; i++) {
        if (seq[i] === 0x9D) { staPos = i; break; }
    }
    if (staPos < 0 || staPos + 2 >= seq.length) return null;
    return {
        ldaPos,
        addrPos,
        staPos,
        addr2Pos: staPos + 1,
        pagePos: staPos + 2,
    };
}

/**
 * Sample candidate byte sequences that pass opcode+offset checks.
 * Rejection-filters for addr=0 and addr-match (structurally located).
 *
 * @param {DFA} dfa - from buildPipeline()
 * @param {number} L - sequence length
 * @param {number} N - number of accepted samples desired
 * @param {Object} rng - PRNG with .real() method
 * @param {Object} [opts]
 * @param {boolean} [opts.requireAddr0=true] - enforce addr = $00
 * @param {number} [opts.maxAttempts=100000] - max sampling attempts
 * @returns {{ samples: Uint8Array[], attempts: number, rejectRate: number }}
 */
export function sampleCandidates(dfa, L, N, rng, opts = {}) {
    const { requireAddr0 = true, maxAttempts = 100000 } = opts;
    const sampler = prepareSampler(dfa, L);
    const samples = [];
    let attempts = 0;

    while (samples.length < N && attempts < maxAttempts) {
        const seq = sampleSequence(sampler, rng);
        attempts++;
        if (!seq) break;

        if (requireAddr0) {
            const s = findStructure(seq);
            if (!s) continue;
            // addr must be 0 and must match
            if (seq[s.addrPos] !== 0x00) continue;
            if (seq[s.addr2Pos] !== 0x00) continue;
        }
        samples.push(seq);
    }

    return {
        samples,
        attempts,
        rejectRate: attempts > 0 ? 1 - samples.length / attempts : 0,
    };
}
