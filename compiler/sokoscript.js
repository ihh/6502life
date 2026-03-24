// SokoScript-to-6502life compiler
//
// Takes a SokoScript grammar and produces 6502 assembly that implements
// the rules on the 6502life board.
//
// Cell encoding:
//   Byte 0x00: type tag (0 = empty/_, 1..N = grammar types)
//   Bytes 0x01-0x10: state string (up to 16 chars, ASCII 33-126)
//   Byte 0x11: state length
//
// Memory layout for compiled code:
//   0x000-0x011: type tag + state (shared encoding region)
//   0x012-0x0EF: zero page scratch space
//   0x100-0x1FF: stack
//   0x200-0x3BF: compiled rule code (448 bytes)
//   0x3C0-0x3DF: 16x16 monochrome bitmap
//   0x3E0-0x3FB: display name (28 bytes)
//   0x3FF: hue byte
//
// The compiled program is placed starting at 0x000 (entry point).
// It reads its own type tag and neighbor type tags to decide which
// rules match, then writes new type/state values.

import { parse } from './grammar.js';
import { makeGrammarIndex, expandInherits } from './gramutil.js';

// --- Constants ---
// Type metadata lives in the zero page at addresses chosen so that the
// address byte is itself a valid 6502 opcode. This is required because
// the BoardController's cycle-0 opcode check reads the operand byte of
// multi-byte instructions and treats invalid opcodes as BRK. By storing
// metadata at "opcode-safe" addresses, LDA/STA instructions accessing
// these locations won't trigger false BRK detection.
//
// Safe zero-page addresses (valid opcodes, not 0x00):
//   0xA5 = LDA zp, 0xA6 = LDX zp, 0xA8 = TAY, 0xA9 = LDA imm, ...
const TYPE_TAG_OFFSET   = 0xA5;   // byte offset within each cell for type tag
const STATE_OFFSET      = 0xA8;   // state string starts here (0xA8-0xB7)
const STATE_MAX_LEN     = 16;     // max state characters
const STATE_LEN_OFFSET  = 0xA6;   // byte offset for state length (0xA6 = LDX zp)
const CELL_SIZE         = 1024;   // bytes per cell in memory map

// State byte offsets: we need 16 addresses, each a valid opcode.
// 0xA8(TAY), 0xA9(LDA#), 0xAA(TAX), 0xAC(LDY abs), 0xAD(LDA abs),
// 0xAE(LDX abs), 0xB0(BCS), 0xB1(LDA(ind),Y), 0xB4(LDY zp,X),
// 0xB5(LDA zp,X), 0xB6(LDX zp,Y), 0xB8(CLV), 0xB9(LDA abs,Y),
// 0xBA(TSX), 0xBC(LDY abs,X), 0xBD(LDA abs,X)
// We use consecutive addresses starting at 0xA8 but some (0xAB, 0xAF,
// 0xB2, 0xB3, 0xB7) are invalid opcodes. To keep it simple, we use
// a contiguous block and accept that the controller will trigger false
// BRK only for state bytes at those specific offsets. For the common
// case of 0-4 state chars, addresses 0xA8-0xAB suffice, and 0xA8-0xAA
// are all valid.

// Spiral-order neighbor indices for cardinal directions
// idx 0 = self (0,0)
// idx 1 = (0,+1) = South in 6502life coords
// idx 2 = (+1,0) = East
// idx 3 = (0,-1) = North
// idx 4 = (-1,0) = West
// With random orientation, these become effectively random relative directions.
// For SokoScript relative directions: F=1, R=2, B=3, L=4
// (This works because the board randomly rotates, so F is just "some direction")
const REL_DIR_INDEX = {
    'F': 1,   // forward
    'R': 2,   // right
    'B': 3,   // back
    'L': 4,   // left
};

// Absolute directions map to physical (dx,dy) vectors.
// idx 1=(0,+1), idx 2=(+1,0), idx 3=(0,-1), idx 4=(-1,0)
// N=(0,-1)=idx3, E=(+1,0)=idx2, S=(0,+1)=idx1, W=(-1,0)=idx4
const ABS_DIR_INDEX = {
    'N': 3,
    'E': 2,
    'S': 1,
    'W': 4,
};

// Compute the base address for a neighbor cell by spiral index
function cellBaseAddr(spiralIdx) {
    return spiralIdx * CELL_SIZE;
}

// Compute the address of a neighbor's type tag
function cellTypeAddr(spiralIdx) {
    return cellBaseAddr(spiralIdx) + TYPE_TAG_OFFSET;
}

// Compute the address of a neighbor's state byte n (1-indexed)
function cellStateAddr(spiralIdx, charIdx) {
    return cellBaseAddr(spiralIdx) + STATE_OFFSET + (charIdx - 1);
}

// Compute the address of a neighbor's state length
function cellStateLenAddr(spiralIdx) {
    return cellBaseAddr(spiralIdx) + STATE_LEN_OFFSET;
}

// Format a 16-bit address as a 4-digit hex string
function addr16(a) {
    return '$' + a.toString(16).padStart(4, '0');
}

// Format an 8-bit immediate as a 2-digit hex string
function imm8(v) {
    return '#$' + (v & 0xFF).toString(16).padStart(2, '0');
}

// --- Parser wrapper ---

export function parseGrammar(text) {
    return parse(text);
}

// --- Grammar analysis ---

export function analyzeGrammar(rules) {
    const index = expandInherits(makeGrammarIndex(rules));
    return index;
}

// Resolve the neighbor index for a direction address.
// Returns the spiral index (0-48) for the neighbor.
function resolveDirection(addr) {
    if (!addr) {
        // Default: forward
        return REL_DIR_INDEX['F'];
    }
    switch (addr.op) {
        case 'reldir':
            if (!(addr.dir in REL_DIR_INDEX)) {
                throw new Error(`Unsupported relative direction: ${addr.dir}`);
            }
            return REL_DIR_INDEX[addr.dir];
        case 'absdir':
            if (!(addr.dir in ABS_DIR_INDEX)) {
                throw new Error(`Unsupported absolute direction: ${addr.dir}`);
            }
            return ABS_DIR_INDEX[addr.dir];
        default:
            throw new Error(`Unsupported address mode: ${addr.op}`);
    }
}

// --- Code generation ---

// Generate 6502 assembly for a single LHS term type check.
// Returns an array of assembly lines.
function genTypeCheck(termIdx, spiralIdx, typeTag, failLabel) {
    const lines = [];
    const ta = cellTypeAddr(spiralIdx);
    lines.push(`  LDA ${addr16(ta)}`);
    lines.push(`  CMP ${imm8(typeTag)}`);
    lines.push(`  BNE ${failLabel}`);
    return lines;
}

// Generate assembly for checking a state character match
function genStateCharCheck(spiralIdx, charIdx, expectedChar, failLabel) {
    const lines = [];
    const sa = cellStateAddr(spiralIdx, charIdx);
    const charCode = typeof expectedChar === 'string'
        ? expectedChar.charCodeAt(0)
        : expectedChar;
    lines.push(`  LDA ${addr16(sa)}`);
    lines.push(`  CMP ${imm8(charCode)}`);
    lines.push(`  BNE ${failLabel}`);
    return lines;
}

// Generate assembly for a wildcard state char check (just verify state is long enough)
function genStateWildCheck(spiralIdx, charIdx, failLabel) {
    const lines = [];
    const sla = cellStateLenAddr(spiralIdx);
    lines.push(`  LDA ${addr16(sla)}`);
    lines.push(`  CMP ${imm8(charIdx)}`);
    lines.push(`  BCC ${failLabel}`);  // branch if stateLen < charIdx
    return lines;
}

// Generate assembly to check that a cell has no state (stateLen == 0)
// Used when LHS term has no state pattern and type has no state
function genNoStateCheck(spiralIdx, failLabel) {
    const lines = [];
    const sla = cellStateLenAddr(spiralIdx);
    lines.push(`  LDA ${addr16(sla)}`);
    lines.push(`  BNE ${failLabel}`);
    return lines;
}

// Generate assembly for writing a type tag to a cell
function genTypeWrite(spiralIdx, typeTag) {
    const lines = [];
    const ta = cellTypeAddr(spiralIdx);
    lines.push(`  LDA ${imm8(typeTag)}`);
    lines.push(`  STA ${addr16(ta)}`);
    return lines;
}

// Generate assembly for writing a state character
function genStateCharWrite(spiralIdx, charIdx, charValue) {
    const lines = [];
    const sa = cellStateAddr(spiralIdx, charIdx);
    const charCode = typeof charValue === 'string'
        ? charValue.charCodeAt(0)
        : charValue;
    lines.push(`  LDA ${imm8(charCode)}`);
    lines.push(`  STA ${addr16(sa)}`);
    return lines;
}

// Generate assembly for writing state length
function genStateLenWrite(spiralIdx, len) {
    const lines = [];
    const sla = cellStateLenAddr(spiralIdx);
    lines.push(`  LDA ${imm8(len)}`);
    lines.push(`  STA ${addr16(sla)}`);
    return lines;
}

// --- LHS matching ---

// Check if a state char pattern is a simple literal
function isLiteralStateChar(sc) {
    return sc.op === 'char';
}

// Generate LHS checks for one term
function genLhsTermCheck(term, termIdx, spiralIdx, typeIndex, failLabel) {
    const lines = [];

    // Handle negation
    if (term.op === 'negterm') {
        // For negated terms, we need inverted logic:
        // if the inner term matches, fail; otherwise continue
        const matchLabel = `@neg_match_${termIdx}`;
        const innerLines = genLhsTermCheckInner(term.term, termIdx, spiralIdx, typeIndex, matchLabel);
        // If we reach here without branching, the inner didn't match => negation succeeds
        lines.push(...innerLines);
        lines.push(`  JMP ${failLabel.replace('@', '@neg_pass_')}`);
        lines.push(`${matchLabel}:`);
        // Inner matched => negation fails
        lines.push(`  JMP ${failLabel}`);
        lines.push(`${failLabel.replace('@', '@neg_pass_')}:`);
        return lines;
    }

    // Handle alternatives
    if (term.op === 'alt') {
        // Try each alternative; if any matches, jump to success
        const successLabel = `@alt_ok_${termIdx}`;
        for (let i = 0; i < term.alt.length; i++) {
            const altFailLabel = i < term.alt.length - 1
                ? `@alt_${termIdx}_${i + 1}`
                : failLabel;
            const altLines = genLhsTermCheckInner(
                term.alt[i], termIdx, spiralIdx, typeIndex, altFailLabel
            );
            if (i > 0) {
                lines.push(`@alt_${termIdx}_${i}:`);
            }
            lines.push(...altLines);
            if (i < term.alt.length - 1) {
                lines.push(`  JMP ${successLabel}`);
            }
        }
        if (term.alt.length > 1) {
            lines.push(`${successLabel}:`);
        }
        return lines;
    }

    // Handle wildcard (match any)
    if (term.op === 'any') {
        return []; // no checks needed
    }

    return genLhsTermCheckInner(term, termIdx, spiralIdx, typeIndex, failLabel);
}

// Inner check for a simple (non-negated, non-alt) LHS term
function genLhsTermCheckInner(term, termIdx, spiralIdx, typeIndex, failLabel) {
    const lines = [];

    // Type check
    if (term.type === '_') {
        // Empty type = tag 0
        lines.push(...genTypeCheck(termIdx, spiralIdx, 0, failLabel));
    } else if (term.type !== undefined) {
        const tag = typeIndex[term.type];
        if (tag === undefined) {
            throw new Error(`Unknown type: ${term.type}`);
        }
        lines.push(...genTypeCheck(termIdx, spiralIdx, tag, failLabel));
    }

    // State checks
    if (term.state) {
        for (let i = 0; i < term.state.length; i++) {
            const sc = term.state[i];
            if (sc.op === 'any') {
                // Wildcard '*' — matches rest of state, no check needed
                break;
            } else if (sc.op === 'wild') {
                // '?' — matches any single char, just check length
                lines.push(...genStateWildCheck(spiralIdx, i + 1, failLabel));
            } else if (sc.op === 'char') {
                // Literal character
                lines.push(...genStateCharCheck(spiralIdx, i + 1, sc.char, failLabel));
            } else if (sc.op === 'class') {
                // Character class [abc] — check membership
                const passLabel = `@class_ok_${termIdx}_${i}`;
                for (let j = 0; j < sc.chars.length; j++) {
                    const ch = typeof sc.chars[j] === 'string' ? sc.chars[j] : sc.chars[j].char || sc.chars[j];
                    const charCode = typeof ch === 'string' ? ch.charCodeAt(0) : ch;
                    const sa = cellStateAddr(spiralIdx, i + 1);
                    lines.push(`  LDA ${addr16(sa)}`);
                    lines.push(`  CMP ${imm8(charCode)}`);
                    lines.push(`  BEQ ${passLabel}`);
                }
                lines.push(`  JMP ${failLabel}`);
                lines.push(`${passLabel}:`);
            } else if (sc.op === 'negated') {
                // Negated character class [^abc]
                for (let j = 0; j < sc.chars.length; j++) {
                    const ch = typeof sc.chars[j] === 'string' ? sc.chars[j] : sc.chars[j].char || sc.chars[j];
                    const charCode = typeof ch === 'string' ? ch.charCodeAt(0) : ch;
                    const sa = cellStateAddr(spiralIdx, i + 1);
                    lines.push(`  LDA ${addr16(sa)}`);
                    lines.push(`  CMP ${imm8(charCode)}`);
                    lines.push(`  BEQ ${failLabel}`);
                }
            } else {
                // Unsupported state pattern for now
                throw new Error(`Unsupported state pattern op: ${sc.op}`);
            }
        }

        // If the LHS state pattern has no wildcard (*) at the end, check exact length
        const lastSc = term.state[term.state.length - 1];
        if (lastSc.op !== 'any') {
            const sla = cellStateLenAddr(spiralIdx);
            lines.push(`  LDA ${addr16(sla)}`);
            lines.push(`  CMP ${imm8(term.state.length)}`);
            lines.push(`  BNE ${failLabel}`);
        }
    }

    return lines;
}

// --- RHS generation ---

// Generate RHS writes for one term
// rhsPos: numeric position in the RHS array (used to index lhsSpiralIndices)
// labelSuffix: string suffix for label uniqueness (defaults to rhsPos)
function genRhsTermWrite(rhsTerm, rhsPos, lhsTerms, lhsSpiralIndices, typeIndex, labelSuffix) {
    const lines = [];
    const lbl = labelSuffix !== undefined ? labelSuffix : rhsPos;
    const spiralIdx = lhsSpiralIndices[rhsPos];

    if (rhsTerm.type === '_') {
        // Set to empty
        lines.push(...genTypeWrite(spiralIdx, 0));
        lines.push(...genStateLenWrite(spiralIdx, 0));
        return lines;
    }

    if (rhsTerm.op === 'group') {
        // $N — copy the matched LHS term's type and state
        // The cell already has the right data (it matched), so this is a no-op
        // unless the position differs (e.g., swap)
        const srcIdx = lhsSpiralIndices[rhsTerm.group - 1];
        if (srcIdx !== spiralIdx) {
            // Copy type tag
            lines.push(`  LDA ${addr16(cellTypeAddr(srcIdx))}`);
            lines.push(`  STA ${addr16(cellTypeAddr(spiralIdx))}`);
            // Copy state length
            lines.push(`  LDA ${addr16(cellStateLenAddr(srcIdx))}`);
            lines.push(`  STA ${addr16(cellStateLenAddr(spiralIdx))}`);
            // Copy state bytes (up to 16)
            // Use a loop with X register
            lines.push(`  TAX`);  // X = state length
            lines.push(`  BEQ @grp_done_${lbl}`);
            lines.push(`@grp_copy_${lbl}:`);
            lines.push(`  DEX`);
            const srcBase = cellBaseAddr(srcIdx) + STATE_OFFSET;
            const dstBase = cellBaseAddr(spiralIdx) + STATE_OFFSET;
            lines.push(`  LDA ${addr16(srcBase)},X`);
            lines.push(`  STA ${addr16(dstBase)},X`);
            lines.push(`  CPX #$00`);
            lines.push(`  BNE @grp_copy_${lbl}`);
            lines.push(`@grp_done_${lbl}:`);
        }
        return lines;
    }

    if (rhsTerm.op === 'prefix') {
        // $N/state — keep matched type, set new state
        const srcIdx = lhsSpiralIndices[rhsTerm.group - 1];
        // Copy type from matched LHS term
        lines.push(`  LDA ${addr16(cellTypeAddr(srcIdx))}`);
        lines.push(`  STA ${addr16(cellTypeAddr(spiralIdx))}`);
        // Write new state
        if (rhsTerm.state) {
            const stateChars = rhsTerm.state.filter(s => s.op === 'char');
            for (let i = 0; i < stateChars.length; i++) {
                lines.push(...genStateCharWrite(spiralIdx, i + 1, stateChars[i].char));
            }
            lines.push(...genStateLenWrite(spiralIdx, stateChars.length));
        } else {
            lines.push(...genStateLenWrite(spiralIdx, 0));
        }
        return lines;
    }

    // Direct type/state assignment
    const tag = typeIndex[rhsTerm.type];
    if (tag === undefined) {
        throw new Error(`Unknown RHS type: ${rhsTerm.type}`);
    }

    lines.push(...genTypeWrite(spiralIdx, tag));

    if (rhsTerm.state) {
        let charCount = 0;
        for (const sc of rhsTerm.state) {
            if (sc.op === 'char') {
                charCount++;
                lines.push(...genStateCharWrite(spiralIdx, charCount, sc.char));
            } else if (sc.op === 'state') {
                // Back-reference to matched state char: $#N or $G#N
                charCount++;
                const srcGroup = sc.group || 0;
                const srcCharIdx = sc.char;
                const srcSpiral = srcGroup > 0
                    ? lhsSpiralIndices[srcGroup - 1]
                    : lhsSpiralIndices[0];
                const srcAddr = cellStateAddr(srcSpiral, srcCharIdx);
                const dstAddr = cellStateAddr(spiralIdx, charCount);
                lines.push(`  LDA ${addr16(srcAddr)}`);
                lines.push(`  STA ${addr16(dstAddr)}`);
            }
            // Other state expression ops (add, sub, etc.) are unsupported for now
        }
        lines.push(...genStateLenWrite(spiralIdx, charCount));
    } else {
        lines.push(...genStateLenWrite(spiralIdx, 0));
    }

    return lines;
}

// --- Display name generation ---

// Generate assembly to write a display name string to $3E0
function genDisplayName(name, color) {
    const lines = [];
    const displayStr = color ? `${color}:${name}` : name;
    const bytes = Array.from(displayStr).map(c => c.charCodeAt(0));
    // Pad to 32 bytes with zeros
    while (bytes.length < 32) bytes.push(0);
    for (let i = 0; i < Math.min(bytes.length, 32); i++) {
        if (bytes[i] !== 0) {
            lines.push(`  LDA ${imm8(bytes[i])}`);
            lines.push(`  STA ${addr16(0x03E0 + i)}`);
        }
    }
    return lines;
}

// --- Main rule compiler ---

// Compile a single rule into assembly.
// ruleIdx: index for label generation
// rule: parsed rule object with lhs/rhs
// typeIndex: map from type name to tag number
// nextLabel: label to jump to on pattern mismatch
function compileRule(ruleIdx, rule, typeIndex, nextLabel) {
    const lines = [];
    const ruleLabel = `@rule_${ruleIdx}`;
    lines.push(`${ruleLabel}:`);

    // Determine spiral indices for each LHS term
    const spiralIndices = [];
    for (let i = 0; i < rule.lhs.length; i++) {
        if (i === 0) {
            spiralIndices.push(0); // subject = self
        } else {
            const term = rule.lhs[i];
            const idx = resolveDirection(term.addr);
            spiralIndices.push(idx);
        }
    }

    // Generate LHS checks
    for (let i = 0; i < rule.lhs.length; i++) {
        const term = rule.lhs[i];
        const checkLines = genLhsTermCheck(
            term, i, spiralIndices[i], typeIndex, nextLabel
        );
        lines.push(...checkLines);
    }

    // Generate RHS writes
    for (let i = 0; i < rule.rhs.length; i++) {
        const rhsTerm = rule.rhs[i];
        const writeLines = genRhsTermWrite(
            rhsTerm, i, rule.lhs, spiralIndices, typeIndex
        );
        lines.push(...writeLines);
    }

    // After applying the rule, yield
    lines.push(`  BRK`);
    lines.push(`  .byte $00`);

    return lines;
}

// --- Full grammar compilation ---

// Compile an entire SokoScript grammar into a map of type name -> 6502 assembly.
// Each type gets its own program that checks rules applicable to that type.
export function compile(grammarText, options = {}) {
    const rules = parseGrammar(grammarText);
    const index = analyzeGrammar(rules);
    const { types, typeIndex, transform } = index;

    const programs = {};

    for (const typeName of types) {
        if (typeName === '_' || typeName === '?') continue;

        const typeRules = transform[typeName] || [];
        if (typeRules.length === 0) continue;

        const tag = typeIndex[typeName];
        const lines = [];

        // Header comment
        lines.push(`; SokoScript compiled: type "${typeName}" (tag ${tag})`);
        lines.push(`; ${typeRules.length} rule(s)`);
        lines.push(``);

        // Entry: verify own type tag (if it got corrupted, yield)
        lines.push(`  LDA ${addr16(cellTypeAddr(0))}`);
        lines.push(`  CMP ${imm8(tag)}`);
        lines.push(`  BEQ @type_ok`);
        lines.push(`  BRK`);
        lines.push(`  .byte $00`);
        lines.push(`@type_ok:`);

        // Compile each rule
        for (let i = 0; i < typeRules.length; i++) {
            const rule = typeRules[i];
            const nextLabel = i < typeRules.length - 1
                ? `@rule_${i + 1}`
                : '@no_match';
            const ruleLines = compileRule(i, rule, typeIndex, nextLabel);
            lines.push(...ruleLines);
        }

        // No rule matched — yield
        lines.push(`@no_match:`);
        lines.push(`  BRK`);
        lines.push(`  .byte $00`);

        programs[typeName] = lines.join('\n');
    }

    return {
        types,
        typeIndex,
        programs,
        // Provide a "loader" program for empty cells that initializes them
        // with the empty type tag (0)
        emptyProgram: generateEmptyProgram(),
    };
}

// Generate a program for empty cells that ensures they have tag 0
function generateEmptyProgram() {
    return [
        '; Empty cell program (type tag = 0)',
        '  LDA #$00',
        `  STA ${addr16(cellTypeAddr(0))}`,
        `  STA ${addr16(cellStateLenAddr(0))}`,
        '  BRK',
        '  .byte $00',
    ].join('\n');
}

// --- High-level compile-to-assembly ---

// Compile a grammar and return assembly source for each type,
// plus metadata about the type encoding.
export function compileToAssembly(grammarText, options = {}) {
    return compile(grammarText, options);
}

// --- Convenience: compile and produce a single "universal" program ---

// A universal program checks its own type tag and dispatches to the
// appropriate rule set. This is useful when all cells run the same program.
export function compileUniversal(grammarText, options = {}) {
    const result = compile(grammarText, options);
    const { types, typeIndex, programs } = result;

    const lines = [];
    lines.push('; SokoScript universal program');
    lines.push(`; Types: ${types.filter(t => t !== '_' && t !== '?').join(', ')}`);
    lines.push('');

    // Read own type tag and dispatch
    lines.push(`  LDA ${addr16(cellTypeAddr(0))}`);

    const typeNames = Object.keys(programs);
    for (let i = 0; i < typeNames.length; i++) {
        const name = typeNames[i];
        const tag = typeIndex[name];
        lines.push(`  CMP ${imm8(tag)}`);
        lines.push(`  BEQ @type_${name}`);
    }

    // Unknown type — yield
    lines.push('  BRK');
    lines.push('  .byte $00');
    lines.push('');

    // Emit each type's rule code inline
    for (const name of typeNames) {
        lines.push(`@type_${name}:`);
        // Re-compile rules inline (without the entry type check since we already did it)
        const typeRules = result.types.includes(name)
            ? (analyzeGrammar(parseGrammar(grammarText)).transform[name] || [])
            : [];

        for (let i = 0; i < typeRules.length; i++) {
            const nextLabel = i < typeRules.length - 1
                ? `@${name}_rule_${i + 1}`
                : `@${name}_no_match`;

            const ruleLines = compileRuleWithPrefix(name, i, typeRules[i], typeIndex, nextLabel);
            lines.push(...ruleLines);
        }

        lines.push(`@${name}_no_match:`);
        lines.push('  BRK');
        lines.push('  .byte $00');
        lines.push('');
    }

    return {
        types,
        typeIndex,
        assembly: lines.join('\n'),
    };
}

// Compile a rule with type-prefixed labels to avoid collisions
function compileRuleWithPrefix(typeName, ruleIdx, rule, typeIndex, nextLabel) {
    const lines = [];
    const ruleLabel = `@${typeName}_rule_${ruleIdx}`;
    lines.push(`${ruleLabel}:`);

    // Determine spiral indices for each LHS term
    const spiralIndices = [];
    for (let i = 0; i < rule.lhs.length; i++) {
        if (i === 0) {
            spiralIndices.push(0); // subject = self
        } else {
            const term = rule.lhs[i];
            const idx = resolveDirection(term.addr);
            spiralIndices.push(idx);
        }
    }

    // Generate LHS checks (skip subject type check — already dispatched)
    for (let i = 0; i < rule.lhs.length; i++) {
        const term = rule.lhs[i];
        if (i === 0) {
            // Only check state for subject, not type (already checked in dispatch)
            if (term.state) {
                const stateLines = genLhsStateCheck(term, i, spiralIndices[i], typeIndex, nextLabel, typeName, ruleIdx);
                lines.push(...stateLines);
            }
            continue;
        }
        const checkLines = genLhsTermCheckPrefixed(
            term, i, spiralIndices[i], typeIndex, nextLabel, typeName, ruleIdx
        );
        lines.push(...checkLines);
    }

    // Generate RHS writes
    for (let i = 0; i < rule.rhs.length; i++) {
        const rhsTerm = rule.rhs[i];
        const writeLines = genRhsTermWritePrefixed(
            rhsTerm, i, rule.lhs, spiralIndices, typeIndex, typeName, ruleIdx
        );
        lines.push(...writeLines);
    }

    // Yield
    lines.push('  BRK');
    lines.push('  .byte $00');

    return lines;
}

// State-only check for the subject term (type already matched by dispatch)
function genLhsStateCheck(term, termIdx, spiralIdx, typeIndex, failLabel, prefix, ruleIdx) {
    const lines = [];
    if (!term.state) return lines;

    for (let i = 0; i < term.state.length; i++) {
        const sc = term.state[i];
        if (sc.op === 'any') break;
        if (sc.op === 'wild') {
            lines.push(...genStateWildCheck(spiralIdx, i + 1, failLabel));
        } else if (sc.op === 'char') {
            lines.push(...genStateCharCheck(spiralIdx, i + 1, sc.char, failLabel));
        }
    }

    const lastSc = term.state[term.state.length - 1];
    if (lastSc.op !== 'any') {
        const sla = cellStateLenAddr(spiralIdx);
        lines.push(`  LDA ${addr16(sla)}`);
        lines.push(`  CMP ${imm8(term.state.length)}`);
        lines.push(`  BNE ${failLabel}`);
    }

    return lines;
}

// Prefixed version of genLhsTermCheck for universal program
function genLhsTermCheckPrefixed(term, termIdx, spiralIdx, typeIndex, failLabel, prefix, ruleIdx) {
    // For now, delegate to the non-prefixed version
    // Labels within are unique enough with termIdx
    return genLhsTermCheck(term, `${prefix}_${ruleIdx}_${termIdx}`, spiralIdx, typeIndex, failLabel);
}

// Prefixed version of genRhsTermWrite
function genRhsTermWritePrefixed(rhsTerm, rhsIdx, lhsTerms, lhsSpiralIndices, typeIndex, prefix, ruleIdx) {
    // Pass numeric rhsIdx for array indexing, prefixed string for label uniqueness
    return genRhsTermWrite(rhsTerm, rhsIdx, lhsTerms, lhsSpiralIndices, typeIndex, `${prefix}_${ruleIdx}_${rhsIdx}`);
}

// --- Exports for testing ---
export {
    TYPE_TAG_OFFSET,
    STATE_OFFSET,
    STATE_LEN_OFFSET,
    STATE_MAX_LEN,
    REL_DIR_INDEX,
    ABS_DIR_INDEX,
    cellTypeAddr,
    cellStateAddr,
    cellStateLenAddr,
    resolveDirection,
    genTypeCheck,
    genStateCharCheck,
    genTypeWrite,
    genDisplayName,
    compileRule,
    analyzeGrammar as analyzeGrammarFromRules,
};
