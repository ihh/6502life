import { parse, SyntaxError } from './grammar.js';
import { lhsTerm } from './serialize.js';

const EmptyType = '_';
const UnknownType = '?';

const makeGrammarIndex = (rules) => {
    let transform = {}, syncTransform = {}, parents = {}, types = [EmptyType], seenType = {[EmptyType]:true,[UnknownType]:true};
    const markTerm = (term) => {
        if (term.op === 'negterm')
            markTerm (term.term);
        else if (term.op === 'alt')
            term.alt.forEach ((t) => markTerm);
        else if (term.op !== 'any' && term.op !== 'group' && term.op !== 'prefix') {
            if (typeof(term.type) === 'undefined')
                throw new Error('undefined type in term: ' + JSON.stringify(term))
            markType (term.type);
        }
    };
    const markType = (type) => {
        if (!seenType[type])
            types.push (type);
        seenType[type] = true;
    };
    rules.forEach ((rule) => {
        let prefix;
        switch (rule.type) {
            case 'transform':
                {
                    prefix = rule.lhs[0].type;
                    let trans = rule.sync ? (syncTransform[rule.sync] = syncTransform[rule.sync] || {}) : transform;
                    trans[prefix] = trans[prefix] || [];
                    trans[prefix].push (rule);
                    rule.lhs.forEach (markTerm);
                    rule.rhs.forEach (markTerm);
                }
                break;
            case 'inherit':
                prefix = rule.child;
                parents[prefix] = (parents[prefix] || []).concat (rule.parents);
                markType (rule.child);
                rule.parents.forEach (markType);
                break;
            case 'comment':
                break;
            default:
                throw new Error ("Unrecognized rule type '" + rule.type + "' in " + JSON.stringify(rule));
            break;
        }
    })
    types.push (UnknownType);
    let ancestors = Object.assign (
        ...[{}].concat (Object.keys(parents).map ((child) => {
            let seen = {};
            const getAncestors = (prefix) => {
                if (seen[prefix] || !parents[prefix])
                    return [];
                seen[prefix] = true;
                return parents[prefix].reduce ((a,p) => a.concat(getAncestors(p)), parents[prefix]);
            };
            return { [child]: getAncestors(child) }
        })
    ));
    let isAncestor = {}, descendants = {};
    Object.keys(ancestors).forEach ((descendant) => ancestors[descendant].forEach ((ancestor) => {
        isAncestor[ancestor] = isAncestor[ancestor] || {}
        isAncestor[ancestor][descendant] = true
    }));
    Object.keys(isAncestor).forEach ((ancestor) => descendants[ancestor] = Object.keys(isAncestor[ancestor]).sort())
    let typeIndex = {};
    types.forEach ((type, n) => typeIndex[type] = n);
    const syncRates = Object.keys(syncTransform).map((s)=>parseInt(s)).sort ((a,b) => a - b);
    const syncCategoriesByType = Object.assign (...[{}].concat (types.map ((t) => ({ [t]: syncRates.filter ((r) => (syncTransform[r][t] || []).length) })).filter ((o) => o[Object.keys(o)[0]].length)));
    return { transform, syncTransform, ancestors, descendants, types, typeIndex, syncRates, syncCategoriesByType };
}

const replaceTermWithAlt = (term, descendants) => {
    if (term.op === 'negterm')
        return { op: term.op, term: replaceTermWithAlt (term.term, descendants) }
    if (term.op === 'alt')
        return { 
                    op: term.op,
                    alt: term.alt.map ((t) => replaceTermWithAlt (t, descendants))
                        .reduce ((alt, t) => alt.concat(t.op==='alt' ? t.alt : [t]), [])
                        .reduce ((memo, t) => {
                            const tstr = lhsTerm(t);
                            if (memo.seen[tstr])
                                return memo;
                            return { alt: memo.alt.concat([t]), seen: { ...memo.seen, [tstr]: true }}
                        }, { alt: [], seen: {} }).alt
                }
    if (descendants[term.type])
        return { op: 'alt', alt: [term].concat (descendants[term.type].map ((descendant) => ({ ...term, type: descendant }))) }
    return term;
}

const expandAlts = (transform, descendants) => Object.assign (...[{}].concat (Object.keys(transform).map ((prefix) => ({
    [prefix]: transform[prefix].map ((rule) => ({
        ...rule,
        lhs: [rule.lhs[0]].concat (rule.lhs.slice(1).map ((term) => replaceTermWithAlt (term, descendants)))
    }))
}))));

const replaceSubjectType = (rule, type) => {
    let lhs = rule.lhs.slice(0);
    lhs[0] = { ...lhs[0], type }
    return { ...rule, lhs }
}

const appendInherited = (types, explicit, ancestors) => Object.assign (...[{}].concat (types.map ((prefix) => ({
    [prefix]: (ancestors[prefix] || []).reduce ((rules,ancs) =>
        rules.concat((explicit[ancs] || []).map ((rule) =>
            replaceSubjectType(rule,prefix))), explicit[prefix] || []) })).filter ((trans) => trans[Object.keys(trans)[0]].length)));

const expandInherits = (index) => {
    const explicit = expandAlts (index.transform, index.descendants);
    const syncExplicit = Object.assign (...[{}].concat(index.syncRates.map ((r) => ({ [r]: expandAlts (index.syncTransform[r], index.descendants) }))));
    const transform = appendInherited (index.types, explicit, index.ancestors);
    const syncTransform = Object.assign (...[{}].concat(index.syncRates.map ((r) => ({ [r]: appendInherited (index.types, syncExplicit[r], index.ancestors) }))));

    return { types: index.types, typeIndex: index.typeIndex, syncRates: index.syncRates, syncCategoriesByType: index.syncCategoriesByType, transform, syncTransform };
};

const compileTerm = (typeIndex, t) => {
    if (t.op === 'negterm')
        return { ...t, term: compileTerm (typeIndex, t.term) };
    if (t.op === 'alt')
        return { ...t, alt: t.alt.map ((t) => compileTerm (typeIndex, t)) };
    return { ...t, type: typeIndex[t.type] }
};

const compileTransform = (types, transform, typeIndex, rateKey, defaultRate) =>
 types.map ((type) =>
    (transform[type] || []).map ((rule) =>
        rule.type === 'transform'
        ? { [rateKey]: defaultRate,
            ...rule,
            lhs: rule.lhs.map((t) => compileTerm(typeIndex,t)),
            rhs: rule.rhs.map((t) => compileTerm(typeIndex,t)) }
        : rule ));

const collectCommandsAndKeys = (command, key, transform, types) =>
 types.forEach ((_name, type) => transform[type].forEach ((rule) => {
    if (rule.command)
        command[type][rule.command] = (command[type][rule.command] || []).concat ([rule]);
    if (rule.key)
        key[type][rule.key] = (key[type][rule.key] || []).concat ([rule]);
 }));

const compileTypes = (rules) => {
    const index = expandInherits (makeGrammarIndex (rules));
    const { types, typeIndex, syncRates } = index;
    const million = 1000000;
    const transform = compileTransform (types, index.transform, typeIndex, 'rate', million);
    const syncTransform = index.syncRates.map ((r) => compileTransform (types, index.syncTransform[r], typeIndex, 'sync', 1));

    // convert from microHertz rate to Hertz with rejection
    // Rules with key or command attributes are excluded from async evolution (rate_Hz=0)
    // so they only fire in response to player input via processMove
    const bigMillion = BigInt(million), big2pow30minus1 = BigInt(0x3fffffff), bigMillion_leftShift32 = bigMillion << BigInt(32);
    transform.forEach ((rules) =>
        rules.forEach ((rule) => {
            if (rule.key || rule.command) {
                rule.rate_Hz = BigInt(0);
                rule.acceptProb_leftShift30 = 0;
            } else {
                rule.rate_Hz = BigInt (Math.ceil (rule.rate / million));
                rule.acceptProb_leftShift30 = rule.rate && Number (BigInt(rule.rate) * big2pow30minus1 / (rule.rate_Hz * bigMillion));
            }
        }))

    let command = types.map(()=>({})), key = types.map(()=>({}));
    collectCommandsAndKeys (command, key, transform, types);
    syncRates.forEach ((r, n) => collectCommandsAndKeys (command, key, syncTransform[n], types));
    const rateByType = transform.map ((rules) => rules.reduce ((total, rule) => total + rule.rate_Hz, BigInt(0)));  // async rates measured in Hz, with accept probabilities providing microHz resolution
    const syncCategoriesByType = types.map ((_t, n) => syncRates.reduce ((l, _r, m) => l.concat (syncTransform[m][n].length ? [m] : []), []));  // sync rates measured in microHz
    const typesBySyncCategory = syncRates.map ((_r, m) => types.reduce ((l, _t, n) => l.concat (syncTransform[m][n].length ? [n] : []), []));
    const syncPeriods = syncRates.map ((r) => bigMillion_leftShift32 / BigInt(r));  // convert from microHz to Hz
    const syncCategories = syncPeriods.map((_p,n)=>n).reverse();
    const unknownType = types.length - 1;

    return { transform, syncTransform, types, unknownType, typeIndex, syncRates, syncPeriods, syncCategories, rateByType, syncCategoriesByType, typesBySyncCategory, command, key }
}

const syntaxErrorMessage = (e, text) => {
    let msg;
    if (e instanceof SyntaxError) {
        const line = text.split("\n")[e.location.start.line - 1];
        const arrow = '-'.repeat(e.location.start.column - 1) + '^';
        msg = `Line ${e.location.start.line}, column ${e.location.start.column}:\n`
              + e.message + "\n"
              + line + "\n"
              + arrow + "\n";
    } else {
        msg = e;
    }
    return msg;
}

const parseOrUndefined = (text, opts) => {
    let rules;
    try {
        rules = parse(text);
    } catch (e) {
        if (opts?.error !== false)
            (opts?.error || console.error) (opts?.suppressLocation ? e.message : syntaxErrorMessage(e,text));
    }
    return rules;
}

const grammarIndexToRuleList = (index, addComments) => index.types.reduce ((newRules,type,n) => newRules.concat(addComments && n !== index.unknownType ? [{type:'comment',comment:' Type '+n+': '+type+' ('+(index.transform[type]||[]).length+' rules)'}] : []).concat(index.transform[type]||[]).concat((index.syncCategoriesByType[type] || []).reduce((l,s)=>l.concat(index.syncTransform[s][type]),[])), []);
const compiledGrammarIndexToRuleList = (index, addComments) => index.types.reduce ((newRules,type,n) => newRules.concat(addComments && n !== index.unknownType ? [{type:'comment',comment:' Type '+n+': '+type+' ('+(index.transform[n]||[]).length+' rules)'}] : []).concat(index.transform[n]||[]).concat((index.syncCategoriesByType[n] || []).reduce((l,s)=>l.concat(index.syncTransform[s][n]),[])), []);

const bigIntContainerToObject = (x) => {
    return JSON.parse(JSON.stringify(x, (key, value) =>
        typeof value === 'bigint'
            ? value.toString() + 'n'
            : value // return everything else unchanged
    ));
}

export { makeGrammarIndex, expandInherits, compileTypes, syntaxErrorMessage, parseOrUndefined, grammarIndexToRuleList, compiledGrammarIndexToRuleList, bigIntContainerToObject, UnknownType, EmptyType }
