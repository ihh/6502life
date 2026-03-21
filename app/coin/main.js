/**
 * 6502coin PWA — main entry point.
 *
 * Runs the Board6502Engine in the main thread with requestAnimationFrame.
 * Renders cell colors to a canvas, counts coins (blocks produced).
 */

import { Board6502Engine } from './engine-browser.js';
import { GridRenderer } from './renderer.js';
import { initWallet } from './wallet.js';
import { listPresets } from './presets-browser.js';
import './style.css';

// --- Configuration ---
const BOARD_SIZE = 16;
const CELL_PX = 16;
const BLOCK_INTERVAL = 1000; // ticks per coin block
const DEFAULT_SPEED = 10;    // ticks per frame
const MAX_SPEED = 200;

// --- State ---
let engine = null;
let renderer = null;
let wallet = null;
let running = false;
let speed = DEFAULT_SPEED;
let coins = 0;
let ticksSinceBlock = 0;
let rafId = null;

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
    <div class="controls">
      <button id="btn-start" class="active">Start</button>
      <button id="btn-stop">Stop</button>
      <select id="preset-select">
        <option value="">Inject preset...</option>
      </select>
      <span class="speed-label" id="speed-label">${speed} t/f</span>
      <input type="range" id="speed-slider" min="1" max="${MAX_SPEED}" value="${speed}">
    </div>
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

  // Init engine
  engine = new Board6502Engine();
  engine.init({
    size: BOARD_SIZE,
    seed: (Date.now() & 0xFFFF) ^ (Math.random() * 0xFFFF | 0),
    presets: [
      { name: 'nano-2x', cell: [0, 0] },
      { name: 'spreader', cell: [BOARD_SIZE - 1, BOARD_SIZE - 1] },
    ]
  });
  await engine.ready();

  // Init renderer
  const canvas = document.getElementById('grid-canvas');
  renderer = new GridRenderer(canvas, BOARD_SIZE, CELL_PX);

  // Render initial state
  renderer.render((x, y) => engine.getCell(x, y));

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
  ticksSinceBlock += speed;

  // Check for block (coin)
  while (ticksSinceBlock >= BLOCK_INTERVAL) {
    ticksSinceBlock -= BLOCK_INTERVAL;
    coins++;
  }

  // Render
  renderer.render((x, y) => engine.getCell(x, y));

  // Update stats (summarize is expensive — throttle to every 30 frames)
  frameCount++;
  if (frameCount % 30 === 0) {
    const summary = engine.summarize();
    cachedActive = summary.activeCells;
  }
  document.getElementById('coins').textContent = coins;
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
