#!/usr/bin/env node

import { readFileSync } from 'fs';
import { writeFileSync } from 'fs';
import { parseArgs, getFlag } from '../lib/args.js';
import { assemble } from '../../engine/assembler.js';

const { flags, positional } = parseArgs();

const outputFile = getFlag(flags, 'o');
const format = getFlag(flags, 'f', 'hex');

let source;
if (positional.length > 0) {
    source = readFileSync(positional[0], 'utf-8');
} else {
    // Read from stdin
    source = readFileSync('/dev/stdin', 'utf-8');
}

try {
    const bytes = await assemble(source);

    let output;
    if (format === 'hex') {
        output = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    } else if (format === 'bin') {
        output = Buffer.from(bytes);
    } else if (format === 'json') {
        output = JSON.stringify(Array.from(bytes));
    } else {
        console.error(`Unknown format: ${format}`);
        process.exit(1);
    }

    if (outputFile) {
        if (format === 'bin') {
            writeFileSync(outputFile, output);
        } else {
            writeFileSync(outputFile, output + '\n');
        }
    } else {
        if (format === 'bin') {
            process.stdout.write(output);
        } else {
            console.log(output);
        }
    }
} catch (e) {
    console.error(`Assembly error: ${e.message}`);
    process.exit(1);
}
