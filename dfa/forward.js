/**
 * Forward algorithm: count accepting paths through a DFA.
 *
 * Given a compiled DFA and a sequence length L, computes:
 *   count[s][n] = number of byte sequences of length n that,
 *   starting from state s, end in an accepting state.
 *
 * Works in both BigInt (exact) and log-float (for large L) modes.
 */

/**
 * Compute exact path counts using BigInts.
 * Returns count[s][n] for all states s and lengths 0..L.
 *
 * @param {import('./dfa.js').DFA} dfa - compiled DFA
 * @param {number} L - maximum sequence length
 * @returns {BigInt[][]} count[state][length]
 */
export function forwardCountsBigInt(dfa, L) {
    const { numStates, trans, acceptSet } = getCompiled(dfa);

    // count[s][n]: number of length-n accepting paths from state s
    // Base case: count[s][0] = 1 if s is accepting, else 0
    const count = Array.from({ length: numStates }, (_, s) =>
        Array.from({ length: L + 1 }, (_, n) => 0n)
    );

    for (let s = 0; s < numStates; s++) {
        count[s][0] = acceptSet.has(s) ? 1n : 0n;
    }

    // Fill: count[s][n] = sum over all bytes b of count[trans[s][b]][n-1]
    for (let n = 1; n <= L; n++) {
        for (let s = 0; s < numStates; s++) {
            let total = 0n;
            for (let b = 0; b < 256; b++) {
                const next = trans[s * 256 + b];
                if (next >= 0) {
                    total += count[next][n - 1];
                }
            }
            count[s][n] = total;
        }
    }

    return count;
}

/**
 * Compute the total number of accepted sequences of length L.
 * @param {import('./dfa.js').DFA} dfa
 * @param {number} L
 * @returns {BigInt}
 */
export function totalAccepting(dfa, L) {
    const counts = forwardCountsBigInt(dfa, L);
    const initial = getCompiled(dfa).initial;
    return counts[initial][L];
}

/**
 * Compute acceptance probability = totalAccepting(L) / 256^L.
 * Returns as a float (may lose precision for large L).
 * @param {import('./dfa.js').DFA} dfa
 * @param {number} L
 * @returns {number}
 */
export function acceptProbability(dfa, L) {
    const total = totalAccepting(dfa, L);
    // 256^L as BigInt
    const space = 256n ** BigInt(L);
    // Convert to float: total / space
    return Number(total * 1000000n / space) / 1000000;
}

/**
 * Compute log2 of acceptance probability (more stable for large L).
 * @param {import('./dfa.js').DFA} dfa
 * @param {number} L
 * @returns {number} log2(P)
 */
export function logAcceptProbability(dfa, L) {
    const total = totalAccepting(dfa, L);
    if (total === 0n) return -Infinity;
    // log2(total / 256^L) = log2(total) - L * 8
    return log2BigInt(total) - L * 8;
}

/**
 * Compute B_eff = -log2(P) for a DFA at sequence length L.
 * @param {import('./dfa.js').DFA} dfa
 * @param {number} L
 * @returns {number}
 */
export function effectiveBits(dfa, L) {
    return -logAcceptProbability(dfa, L);
}

/**
 * Get forward counts as Float64 (for the sampler).
 * Uses log-space internally to avoid overflow, but returns
 * actual counts (which may be Infinity for large L).
 * For the sampler, relative weights are sufficient.
 *
 * @param {import('./dfa.js').DFA} dfa
 * @param {number} L
 * @returns {Float64Array[]} count[state] = Float64Array(L+1)
 */
export function forwardCountsFloat(dfa, L) {
    const { numStates, trans, acceptSet } = getCompiled(dfa);

    const count = Array.from({ length: numStates }, () =>
        new Float64Array(L + 1)
    );

    for (let s = 0; s < numStates; s++) {
        count[s][0] = acceptSet.has(s) ? 1 : 0;
    }

    for (let n = 1; n <= L; n++) {
        for (let s = 0; s < numStates; s++) {
            let total = 0;
            for (let b = 0; b < 256; b++) {
                const next = trans[s * 256 + b];
                if (next >= 0) {
                    total += count[next][n - 1];
                }
            }
            count[s][n] = total;
        }
    }

    return count;
}

// --- Helpers ---

function getCompiled(dfa) {
    dfa._ensureCompiled();
    return {
        numStates: dfa._compiled.numStates,
        trans: dfa._compiled.trans,
        acceptSet: dfa._compiled.acceptSet,
        initial: dfa._compiled.initial,
    };
}

/** Approximate log2 of a BigInt. */
function log2BigInt(n) {
    if (n <= 0n) return -Infinity;
    const s = n.toString(2);
    const bitLen = s.length;
    // For precision: use the top ~52 bits as a float
    if (bitLen <= 52) {
        return Math.log2(Number(n));
    }
    const top = Number(BigInt(s.substring(0, 52)) || 1n);
    return (bitLen - 52) + Math.log2(top);
}

export { log2BigInt };
