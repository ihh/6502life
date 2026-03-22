#!/usr/bin/env node

// phylo.js — Reconstruct phylogenetic tree from lineage event log
// Takes JSONL from `probe.js track` or `replay.js --track` and builds a tree
//
// Usage:
//   node cli/bin/phylo.js --log lineage.jsonl [--format ascii|newick|dot|json]
//   node cli/bin/phylo.js --log lineage.jsonl --format newick > tree.nwk
//   node cli/bin/phylo.js --log lineage.jsonl --format dot | dot -Tsvg > tree.svg
//   cat lineage.jsonl | node cli/bin/phylo.js --format ascii

import { readFileSync } from 'fs';
import { parseArgs, getFlag } from '../lib/args.js';

const { flags } = parseArgs();

if ('help' in flags) {
    console.log(`phylo.js — Reconstruct phylogenetic tree from lineage event log

Usage:
  node cli/bin/phylo.js --log <file> [--format FORMAT]
  cat lineage.jsonl | node cli/bin/phylo.js --format ascii

Options:
  --log FILE         JSONL lineage event log file (default: stdin)
  --format FORMAT    Output format: ascii, newick, dot, or json (default: ascii)
  --help             Show this help message`);
    process.exit(0);
}

const logFile = getFlag(flags, 'log');
const format = getFlag(flags, 'format') || 'ascii';

// Read events
let lines;
if (logFile) {
    lines = readFileSync(logFile, 'utf-8').trim().split('\n');
} else {
    lines = readFileSync('/dev/stdin', 'utf-8').trim().split('\n');
}

// Parse lineage events
const events = [];
for (const line of lines) {
    if (!line.trim()) continue;
    try {
        const e = JSON.parse(line);
        if (e.event === 'copied_to' || e.channel === 'lineage') {
            events.push(e);
        }
    } catch {}
}

if (events.length === 0) {
    console.error('No lineage events found in input.');
    process.exit(1);
}

// Build tree: nodes keyed by "i,j"
const nodes = new Map(); // key -> { key, parent, children, time, similarity }

function cellKey(cell) {
    return `${cell[0]},${cell[1]}`;
}

function getOrCreate(key) {
    if (!nodes.has(key)) {
        nodes.set(key, { key, parent: null, children: [], time: 0, similarity: 1 });
    }
    return nodes.get(key);
}

// Identify the root: the source of the first event (the originally tracked cell).
// Pre-create it so it is never assigned a parent during processing.
const rootKey = cellKey(events[0].src);
const rootNode = getOrCreate(rootKey);

// Sentinel: mark cells that have been "reached" (either as root or as a copy
// destination). We use a Set rather than the parent field, since the root has
// parent=null but should still be treated as reached.
const reached = new Set([rootKey]);

// Process events chronologically.
// Use colonization semantics: only the FIRST copy to each destination cell
// establishes the parent edge. Subsequent re-copies are ignored. This
// guarantees an acyclic tree (each node has at most one parent, assigned once).
for (const e of events) {
    const srcKey = cellKey(e.src);
    const dstKey = cellKey(e.dst);
    const src = getOrCreate(srcKey);
    const dst = getOrCreate(dstKey);

    // Skip if destination has already been reached (first copy wins)
    if (reached.has(dstKey)) continue;

    reached.add(dstKey);
    dst.parent = srcKey;
    dst.time = e.interrupt || e.time || 0;
    dst.similarity = e.similarity || 1;

    if (!src.children.includes(dstKey)) {
        src.children.push(dstKey);
    }
}

// Find roots (nodes with no parent)
const roots = [];
for (const [key, node] of nodes) {
    if (!node.parent) roots.push(key);
}

// Safety check: if somehow no roots exist (should not happen with first-copy
// semantics, but handle gracefully), warn and identify disconnected components
if (roots.length === 0 && nodes.size > 0) {
    console.error('Warning: no root nodes found (unexpected). Listing all nodes as disconnected.');
    for (const key of nodes.keys()) {
        roots.push(key);
    }
}

// Output
switch (format) {
    case 'ascii':
        for (let r = 0; r < roots.length; r++) {
            if (r > 0) console.log('');  // blank line between disconnected trees
            printAsciiTree(roots[r], '', true);
        }
        printStats();
        break;

    case 'newick':
        for (const root of roots) {
            console.log(toNewick(root) + ';');
        }
        break;

    case 'dot':
        console.log('digraph lineage {');
        console.log('  rankdir=TB;');
        console.log('  node [shape=box, fontname="monospace", fontsize=10];');
        for (const [key, node] of nodes) {
            const label = key;
            const style = roots.includes(key) ? ', style=filled, fillcolor="#ffcccc"' : '';
            console.log(`  "${key}" [label="${label}"${style}];`);
            for (const child of node.children) {
                const childNode = nodes.get(child);
                const simLabel = childNode ? `sim=${childNode.similarity}` : '';
                console.log(`  "${key}" -> "${child}" [label="${simLabel}"];`);
            }
        }
        console.log('}');
        break;

    case 'json':
        console.log(JSON.stringify({
            roots,
            nodes: Object.fromEntries(
                Array.from(nodes.entries()).map(([k, v]) => [k, {
                    parent: v.parent,
                    children: v.children,
                    time: v.time,
                    similarity: v.similarity,
                }])
            ),
            stats: getStats(),
        }, null, 2));
        break;

    default:
        console.error(`Unknown format: ${format}. Use ascii, newick, dot, or json.`);
        process.exit(1);
}

// --- Tree formatters ---

function printAsciiTree(key, prefix, isLast) {
    const node = nodes.get(key);
    const connector = isLast ? '└── ' : '├── ';
    const sim = node.parent ? ` (sim=${node.similarity}, t=${node.time})` : ' (root)';
    console.log(`${prefix}${connector}[${key}]${sim}`);

    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < node.children.length; i++) {
        printAsciiTree(node.children[i], childPrefix, i === node.children.length - 1);
    }
}

function toNewick(key) {
    const node = nodes.get(key);
    const name = key.replace(',', '_');
    if (node.children.length === 0) {
        return name;
    }
    const children = node.children.map(c => {
        const child = nodes.get(c);
        const branchLen = child.time - node.time || 1;
        return `${toNewick(c)}:${branchLen}`;
    }).join(',');
    return `(${children})${name}`;
}

function getStats() {
    let maxDepth = 0;
    let leafCount = 0;

    function walk(key, depth) {
        const node = nodes.get(key);
        if (node.children.length === 0) {
            leafCount++;
            maxDepth = Math.max(maxDepth, depth);
        }
        for (const child of node.children) {
            walk(child, depth + 1);
        }
    }

    for (const root of roots) walk(root, 0);

    return {
        totalNodes: nodes.size,
        roots: roots.length,
        leaves: leafCount,
        maxDepth,
        totalEvents: events.length,
    };
}

function printStats() {
    const stats = getStats();
    console.log(`\n--- ${stats.totalNodes} nodes, ${stats.leaves} leaves, depth ${stats.maxDepth}, ${stats.totalEvents} events ---`);
}
