const escape = (c, special) => {
  if (!special)
    special = ' !"#$%&\'()*+,-./0123456789:;<=>?@[\\]^_`{|}~';
  return (special.indexOf(c) >= 0 ? '\\' : '') + c;
}
const escapeAttr = (c) => escape (c, '\\}');

const topStateChar = (t) => {
  if (typeof(t) === 'string')
    return t;
  switch (t.op) {
  case '+':
  case '-':
  case '*':
    return '(' + makeStateChar(t) + ')';
  default:
    return makeStateChar(t);
  }
}

const makeStateChar = (t) => {
  if (typeof(t) === 'string')
    return t;
  switch (t.op) {
  case 'char':
    return escape(t.char);
  case 'wild':
    return '?';
  case 'any':
    return '*';
  case 'class':
    return '[' + t.chars.map(makeStateChar).join('') + ']';
  case 'negated':
    return '[^' + t.chars.map(makeStateChar).join('') + ']';
  case 'neighborhood':
    return '@' + t.neighborhood + '(' + vecExpr(t.origin) + ')';
  case 'clock':
  case 'anti':
      return '@' + t.op + '(' + vecExpr(t.arg) + ')';
  case 'add':
  case 'sub':
      return '@' + t.op + '(' + vecExpr(t.left) + ',' + vecExpr(t.right) + ')';
  case '+':
  case '-':
  case '*':
  case 'location':
  case 'absdir':
  case 'reldir':
  case 'integer':
  case 'vector':
  case 'state':
  case 'tail':
      return vecExpr(t);
  default:
    throw new Error ("Unrecognized op '" + t.op + "' in " + JSON.stringify(t));
  }
}

const vecExpr = (t) => {
  switch (t.op) {
  case '+':
  case '-':
    return vecExpr(t.left) + t.op + vecExpr(t.right);
  case '*':
    return vecExpr(t.left) + t.op + multiplicativeVecExpr(t.right);
  case 'location':
    return '@' + t.group;
  case 'absdir':
  case 'reldir':
      return '@' + t.dir;
  case 'integer':
    return '@int(' + t.n + ')';
  case 'vector':
    return '@vec(' + t.x + ',' + t.y + ')';
  case 'state':
    return '$' + (t.group || '') + '#' + t.char;
  case 'tail':
    return '$' + (t.group || '') + '#*';
  case 'matrix':
    return '%' + t.matrix;
  default:
    throw new Error ("Unrecognized op '" + t.op + "' in " + JSON.stringify(t));
  }
}
const multiplicativeVecExpr = (t) => {
  const s = vecExpr(t);
  return (t.op === '+' || t.op === '-') ? ('(' + s + ')') : s;
}

const stateSuffix = (t) => {
  return t.state ? ("/" + t.state.map(topStateChar).join('')) : '';
}

const termWithState = (t) => {
  return (typeof(t.type) === 'number' ? 't' : '') + t.type + stateSuffix(t);
}

const lhsTerm = (t) => {
  switch (t.op) {
    case 'any':
      return '*';
    case 'negterm':
      return '^' + lhsTerm(t.term);
    case 'alt':
      return '(' + t.alt.map(lhsTerm).join('|') + ')';
    default:
      return termWithState(t);
    }
}

const addrExpr = (t) => {
  switch (t.op) {
    case 'absdir':
    case 'reldir':
        return '>' + t.dir.toUpperCase() + '>';
    case 'cell':
      return '>' + vecExpr(t.arg) + '>';
    case 'neighbor':
      return '>+' + vecExpr(t.arg) + '>';
    default:
      throw new Error ("Unrecognized op '" + t.op + "' in " + JSON.stringify(t));
      return undefined;
    }
}

const makeLhs = (lhs) => {
  return lhs.slice(1).reduce ((list, curr) => {
    return list + ' ' + (curr.addr ? (addrExpr(curr.addr) + ' ') : '') + lhsTerm(curr);
  }, [lhsTerm(lhs[0])]);
}

const rhsTerm = (t) => {
  const id = 'id' in t ? ('~' + t.id) : '';
  if (t.op === 'group')
    return '$' + t.group + id;
  if (t.op === 'prefix')
    return '$' + t.group + stateSuffix(t) + id;
  return termWithState(t) + id;
};

const makeRhs = (rhs, sep) => {
  return rhs.map(rhsTerm).join(sep);
};

const fixedPoint6 = (rate) => {
  let s = Math.floor (rate / 1000000), f = Math.floor (rate % 1000000);
  if (f) {
    f = f.toString();
    while (f.length < 6)
      f = '0' + f;
    s = (s + '.' + f).replace(/0+$/g,'');
  }
  return s;
}

const serialize = (rules) => {
  const attrs = (rule) =>
    (rule.rate ? (' rate=' + fixedPoint6(rule.rate)) : '')
    + (rule.sync ? (' sync=' + fixedPoint6(rule.sync)) : '')
    + (rule.command ? (' command={' + escapeAttr(rule.command) + '}') : '')
    + (rule.key ? (' key={' + escapeAttr(rule.key) + '}') : '')
    + (rule.score ? (' score=' + rule.score) : '')
    + (rule.sound ? (' sound={' + escapeAttr(rule.sound) + '}') : '')
    + (rule.caption ? (' caption={' + escapeAttr(rule.caption) + '}') : '');
  return rules.map ((rule) => {
    switch (rule.type) {
      case 'transform': {
        const a = attrs(rule);
        return makeLhs(rule.lhs) + ' : ' + makeRhs(rule.rhs,' ')
        + (a.length ? ("," + a) : "")
        + ".\n";
      }
      case 'inherit':
        return rule.child + ' = ' + rule.parents.join(', ') + ".\n";
      case 'comment':
        return '//' + rule.comment + "\n";
      default:
        throw new Error ("Unrecognized rule type '" + rule.type + "' in " + JSON.stringify(rule));
      }
  }).join("");
}

const serializeRuleWithTypes = (rule, types) => {
    const resolve = (t) => {
        if (t.op === 'negterm') return { ...t, term: resolve(t.term) };
        if (t.op === 'alt') return { ...t, alt: t.alt.map(resolve) };
        if (t.op === 'group' || t.op === 'prefix') return t;
        return typeof(t.type) === 'number' ? { ...t, type: types[t.type] } : t;
    };
    const resolved = { ...rule, lhs: rule.lhs.map(resolve), rhs: rule.rhs.map(resolve) };
    return serialize([resolved]).trim();
};

export { serialize, serializeRuleWithTypes, lhsTerm }
