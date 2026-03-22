# Social Game Tooling: Investigation and Spec

This document covers the CLI tools, IDE/TUI features, automated tests,
and analytics needed to support multi-board social play in 6502life.

In social play, two or more players each run a board. Boards share edge
data at their boundaries: the outermost row/column of one board becomes
visible to (or is copied to) the neighboring edge of another. Organisms
can migrate across these boundaries. Social mining rewards cooperation
between boards.

---

## 1. CLI Tools for Debugging Social Play

### 1.1 `social-diff.js` -- Diff two board states

Compare two saved board states side by side, highlighting cells that
differ. Useful for finding divergence points when two boards should
be in sync but are not.

```
Usage:
  node cli/bin/social-diff.js --state-a board1.json --state-b board2.json [options]

Flags:
  --state-a <file>     First board state (required)
  --state-b <file>     Second board state (required)
  --cell <i,j>         Compare a specific cell across both boards
  --edge <north|south|east|west>  Compare only the boundary edge
  --threshold <N>      Only show cells differing by more than N bytes (default: 0)
  --json               Machine-readable JSON output
  --summary            Print only summary statistics (differing cell count, byte diff total)

Output (default text mode):
  Differing cells:
    (0,0): 47 bytes differ (first diff at offset 0x03: A=0xEA B=0x00)
    (0,1): 12 bytes differ (first diff at offset 0x10: A=0xA9 B=0xAD)
  Summary: 23 of 256 cells differ, 412 total byte differences

Output (--json):
  { "differingCells": 23, "totalByteDiffs": 412, "cells": [...] }
```

### 1.2 `social-edge.js` -- Inspect and visualize boundary data

Show the data flowing across a board boundary. Displays the edge
row/column with per-cell byte summaries, entropy, and activity status.

```
Usage:
  node cli/bin/social-edge.js --state board.json --edge <north|south|east|west> [options]

Flags:
  --state <file>       Board state (required)
  --edge <direction>   Which edge to inspect (required)
  --depth <N>          How many rows/columns from the edge to show (default: 1)
  --metric <entropy|writes|fingerprint>  What to display per cell
  --json               Machine-readable output

Output (default, --edge north --metric entropy):
  North edge (row 0), 16 cells:
    (0,0)  ent=0.234  writes=47  fp=a3b2c1
    (0,1)  ent=0.891  writes=12  fp=d4e5f6
    ...
```

### 1.3 `social-track.js` -- Track organisms crossing boundaries

Given two board states (before and after an edge-share event), identify
organisms that migrated from one board to the other by comparing
fingerprints at boundary cells.

```
Usage:
  node cli/bin/social-track.js --before-a a1.json --after-a a2.json \
    --before-b b1.json --after-b b2.json --edge east [options]

Flags:
  --before-a <file>    Board A state before edge share
  --after-a <file>     Board A state after edge share
  --before-b <file>    Board B state before edge share
  --after-b <file>     Board B state after edge share
  --edge <direction>   Which edge was shared (from A's perspective)
  --json               Machine-readable output

Output:
  Edge share: A.east -> B.west
  Migrated organisms (by fingerprint similarity):
    A(15,3) -> B(0,3): similarity=0.94, 978/1024 bytes match
    A(15,7) -> B(0,7): similarity=0.87, 891/1024 bytes match
  New organisms appearing on B.west: 2
  Organisms lost from A.east: 0
```

### 1.4 `social-replay.js` -- Replay two boards with edge sharing

Run two boards simultaneously with a scripted edge-sharing schedule.
Logs all cross-boundary events for later analysis.

```
Usage:
  node cli/bin/social-replay.js --state-a a.json --state-b b.json \
    --edge east --share-interval 100 --interrupts 5000 \
    --log social-events.jsonl --save-a a2.json --save-b b2.json

Flags:
  --state-a <file>     Board A initial state (required)
  --state-b <file>     Board B initial state (required)
  --edge <direction>   Shared edge (from A's perspective; required)
  --share-interval <N> Run N interrupts between each edge share (default: 100)
  --interrupts <N>     Total interrupts to run (default: 1000)
  --log <file>         JSONL event log output
  --save-a <file>      Save board A final state
  --save-b <file>      Save board B final state
  --json               Summary as JSON

Event log format (one JSON object per line):
  {"event":"edge-share","time":500,"direction":"east","cellsShared":16}
  {"event":"migration","time":500,"from":"A","to":"B","cell":[15,3],"similarity":0.94}
  {"event":"census","time":500,"board":"A","activeCells":128,"entropy":0.45}
```

### 1.5 `social-heatmap.js` -- Side-by-side heatmaps

Render two board heatmaps side by side in the terminal, with boundary
edges highlighted. Uses the existing heatmap rendering engine but
draws two grids next to each other.

```
Usage:
  node cli/bin/social-heatmap.js --state-a a.json --state-b b.json \
    --metric writes --edge east

Output:
  Board A (16x16)         Board B (16x16)
  [heatmap grid]    |     [heatmap grid]
                    ^ shared edge highlighted
```

---

## 2. IDE/TUI Features

### 2.1 Split-Screen View

Add a `--social` mode to `terminal.js` that connects to a partner's
board (or loads two states) and shows them side by side.

```
node cli/bin/terminal.js --social --state-a a.json --state-b b.json --edge east
```

Layout:
```
+------------------+--+------------------+
| Board A minimap  |  | Board B minimap  |
|                  |  |                  |
+------------------+--+------------------+
| Disasm / Memory  |  | Event log        |
| (focused cell)   |  | (social events)  |
+------------------+--+------------------+
| Command prompt                          |
+-----------------------------------------+
```

The middle column highlights the shared edge. Cells on the boundary
are rendered with a distinct border color (e.g., magenta).

New commands for social mode:
- `focus a` / `focus b` -- switch which board is being inspected
- `share` -- manually trigger an edge share
- `auto-share <N>` -- edge share every N interrupts
- `social-status` -- show partner connection, blocks witnessed, sync state
- `migration-log` -- show recent cross-boundary organism movements

### 2.2 Boundary Cell Highlighting

In both the overview minimap and the detail cell view, boundary cells
should be visually distinct:
- Minimap: draw a colored border line along shared edges
- Detail view: when inspecting a boundary cell, show which neighbor
  cells are from the partner board (grayed out or labeled)
- Edge data direction indicator: arrows showing data flow direction

### 2.3 Social Event Log

Add a dedicated event stream for social events, shown in the command
output pane:
- `[SHARE]` -- edge share occurred, N cells synchronized
- `[MIGRATE]` -- organism crossed from one board to the other
- `[WITNESS]` -- block witnessed by partner
- `[CONNECT]` / `[DISCONNECT]` -- partner connection status changes

### 2.4 Social Mining Status Panel

A small status bar (or panel section) showing:
- Partner: connected / disconnected / latency
- Blocks witnessed: N (by partner), M (by self)
- Edge share rate: every N interrupts
- Last share: T cycles ago
- Migration balance: +X from partner, -Y to partner

---

## 3. Automated Testing

### 3.1 Determinism Test

Verify that two boards with the same initial state and the same
edge-sharing schedule produce identical final states.

```
Test procedure:
1. Create two pairs of boards (A1, B1) and (A2, B2) with identical states
2. Run both pairs for N interrupts with edge shares every M interrupts
3. Assert A1.state === A2.state and B1.state === B2.state

Key edge cases:
- Edge share at interrupt 0 (before any execution)
- Edge share at the final interrupt
- Back-to-back edge shares (interval = 1)
- Large board (64x64) to stress memory
```

### 3.2 Cross-Engine Consistency Test

Verify the JS and WASM engines produce identical results for social
mining scenarios.

```
Test procedure:
1. Create identical board pairs in both JS and WASM engines
2. Run same number of interrupts with same edge-sharing schedule
3. Compare final states byte-for-byte
4. Compare event logs entry-for-entry

Key scenarios:
- Simple replicator spreading across edge boundary
- Organism migration in both directions
- Edge share during atomic (I-flag) write
```

### 3.3 Stress Tests

```
Scenarios:
- Rapid edge shares (every interrupt) for 100,000 interrupts
- Asymmetric boards: one saturated with replicators, one empty
- Multiple edges shared simultaneously (4-board grid)
- Edge share with high epsilon (1/64) causing rapid mutation at boundary
- Large organisms (spanning multiple cells) crossing boundary
```

### 3.4 Edge Share Correctness Tests

```
Unit tests:
- After edge share, boundary cells on B match boundary cells on A
- Non-boundary cells are unaffected
- Edge share is directional: A.east -> B.west, not the reverse
- Bidirectional edge share: A.east -> B.west AND B.west -> A.east
- Edge share preserves register save area
- Edge share preserves display name and bitmap
- Cell activity tracking (lastWriteTime) is updated for shared cells
```

---

## 4. Analytics

### 4.1 Organism Migration Rate

Track how frequently organisms cross board boundaries over time.
An "organism" is defined as a cell whose MinHash fingerprint is similar
to a known replicator pattern.

```
Metrics:
- Migrations per 1000 interrupts (A->B and B->A)
- Net migration balance (positive = net flow from A to B)
- Migration by organism type (fingerprint cluster)
- Time-to-first-migration from board initialization

Output format (JSONL, one entry per census interval):
  {"time":1000,"a_to_b":3,"b_to_a":1,"net":2,"by_cluster":{"nano":2,"trip":1}}

Visualization:
  node cli/bin/social-analytics.js --log social-events.jsonl --metric migration-rate
  Prints a sparkline chart of migration rate over time.
```

### 4.2 Cross-Board Phylogenetic Trees

Extend the existing phylo.js tool to handle lineage events spanning
multiple boards. Each node in the tree is annotated with which board
it lives on. Migrations appear as edges crossing from one board's
subtree to another.

```
Extended phylo.js flags:
  --log a-events.jsonl --log b-events.jsonl --social-log social-events.jsonl
  --format dot --color-by-board

Output: a DOT graph where nodes are colored by board (e.g., red for A,
blue for B). Migration events are drawn as dashed edges crossing the
color boundary.
```

### 4.3 Diversity and Entropy Correlation

Track how organism diversity (measured by MinHash fingerprint cluster
count) correlates with board-level entropy and mining output over time.

```
Metrics:
- Shannon diversity index of fingerprint clusters per board
- Board-average entropy
- Mining rate (blocks per 1000 interrupts)
- Cross-board diversity (joint cluster count across both boards)

Hypothesis: boards with higher organism diversity produce more
interesting dynamics and should correlate with higher mining rewards.
This metric helps validate the proof-of-life mining mechanism.

Output:
  node cli/bin/social-analytics.js --log events.jsonl --metric diversity
  Time    Diversity  Entropy  Blocks
  1000    4.2        0.312    12
  2000    3.8        0.345    11
  ...
```

### 4.4 Boundary Activity Heatmap

A time-series heatmap of write activity along the shared boundary,
showing where organisms are most active at the edge.

```
Output:
  node cli/bin/social-analytics.js --log social-events.jsonl --metric boundary-heat

  Time ->
  Cell 0  ░░▒▓██▓▒░░░▒▓██
  Cell 1  ░░░░▒▓██▓▒░░░░░
  Cell 2  ▒▓▓▒░░░░░░▒▓▓▓█
  ...

Hot spots indicate where organisms prefer to cross, which may reveal
emergent "corridors" or "ports" in the boundary.
```

---

## Implementation Priority

The following order balances immediate debugging needs with longer-term
analytics goals:

1. **`social-diff.js`** -- essential for debugging any multi-board issue
2. **`social-edge.js`** -- quick to build, reuses existing heatmap code
3. **Determinism tests** -- must work before anything else is reliable
4. **`social-replay.js`** -- the core simulation tool for social play
5. **`social-track.js`** -- needs social-replay to generate data
6. **TUI split-screen mode** -- significant UI work, lower priority
7. **Cross-board phylo** -- extends existing tool, moderate effort
8. **Analytics suite** -- builds on top of event logs from social-replay

The first three items are prerequisites for reliable social play.
Items 4-5 enable experimentation. Items 6-8 are nice-to-have for
deeper investigation.
