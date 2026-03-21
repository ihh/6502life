# 6502coin Milestone 2: 6502life Engine Adapter + PWA Shell

## Objective

Make 6502life playable as a coin-mining game on a phone. This milestone
produces a working PWA where you watch your 6502life board evolve,
organisms replicate, and coins accumulate.

## Deliverables

### 1. 6502life Engine Adapter (`coin/engines/board6502.js`)

Wrap the existing `board/` engine (BoardMemory, BoardController) as a
coin Engine implementing the interface from `coin/engine.js`.

```js
class Board6502Engine extends Engine {
    init(config)        // config: { size, seed, pBitNoise, presets: [{name, cell}] }
    step()              // run one interrupt (runToNextInterrupt)
    serialize()         // board state as JSON (using Array serialization, not TextEncoder)
    deserialize(state)  // restore board state
    applyInput(input)   // inject a preset, poke bytes, etc.
    getBoundary(edge)   // return cells along one edge
    setBoundary(edge, data) // write neighbor cells from another board
    clock()             // total interrupts
    dimensions()        // { width, height }
    getCell(x, y)       // return cell view for rendering
    summarize()         // { activeCells, brkCopies, uniqueFingerprints, ... }
}
```

Key design decisions:
- `step()` runs ONE interrupt (not one cycle). The coin protocol counts
  interrupts, not cycles. This is the natural "tick" for 6502life.
- `getCell(x, y)` returns: `{ rgb: [r,g,b], activity: 0-1, name: string }`.
  Use the existing visualizer logic for colors (HSV from write/move recency).
- `summarize()` includes metrics that reveal whether the board is "alive":
  number of BRK copy events since last summary, number of cells with
  recent writes, number of unique MinHash fingerprints. Dead boards
  (all zeros, no copies) produce boring summaries.
- Board size for mobile: 16×16 (256 cells, 256KB state) or 32×32.

### 2. PWA Shell (`app/coin/`)

Minimal web app, buildable with Vite (the existing `app/` already uses Vite):

- **index.html**: single page
- **main.js**: app entry, starts Web Worker, renders grid
- **worker.js**: runs Board6502Engine in a Web Worker, posts cell updates
  to main thread periodically
- **renderer.js**: canvas-based grid renderer. Each cell = colored square.
  Click a cell to inspect it.
- **wallet.js**: Ed25519 keypair generation and storage (IndexedDB via
  Web Crypto API). Signs session blocks.
- **ui.js**: coin counter, speed controls, preset injection buttons

Communication: main thread ↔ worker via postMessage:
- Worker → main: `{ type: 'cells', data: [{x,y,rgb,activity}...] }` (periodic)
- Worker → main: `{ type: 'block', block: {...} }` (each mining block)
- Main → worker: `{ type: 'inject', preset: 'nano-2x', cell: [0,0] }`
- Main → worker: `{ type: 'speed', ticksPerFrame: 100 }`

### 3. Session Recording in Worker

The worker runs a Session (from `coin/session.js`) wrapping the
Board6502Engine. Every N ticks (configurable, default 1000), it produces
a block, signs it with the user's private key, and posts it to the main
thread. Blocks accumulate in IndexedDB.

### 4. Manifest + Service Worker

- `manifest.json` for PWA installability
- Service worker for offline caching (the app should work without internet
  once loaded — mining is local)

## What NOT to build yet

- Social play (Milestone 3)
- Ledger sync
- Coin transfer
- SokoScript engine

## Tech stack

- Vite for build
- Preact or vanilla JS (keep it light)
- Web Crypto API for Ed25519
- Canvas 2D for rendering
- Web Worker for simulation
- IndexedDB for wallet + session storage

## File structure

```
app/coin/
  index.html
  main.js
  worker.js
  renderer.js
  wallet.js
  style.css
  manifest.json
  sw.js
```

## Testing

- Engine adapter tests in `coin/test/board6502.test.js`
- Manual testing of PWA on phone (Chrome Android, Safari iOS)

## Estimated effort

~20-30 hours for a solo developer.
