/**
 * Generic byte-level DFA with named states and semantic annotations.
 *
 * Designed for readability and extensibility:
 * - States have names and metadata (for narrative generation)
 * - Transitions carry labels explaining what they match and why
 * - The DFA can be built incrementally from named rules
 * - Match results include the full path taken (for diagnostics)
 */

/**
 * A DFA state.
 * @typedef {Object} State
 * @property {string} name - human-readable name (e.g. 'seen-LDA')
 * @property {boolean} accept - is this an accepting state?
 * @property {Object} [meta] - arbitrary metadata (for narrative engine)
 */

/**
 * A DFA transition rule.
 * @typedef {Object} Rule
 * @property {string} from - source state name
 * @property {string} to - destination state name
 * @property {number|number[]|'*'|function} match - byte matcher:
 *   number: exact byte. number[]: any of these bytes.
 *   '*': any byte (default/fallback). function(byte): bool.
 * @property {number} [priority=0] - higher priority overrides lower
 * @property {string} [label] - human-readable description
 * @property {string} [tag] - semantic tag for narrative engine
 *   (e.g. 'nop-slide', 'core-opcode', 'relaxed-branch')
 * @property {Object} [meta] - arbitrary metadata carried on the transition
 */

export class DFA {
    constructor() {
        /** @type {Map<string, State>} */
        this.states = new Map();
        /** @type {Rule[]} */
        this.rules = [];
        /** @type {string} */
        this.initialStateName = null;

        // Compiled form (built by compile())
        this._compiled = null;
    }

    /** Add a state. */
    addState(name, { accept = false, meta = {} } = {}) {
        this.states.set(name, { name, accept, meta });
        if (!this.initialStateName) this.initialStateName = name;
        this._compiled = null;
        return this;
    }

    /** Set the initial state. */
    setInitial(name) {
        this.initialStateName = name;
        this._compiled = null;
        return this;
    }

    /** Add a transition rule. */
    addRule({ from, to, match, priority = 0, label = '', tag = '', meta = {} }) {
        this.rules.push({ from, to, match, priority, label, tag, meta });
        this._compiled = null;
        return this;
    }

    /**
     * Add multiple rules at once (convenience).
     * @param {Rule[]} rules
     */
    addRules(rules) {
        for (const r of rules) this.addRule(r);
        return this;
    }

    /** Compile to a fast flat transition table + index maps. */
    compile() {
        const stateNames = [...this.states.keys()];
        const nameToIdx = new Map(stateNames.map((n, i) => [n, i]));
        const numStates = stateNames.length;
        const DEAD = -1;

        // Transition table: state × byte → next state index
        const trans = new Int32Array(numStates * 256).fill(DEAD);
        // Transition metadata: state × byte → rule index (for path tracing)
        const transRule = new Int32Array(numStates * 256).fill(-1);

        // Sort rules by priority (low first, high overrides)
        const sorted = [...this.rules].sort((a, b) => a.priority - b.priority);

        for (let ri = 0; ri < sorted.length; ri++) {
            const rule = sorted[ri];
            const fromIdx = nameToIdx.get(rule.from);
            if (fromIdx === undefined) throw new Error(`Unknown state: ${rule.from}`);
            const toIdx = nameToIdx.get(rule.to);
            if (toIdx === undefined) throw new Error(`Unknown state: ${rule.to}`);

            const bytes = expandMatch(rule.match);
            for (const b of bytes) {
                trans[fromIdx * 256 + b] = toIdx;
                transRule[fromIdx * 256 + b] = ri;
            }
        }

        // Accept set
        const acceptSet = new Set();
        for (const [name, state] of this.states) {
            if (state.accept) acceptSet.add(nameToIdx.get(name));
        }

        this._compiled = {
            numStates,
            trans,
            transRule,
            acceptSet,
            initial: nameToIdx.get(this.initialStateName),
            nameToIdx,
            idxToName: stateNames,
            sortedRules: sorted,
        };
        return this;
    }

    /** Ensure compiled. */
    _ensureCompiled() {
        if (!this._compiled) this.compile();
        return this._compiled;
    }

    /** Single transition. Returns next state index or -1. */
    step(stateIdx, byte) {
        const c = this._ensureCompiled();
        if (stateIdx < 0 || stateIdx >= c.numStates) return -1;
        return c.trans[stateIdx * 256 + byte];
    }

    /** Run the DFA on a byte sequence. Returns final state index or -1. */
    run(bytes) {
        const c = this._ensureCompiled();
        let state = c.initial;
        for (let i = 0; i < bytes.length; i++) {
            state = c.trans[state * 256 + bytes[i]];
            if (state < 0) return -1;
        }
        return state;
    }

    /** Check if a byte sequence is accepted. */
    accepts(bytes) {
        const c = this._ensureCompiled();
        const final = this.run(bytes);
        return final >= 0 && c.acceptSet.has(final);
    }

    /**
     * Run with full path tracing. Returns a MatchResult with the
     * sequence of states visited and rules fired — for diagnostics.
     */
    trace(bytes) {
        const c = this._ensureCompiled();
        let state = c.initial;
        const path = [{ state, name: c.idxToName[state], byte: null, rule: null }];

        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            const ruleIdx = c.transRule[state * 256 + b];
            const nextState = c.trans[state * 256 + b];
            if (nextState < 0) {
                return {
                    accepted: false,
                    failedAt: i,
                    failedByte: b,
                    failedState: c.idxToName[state],
                    path,
                };
            }
            const rule = ruleIdx >= 0 ? c.sortedRules[ruleIdx] : null;
            state = nextState;
            path.push({
                state,
                name: c.idxToName[state],
                byte: b,
                rule: rule ? { label: rule.label, tag: rule.tag, meta: rule.meta } : null,
            });
        }

        return {
            accepted: c.acceptSet.has(state),
            finalState: c.idxToName[state],
            path,
        };
    }

    /** Check if a state index is accepting. */
    isAccept(stateIdx) {
        return this._ensureCompiled().acceptSet.has(stateIdx);
    }

    /** Get the compiled number of states. */
    get numStates() {
        return this._ensureCompiled().numStates;
    }

    /** Get the compiled transition table (for Forward algorithm). */
    get transitionTable() {
        return this._ensureCompiled().trans;
    }

    /** Get the initial state index. */
    get initialState() {
        return this._ensureCompiled().initial;
    }

    /** Get the accept state set. */
    get acceptStates() {
        return this._ensureCompiled().acceptSet;
    }

    /** Get state name from index. */
    stateName(idx) {
        return this._ensureCompiled().idxToName[idx];
    }

    /** Get state index from name. */
    stateIndex(name) {
        return this._ensureCompiled().nameToIdx.get(name);
    }
}

/**
 * Expand a match spec into an array of byte values.
 * @param {number|number[]|'*'|function} match
 * @returns {number[]}
 */
function expandMatch(match) {
    if (match === '*') {
        return Array.from({ length: 256 }, (_, i) => i);
    }
    if (typeof match === 'number') {
        return [match];
    }
    if (Array.isArray(match)) {
        return match;
    }
    if (typeof match === 'function') {
        const result = [];
        for (let b = 0; b < 256; b++) {
            if (match(b)) result.push(b);
        }
        return result;
    }
    throw new Error(`Invalid match spec: ${match}`);
}

/**
 * Convenience builder: construct a DFA from a compact description.
 * Kept for backward compatibility with simple DFAs.
 */
export function buildDFA(numStates, initialState, acceptStates, rules) {
    const dfa = new DFA();
    for (let i = 0; i < numStates; i++) {
        dfa.addState(`s${i}`, { accept: acceptStates.includes(i) });
    }
    dfa.setInitial(`s${initialState}`);
    for (const rule of rules) {
        dfa.addRule({
            from: `s${rule.from}`,
            to: `s${rule.to}`,
            match: rule.on,
            label: rule.label || '',
            tag: rule.tag || '',
        });
    }
    dfa.compile();
    return dfa;
}
