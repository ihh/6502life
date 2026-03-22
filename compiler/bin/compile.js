#!/usr/bin/env node
// SokoScript-to-6502life compiler CLI
//
// Usage:
//   node compiler/bin/compile.js grammar.txt              # compile, show assembly
//   node compiler/bin/compile.js grammar.txt --universal   # single universal program
//   node compiler/bin/compile.js grammar.txt --json        # JSON output
//   node compiler/bin/compile.js grammar.txt --types       # show type encoding
//   cat grammar.txt | node compiler/bin/compile.js         # from stdin

import { readFileSync } from 'fs';
import { compile, compileUniversal } from '../sokoscript.js';
import { assemble } from '../../engine/assembler.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.filter(a => !a.startsWith('--'));

const showJson = flags.has('--json');
const showTypes = flags.has('--types');
const universal = flags.has('--universal');
const showHelp = flags.has('--help') || flags.has('-h');

if (showHelp) {
    console.log(`SokoScript-to-6502life compiler

Usage:
  node compiler/bin/compile.js [options] [grammar-file]

Options:
  --universal   Generate a single universal program (all types in one)
  --json        Output as JSON
  --types       Show type tag encoding
  --help        Show this help

If no grammar file is given, reads from stdin.

Examples:
  node compiler/bin/compile.js grammars/diffuse.txt
  echo 'x _ : _ x.' | node compiler/bin/compile.js --types
  node compiler/bin/compile.js grammars/ecosystem.txt --json`);
    process.exit(0);
}

// Read grammar
let grammarText;
if (positional.length > 0) {
    grammarText = readFileSync(positional[0], 'utf-8');
} else {
    // Read from stdin
    grammarText = readFileSync('/dev/stdin', 'utf-8');
}

try {
    if (universal) {
        const result = compileUniversal(grammarText);
        if (showJson) {
            const bytes = await assemble(result.assembly);
            console.log(JSON.stringify({
                types: result.types,
                typeIndex: result.typeIndex,
                assembly: result.assembly,
                bytes: Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''),
                size: bytes.length,
            }, null, 2));
        } else if (showTypes) {
            console.log('Type encoding:');
            for (const [name, tag] of Object.entries(result.typeIndex)) {
                console.log(`  ${name}: ${tag} (0x${tag.toString(16).padStart(2, '0')})`);
            }
        } else {
            console.log(result.assembly);
        }
    } else {
        const result = compile(grammarText);

        if (showTypes) {
            console.log('Type encoding:');
            for (const [name, tag] of Object.entries(result.typeIndex)) {
                console.log(`  ${name}: ${tag} (0x${tag.toString(16).padStart(2, '0')})`);
            }
            console.log(`\nPrograms generated for: ${Object.keys(result.programs).join(', ')}`);
            process.exit(0);
        }

        if (showJson) {
            const programData = {};
            for (const [type, asm] of Object.entries(result.programs)) {
                const bytes = await assemble(asm);
                programData[type] = {
                    assembly: asm,
                    bytes: Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''),
                    size: bytes.length,
                };
            }
            console.log(JSON.stringify({
                types: result.types,
                typeIndex: result.typeIndex,
                programs: programData,
            }, null, 2));
        } else {
            for (const [type, asm] of Object.entries(result.programs)) {
                console.log(asm);
                console.log('');
            }
        }
    }
} catch (e) {
    console.error('Compilation error:', e.message);
    process.exit(1);
}
