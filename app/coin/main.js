/**
 * 6502coin PWA — main entry point.
 *
 * Runs the Board6502Engine in the main thread with requestAnimationFrame.
 * Renders cell colors to a canvas, counts coins (blocks produced).
 * Supports optional WebRTC social play via PeerJS.
 */

import { Board6502Engine } from './engine-browser.js';
import { GridRenderer } from './renderer.js';
import { initWallet } from './wallet.js';
import { listPresets } from './presets-browser.js';
import { SocialPlay } from './social-play.js';
import './style.css';

// --- Configuration ---
const BOARD_SIZE = 16;
const CELL_PX = 16;
const BLOCK_INTERVAL = 1000; // ticks per coin block
const DEFAULT_SPEED = 50;    // ticks per frame (enough to see dynamics)
const MAX_SPEED = 500;

// --- State ---
let engine = null;
let renderer = null;
let wallet = null;
let social = null;
let running = false;
let speed = DEFAULT_SPEED;
let coins = 0;
let ticksSinceBlock = 0;
let rafId = null;

// --- Notification queue ---
let notificationTimeout = null;

function showNotification(message) {
  const el = document.getElementById('notification');
  if (!el) return;
  el.textContent = message;
  el.className = 'notification-toast visible' +
    (message.startsWith('Niche') ? ' niche' : '');

  clearTimeout(notificationTimeout);
  notificationTimeout = setTimeout(() => {
    el.className = 'notification-toast';
  }, 3000);
}

// --- DOM ---
const app = document.getElementById('app');

function createUI() {
  app.innerHTML = `
    <header>
      <h1>6502coin</h1>
      <div class="pubkey" id="pubkey">loading wallet...</div>
    </header>
    <canvas id="grid-canvas"></canvas>
    <div class="status-bar">
      <div class="stat">
        <span class="label">Coins</span>
        <span class="value" id="coins">0</span>
      </div>
      <div class="stat">
        <span class="label">Ticks</span>
        <span class="value" id="ticks">0</span>
      </div>
      <div class="stat">
        <span class="label">Active</span>
        <span class="value" id="active">0</span>
      </div>
      <div class="stat">
        <span class="label">Copies</span>
        <span class="value" id="copies">0</span>
      </div>
    </div>
    <div class="social-bar" id="social-bar">
      <span class="status-dot" id="social-dot" title="Connection status"></span>
      <span class="peer-id" id="peer-id" title="Click to copy your Peer ID">...</span>
      <div class="social-connect">
        <input type="text" id="peer-input" placeholder="Enter peer ID..." />
        <button id="btn-connect">Connect</button>
      </div>
    </div>
    <div class="social-info" id="social-info"></div>
    <div class="controls">
      <button id="btn-start" class="active">Start</button>
      <button id="btn-stop">Stop</button>
      <select id="preset-select">
        <option value="">Inject preset...</option>
      </select>
      <span class="speed-label" id="speed-label">${speed} t/f</span>
      <input type="range" id="speed-slider" min="1" max="${MAX_SPEED}" value="${speed}" step="1">
    </div>
    <div id="notification" class="notification-toast"></div>
  `;

  // Populate presets dropdown
  const select = document.getElementById('preset-select');
  for (const p of listPresets()) {
    const opt = document.createElement('option');
    opt.value = p.key;
    opt.textContent = `${p.name}`;
    select.appendChild(opt);
  }
}

async function init() {
  createUI();

  // Init wallet
  wallet = await initWallet();
  document.getElementById('pubkey').textContent = wallet.publicKeyHex;

  // Init engine with a diverse mix of colored organisms
  engine = new Board6502Engine();
  await engine.init({
    size: BOARD_SIZE,
    seed: (Date.now() & 0xFFFF) ^ (Math.random() * 0xFFFF | 0),
    presets: [
      // Colored replicators -- these write to the RGB bitmap so they show vivid colors
      { name: 'red',   cell: [0, 0] },
      { name: 'red',   cell: [8, 8] },
      { name: 'green', cell: [0, BOARD_SIZE - 1] },
      { name: 'green', cell: [8, 4] },
      { name: 'blue',  cell: [BOARD_SIZE - 1, 0] },
      { name: 'blue',  cell: [4, 12] },
      // Spreaders for background activity
      { name: 'nano-2x', cell: [BOARD_SIZE - 1, BOARD_SIZE - 1] },
      { name: 'nano-2x', cell: [4, 4] },
    ]
  });
  await engine.ready();

  // Run a burst of ticks so the board is already alive on first render
  engine.step(200);

  // Init renderer
  const canvas = document.getElementById('grid-canvas');
  renderer = new GridRenderer(canvas, BOARD_SIZE, CELL_PX);

  // Render initial state
  renderer.render((x, y) => engine.getCell(x, y));

  // Init social play
  await initSocial();

  // Wire up controls
  document.getElementById('btn-start').addEventListener('click', start);
  document.getElementById('btn-stop').addEventListener('click', stop);

  document.getElementById('speed-slider').addEventListener('input', (e) => {
    speed = parseInt(e.target.value);
    document.getElementById('speed-label').textContent = `${speed} t/f`;
  });

  document.getElementById('preset-select').addEventListener('change', async (e) => {
    const presetKey = e.target.value;
    if (!presetKey) return;

    // Inject at a random cell
    const x = Math.floor(Math.random() * BOARD_SIZE);
    const y = Math.floor(Math.random() * BOARD_SIZE);

    await engine.applyInput({
      type: 'inject',
      preset: presetKey,
      cell: [x, y],
    });

    // Reset dropdown
    e.target.value = '';
  });

  // Auto-start
  start();
}

// --- Social Play ---

async function initSocial() {
  social = new SocialPlay(engine, wallet, {
    exportEdge: 'north',
    shareInterval: 100,
    onNotification: showNotification,
  });

  try {
    const peerId = await social.start();
    updatePeerIdDisplay(peerId);
  } catch (err) {
    console.warn('Social play unavailable:', err.message);
    document.getElementById('peer-id').textContent = 'offline';
    document.getElementById('peer-id').title = err.message;
  }

  // Copy peer ID on click
  document.getElementById('peer-id').addEventListener('click', () => {
    const id = social.getPeerId();
    if (!id) return;
    navigator.clipboard.writeText(id).then(() => {
      const el = document.getElementById('peer-id');
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 1500);
    }).catch(() => {
      // Fallback: select the text
    });
  });

  // Connect button
  document.getElementById('btn-connect').addEventListener('click', async () => {
    const input = document.getElementById('peer-input');
    const remotePeerId = input.value.trim();
    if (!remotePeerId) return;

    const btn = document.getElementById('btn-connect');
    btn.textContent = '...';
    btn.disabled = true;

    try {
      await social.connectTo(remotePeerId);
      input.value = '';
    } catch (err) {
      showNotification(`Failed: ${err.message}`);
    } finally {
      btn.textContent = 'Connect';
      btn.disabled = false;
    }
  });

  // Enter key in input
  document.getElementById('peer-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('btn-connect').click();
    }
  });
}

function updatePeerIdDisplay(peerId) {
  const el = document.getElementById('peer-id');
  el.textContent = peerId;
  el.title = 'Click to copy: ' + peerId;
}

function updateSocialUI() {
  if (!social) return;

  const stats = social.getStats();
  const dot = document.getElementById('social-dot');
  const info = document.getElementById('social-info');

  // Update connection dot
  if (stats.connected) {
    dot.classList.add('connected');
  } else {
    dot.classList.remove('connected');
  }

  // Update info line
  if (stats.connected) {
    const shortId = stats.partnerId.length > 20
      ? stats.partnerId.slice(0, 20) + '...'
      : stats.partnerId;
    info.innerHTML =
      `<span class="partner">Connected: ${shortId}</span> ` +
      `<span class="multiplier">${stats.miningMultiplier}x</span> ` +
      `| Shares: ${stats.sharesSent}/${stats.sharesReceived}` +
      (stats.nicheEvents > 0
        ? ` | Niches: ${stats.nicheEvents} (+${stats.nicheCoins.toFixed(2)})`
        : '');
  } else {
    info.textContent = '';
  }
}

// --- Run Loop ---

function start() {
  if (running) return;
  running = true;
  document.getElementById('btn-start').classList.add('active');
  document.getElementById('btn-stop').classList.remove('active');
  rafId = requestAnimationFrame(loop);
}

function stop() {
  running = false;
  document.getElementById('btn-stop').classList.add('active');
  document.getElementById('btn-start').classList.remove('active');
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

let frameCount = 0;
let cachedActive = 0;

function loop() {
  if (!running) return;

  // Step the engine
  engine.step(speed);

  // Handle social edge sharing
  if (social) {
    social.tick(speed);
  }

  // Get mining multiplier (1.0 solo, 1.5 social)
  const multiplier = social ? social.getMiningMultiplier() : 1.0;

  // Check for block (coin) — apply social multiplier
  ticksSinceBlock += speed * multiplier;
  while (ticksSinceBlock >= BLOCK_INTERVAL) {
    ticksSinceBlock -= BLOCK_INTERVAL;
    coins++;
  }

  // Add niche coins if any
  if (social) {
    const stats = social.getStats();
    // Niche coins are tracked in social stats, add them to display total
    const totalCoins = coins + stats.nicheCoins;
    document.getElementById('coins').textContent = totalCoins % 1 === 0
      ? totalCoins
      : totalCoins.toFixed(2);
  } else {
    document.getElementById('coins').textContent = coins;
  }

  // Render
  renderer.render((x, y) => engine.getCell(x, y));

  // Update stats (summarize is expensive — throttle to every 30 frames)
  frameCount++;
  if (frameCount % 30 === 0) {
    const summary = engine.summarize();
    cachedActive = summary.activeCells;
    updateSocialUI();
  }
  document.getElementById('ticks').textContent = formatNum(engine.clock());
  document.getElementById('active').textContent = cachedActive;
  document.getElementById('copies').textContent = engine._totalCopies;

  rafId = requestAnimationFrame(loop);
}

function formatNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

// --- Go ---
init().catch(err => {
  console.error('6502coin init failed:', err);
  app.innerHTML = `<div class="loading">Failed to initialize: ${err.message}</div>`;
});
