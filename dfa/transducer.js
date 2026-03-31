/**
 * Copy-transducer: reads bytes, echoes them to output, and inserts
 * inline PASS/FAIL verdict tokens at specific positions.
 *
 * Built on top of the DFA engine. The transducer is represented as
 * a DFA over an extended alphabet: bytes 0-255 plus PASS (256) and
 * FAIL (257). Transitions carry an output symbol (byte, PASS, FAIL,
 * or null for silent).
 *
 * A "copy-transducer" echoes input bytes to output by default.
 * Verdict emissions are additional outputs inserted alongside the echo.
 */

export const PASS = 256;
export const FAIL = 257;
export const VERDICT_NAMES = { [PASS]: 'PASS', [FAIL]: 'FAIL' };

/**
 * A transition in a copy-transducer.
 * @typedef {Object} TransducerTransition
 * @property {string} from - source state name
 * @property {string} to - destination state name
 * @property {number|number[]|'*'|function} match - input byte matcher
 * @property {number|null} verdict - PASS, FAIL, or null (no verdict)
 * @property {number} [weight=1] - transition weight
 * @property {string} [tag=''] - semantic tag for narrative
 * @property {string} [label=''] - human-readable description
 * @property {Object} [meta={}] - arbitrary metadata
 */

/**
 * Build a copy-transducer from a state/rule description.
 *
 * The transducer has two kinds of transitions:
 * - "copy" transitions: read a byte, echo it, optionally emit a verdict
 * - "default" transitions: for states without explicit rules, all bytes
 *   are echoed without verdict (pure pass-through)
 *
 * @param {Object} spec
 * @param {string[]} spec.states - state names (first is initial)
 * @param {string} [spec.accept] - accepting state name (default: last state)
 * @param {TransducerTransition[]} spec.rules - transition rules
 * @param {boolean} [spec.passthrough=true] - if true, states without
 *   explicit rules for a byte echo it and stay (self-loop pass-through)
 * @returns {CopyTransducer}
 */
export function buildCopyTransducer(spec) {
    const { states, rules, passthrough = true } = spec;
    const accept = spec.accept || states[states.length - 1];

    const stateIdx = new Map(states.map((s, i) => [s, i]));
    const numStates = states.length;

    // Transition table: state × byte → { next, verdict, weight, tag, label, meta }
    // Initialize with passthrough (self-loop, no verdict) if enabled
    const trans = new Array(numStates * 256);
    for (let s = 0; s < numStates; s++) {
        for (let b = 0; b < 256; b++) {
            trans[s * 256 + b] = passthrough
                ? { next: s, verdict: null, weight: 1, tag: '', label: '', meta: {} }
                : null;
        }
    }

    // Apply rules (later rules override earlier)
    for (const rule of rules) {
        const from = stateIdx.get(rule.from);
        const to = stateIdx.get(rule.to);
        if (from === undefined) throw new Error(`Unknown state: ${rule.from}`);
        if (to === undefined) throw new Error(`Unknown state: ${rule.to}`);

        const bytes = expandMatch(rule.match);
        for (const b of bytes) {
            trans[from * 256 + b] = {
                next: to,
                verdict: rule.verdict !== undefined ? rule.verdict : null,
                weight: rule.weight !== undefined ? rule.weight : 1,
                tag: rule.tag || '',
                label: rule.label || '',
                meta: rule.meta || {},
            };
        }
    }

    return new CopyTransducer(numStates, states, stateIdx, trans,
        stateIdx.get(accept), 0);
}

export class CopyTransducer {
    constructor(numStates, stateNames, stateIdx, trans, acceptState, initialState) {
        this.numStates = numStates;
        this.stateNames = stateNames;
        this.stateIdx = stateIdx;
        this.trans = trans;
        this.acceptState = acceptState;
        this.initial = initialState;
    }

    /** Run the transducer on a byte sequence. Returns result with verdicts. */
    run(bytes) {
        let state = this.initial;
        const verdicts = [];
        const path = [];
        let totalWeight = 1;

        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            const t = this.trans[state * 256 + b];
            if (!t) {
                return { accepted: false, failedAt: i, verdicts, path, weight: 0 };
            }

            if (t.verdict !== null) {
                verdicts.push({
                    position: i,
                    byte: b,
                    verdict: t.verdict,
                    tag: t.tag,
                    label: t.label,
                    meta: t.meta,
                    state: this.stateNames[state],
                });
            }

            totalWeight *= t.weight;
            path.push({
                state: this.stateNames[t.next],
                byte: b,
                verdict: t.verdict,
                tag: t.tag,
            });
            state = t.next;
        }

        return {
            accepted: state === this.acceptState,
            finalState: this.stateNames[state],
            verdicts,
            path,
            weight: totalWeight,
            passed: verdicts.every(v => v.verdict === PASS),
        };
    }

    /** Check if a byte sequence passes (accepted + all verdicts PASS). */
    passes(bytes) {
        const result = this.run(bytes);
        return result.accepted && result.passed;
    }

    /** Get the transition for a state and byte. */
    getTransition(stateIndex, byte) {
        return this.trans[stateIndex * 256 + byte];
    }
}

// --- Composition ---

/**
 * Compose two copy-transducers sequentially.
 * The composed transducer runs both on the same input stream.
 * Verdicts from both accumulate.
 *
 * Product state = (stateA, stateB). Both advance on each input byte.
 *
 * @param {CopyTransducer} a
 * @param {CopyTransducer} b
 * @returns {CopyTransducer}
 */
export function composeCopyTransducers(a, b) {
    const numStates = a.numStates * b.numStates;
    const stateNames = [];
    const stateIdx = new Map();

    for (let sa = 0; sa < a.numStates; sa++) {
        for (let sb = 0; sb < b.numStates; sb++) {
            const name = `${a.stateNames[sa]}×${b.stateNames[sb]}`;
            const idx = sa * b.numStates + sb;
            stateNames.push(name);
            stateIdx.set(name, idx);
        }
    }

    const trans = new Array(numStates * 256);
    for (let sa = 0; sa < a.numStates; sa++) {
        for (let sb = 0; sb < b.numStates; sb++) {
            const fromIdx = sa * b.numStates + sb;
            for (let byte = 0; byte < 256; byte++) {
                const ta = a.trans[sa * 256 + byte];
                const tb = b.trans[sb * 256 + byte];
                if (!ta || !tb) {
                    trans[fromIdx * 256 + byte] = null;
                    continue;
                }
                const toIdx = ta.next * b.numStates + tb.next;
                // Merge verdicts: collect both, prefer FAIL
                let verdict = null;
                const verdictSources = [];
                if (ta.verdict !== null) verdictSources.push(ta);
                if (tb.verdict !== null) verdictSources.push(tb);
                if (verdictSources.length > 0) {
                    verdict = verdictSources.some(v => v.verdict === FAIL) ? FAIL : PASS;
                }

                trans[fromIdx * 256 + byte] = {
                    next: toIdx,
                    verdict,
                    weight: ta.weight * tb.weight,
                    tag: [ta.tag, tb.tag].filter(Boolean).join('+'),
                    label: [ta.label, tb.label].filter(Boolean).join('; '),
                    meta: { a: ta.meta, b: tb.meta },
                };
            }
        }
    }

    const acceptState = a.acceptState * b.numStates + b.acceptState;
    const initialState = a.initial * b.numStates + b.initial;

    return new CopyTransducer(numStates, stateNames, stateIdx, trans,
        acceptState, initialState);
}

// --- AND-gate filter ---

/**
 * Apply the AND-gate: check if all verdicts in a run result are PASS.
 * This is just `result.passed` — the filter is implicit, not a
 * separate transducer. The explicit transducer form would consume
 * the output stream, but since we're running everything on the
 * same input, the AND is just a check on the verdicts array.
 *
 * @param {Object} result - from CopyTransducer.run()
 * @returns {boolean}
 */
export function andGate(result) {
    return result.accepted && result.passed;
}

// --- Helpers ---

function expandMatch(match) {
    if (match === '*') return Array.from({ length: 256 }, (_, i) => i);
    if (typeof match === 'number') return [match];
    if (Array.isArray(match)) return match;
    if (typeof match === 'function') {
        const result = [];
        for (let b = 0; b < 256; b++) if (match(b)) result.push(b);
        return result;
    }
    throw new Error(`Invalid match spec: ${match}`);
}
