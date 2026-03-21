# Phone Client Research: 2D Grid Game with Bluetooth Social Play

Research date: March 2026

---

## 1. Web Bluetooth API Status (2025-2026)

### Browser Support

| Browser | Web Bluetooth | Since |
|---------|--------------|-------|
| Chrome Android | Yes | v56 |
| Samsung Internet | Yes | v6.2 |
| Chrome Desktop (Mac/Win/CrOS) | Yes | v56-70 |
| Edge | Yes | v79 |
| Firefox | **No** (all versions; standards position: "harmful") | -- |
| Safari (macOS) | **No** | -- |
| Safari (iOS) | **No** | -- |

**Bottom line:** ~79% global coverage due to Chrome/Edge dominance, but zero iOS
support. Firefox has formally declared Web Bluetooth "harmful" and will not implement it.

### What Web Bluetooth Can and Cannot Do

**Can do (Central role only):**
- `navigator.bluetooth.requestDevice()` -- user picks a device from a system picker
  (requires user gesture)
- Connect to a remote GATT server, read/write characteristics
- Subscribe to characteristic notifications
- Requires HTTPS (secure context)

**Cannot do:**
- Act as a BLE peripheral / advertiser (no GATT server mode)
- Scan for advertisements without user gesture (`requestLEScan()` is still experimental)
- Run in a Web Worker (API not exposed on `WorkerNavigator`)

### Can Two Phones Discover Each Other via Web Bluetooth?

**No.** Web Bluetooth is Central-only. Both phones would try to connect as Central to a
GATT server; neither can advertise as a Peripheral. There is no browser API for BLE
advertising/peripheral mode.

For phone-to-phone BLE, you need native code (CoreBluetooth on iOS,
android.bluetooth on Android) or a framework like Capacitor with a community BLE plugin
that exposes peripheral mode.

### Latency and Throughput

BLE 4.2+ supports data payloads up to 251 bytes per packet (with DLE), negotiated per
connection. Practical throughput for small transfers:

| Metric | Typical BLE value |
|--------|-------------------|
| Connection interval | 7.5ms - 4s (negotiated) |
| Round-trip latency | 15-30ms (best case, one connection interval) |
| Throughput (no DLE) | ~2-5 KB/s |
| Throughput (DLE, 251B) | ~20-40 KB/s |
| Single <1KB transfer | ~50-200ms end-to-end |

For <1KB game state transfers, BLE is adequate. Latency is fine for turn-based or
periodic-sync gameplay, not for real-time action.

### Alternatives to Web Bluetooth

#### WebRTC Data Channels (Recommended)

| Feature | Status |
|---------|--------|
| Browser support | 97.2% global; iOS Safari 11+, Chrome Android, Firefox |
| Peer-to-peer | Yes, after signaling exchange |
| Latency | <50ms typical on LAN, <100ms on internet |
| Throughput | Mbps-range, far exceeds BLE |
| Reliable + unreliable modes | Yes (ordered/unordered, maxRetransmits) |
| Works in Web Workers | Yes (RTCDataChannel is transferable) |

**Catch:** Requires a signaling step to exchange SDP offers/ICE candidates. Options:
- **PeerJS** -- open-source library, free cloud signaling server or self-hosted.
  Peer-to-peer in ~10 lines of code. Data never transits the server after setup.
- **QR code exchange** -- one phone shows QR with SDP offer, other scans it. True
  serverless, works offline.
- **Manual ID exchange** -- short room codes (e.g., 6-digit PIN) via a lightweight
  signaling server.

WebRTC is the clear winner for cross-platform phone-to-phone data exchange. Works
everywhere including iOS Safari.

#### Capacitor + Native BLE (if BLE is required)

Capacitor wraps a web app in a native shell. The `@nicedoc/nicedoc-capacitor-community-bluetooth-le`
community plugin (or similar) can expose both Central and Peripheral BLE modes on iOS
and Android. This requires shipping through app stores.

Capacitor also provides a Background Runner plugin for background execution.

#### Other Options

- **Nearby Share / AirDrop APIs**: Not exposed to web or third-party apps.
- **Multipeer Connectivity (iOS)**: Native-only (Swift/ObjC). Not available to web apps.
- **NFC**: Very short range (~4cm), better for one-time pairing than ongoing data exchange.

---

## 2. Fastest Path to Working Phone Client

### Framework Comparison

| Approach | iOS BLE | Android BLE | Cross-platform | App store? | Dev speed |
|----------|---------|-------------|----------------|------------|-----------|
| **PWA (WebRTC)** | No BLE, but WebRTC works | No BLE, but WebRTC works | Yes | No | Fastest |
| **PWA (Web Bluetooth)** | No | Yes | No | No | Fast |
| **Capacitor** | Yes (plugin) | Yes (plugin) | Yes | Yes (required) | Medium |
| **React Native** | Yes (react-native-ble-plx) | Yes | Yes | Yes (required) | Medium |
| **Flutter** | Yes | Yes | Yes | Yes (required) | Medium-slow |
| **Native (Swift + Kotlin)** | Yes | Yes | Two codebases | Yes | Slowest |

**Recommendation: PWA with WebRTC for the MVP.** Reasons:
1. Works on both iOS and Android in the browser -- no app store review
2. WebRTC gives peer-to-peer data exchange with better throughput than BLE
3. Same JavaScript codebase as the existing 6502life engine
4. Can be upgraded to Capacitor later if native BLE is needed
5. Instant deployment via URL sharing

### User Identity in the Browser

**Ed25519 in Web Crypto API (2025-2026 status):**

| Browser | Ed25519 Support | Since |
|---------|----------------|-------|
| Chrome | Yes | v137 |
| Edge | Yes | v137 |
| Firefox | Yes | v129 |
| Safari/iOS | Yes (but generates randomized signatures, not deterministic per RFC 8032) | v17.0 |

~83% global coverage. The Safari caveat about randomized signatures is notable: signature
verification still works, but the same message+key produces different signatures each time.
This is acceptable for authentication but means you cannot use signature determinism as a
test vector.

**Storage options:**

```javascript
// Generate keypair
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "Ed25519" },
  false, // extractable=false for security; true if you need export
  ["sign", "verify"]
);

// Store in IndexedDB (CryptoKey objects are structured-cloneable)
const db = await idb.open('identity', 1);
await db.put('keys', { publicKey, privateKey }, 'user');
```

- **IndexedDB**: Best option. CryptoKey objects can be stored directly (structured clone).
  Persistent across sessions. No size limits in practice.
- **localStorage**: Cannot store CryptoKey objects (string-only). Would need to export
  to JWK and re-import. Acceptable fallback.
- **Caveat on iOS**: Safari may evict IndexedDB data after 7 days of non-use for
  non-installed PWAs. For installed home-screen PWAs, storage is more persistent.
  Always design for key re-creation or backup.

### Web Worker for Background Mining

```javascript
// main.js
const worker = new Worker('miner.js');
worker.postMessage({ board: boardState, cycles: 1000 });
worker.onmessage = (e) => updateUI(e.data);

// miner.js
self.onmessage = (e) => {
  const result = runSimulation(e.data.board, e.data.cycles);
  self.postMessage(result);
};
```

- Web Workers are supported everywhere (iOS Safari 5+, Chrome, Firefox, etc.)
- The 6502life engine is pure JS with no DOM dependencies -- it will run in a Worker
- SharedArrayBuffer would allow zero-copy board state sharing but requires
  `Cross-Origin-Isolation` headers (COOP/COEP), which may complicate deployment

### iOS Background Execution Limits

This is the hard constraint:

- **PWA backgrounded on iOS**: JavaScript execution is **suspended within seconds**.
  No Background Sync, no Periodic Background Sync, no Background Fetch on iOS.
- **Web Workers**: Suspended along with the main thread when backgrounded.
- **Push notifications**: Only work for home-screen-installed PWAs (not in Safari browser).
- **Practical impact**: Mining can only happen while the app is in the foreground.
  This is acceptable for a game where mining is interactive.

**If background mining is required:**
- Use Capacitor with the Background Runner plugin (native background task, limited to
  ~30s bursts on iOS, longer on Android)
- Or accept foreground-only mining for the MVP

### Minimal UI

1. **Canvas grid view**: HTML5 Canvas rendering a 2D grid. At 60fps, a 64x64 grid is
   trivial. Use `requestAnimationFrame` + direct pixel manipulation or `fillRect` calls.
2. **Coin counter**: DOM overlay showing mined coins, updated from Worker messages.
3. **Nearby players list**: WebRTC peer list. Show connected peer public keys (truncated)
   and their grid state.
4. **Connection UI**: "Create Room" button generates a room code; "Join Room" takes a code.
   PeerJS handles the rest.

---

## 3. Auth Layer Design

### User Identity

Each player generates an Ed25519 keypair on first launch:

```
Public key  = 32 bytes (hex: 64 chars) -- serves as player ID
Private key = stored in IndexedDB, never transmitted
```

The public key is the player's permanent identity. Display as a truncated hex string
or a deterministic avatar/nickname derived from the key.

### Session Signing

A "mining session" produces a block:

```json
{
  "player": "<public_key_hex>",
  "timestamp": 1711036800,
  "initial_state_hash": "<sha256>",
  "final_state_hash": "<sha256>",
  "cycles_run": 50000,
  "coins_mined": 3,
  "signature": "<ed25519_signature>"
}
```

The signature covers the canonical JSON of all fields except `signature`. Any peer
can verify the block using the player's public key.

### Cell Ownership in 6502life Context

Three models, from simplest to most complex:

| Model | Description | Complexity | Trust |
|-------|-------------|-----------|-------|
| **Board ownership** | You sign the board you seeded. The whole board is yours. | Low | Low -- you could fake results |
| **Signed trajectories** | You sign (initial_hash, final_hash, cycles). Peers can replay to verify. | Medium | Medium -- verifiable if peers replay |
| **Cell-level ownership** | Individual cells are owned by players who injected code. Writes to foreign cells require counter-signatures. | High | High -- but very complex |

**Recommendation for MVP: Signed trajectories.** The player signs a block attesting
"I ran this board from state X to state Y over N cycles." Verification is possible by
replaying the simulation (deterministic engine). Cell-level ownership adds significant
complexity and is better suited to the SokoScript model where cells have explicit owners.

### Middleware Layer for Credentials

The engine should accept an optional middleware that:

1. **On session start**: Attaches player identity to the session
2. **On block production**: Signs the block with the player's private key
3. **On block receipt**: Validates the signature against the claimed public key
4. **On peer connection**: Exchanges public keys as part of the handshake

```javascript
// Middleware interface
const authMiddleware = {
  async signBlock(block) { /* returns block with signature */ },
  async verifyBlock(block) { /* returns boolean */ },
  async handshake(peer) { /* exchange public keys */ },
  getPlayerId() { /* returns public key hex */ }
};
```

This keeps the engine agnostic to the auth mechanism. The same engine code works
in CLI (no auth), web (Ed25519), and future native apps.

---

## 4. Concrete MVP Checklist

### Step 1: PWA Shell with Canvas Grid Renderer

**What:** Minimal PWA (manifest.json, service worker, index.html) with a Canvas element
rendering a 2D grid. Touch/pan/zoom support. Installable to home screen.

**Technical details:**
- Vite build (already used by the 6502life app/)
- Canvas 2D context, `fillRect` for each cell
- Touch events for pan/zoom (use a library like Hammer.js or write minimal gesture code)
- PWA manifest with icons, `display: standalone`
- Service worker for offline caching

**Effort: 8-12 hours**

### Step 2: Web Worker Running Game Engine

**What:** Port the 6502life simulation engine to run in a Web Worker. Main thread sends
board state, Worker runs N cycles and returns results.

**Technical details:**
- The engine (board/memory.js, board/controller.js) is already pure JS
- Serialize board state to ArrayBuffer or JSON for Worker transfer
- Use `postMessage` for command/result exchange
- Implement a simple protocol: `{cmd: 'init', board}`, `{cmd: 'run', cycles}`,
  `{cmd: 'getState'}`
- Add coin-mining logic: define what constitutes a "coin" (e.g., a specific pattern
  emerging, or simply proof-of-work over N cycles)

**Effort: 6-10 hours**

### Step 3: Session Recorder Producing Signed Blocks

**What:** After each mining run, produce a signed block containing initial state hash,
final state hash, cycle count, and Ed25519 signature.

**Technical details:**
- Generate Ed25519 keypair on first launch via `crypto.subtle.generateKey()`
- Store in IndexedDB (CryptoKey objects are structured-cloneable)
- Hash board state with SHA-256 via `crypto.subtle.digest()`
- Sign blocks with `crypto.subtle.sign("Ed25519", privateKey, data)`
- Store signed blocks in IndexedDB as a local ledger
- Display coin count from accumulated verified blocks

**Effort: 4-6 hours**

### Step 4: WebRTC Discovery and Edge-Sharing

**What:** Two phones connect via WebRTC data channel and exchange signed blocks
and board edge state.

**Technical details:**
- Use PeerJS library (npm `peerjs`, ~50KB)
- PeerJS provides a free signaling server; self-hosting is one `peerjs --port 9000` away
- Connection flow:
  1. Player A creates a room, gets a short room ID (PeerJS peer ID)
  2. Player A shows room ID as text or QR code
  3. Player B enters room ID or scans QR
  4. PeerJS establishes WebRTC data channel
  5. Phones exchange public keys, then signed blocks, then edge state
- Edge-sharing protocol: each phone sends its border cells' state; the receiving phone
  maps them to its neighbor cells
- Latency: <100ms for data channel messages on local network

**Effort: 10-16 hours** (most time spent on edge-sharing protocol and state sync)

### Step 5: Coin Counter and Leaderboard

**What:** Display mined coins, show connected peers and their coin counts.

**Technical details:**
- Local coin count from IndexedDB ledger
- Peer coin counts received via data channel
- Simple DOM overlay on the canvas
- Optional: persist to a lightweight server for a global leaderboard (out of MVP scope)

**Effort: 2-4 hours**

### Summary Table

| Step | Component | Effort (solo dev) | Dependencies |
|------|-----------|-------------------|--------------|
| 1 | PWA + Canvas grid | 8-12 hours | None |
| 2 | Web Worker engine | 6-10 hours | Step 1 |
| 3 | Signed session blocks | 4-6 hours | Step 2 |
| 4 | WebRTC peer connection | 10-16 hours | Step 3 |
| 5 | Coin counter + peer list | 2-4 hours | Step 4 |
| **Total** | | **30-48 hours** | |

### Risk Factors

- **iOS Safari Ed25519**: Randomized signatures work for verification but test vectors
  will differ. Not a blocker.
- **iOS PWA storage eviction**: IndexedDB may be cleared after 7 days of non-use.
  Mitigation: prompt user to install to home screen; consider key backup/export.
- **iOS background suspension**: Mining stops when backgrounded. Acceptable for MVP.
  Capacitor upgrade path exists for later.
- **PeerJS signaling server**: Free tier may have reliability issues. Self-hosting
  is trivial (single Node.js process).
- **WebRTC NAT traversal**: On the same WiFi network, connections are direct. Across
  networks, a TURN server may be needed. PeerJS does not provide TURN; consider
  adding one (e.g., Twilio TURN or self-hosted coturn) for robust connectivity.

### Upgrade Path to BLE (Post-MVP)

If Bluetooth is required for offline/no-WiFi scenarios:
1. Wrap the PWA in Capacitor (`npx cap init`, `npx cap add ios`, `npx cap add android`)
2. Add `@nicedoc/nicedoc-capacitor-community-bluetooth-le` or equivalent plugin
3. Implement BLE peripheral + central mode for bidirectional phone-to-phone
4. Ship via App Store / Play Store
5. Estimated additional effort: 20-30 hours
