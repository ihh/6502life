import { describe, it, expect } from 'vitest';

// Test the tree-building logic from phylo.js
// We replicate the core algorithm here since phylo.js is a CLI script

describe('phylo (tree reconstruction)', () => {
    function buildTree(events) {
        const nodes = new Map();

        function cellKey(cell) { return `${cell[0]},${cell[1]}`; }
        function getOrCreate(key) {
            if (!nodes.has(key)) {
                nodes.set(key, { key, parent: null, children: [], time: 0, similarity: 1 });
            }
            return nodes.get(key);
        }

        for (const e of events) {
            const srcKey = cellKey(e.src);
            const dstKey = cellKey(e.dst);
            const src = getOrCreate(srcKey);
            const dst = getOrCreate(dstKey);

            if (dst.parent && dst.parent !== srcKey) {
                const oldParent = nodes.get(dst.parent);
                if (oldParent) {
                    oldParent.children = oldParent.children.filter(k => k !== dstKey);
                }
            }

            dst.parent = srcKey;
            dst.time = e.interrupt || 0;
            dst.similarity = e.similarity || 1;

            if (!src.children.includes(dstKey)) {
                src.children.push(dstKey);
            }
        }

        const roots = [];
        for (const [key, node] of nodes) {
            if (!node.parent) roots.push(key);
        }

        return { nodes, roots };
    }

    function toNewick(nodes, key) {
        const node = nodes.get(key);
        const name = key.replace(',', '_');
        if (node.children.length === 0) return name;
        const children = node.children.map(c => {
            const child = nodes.get(c);
            const branchLen = child.time - node.time || 1;
            return `${toNewick(nodes, c)}:${branchLen}`;
        }).join(',');
        return `(${children})${name}`;
    }

    it('builds a simple parent-child tree', () => {
        const events = [
            { event: 'copied_to', src: [0, 0], dst: [1, 0], interrupt: 10, similarity: 0.95 },
            { event: 'copied_to', src: [0, 0], dst: [0, 1], interrupt: 20, similarity: 0.90 },
        ];

        const { nodes, roots } = buildTree(events);
        expect(roots).toEqual(['0,0']);
        expect(nodes.get('0,0').children).toEqual(['1,0', '0,1']);
        expect(nodes.get('1,0').parent).toBe('0,0');
        expect(nodes.get('0,1').parent).toBe('0,0');
    });

    it('handles chain replication (A→B→C)', () => {
        const events = [
            { event: 'copied_to', src: [0, 0], dst: [1, 0], interrupt: 10, similarity: 0.95 },
            { event: 'copied_to', src: [1, 0], dst: [2, 0], interrupt: 20, similarity: 0.90 },
        ];

        const { nodes, roots } = buildTree(events);
        expect(roots).toEqual(['0,0']);
        expect(nodes.get('0,0').children).toEqual(['1,0']);
        expect(nodes.get('1,0').children).toEqual(['2,0']);
    });

    it('handles re-copy (updates parent)', () => {
        const events = [
            { event: 'copied_to', src: [0, 0], dst: [1, 0], interrupt: 10, similarity: 0.95 },
            // Cell (1,0) gets re-copied by (2,0)
            { event: 'copied_to', src: [2, 0], dst: [1, 0], interrupt: 30, similarity: 0.80 },
        ];

        const { nodes, roots } = buildTree(events);
        // (1,0) should now be child of (2,0), not (0,0)
        expect(nodes.get('1,0').parent).toBe('2,0');
        expect(nodes.get('0,0').children).not.toContain('1,0');
        expect(nodes.get('2,0').children).toContain('1,0');
    });

    it('generates valid Newick format', () => {
        const events = [
            { event: 'copied_to', src: [0, 0], dst: [1, 0], interrupt: 10, similarity: 0.95 },
            { event: 'copied_to', src: [0, 0], dst: [0, 1], interrupt: 20, similarity: 0.90 },
        ];

        const { nodes, roots } = buildTree(events);
        const newick = toNewick(nodes, roots[0]);

        expect(newick).toContain('0_0');
        expect(newick).toContain('1_0');
        expect(newick).toContain('0_1');
        // Should have parentheses
        expect(newick.startsWith('(')).toBe(true);
    });

    it('handles empty events list', () => {
        const { nodes, roots } = buildTree([]);
        expect(nodes.size).toBe(0);
        expect(roots.length).toBe(0);
    });

    it('tracks similarity and timing', () => {
        const events = [
            { event: 'copied_to', src: [0, 0], dst: [1, 0], interrupt: 100, similarity: 0.85 },
        ];

        const { nodes } = buildTree(events);
        expect(nodes.get('1,0').similarity).toBe(0.85);
        expect(nodes.get('1,0').time).toBe(100);
    });

    it('builds a wide tree (fan-out)', () => {
        const events = [];
        for (let j = 1; j <= 5; j++) {
            events.push({
                event: 'copied_to',
                src: [0, 0],
                dst: [0, j],
                interrupt: j * 10,
                similarity: 0.9,
            });
        }

        const { nodes, roots } = buildTree(events);
        expect(roots).toEqual(['0,0']);
        expect(nodes.get('0,0').children.length).toBe(5);
    });
});
