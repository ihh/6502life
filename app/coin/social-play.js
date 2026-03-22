/**
 * Social play manager for 6502coin.
 *
 * Handles edge sharing over WebRTC data channels using CoinPeer.
 * When connected to a peer, exchanges boundary cells at configurable
 * tick intervals. Tracks niche events and applies the social mining bonus.
 *
 * This module is additive — solo mining works identically when disconnected.
 *
 * @module app/coin/social-play
 */

import { CoinPeer } from './peer.js';

/**
 * Opposite edges: my north export maps to their south import.
 */
const OPPOSITE_EDGE = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
};

/**
 * @typedef {Object} SocialStats
 * @property {boolean} connected - whether a peer is connected
 * @property {string|null} partnerId - connected peer's ID
 * @property {string|null} partnerPubkey - connected peer's public key hex
 * @property {number} sharesSent - total boundary shares sent
 * @property {number} sharesReceived - total boundary shares received
 * @property {number} nicheEvents - total niche events detected
 * @property {number} nicheCoins - total bonus coins from niche events
 * @property {number} miningMultiplier - current mining rate multiplier (1.0 solo, 1.5 social)
 */

/**
 * Manages social play: peer connections, edge sharing, and niche detection.
 */
export class SocialPlay {
  /**
   * @param {import('./engine-browser.js').Board6502Engine} engine - local engine
   * @param {Object} wallet - wallet from initWallet()
   * @param {Object} [options]
   * @param {'north'|'south'|'east'|'west'} [options.exportEdge='north'] - edge to export
   * @param {number} [options.shareInterval=100] - ticks between boundary shares
   * @param {number} [options.socialMultiplier=1.5] - mining rate multiplier when connected
   * @param {number} [options.nicheBonus=0.69] - coins per niche event
   * @param {function(string):void} [options.onNotification] - callback for UI notifications
   */
  constructor(engine, wallet, options = {}) {
    this.engine = engine;
    this.wallet = wallet;
    this.exportEdge = options.exportEdge ?? 'north';
    this.shareInterval = options.shareInterval ?? 100;
    this.socialMultiplier = options.socialMultiplier ?? 1.5;
    this.nicheBonus = options.nicheBonus ?? 0.69;
    this.onNotification = options.onNotification ?? (() => {});

    /** @type {CoinPeer|null} */
    this.peer = null;

    /** @type {string|null} current partner peer ID */
    this._partnerId = null;
    /** @type {string|null} current partner public key hex */
    this._partnerPubkey = null;

    // Counters
    this._sharesSent = 0;
    this._sharesReceived = 0;
    this._nicheEvents = 0;
    this._nicheCoins = 0;
    this._ticksSinceLastShare = 0;

    // Track last pairing time for solo decay
    this._lastPairingTime = Date.now();

    // Pending boundary from partner (applied on next share tick)
    this._pendingBoundary = null;
  }

  /**
   * Initialize the PeerJS connection and start listening.
   * @returns {Promise<string>} our peer ID
   */
  async start() {
    this.peer = new CoinPeer(this.wallet.publicKeyHex, {
      onMessage: (peerId, data) => this._handleMessage(peerId, data),
      onConnect: (peerId) => this._handleConnect(peerId),
      onDisconnect: (peerId) => this._handleDisconnect(peerId),
      onError: (msg) => {
        console.error('[social] peer error:', msg);
        this.onNotification(`Peer error: ${msg}`);
      },
    });

    const id = await this.peer.start();
    return id;
  }

  /**
   * Connect to a remote peer by ID.
   * @param {string} remotePeerId
   * @returns {Promise<void>}
   */
  async connectTo(remotePeerId) {
    if (!this.peer) throw new Error('Social play not started. Call start() first.');
    await this.peer.connectToPeer(remotePeerId);
  }

  /**
   * Call this every frame/tick batch to handle periodic edge sharing.
   * @param {number} ticksAdvanced - how many ticks were advanced this frame
   */
  tick(ticksAdvanced) {
    if (!this._partnerId) return;

    this._ticksSinceLastShare += ticksAdvanced;

    if (this._ticksSinceLastShare >= this.shareInterval) {
      this._ticksSinceLastShare = 0;
      this._shareBoundary();
    }
  }

  /**
   * Read our export edge and send it to the partner.
   * If we have a pending boundary from the partner, apply it.
   * @private
   */
  _shareBoundary() {
    if (!this._partnerId || !this.peer) return;

    // Read our export edge
    const boundaryData = this.engine.getBoundary(this.exportEdge);

    // Send to partner as an ArrayBuffer for efficient transfer
    const message = {
      type: 'boundary',
      edge: this.exportEdge,
      tick: this.engine.clock(),
      // Convert to array for JSON serialization over PeerJS
      data: Array.from(boundaryData),
    };

    this.peer.send(this._partnerId, message);
    this._sharesSent++;

    // Apply any pending boundary from partner
    if (this._pendingBoundary) {
      const importEdge = OPPOSITE_EDGE[this._pendingBoundary.edge];
      const data = new Uint8Array(this._pendingBoundary.data);
      this.engine.setBoundary(importEdge, data);
      this._sharesReceived++;
      this._pendingBoundary = null;
    }
  }

  /**
   * Handle incoming messages from a peer.
   * @param {string} peerId
   * @param {Object} data
   * @private
   */
  _handleMessage(peerId, data) {
    if (!data || !data.type) return;

    switch (data.type) {
      case 'handshake':
        this._partnerPubkey = data.publicKeyHex;
        console.log(`[social] partner pubkey: ${data.publicKeyHex.slice(0, 16)}...`);
        break;

      case 'boundary':
        // Store boundary for next share tick (applied synchronously with our share)
        this._pendingBoundary = {
          edge: data.edge,
          data: data.data,
          tick: data.tick,
        };
        break;

      case 'niche':
        // Partner detected our organisms on their board
        this._nicheEvents++;
        this._nicheCoins += this.nicheBonus;
        this.onNotification(`Niche! +${this.nicheBonus} coins`);
        break;

      default:
        console.log(`[social] unknown message type: ${data.type}`);
    }
  }

  /**
   * Handle a new peer connection.
   * @param {string} peerId
   * @private
   */
  _handleConnect(peerId) {
    this._partnerId = peerId;
    this._lastPairingTime = Date.now();
    this._ticksSinceLastShare = 0;
    this._pendingBoundary = null;
    this.onNotification(`Connected to ${peerId}`);
  }

  /**
   * Handle a peer disconnection.
   * @param {string} peerId
   * @private
   */
  _handleDisconnect(peerId) {
    if (this._partnerId === peerId) {
      this._partnerId = null;
      this._partnerPubkey = null;
      this._pendingBoundary = null;
      this.onNotification('Peer disconnected');
    }
  }

  /**
   * Get the current mining multiplier.
   * 1.5x when connected (social mining), 1.0x when solo.
   * @returns {number}
   */
  getMiningMultiplier() {
    return this._partnerId ? this.socialMultiplier : 1.0;
  }

  /**
   * Get social play statistics.
   * @returns {SocialStats}
   */
  getStats() {
    return {
      connected: this._partnerId !== null,
      partnerId: this._partnerId,
      partnerPubkey: this._partnerPubkey,
      sharesSent: this._sharesSent,
      sharesReceived: this._sharesReceived,
      nicheEvents: this._nicheEvents,
      nicheCoins: this._nicheCoins,
      miningMultiplier: this.getMiningMultiplier(),
    };
  }

  /**
   * Get our peer ID (for display/sharing).
   * @returns {string|null}
   */
  getPeerId() {
    return this.peer?.peerId ?? null;
  }

  /**
   * Disconnect from current partner.
   */
  disconnectPartner() {
    if (this._partnerId && this.peer) {
      this.peer.disconnect(this._partnerId);
      this._partnerId = null;
      this._partnerPubkey = null;
      this._pendingBoundary = null;
    }
  }

  /**
   * Shut down social play entirely.
   */
  destroy() {
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
    this._partnerId = null;
    this._partnerPubkey = null;
  }
}
