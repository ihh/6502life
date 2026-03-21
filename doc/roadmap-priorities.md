# Roadmap Priorities: Phone Ecosystem + Coin Mining

Goal: self-reproducing ecosystem on peoples' phones, incentivized by
coin-mining fun.

## Priority 1: Can organisms survive at realistic noise?

The triplicator sustains at ε=0 but dies at ε=1/8192 (~1 bit/KB).
This is the critical blocker for interesting biology.

### Experiments needed
- [ ] P1a: Triplicator at ε=1/16384 (half current default) — does it survive?
- [ ] P1b: Triplicator repairing 2, 4, 8 bytes per scheduling — find the
      repair rate that beats ε=1/8192
- [ ] P1c: Triplicator with evolvable repair/replicate ratio (repair N
      bytes encoded as a parameter in the program itself)
- [ ] P1d: Competition: triplicator vs nano-2x at various noise levels —
      does error correction beat raw speed?
- [ ] P1e: What is the maximum ε where the triplicator can sustain 64/64
      for >10M interrupts? (Binary search on ε)

## Priority 2: Phone client — fastest path to working code

### Key questions
- [ ] P2a: Does Web Bluetooth work from a PWA on iOS/Android? What are
      the actual API constraints? (Agent: research current state)
- [ ] P2b: Quickest path: browser-based client with Web Bluetooth that
      keeps user identity credentials in the browser (localStorage /
      IndexedDB). No app store needed.
- [ ] P2c: Engine auth layer: how to inject user credentials into
      requests. SokoScript model: players 'own' cell IDs and must sign
      commands. For 6502life: signed writes? Cell ownership via public key?
- [ ] P2d: Can we run 6502life simulation in a Web Worker / Service Worker
      for background mining while the UI stays responsive?

## Priority 3: Engine integration and auth

### Design questions
- [ ] P3a: 6502life engine adapter for coin/engine.js interface
- [ ] P3b: Auth layer spec: engine permits a middleware layer that injects
      user credentials and masks phony credentials. Ed25519 key pair in
      browser. Signed session blocks.
- [ ] P3c: Cell ownership model for 6502life: what does it mean for a
      player to "own" a cell? Options: signed initial state, signed BRK
      copy events, signed trajectory blocks.

## Priority 4: WASM CPU integration

- [ ] P4a: Build cpu/6502.c with emscripten, integrate as Sfotty replacement
- [ ] P4b: Benchmark against Sfotty on real workloads
- [ ] P4c: Move inner loop (CPU + memory) into WASM for maximum performance

## Priority 5: Social mining mechanics

- [ ] P5a: Edge-sharing protocol: two boards share a boundary over
      Bluetooth, organisms cross between them
- [ ] P5b: Location-based edge assignment: use real-world compass
      orientation to decide which edge faces which
- [ ] P5c: Zero-knowledge proximity proof: can we prove two devices are
      nearby without revealing locations? (Nice to have, not essential)

## Additional questions

- [ ] Q1: TextEncoder/Decoder bug (from math review): fix the lossy
      UTF-8 serialization in board/memory.js — use base64 or raw
      Uint8Array serialization instead
- [ ] Q2: Sfotty CLC/BCC bug: is this a Sfotty bug or expected behavior?
      Does the WASM CPU handle it correctly?
- [ ] Q3: Can we make the triplicator's repair range self-adjusting?
      (e.g., repair only the bytes that differ between copies)
- [ ] Q4: Multi-species ecology: what happens when triplicator competes
      with nano-2x on the same board? Does the self-repairer win?
